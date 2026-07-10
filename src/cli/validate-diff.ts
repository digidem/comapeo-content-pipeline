/**
 * validate / diff implementation — manifest validation + per-page metadata diff.
 *
 * Extracted verbatim from src/cli/index.ts so it can be unit-tested in isolation.
 * The thin cmdValidate / cmdDiff wrappers in index.ts catch ValidationError and
 * exit(1).
 *
 * diff requires a live Notion fetch; the fetch is injected (DiffPageFetcher) so
 * tests can drive the comparison logic with no network.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Fatal-but-recoverable error from validate / diff (missing manifest, bad input, …). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Fetches the live page metadata. Injected so diff is testable without Notion. */
export type DiffPageFetcher = (pageId: string) => Promise<{
  metadata: Record<string, unknown>;
}>;

/** A single field that changed between stored and current metadata. */
export interface MetadataChange {
  label: string;
  old: string;
  cur: string;
}

/** Fields diff compares between stored and live metadata, in display order. */
const DIFF_FIELDS = [
  { label: "title", key: "title" },
  { label: "content_hash", key: "content_hash" },
  { label: "status", key: "status" },
  { label: "last_edited", key: "notion_last_edited_time" },
] as const;

/**
 * Field-level diff between stored and current page metadata. Pure + hermetic —
 * the same loop diffCmd inlined before extraction. Returns the changed fields
 * (missing values coerce to "" as the original String(x ?? "") did).
 */
export function diffMetadata(
  stored: Record<string, unknown>,
  current: Record<string, unknown>,
): MetadataChange[] {
  const changes: MetadataChange[] = [];
  for (const { label, key } of DIFF_FIELDS) {
    const oldVal = String(stored[key] ?? "");
    const curVal = String(current[key] ?? "");
    if (oldVal !== curVal) {
      changes.push({ label, old: oldVal, cur: curVal });
    }
  }
  return changes;
}

/**
 * validate command: ad-hoc checks the manifest passes its consumers.
 * Throws ValidationError (caught + exit(1) by the index.ts wrapper) on failure.
 */
export async function validateCmd(args: Record<string, string>): Promise<void> {
  const input = args.input || join(process.cwd(), "output/manifest.json");

  if (!existsSync(input)) {
    throw new ValidationError(`Manifest not found: ${input}`);
  }

  const manifest = JSON.parse(readFileSync(input, "utf8"));
  const errors: string[] = [];

  // Check schema version
  if (manifest.schema_version !== "1.0") {
    errors.push(`Unsupported schema version: ${manifest.schema_version}`);
  }

  // Check docs
  const slugs = new Set<string>();
  for (const doc of manifest.docs) {
    if (slugs.has(doc.slug)) {
      errors.push(`Duplicate slug: ${doc.slug}`);
    }
    slugs.add(doc.slug);

    if (!doc.page_id) errors.push(`Missing page_id for: ${doc.title}`);
    if (!doc.content_hash) errors.push(`Missing content_hash for: ${doc.title}`);
  }

  if (errors.length === 0) {
    console.log(`✓ Valid manifest with ${manifest.docs.length} docs`);
  } else {
    throw new ValidationError(
      `${errors.length} validation errors:\n${errors.map((err) => `  ✗ ${err}`).join("\n")}`,
    );
  }
}

/**
 * diff command: fetch the live page and compare its metadata against the stored
 * `<page_id>.metadata.json`. Reports changed fields (title / content_hash /
 * status / last_edited) or "No changes detected". Throws ValidationError on
 * usage, fetch, or parse failures (caught + exit(1) by the index.ts wrapper).
 *
 * `fetchPage` is injected so tests avoid the network; the index.ts wrapper wires
 * it to createClient() + syncPage().
 */
export async function diffCmd(
  args: Record<string, string>,
  fetchPage: DiffPageFetcher,
): Promise<void> {
  const positional = JSON.parse(args._ || "[]") as string[];
  const pageId = positional[0] || args.page;
  if (!pageId) {
    throw new ValidationError("Usage: pnpm pipeline diff --page <page_id>");
  }

  const outDir = args.out || process.cwd();
  const metadataPath = args.metadata || join(outDir, `${pageId}.metadata.json`);

  console.log(`Fetching page from Notion: ${pageId}...`);
  let current: Record<string, unknown>;
  try {
    const result = await fetchPage(pageId);
    current = result.metadata;
  } catch (err) {
    throw new ValidationError(`Failed to fetch page: ${err}`);
  }

  // No stored metadata — show current info only
  if (!existsSync(metadataPath)) {
    console.log(`\nPage: ${pageId}`);
    console.log(`Title: ${current.title}`);
    console.log(`Status: ${current.status}`);
    console.log(`Hash: ${current.content_hash}`);
    console.log(`Last edited: ${current.notion_last_edited_time}`);
    console.log(`\nNo stored metadata found at: ${metadataPath}`);
    return;
  }

  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    throw new ValidationError(`Failed to parse stored metadata: ${metadataPath}`);
  }

  // Compare fields
  const changes = diffMetadata(stored, current);

  console.log(`\nPage: ${pageId}`);
  console.log(`Title: ${current.title}`);

  if (changes.length === 0) {
    console.log("\nNo changes detected");
  } else {
    console.log("\nChanges:");
    for (const c of changes) {
      console.log(`  ${c.label}: "${c.old}" → "${c.cur}"`);
    }
  }
}
