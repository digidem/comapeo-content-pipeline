/**
 * sync:mark-published implementation — post-deploy status write-back to Notion.
 *
 * Implements Track B1 (comapeo-docs#185 / TASKS.md §3):
 * Transitions pages matching a pre-publish status (default: "Draft published")
 * to a published status (default: "Published") via the Notion API.
 *
 * Defaults to DRY-RUN mode. Requires `--live` (or `--dry-run false`) to execute real writes.
 * Supports incremental rollback logging to output/rollback-published-<timestamp>.json.
 * Follows non-blocking failure semantics (logs and collects errors without halting).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NotionClient } from "../lib/notion-client.js";
import { NOTION_PROPERTIES } from "../lib/notion-properties.js";
import { ContentManifestSchema, type ContentManifest } from "../schemas/manifest.js";

export class MarkPublishedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkPublishedError";
  }
}

export interface StatusUpdateClient {
  updatePageStatus(
    pageId: string,
    status: string,
    options?: { setPublishedDate?: boolean; publishedDate?: string },
  ): Promise<unknown>;
  getPage?(pageId: string): Promise<{
    id: string;
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
}

export interface RollbackEntry {
  page_id: string;
  title: string;
  locale: string;
  original_status: string;
  new_status: string;
  updated_at: string;
}

export interface MarkPublishedOptions {
  manifestPath?: string;
  manifestVersion?: string;
  fromStatus?: string;
  toStatus?: string;
  setPublishedDate?: boolean;
  publishedDate?: string;
  live?: boolean;
  dryRun?: boolean;
  force?: boolean;
  outDir?: string;
  limit?: number;
  locale?: string;
  token?: string;
  databaseId?: string;
  dataSourceId?: string;
}

export interface MarkPublishedResult {
  totalManifestDocs: number;
  targetedDocs: number;
  updatedCount: number;
  failedCount: number;
  skippedCount: number;
  dryRun: boolean;
  rollbackPath?: string;
  errors: Array<{ pageId: string; title: string; error: string }>;
  targets: Array<{ pageId: string; title: string; locale: string; currentStatus: string | null }>;
}

/**
 * Resolves the manifest file path based on provided options.
 * Throws MarkPublishedError if an explicit manifestVersion is requested but cannot be found.
 */
export function resolveManifestPath(options: {
  manifestPath?: string;
  manifestVersion?: string;
  outDir?: string;
}): string {
  if (options.manifestPath) {
    return resolve(options.manifestPath);
  }

  const baseDir = options.outDir ? resolve(options.outDir) : resolve("./output");

  if (options.manifestVersion) {
    const candidatePaths = [
      join(baseDir, "manifests", "versions", `${options.manifestVersion}.json`),
      join(baseDir, `manifest-${options.manifestVersion}.json`),
      join(baseDir, `${options.manifestVersion}.json`),
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        return p;
      }
    }
    throw new MarkPublishedError(
      `Manifest version "${options.manifestVersion}" not found. Checked candidate paths: ${candidatePaths.join(", ")}`,
    );
  }

  return join(baseDir, "manifest.json");
}

/**
 * Core status write-back logic, decoupled from CLI environment for unit testability.
 */
export async function markPublished(
  options: MarkPublishedOptions,
  deps?: { client?: StatusUpdateClient },
): Promise<MarkPublishedResult> {
  const outDir = options.outDir ? resolve(options.outDir) : resolve("./output");
  const manifestPath = resolveManifestPath({
    manifestPath: options.manifestPath,
    manifestVersion: options.manifestVersion,
    outDir,
  });

  if (!existsSync(manifestPath)) {
    throw new MarkPublishedError(`Manifest file not found at: ${manifestPath}`);
  }

  let manifest: ContentManifest;
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    const validated = ContentManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(validated.error.message);
    }
    manifest = validated.data;
  } catch (err) {
    throw new MarkPublishedError(
      `Failed to validate manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fromStatus = (options.fromStatus ?? "Draft published").trim();
  const toStatus = (options.toStatus ?? "Published").trim();
  const isDryRun = options.dryRun ?? (!options.live);
  const shouldSetDate = options.setPublishedDate ?? (toStatus.toLowerCase() === "published");

  // Filter candidate docs matching fromStatus and optional locale
  const candidateDocs = manifest.docs.filter((doc) => {
    const current = (doc.drafting_status ?? "").trim();
    if (current.toLowerCase() !== fromStatus.toLowerCase()) {
      return false;
    }
    if (options.locale && doc.locale.toLowerCase() !== options.locale.toLowerCase()) {
      return false;
    }
    return true;
  });

  const targetDocs = options.limit && options.limit > 0
    ? candidateDocs.slice(0, options.limit)
    : candidateDocs;

  const targetsSummary = targetDocs.map((doc) => ({
    pageId: doc.page_id,
    title: doc.title,
    locale: doc.locale,
    currentStatus: doc.drafting_status ?? null,
  }));

  // In dry-run mode, return target plan without executing writes
  if (isDryRun) {
    return {
      totalManifestDocs: manifest.docs.length,
      targetedDocs: targetDocs.length,
      updatedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      dryRun: true,
      errors: [],
      targets: targetsSummary,
    };
  }

  // Live execution mode: initialize client
  let client = deps?.client;
  if (!client) {
    const token = options.token || process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
    if (!token) {
      throw new MarkPublishedError(
        "Notion API token is required for live write-back. Set NOTION_TOKEN or pass --token.",
      );
    }
    const databaseId = options.databaseId || process.env.NOTION_DATABASE_ID;
    const dataSourceId = options.dataSourceId || process.env.NOTION_DATA_SOURCE_ID;
    client = new NotionClient({ token, databaseId, dataSourceId });
  }

  let rollbackPath: string | undefined;
  const rollbackEntries: RollbackEntry[] = [];
  const errors: Array<{ pageId: string; title: string; error: string }> = [];
  let updatedCount = 0;
  let skippedCount = 0;

  // Persist rollback record incrementally so entries are not lost if process is interrupted
  const flushRollback = () => {
    if (rollbackEntries.length === 0) return;
    if (!rollbackPath) {
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }
      const timestamp = Date.now();
      rollbackPath = join(outDir, `rollback-published-${timestamp}.json`);
    }
    writeFileSync(
      rollbackPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          operation: `${fromStatus}-to-${toStatus}`,
          from_status: fromStatus,
          to_status: toStatus,
          total_updated: rollbackEntries.length,
          entries: rollbackEntries,
        },
        null,
        2,
      ),
      "utf-8",
    );
  };

  for (const doc of targetDocs) {
    try {
      // Stale status check: verify live Notion status hasn't changed since manifest was generated
      if (!options.force && typeof client.getPage === "function") {
        try {
          const livePage = await client.getPage(doc.page_id);
          const liveProps = livePage.properties ?? {};
          const statusProp = liveProps[NOTION_PROPERTIES.PUBLISH_STATUS] as
            | { select?: { name?: string } }
            | undefined;
          const liveStatus = statusProp?.select?.name ?? null;

          if (liveStatus && liveStatus.toLowerCase() !== fromStatus.toLowerCase()) {
            skippedCount++;
            console.warn(
              `[sync:mark-published] Skipping page ${doc.page_id} ("${doc.title}"): live status is "${liveStatus}", expected "${fromStatus}".`,
            );
            continue;
          }
        } catch (fetchErr) {
          const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          console.warn(
            `[sync:mark-published] Warning: Failed to verify live status for page ${doc.page_id} ("${doc.title}"): ${fetchMsg}. Proceeding with update.`,
          );
        }
      }

      await client.updatePageStatus(doc.page_id, toStatus, {
        setPublishedDate: shouldSetDate,
        publishedDate: options.publishedDate,
      });
      updatedCount++;
      rollbackEntries.push({
        page_id: doc.page_id,
        title: doc.title,
        locale: doc.locale,
        original_status: fromStatus,
        new_status: toStatus,
        updated_at: new Date().toISOString(),
      });
      flushRollback();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        pageId: doc.page_id,
        title: doc.title,
        error: msg,
      });
      console.warn(
        `[sync:mark-published] Warning: Failed to update page ${doc.page_id} ("${doc.title}"): ${msg}`,
      );
    }
  }

  return {
    totalManifestDocs: manifest.docs.length,
    targetedDocs: targetDocs.length,
    updatedCount,
    failedCount: errors.length,
    skippedCount,
    dryRun: false,
    rollbackPath,
    errors,
    targets: targetsSummary,
  };
}

/**
 * CLI command runner for `sync:mark-published`.
 */
export async function cmdMarkPublished(
  args: Record<string, string>,
  deps?: { client?: StatusUpdateClient },
): Promise<void> {
  const isLive = args.live === "true" || args["dry-run"] === "false";
  const isDryRun = args["dry-run"] === "true" || !isLive;

  let limit: number | undefined;
  if (args.limit) {
    const parsed = parseInt(args.limit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      limit = parsed;
    }
  }

  let setPublishedDate: boolean | undefined;
  if (args["set-published-date"] !== undefined) {
    setPublishedDate = args["set-published-date"] !== "false";
  }

  const options: MarkPublishedOptions = {
    manifestPath: args["manifest-path"] || args.input,
    manifestVersion: args["manifest-version"],
    fromStatus: args.from,
    toStatus: args.to,
    setPublishedDate,
    publishedDate: args["published-date"],
    live: isLive,
    dryRun: isDryRun,
    force: args.force === "true",
    outDir: args.out,
    limit,
    locale: args.locale,
    token: args.token,
    databaseId: args["database-id"],
    dataSourceId: args["data-source-id"],
  };

  const fromStatus = options.fromStatus ?? "Draft published";
  const toStatus = options.toStatus ?? "Published";

  console.log(`[sync:mark-published] Resolving pages from "${fromStatus}" -> "${toStatus}"...`);

  try {
    const result = await markPublished(options, deps);

    if (result.dryRun) {
      console.log(`[sync:mark-published] [DRY RUN] Found ${result.targetedDocs} page(s) with status "${fromStatus}".`);
      for (const target of result.targets) {
        console.log(`  - [${target.locale}] ${target.title} (${target.pageId})`);
      }
      console.log(
        `[sync:mark-published] [DRY RUN] 0 modifications made. Run with --live to update Notion status to "${toStatus}".`,
      );
      return;
    }

    console.log(
      `[sync:mark-published] Completed: ${result.updatedCount} page(s) updated to "${toStatus}". (${result.failedCount} failed, ${result.skippedCount} skipped).`,
    );

    if (result.rollbackPath) {
      console.log(`[sync:mark-published] Rollback log recorded at: ${result.rollbackPath}`);
    }

    if (result.errors.length > 0) {
      console.warn(`[sync:mark-published] ${result.errors.length} non-blocking error(s) occurred:`);
      for (const err of result.errors) {
        console.warn(`  - Page ${err.pageId} (${err.title}): ${err.error}`);
      }
    }
  } catch (err) {
    if (err instanceof MarkPublishedError) {
      console.error(`[sync:mark-published] Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
