#!/usr/bin/env bun
/**
 * CLI entry point for the content pipeline.
 *
 * Commands:
 *   pnpm pipeline sync:page <page_id>
 *   pnpm pipeline sync:full
 *   pnpm pipeline manifest:generate
 *   pnpm pipeline docs:pull --out ./docs
 *   pnpm pipeline rag:chunks
 *   pnpm pipeline validate
 *   pnpm pipeline diff --page <page_id>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { NotionClient } from "../lib/notion-client.js";
import { buildQueryFilter } from "../lib/notion-filters.js";
import { isPublishableStatus } from "../lib/status.js";
import { isStructuralPage } from "../lib/notion-properties.js";
import { syncPage } from "../lib/sync.js";
import { generateManifest, manifestElementType } from "../lib/manifest.js";
import { parseDoc } from "../lib/frontmatter.js";
import { generateChunks, generateChunksManifest } from "../rag/chunker.js";
import { ErrorRecorder } from "../lib/errors.js";
import { docsPull, DocsPullError, toSectionDir } from "./docs-pull.js";
import {
  validateCmd,
  diffCmd,
  ValidationError,
  type DiffPageFetcher,
} from "./validate-diff.js";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

async function main() {
  if (!command) {
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "sync:page":
      await cmdSyncPage(args);
      break;
    case "sync:full":
      await cmdSyncFull(args);
      break;
    case "manifest:generate":
      await cmdManifestGenerate(args);
      break;
    case "docs:pull":
      await cmdDocsPull(args);
      break;
    case "validate":
      await cmdValidate(args);
      break;
    case "diff":
      await cmdDiff(args);
      break;
    case "rag:chunks":
      await cmdRagChunks(args);
      break;
    case "db:migrate":
      await cmdDbMigrate(args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// ── Command implementations ──

async function cmdSyncPage(args: Record<string, string>) {
  const positional = JSON.parse(args._ || "[]") as string[];
  const pageId = positional[0] || args.page;
  if (!pageId) {
    console.error("Usage: pnpm pipeline sync:page <page_id>");
    process.exit(1);
  }

  const client = createClient();
  const outDir = args.out || process.cwd();

  console.log(`Syncing page: ${pageId}...`);
  const errorRecorder = new ErrorRecorder();
  const result = await syncPage({
    pageId,
    client,
    usedSlugs: new Set(),
  });

  // Skip logic: check existing metadata for matching content_hash (unless --force)
  const metadataPath = join(outDir, `${pageId}.metadata.json`);
  if (args.force !== "true" && existsSync(metadataPath)) {
    try {
      const existingMeta = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (existingMeta.content_hash === result.metadata.content_hash) {
        console.log(`Content unchanged, skipped: ${pageId}`);
        return;
      }
    } catch {
      // Corrupt or unreadable metadata — proceed with write
    }
  }

  // Write artifacts
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${pageId}.md`), result.canoncialMd);
  writeFileSync(
    join(outDir, `${pageId}.metadata.json`),
    JSON.stringify(result.metadata, null, 2),
  );

  // Write rehosted asset binaries
  for (const asset of result.assetBinaries) {
    try {
      const assetPath = join(outDir, asset.r2Key);
      mkdirSync(join(assetPath, ".."), { recursive: true });
      writeFileSync(assetPath, asset.data);
    } catch (err) {
      errorRecorder.record(err, `write-asset:${asset.r2Key}`);
      console.warn(`Failed to write asset: ${asset.r2Key}`, err);
    }
  }

  console.log(`  Title: ${result.metadata.title}`);
  console.log(`  Slug: ${result.metadata.slug}`);
  console.log(`  Hash: ${result.hash}`);
  console.log(`  Output: ${join(outDir, `${pageId}.md`)}`);

  if (result.failedAssets.length > 0) {
    console.warn(`  ⚠ ${result.failedAssets.length} asset download(s) failed`);
  }

  // Print error summary
  const errSummary = errorRecorder.summary();
  if (errSummary.total > 0) {
    console.warn(`\n  ⚠ Error summary: ${errSummary.total} total`);
    for (const [cat, count] of Object.entries(errSummary.byCategory)) {
      console.warn(`    ${cat}: ${count}`);
    }
    if (errSummary.topMessages.length > 0) {
      console.warn("  Top errors:");
      for (const msg of errSummary.topMessages) {
        console.warn(`    - ${msg}`);
      }
    }
  }
}

async function cmdSyncFull(args: Record<string, string>) {
  const client = createClient();
  const outDir = args.out || join(process.cwd(), "output");
  const limit = args.limit ? parseInt(args.limit, 10) : Infinity;

  console.log("Starting full sync...");
  console.log(`  Output: ${outDir}`);

  mkdirSync(outDir, { recursive: true });
  const usedSlugs = new Set<string>();
  const allMetadata = [];
  const allFailedAssets: Array<{ pageId: string; url: string; timestamp: string }> = [];
  let count = 0;
  let maxLastEditedTime = "";
  const errorRecorder = new ErrorRecorder();

  // Pagination anomaly detection
  const seenPageIds = new Set<string>();
  const seenCursors = new Set<string>();

  // Paginate through all pages
  let cursor: string | undefined;
  do {
    if (count >= limit) break;

    const resp = await client.queryDatabase({
      filter: args.filter
        ? JSON.parse(args.filter)
        : buildQueryFilter({ includeAll: args.all === "true" }),
    });

    for (const page of resp.results) {
      if (count >= limit) break;

      // Duplicate page ID detection
      if (seenPageIds.has(page.id)) {
        console.warn(`  ⚠ Duplicate page ID in pagination: ${page.id} (possible cursor issue)`);
        continue;
      }
      seenPageIds.add(page.id);

      console.log(`  [${++count}] ${page.id}...`);

      try {
        const result = await syncPage({
          pageId: page.id,
          client,
          usedSlugs,
        });

        // Write artifacts
        writeFileSync(
          join(outDir, `${page.id}.md`),
          result.canoncialMd,
        );
        allMetadata.push(result.metadata);

        // Write rehosted asset binaries
        for (const asset of result.assetBinaries) {
          try {
            const assetPath = join(outDir, asset.r2Key);
            mkdirSync(join(assetPath, ".."), { recursive: true });
            writeFileSync(assetPath, asset.data);
          } catch (err) {
            errorRecorder.record(err, `write-asset:${asset.r2Key}`);
            console.warn(`Failed to write asset: ${asset.r2Key}`, err);
          }
        }

        // Track latest edited time for watermark
        if (result.metadata.notion_last_edited_time > maxLastEditedTime) {
          maxLastEditedTime = result.metadata.notion_last_edited_time;
        }

        if (result.failedAssets.length > 0) {
          for (const url of result.failedAssets) {
            allFailedAssets.push({
              pageId: result.metadata.page_id,
              url,
              timestamp: new Date().toISOString(),
            });
          }
          console.warn(`    ⚠ ${result.failedAssets.length} asset download(s) failed`);
        }
      } catch (err) {
        errorRecorder.record(err, `sync:${page.id}`);
        console.error(`  Failed to sync page ${page.id}:`, err);
      }
    }

    const nextCursor = resp.next_cursor || undefined;
    if (nextCursor) {
      if (seenCursors.has(nextCursor)) {
        console.error(`  ⚠ Stale cursor detected: ${nextCursor}. Breaking pagination to prevent infinite loop.`);
        break;
      }
      seenCursors.add(nextCursor);
    }
    cursor = nextCursor;
  } while (cursor);

  // ── Persist image failure log ──
  if (allFailedAssets.length > 0) {
    const failuresPath = join(outDir, "image-failures.json");
    let existing: typeof allFailedAssets = [];
    if (existsSync(failuresPath)) {
      try {
        existing = JSON.parse(readFileSync(failuresPath, "utf8"));
      } catch { /* ignore parse errors */ }
    }
    const merged = [...existing, ...allFailedAssets];
    writeFileSync(failuresPath, JSON.stringify(merged, null, 2));
    console.warn(`  ⚠ ${allFailedAssets.length} asset download(s) failed (total in log: ${merged.length})`);
  }

  // ── Sidebar position fallback ──
  // Pages without explicit Order get sequential positions after max in their section.
  assignFallbackPositions(allMetadata, outDir);

  // Re-write .md files with updated frontmatter (sidebar_position may have changed),
  // and write per-page .metadata.json blobs that reflect the final sidebar_position
  // assigned by assignFallbackPositions above. These blobs are what manifest:generate
  // reads — writing them here makes that command actually usable after a CLI sync.
  for (const meta of allMetadata) {
    const fm = await buildUpdatedFrontmatter(meta, outDir);
    if (fm) {
      writeFileSync(join(outDir, `${meta.page_id}.md`), fm);
    }
    writeFileSync(
      join(outDir, `${meta.page_id}.metadata.json`),
      JSON.stringify(meta, null, 2),
    );
  }

  // Write sync state watermark (only if pages were synced)
  if (allMetadata.length > 0 && maxLastEditedTime) {
    const syncState = {
      last_sync_watermark: maxLastEditedTime,
      updated_at: new Date().toISOString(),
    };
    writeFileSync(
      join(outDir, "sync_state.json"),
      JSON.stringify(syncState, null, 2),
    );
  }

  // Write manifest
  const dbId = process.env.NOTION_DATABASE_ID || "";
  const dsId = process.env.NOTION_DATA_SOURCE_ID || "";
  const manifest = generateManifest({
    databaseId: dbId,
    dataSourceId: dsId,
    pages: allMetadata,
  });

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  console.log(`\nDone. ${allMetadata.length} pages synced.`);
  if (maxLastEditedTime) {
    console.log(`Watermark: ${maxLastEditedTime}`);
  }

  // Print error summary
  const errSummary = errorRecorder.summary();
  if (errSummary.total > 0) {
    console.warn(`\n  ⚠ Error summary: ${errSummary.total} total`);
    for (const [cat, count] of Object.entries(errSummary.byCategory)) {
      console.warn(`    ${cat}: ${count}`);
    }
    if (errSummary.topMessages.length > 0) {
      console.warn("  Top errors:");
      for (const msg of errSummary.topMessages) {
        console.warn(`    - ${msg}`);
      }
    }
  }
}

async function cmdManifestGenerate(args: Record<string, string>) {
  const input = args.input || join(process.cwd(), "output");
  const outFile = args.out || join(input, "manifest.json");

  // Read all metadata files in input dir
  const fs = await import("node:fs");

  if (!fs.existsSync(input)) {
    console.error(`Error: Input directory not found: ${input}`);
    console.error(
      "Run sync:full first to populate the directory with <page_id>.metadata.json files."
    );
    process.exit(1);
  }

  const files = fs.readdirSync(input).filter((f: string) => f.endsWith(".metadata.json"));

  // Guard: no metadata blobs — do NOT write (and never clobber) the manifest.
  //
  // sync:full writes manifest.json directly from in-memory metadata AND (with the
  // current fix) also emits per-page <page_id>.metadata.json blobs alongside each
  // <page_id>.md.  manifest:generate is only useful when you want to regenerate the
  // manifest from those on-disk blobs without re-running a full Notion sync.
  //
  // If you just ran sync:full, the manifest it wrote is already correct — there is
  // no need to run manifest:generate.  If you specifically need manifest:generate,
  // run sync:full first so the blobs exist, then run this command.
  if (files.length === 0) {
    console.error(`Error: No .metadata.json files found in: ${input}`);
    console.error(
      "\nmanifest:generate requires per-page <page_id>.metadata.json blobs.\n" +
      "These are written by sync:full alongside each <page_id>.md file.\n" +
      "\nIf you already ran sync:full, its manifest.json is already up to date —\n" +
      "you do not need manifest:generate.  To use manifest:generate, run\n" +
      "sync:full first so it emits the .metadata.json files, then run this command."
    );
    process.exit(1);
  }

  const pages = files.map((f: string) =>
    JSON.parse(fs.readFileSync(join(input, f), "utf8")),
  );

  const dbId = process.env.NOTION_DATABASE_ID || "";
  const dsId = process.env.NOTION_DATA_SOURCE_ID || "";
  const manifest = generateManifest({
    databaseId: dbId,
    dataSourceId: dsId,
    pages,
  });

  // Belt-and-suspenders: refuse to overwrite a non-empty manifest with a 0-doc result.
  // This guards against data races, stale input dirs, or generateManifest edge cases.
  if (manifest.docs.length === 0 && fs.existsSync(outFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outFile, "utf8"));
      if (Array.isArray(existing.docs) && existing.docs.length > 0) {
        console.error(
          `Error: Would clobber existing manifest (${existing.docs.length} docs) with an empty 0-doc result.\n` +
          `Refusing to write ${outFile} to prevent data loss.\n` +
          "Investigate why generateManifest produced 0 docs from non-empty .metadata.json files,\n" +
          "or run sync:full to regenerate the manifest from fresh Notion data."
        );
        process.exit(1);
      }
    } catch { /* unparseable existing file — allow overwrite */ }
  }

  writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to: ${outFile}`);
  console.log(`  ${pages.length} pages`);
}

async function cmdDocsPull(args: Record<string, string>) {
  try {
    await docsPull(args);
  } catch (e) {
    if (e instanceof DocsPullError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdValidate(args: Record<string, string>) {
  try {
    await validateCmd(args);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdRagChunks(args: Record<string, string>) {
  const input = args.input || join(process.cwd(), "output/manifest.json");
  const outDir = args.out || join(process.cwd(), "output");

  // Resolve manifest path — accept file or directory containing manifest.json
  let manifestPath = input;
  if (!manifestPath.endsWith(".json") && existsSync(join(manifestPath, "manifest.json"))) {
    manifestPath = join(manifestPath, "manifest.json");
  }

  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    console.error("Run sync:full or manifest:generate first, or specify --input");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const inputDir = args["input-dir"] || join(manifestPath, "..");

  // Mirror docs:pull selection: by default only "active" docs, but `--all`
  // includes every status (Notion content is currently all "draft", so the
  // RAG index needs --all to chunk anything). Structural pages (Toggle/Title)
  // are never chunked — they carry section labels, not content.
  const includeAll = args.all === "true";
  const activeDocs = (manifest.docs || []).filter(
    (doc: { status: string; element_type?: unknown }) => {
      if (!isPublishableStatus(doc.status, includeAll)) return false;
      const et = manifestElementType(doc);
      if (isStructuralPage(et)) return false;
      return true;
    },
  );

  if (activeDocs.length === 0) {
    console.log(
      includeAll
        ? "No chunkable docs in manifest."
        : "No active docs in manifest. Nothing to chunk (try --all to include drafts).",
    );
    return;
  }

  const chunksDir = join(outDir, "rag", "chunks");
  mkdirSync(chunksDir, { recursive: true });

  const allChunks = [];
  let pagesProcessed = 0;

  for (const doc of activeDocs) {
    // Try page_id.md then slug.md as source file
    const srcFile = [join(inputDir, `${doc.page_id}.md`), join(inputDir, `${doc.slug}.md`)].find(
      (p) => existsSync(p),
    );

    if (!srcFile) {
      console.warn(`  Skipping ${doc.page_id}: no source .md file found`);
      continue;
    }

    const raw = readFileSync(srcFile, "utf8");
    const { frontmatter: fmData, body } = parseDoc(raw);

    const chunks = await generateChunks({
      pageId: doc.page_id,
      title: fmData.title || doc.title,
      locale: fmData.locale || doc.locale,
      slug: fmData.slug || doc.slug,
      sourceUrl: doc.source_url,
      docusaurusPath: doc.docusaurus_path,
      contentHash: fmData.content_hash || doc.content_hash,
      markdownBody: body,
    });

    for (const chunk of chunks) {
      writeFileSync(join(chunksDir, `${chunk.chunk_id}.json`), JSON.stringify(chunk, null, 2));
    }

    allChunks.push(...chunks);
    pagesProcessed++;
  }

  // Write chunks manifest
  const chunksManifest = generateChunksManifest(allChunks);
  writeFileSync(join(outDir, "rag", "chunks-manifest.json"), JSON.stringify(chunksManifest, null, 2));

  console.log(`RAG chunks generated:`);
  console.log(`  Pages processed: ${pagesProcessed}/${activeDocs.length}`);
  console.log(`  Total chunks:    ${allChunks.length}`);
  console.log(`  Output:          ${chunksDir}`);
}

async function cmdDiff(args: Record<string, string>) {
  // Wire the injected fetch to the real Notion client + syncPage.
  const fetchPage: DiffPageFetcher = (pageId) =>
    syncPage({ pageId, client: createClient(), usedSlugs: new Set() });
  try {
    await diffCmd(args, fetchPage);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function cmdDbMigrate(args: Record<string, string>) {
  const remote = args.remote === "true";
  const migrationFile = join(process.cwd(), "migrations/0001_initial.sql");

  if (!existsSync(migrationFile)) {
    console.error(`Migration file not found: ${migrationFile}`);
    process.exit(1);
  }

  const mode = remote ? "--remote" : "--local";
  console.log(`Applying D1 migrations (${remote ? "remote" : "local"})...`);

  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "comapeo-content-pipeline",
      mode,
      "--file=migrations/0001_initial.sql",
    ],
    { stdio: ["inherit", "pipe", "pipe"] },
  );

  if (result.stdout.length > 0) {
    console.log(result.stdout.toString());
  }
  if (result.stderr.length > 0) {
    console.error(result.stderr.toString());
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// ── Helpers ──

/**
 * Assign sequential sidebar positions to pages without explicit Order.
 *
 * Groups pages by section, finds max explicit position per section,
 * then assigns sequential positions (max+1, max+2, ...) to remaining pages.
 */
function assignFallbackPositions(metadata: Array<{ section: string | null; section_order: number | null }>, outDir: string) {
  // Group by section (use "" key for null section)
  const sections = new Map<string, Array<typeof metadata[0]>>();
  for (const m of metadata) {
    const key = m.section ?? "";
    const list = sections.get(key) || [];
    list.push(m);
    sections.set(key, list);
  }

  for (const [sectionKey, pages] of sections) {
    let maxPos = 0;

    // Scan existing _category_.json on disk for this section
    const sectionDir = sectionKey ? toSectionDir(sectionKey) : null;
    if (sectionDir) {
      const catPath = join(outDir, "docs", sectionDir, "_category_.json");
      if (existsSync(catPath)) {
        try {
          const existing = JSON.parse(readFileSync(catPath, "utf8"));
          if (typeof existing.position === "number" && existing.position > maxPos) {
            maxPos = existing.position;
          }
        } catch { /* ignore */ }
      }
    }

    // Find max explicit position from metadata
    const unpositioned: typeof metadata = [];
    for (const p of pages) {
      if (p.section_order != null && p.section_order > maxPos) {
        maxPos = p.section_order;
      } else if (p.section_order == null) {
        unpositioned.push(p);
      }
    }

    // Assign sequential positions
    for (const p of unpositioned) {
      p.section_order = ++maxPos;
    }
  }
}

/**
 * Re-build a markdown file with updated frontmatter.
 * Returns null if the file doesn't exist.
 */
async function buildUpdatedFrontmatter(
  meta: { page_id: string; section_order: number | null; title: string },
  outDir: string,
): Promise<string | null> {
  const mdPath = join(outDir, `${meta.page_id}.md`);
  if (!existsSync(mdPath)) return null;

  const content = readFileSync(mdPath, "utf8");

  // Parse frontmatter manually to avoid YAML parser failures on body content
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
  if (!fmMatch) return null;

  const fmLines = fmMatch[1].split("\n");
  const body = fmMatch[2];

  // Update sidebar_position line
  let updated = false;
  const newLines = fmLines.map((line) => {
    if (/^sidebar_position:/.test(line)) {
      updated = true;
      return `sidebar_position: ${meta.section_order}`;
    }
    return line;
  });

  // If sidebar_position wasn't in frontmatter, add it before closing ---
  const newFm = updated
    ? newLines.join("\n")
    : [...fmLines, `sidebar_position: ${meta.section_order}`].join("\n");

  return `---\n${newFm}\n---\n${body}`;
}

function createClient(): NotionClient {
  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY || "";
  if (!token) {
    console.error("NOTION_TOKEN or NOTION_API_KEY is required");
    process.exit(1);
  }

  return new NotionClient({
    token,
    databaseId: process.env.NOTION_DATABASE_ID,
    dataSourceId: process.env.NOTION_DATA_SOURCE_ID,
    version: process.env.NOTION_VERSION,
    maxRps: parseInt(process.env.MAX_NOTION_RPS || "3", 10),
  });
}

function parseArgs(raw: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith("--")) {
      const key = raw[i].slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    } else {
      positional.push(raw[i]);
    }
  }
  result._ = JSON.stringify(positional);
  return result;
}

function printUsage() {
  console.log(`
Usage: pnpm pipeline <command> [options]

Commands:
  sync:page <page_id>     Sync a single Notion page
  sync:full               Full import of all pages
  manifest:generate       Generate manifest from synced pages
  docs:pull               Pull docs for Docusaurus build
  rag:chunks              Generate RAG chunks
  validate                Validate manifest
  diff --page <page_id>   Show diff for a page
  db:migrate               Apply D1 migrations (--remote for production)

Options:
  --out <dir>             Output directory
  --input <file>          Input manifest or metadata file
  --limit <n>             Max pages for sync:full
  --all                   sync:full: fetch dead rows too; docs:pull/rag:chunks:
                          include drafts (never deprecated/archived)
  --clean-orphans         Remove .md files not in manifest (docs:pull)
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
