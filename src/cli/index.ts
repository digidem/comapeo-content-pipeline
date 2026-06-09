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
import matter from "gray-matter";
import { NotionClient } from "../lib/notion-client.js";
import { syncPage } from "../lib/sync.js";
import { generateManifest } from "../lib/manifest.js";
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
      } catch (err) {
        console.error(`  Failed to sync page ${page.id}:`, err);
      }
    }

    cursor = resp.next_cursor || undefined;
  } while (cursor);

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
  for (const doc of manifest.docs) {
    if (doc.status !== "active") continue;

    const srcFile = join(inputDir, `${doc.page_id}.md`);
    if (!existsSync(srcFile)) {
      console.warn(`  Missing source file: ${srcFile}`);
      continue;
    }

    const content = readFileSync(srcFile, "utf8");

    // Build Docusaurus-compatible output path
    const section = doc.section ? `${doc.section}/` : "";
    const outPath = join(outDir, doc.locale, "docs", section, `${doc.slug}.md`);

    // For non-en locales, write to i18n structure
    let finalPath: string;
    if (doc.locale === "en") {
      finalPath = join(outDir, section, `${doc.slug}.md`);
    } else {
      finalPath = join(
        outDir,
        "..",
        "i18n",
        doc.locale,
        "docusaurus-plugin-content-docs",
        "current",
        section,
        `${doc.slug}.md`,
      );
    }

    mkdirSync(join(finalPath, ".."), { recursive: true });
    writeFileSync(finalPath, content);
    count++;
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
    const { data: fmData, content: body } = matter(raw);

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
  console.log("Diff command — not yet implemented");
  console.log("Args:", args);
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
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
