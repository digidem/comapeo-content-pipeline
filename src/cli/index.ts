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
import { syncPage } from "../lib/sync.js";
import { generateManifest } from "../lib/manifest.js";
import { parseDoc } from "../lib/frontmatter.js";
import { generateChunks, generateChunksManifest } from "../rag/chunker.js";

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
      console.warn(`Failed to write asset: ${asset.r2Key}`, err);
    }
  }

  console.log(`  Title: ${result.metadata.title}`);
  console.log(`  Slug: ${result.metadata.slug}`);
  console.log(`  Hash: ${result.hash}`);
  console.log(`  Output: ${join(outDir, `${pageId}.md`)}`);
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
  let count = 0;
  let maxLastEditedTime = "";

  // Paginate through all pages
  let cursor: string | undefined;
  // eslint-disable-next-line no-constant-condition
  do {
    if (count >= limit) break;

    const resp = await client.queryDataSource({
      filter: args.filter ? JSON.parse(args.filter) : undefined,
      startCursor: cursor,
    });

    for (const page of resp.results) {
      if (count >= limit) break;
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
            console.warn(`Failed to write asset: ${asset.r2Key}`, err);
          }
        }

        // Track latest edited time for watermark
        if (result.metadata.notion_last_edited_time > maxLastEditedTime) {
          maxLastEditedTime = result.metadata.notion_last_edited_time;
        }
      } catch (err) {
        console.error(`  Failed to sync page ${page.id}:`, err);
      }
    }

    cursor = resp.next_cursor || undefined;
  } while (cursor);

  // ── Sidebar position fallback ──
  // Pages without explicit Order get sequential positions after max in their section.
  assignFallbackPositions(allMetadata);

  // Re-write .md files with updated frontmatter (sidebar_position may have changed)
  for (const meta of allMetadata) {
    const fm = await buildUpdatedFrontmatter(meta, outDir);
    if (fm) {
      writeFileSync(join(outDir, `${meta.page_id}.md`), fm);
    }
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
}

async function cmdManifestGenerate(args: Record<string, string>) {
  const input = args.input || join(process.cwd(), "output");
  const outFile = args.out || join(input, "manifest.json");

  // Read all metadata files in input dir
  const fs = await import("node:fs");
  const files = fs.readdirSync(input).filter((f) => f.endsWith(".metadata.json"));
  const pages = files.map((f) =>
    JSON.parse(fs.readFileSync(join(input, f), "utf8")),
  );

  const dbId = process.env.NOTION_DATABASE_ID || "";
  const dsId = process.env.NOTION_DATA_SOURCE_ID || "";
  const manifest = generateManifest({
    databaseId: dbId,
    dataSourceId: dsId,
    pages,
  });

  writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to: ${outFile}`);
  console.log(`  ${pages.length} pages`);
}

async function cmdDocsPull(args: Record<string, string>) {
  const input = args.input || args.manifest || join(process.cwd(), "output/manifest.json");
  const outDir = args.out || "./docs";

  if (!existsSync(input)) {
    console.error(`Manifest not found: ${input}`);
    console.error("Run sync:full first, or specify --input pointing to manifest.json");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(input, "utf8"));
  const inputDir = args["input-dir"] || join(process.cwd(), "output");

  mkdirSync(outDir, { recursive: true });

  let count = 0;
  // Track sections per locale for _category_.json generation
  const sectionPositions = new Map<string, Map<string, number>>(); // locale → section → min position
  for (const doc of manifest.docs) {
    if (args.all !== "true" && doc.status !== "active") continue;

    const srcFile = join(inputDir, `${doc.page_id}.md`);
    if (!existsSync(srcFile)) {
      console.warn(`  Missing source file: ${srcFile}`);
      continue;
    }

    const content = readFileSync(srcFile, "utf8");

    // Build Docusaurus-compatible output path
    // en:   {outDir}/docs/{section}/{slug}.md
    // non-en: {outDir}/i18n/{locale}/docusaurus-plugin-content-docs/current/{section}/{slug}.md
    const sectionRaw = doc.section || undefined;
    const sectionDir = sectionRaw ? toSectionDir(sectionRaw) : undefined;
    const finalPath =
      doc.locale === "en"
        ? join(outDir, "docs", ...(sectionDir ? [sectionDir] : []), `${doc.slug}.md`)
        : join(
            outDir,
            "i18n",
            doc.locale,
            "docusaurus-plugin-content-docs",
            "current",
            ...(sectionDir ? [sectionDir] : []),
            `${doc.slug}.md`,
          );

    mkdirSync(join(finalPath, ".."), { recursive: true });
    writeFileSync(finalPath, content);
    count++;

    // Track minimum section_order per section for _category_.json position
    if (sectionRaw && doc.section_order != null) {
      const locale = doc.locale || "en";
      if (!sectionPositions.has(locale)) {
        sectionPositions.set(locale, new Map());
      }
      const localeMap = sectionPositions.get(locale)!;
      const currentMin = localeMap.get(sectionRaw);
      if (currentMin === undefined || doc.section_order < currentMin) {
        localeMap.set(sectionRaw, doc.section_order);
      }
    }
  }

  // Write _category_.json for each section (Docusaurus sidebar labels)
  // Sort sections by numeric prefix (10, 20, ...) then alphabetically
  for (const [locale, sectionMap] of sectionPositions) {
    const sortedEntries = Array.from(sectionMap.entries()).sort((a, b) => {
      const aNum = getSectionNumberPrefix(a[0]);
      const bNum = getSectionNumberPrefix(b[0]);
      if (aNum !== bNum) return aNum - bNum;
      return a[0].localeCompare(b[0]);
    });
    let position = 1;
    for (const [sectionName] of sortedEntries) {
      const label = stripSectionPrefix(sectionName);
      const sectionDir = toSectionDir(sectionName);
      const categoryDir =
        locale === "en"
          ? join(outDir, "docs", sectionDir)
          : join(outDir, "i18n", locale, "docusaurus-plugin-content-docs", "current", sectionDir);
      const categoryPath = join(categoryDir, "_category_.json");
      if (!existsSync(categoryDir)) {
        mkdirSync(categoryDir, { recursive: true });
      }
      const categoryJson = {
        label,
        position: position++,
        collapsible: true,
        collapsed: true,
        link: { type: "generated-index" as const },
        customProps: { title: null as string | null },
      };
      writeFileSync(categoryPath, JSON.stringify(categoryJson, null, 2));
    }
  }

  console.log(`Pulled ${count} active docs to ${outDir}`);
}

async function cmdValidate(args: Record<string, string>) {
  const input = args.input || join(process.cwd(), "output/manifest.json");

  if (!existsSync(input)) {
    console.error(`Manifest not found: ${input}`);
    process.exit(1);
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
    console.error(`${errors.length} validation errors:`);
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
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
  const activeDocs = (manifest.docs || []).filter(
    (doc: { status: string }) => doc.status === "active",
  );

  if (activeDocs.length === 0) {
    console.log("No active docs in manifest. Nothing to chunk.");
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

    const chunks = generateChunks({
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
  const positional = JSON.parse(args._ || "[]") as string[];
  const pageId = positional[0] || args.page;
  if (!pageId) {
    console.error("Usage: pnpm pipeline diff --page <page_id>");
    process.exit(1);
  }

  const client = createClient();
  const outDir = args.out || process.cwd();
  const metadataPath = args.metadata || join(outDir, `${pageId}.metadata.json`);

  console.log(`Fetching page from Notion: ${pageId}...`);
  let result: Awaited<ReturnType<typeof syncPage>>;
  try {
    result = await syncPage({ pageId, client, usedSlugs: new Set() });
  } catch (err) {
    console.error(`Failed to fetch page: ${err}`);
    process.exit(1);
  }

  const current = result.metadata;

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
    console.error(`Failed to parse stored metadata: ${metadataPath}`);
    process.exit(1);
  }

  // Compare fields
  const fields: Array<{ label: string; key: string }> = [
    { label: "title", key: "title" },
    { label: "content_hash", key: "content_hash" },
    { label: "status", key: "status" },
    { label: "last_edited", key: "notion_last_edited_time" },
  ];

  const changes: Array<{ label: string; old: string; cur: string }> = [];
  for (const { label, key } of fields) {
    const oldVal = String(stored[key] ?? "");
    const curVal = String((current as Record<string, unknown>)[key] ?? "");
    if (oldVal !== curVal) {
      changes.push({ label, old: oldVal, cur: curVal });
    }
  }

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
 * Strip number prefix from section name for display labels.
 * "10-Preparing to use CoMapeo" → "Preparing to use CoMapeo"
 * "90+ - Miscellaneous" → "Miscellaneous"
 */
function stripSectionPrefix(sectionName: string): string {
  return sectionName.replace(/^\d+[+\-]\s*(?:-\s*)?/, "").trim();
}

/**
 * Convert section name to URL/filesystem-safe directory name.
 * "10-Preparing to use CoMapeo" → "preparing-to-use-comapeo"
 */
function toSectionDir(sectionName: string): string {
  return stripSectionPrefix(sectionName)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract numeric prefix for section ordering.
 * "10-Preparing" → 10, "90+ - Misc" → 90, "Overview" → Infinity
 */
function getSectionNumberPrefix(sectionName: string): number {
  const match = sectionName.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : Infinity;
}

/**
 * Assign sequential sidebar positions to pages without explicit Order.
 *
 * Groups pages by section, finds max explicit position per section,
 * then assigns sequential positions (max+1, max+2, ...) to remaining pages.
 */
function assignFallbackPositions(metadata: Array<{ section: string | null; section_order: number | null }>) {
  // Group by section (use "" key for null section)
  const sections = new Map<string, Array<typeof metadata[0]>>();
  for (const m of metadata) {
    const key = m.section ?? "";
    const list = sections.get(key) || [];
    list.push(m);
    sections.set(key, list);
  }

  for (const [, pages] of sections) {
    // Find max explicit position
    let maxPos = 0;
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
  --all                   Include all statuses (docs:pull, default: active only)
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
