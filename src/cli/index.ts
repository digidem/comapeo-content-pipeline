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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { NotionClient } from "../lib/notion-client.js";
import {
  isContentPage,
  isStructuralPage,
  normalizeLocale,
  NOTION_ELEMENT_TYPES,
  SECTION_NAMES,
  UNCATEGORIZED_ORDER,
} from "../lib/notion-properties.js";
import { syncPage } from "../lib/sync.js";
import { generateManifest } from "../lib/manifest.js";
import { parseDoc } from "../lib/frontmatter.js";
import { slugify } from "../lib/slug.js";
import { buildRouteMaps, resolveInternalLinks, type DocLite } from "../lib/links.js";
import { generateChunks, generateChunksManifest } from "../rag/chunker.js";
import { ErrorRecorder } from "../lib/errors.js";

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
  // eslint-disable-next-line no-constant-condition
  do {
    if (count >= limit) break;

    const resp = await client.queryDataSource({
      filter: args.filter ? JSON.parse(args.filter) : undefined,
      startCursor: cursor,
      excludeSubItems: true,
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

  const docById = new Map<string, (typeof manifest.docs)[number]>();
  for (const doc of manifest.docs) {
    docById.set(doc.page_id, doc);
  }

  const containerIds = new Set<string>();
  const containerHasEnChild = new Set<string>();
  for (const doc of manifest.docs) {
    if (doc.locale !== "en" || !Array.isArray(doc.sub_items) || doc.sub_items.length === 0) continue;
    containerIds.add(doc.page_id);
    if (doc.sub_items.some((subId: string) => docById.get(subId)?.locale === "en")) {
      containerHasEnChild.add(doc.page_id);
    }
  }

  // Build translation lookup from Sub-item relations: translation page_id → { slug, section, order }
  // The container parent's own slug may carry a collision suffix (e.g.
  // `inviting-collaborators-2331b081`) because the real English child reserved
  // the clean slug first. The parent is skipped from publishing, so the whole
  // group (en child + translations) should publish at the *clean* slug derived
  // from the title — that's what cross-references point at.
  const translationMap = new Map<string, { slug: string; section: string | null; order: number | null }>();
  for (const doc of manifest.docs) {
    if (doc.locale === "en" && doc.sub_items && doc.sub_items.length > 0) {
      const cleanSlug = slugify(doc.title ?? "") || doc.slug;
      for (const subId of doc.sub_items) {
        translationMap.set(subId, { slug: cleanSlug, section: doc.section, order: doc.section_order ?? null });
      }
    }
  }

  // Canonical published slug for a page: the (cleaned) English source slug for
  // grouped pages, otherwise the page's own slug.
  const canonicalSlugOf = (pageId: string): string | null => {
    const t = translationMap.get(pageId);
    if (t) return t.slug;
    const d = docById.get(pageId);
    if (!d) return null;
    // Container parent (skipped from publishing): a link to its own (possibly
    // suffixed) slug should resolve to the clean group slug its children use.
    if (Array.isArray(d.sub_items) && d.sub_items.length > 0) {
      return slugify(d.title ?? "") || d.slug;
    }
    return d.slug;
  };
  const routeMaps = buildRouteMaps(manifest.docs as DocLite[], canonicalSlugOf);

  // Build translated section labels from Toggle pages.
  // Toggle page titles provide localized sidebar labels.
  // (Section order is derived from each section's numeric name prefix, not the
  // Toggle Order property — see the category-sort block below.)
  const sectionLabels = new Map<string, Map<string, string>>(); // locale → section → label
  for (const doc of manifest.docs) {
    const et = doc.element_type?.select?.name ?? doc.element_type?.name ?? "";
    if (et.toLowerCase() !== NOTION_ELEMENT_TYPES.TOGGLE) continue;
    const sec = doc.section || "__none__";
    const loc = normalizeLocale(doc.locale);
    // Store label per locale (first Toggle wins — lowest section_order)
    if (!sectionLabels.has(loc)) sectionLabels.set(loc, new Map());
    if (!sectionLabels.get(loc)!.has(sec)) {
      sectionLabels.get(loc)!.set(sec, doc.title);
    }
  }

  let count = 0;
  let skippedNonPage = 0;
  let skippedTestPages = 0;
  let skippedStubTranslations = 0;
  // Track sections per locale for _category_.json generation
  const sectionPositions = new Map<string, Map<string, number>>(); // locale → section → min position
  // Absolute section dirs that actually received .md writes — drives per-section
  // asset copying (only assets referenced by each section's .md files).
  const writtenSectionDirs = new Set<string>();

  // Editorial QA/test pages authored in Notion. They cannot be distinguished by
  // status/element_type (all draft Pages), so match by slug (most reliable —
  // translations inherit the English slug) and by title as a secondary signal.
  const TEST_PAGE_TITLE = /^\s*[\[(]?\s*(testing|test|teste|prueba)\b/i;
  const TEST_PAGE_SLUG = /^(testing|teste)-/i;

  // Internal/template scratch pages authored in Notion that must never publish.
  const INTERNAL_PAGE_TITLE = /^\s*(new element|process checklist)\s*$/i;
  const INTERNAL_PAGE_MARKER = /\[\s*(add content here|en title|insert content here)\s*\]/i;

  // Deduplicate pages with the same slug in the same locale
  // (e.g. test pages that share a slug like "test-guia-de-instalacao" in PT)
  const dedupedDocs: typeof manifest.docs = [];
  const seenSlugs = new Map<string, (typeof manifest.docs)[number]>(); // locale/slug → doc
  for (const doc of manifest.docs) {
    if (containerIds.has(doc.page_id) && containerHasEnChild.has(doc.page_id)) {
      continue;
    }
    if (args.all !== "true" && doc.status !== "active") {
      dedupedDocs.push(doc);
      continue;
    }
    const elementType = doc.element_type?.select?.name ?? doc.element_type?.name ?? "";
    if (!isContentPage(elementType)) {
      dedupedDocs.push(doc);
      continue;
    }
    const translation = translationMap.get(doc.page_id);
    const translationSlug = translation?.slug ?? doc.slug;
    const title = doc.title ?? "";
    const isInternal =
      INTERNAL_PAGE_TITLE.test(title) ||
      INTERNAL_PAGE_MARKER.test(title) ||
      title.trim() === doc.page_id; // untitled page (title defaulted to its id)
    if (
      TEST_PAGE_TITLE.test(title) ||
      TEST_PAGE_SLUG.test(translationSlug ?? "") ||
      isInternal
    ) {
      skippedTestPages++;
      continue; // drop editorial test/internal/template page (and its translations)
    }
    const normalizedLocale = normalizeLocale(doc.locale);
    const key = `${normalizedLocale}/${translationSlug}`;
    const existing = seenSlugs.get(key);
    if (existing) {
      const existingOrder = existing.section_order ?? 999;
      const docOrder = doc.section_order ?? 999;
      if (docOrder < existingOrder) {
        console.warn(`  Replacing duplicate slug "${translationSlug}" (${normalizedLocale}): ${existing.page_id} → ${doc.page_id}`);
        // Replace existing in dedupedDocs
        const idx = dedupedDocs.indexOf(existing);
        if (idx !== -1) dedupedDocs[idx] = doc;
        seenSlugs.set(key, doc);
      } else {
        console.warn(`  Skipping duplicate slug "${translationSlug}" (${normalizedLocale}): keeping ${existing.page_id}, dropping ${doc.page_id}`);
      }
      continue;
    }
    seenSlugs.set(key, doc);
    dedupedDocs.push(doc);
  }

  for (const doc of dedupedDocs) {
    if (containerIds.has(doc.page_id) && containerHasEnChild.has(doc.page_id)) {
      continue;
    }
    if (args.all !== "true" && doc.status !== "active") continue;

    // Skip structural pages (Toggles, Titles) — only publish content Pages
    const elementType = doc.element_type?.select?.name ?? doc.element_type?.name ?? "";
    if (!isContentPage(elementType)) {
      skippedNonPage++;
      continue;
    }

    // Docusaurus i18n requires translations to share the English source's slug AND path
    const translation = translationMap.get(doc.page_id);
    const translationSlug = translation?.slug ?? doc.slug;
    const title = doc.title ?? "";
    const isInternal =
      INTERNAL_PAGE_TITLE.test(title) ||
      INTERNAL_PAGE_MARKER.test(title) ||
      title.trim() === doc.page_id; // untitled page (title defaulted to its id)
    if (
      TEST_PAGE_TITLE.test(title) ||
      TEST_PAGE_SLUG.test(translationSlug ?? "") ||
      isInternal
    ) {
      skippedTestPages++;
      continue; // drop editorial test/internal/template page (and its translations)
    }
    // Use English section for translated page so paths match
    const effectiveSection = translation?.section ?? doc.section;

    const srcFile = join(inputDir, `${doc.page_id}.md`);
    if (!existsSync(srcFile)) {
      console.warn(`  Missing source file: ${srcFile}`);
      continue;
    }

    let content = readFileSync(srcFile, "utf8");

    // If translation slug differs from original, rewrite frontmatter to match
    if (translationSlug !== doc.slug) {
      content = content
        .replace(/^id: .*$/m, `id: "${translationSlug}"`)
        .replace(/^slug: .*$/m, `slug: /${translationSlug}`);
    }
    if (translation && translation.order != null) {
      content = content.replace(/^sidebar_position: .*$/m, `sidebar_position: ${translation.order}`);
    }

    // Strip stray Notion "[Insert/ADD content here]" placeholder lines left over
    // inside otherwise-real content (the marker is never meaningful text).
    content = content.replace(/^[ \t]*\[\s*(?:insert|add)\s+content\s+here\s*\][ \t]*\r?\n?/gim, "");

    // Build Docusaurus-compatible output path
    // en:   {outDir}/docs/{section}/{slug}.md
    // non-en: {outDir}/i18n/{locale}/docusaurus-plugin-content-docs/current/{section}/{slug}.md
    // Pages without a Content Section are placed in "Uncategorized" (appears last in sidebar)
    const sectionRaw = effectiveSection || SECTION_NAMES.UNCATEGORIZED;
    const sectionDir = sectionRaw ? toSectionDir(sectionRaw) : undefined;
    // Normalize automated locales: "es - automated" → "es", "pt - automated" → "pt"
    const normalizedLocale = normalizeLocale(doc.locale);

    // Resolve internal cross-references to the locale-correct published route
    // and slugify heading anchors to Docusaurus heading-ID format.
    content = resolveInternalLinks(content, { locale: normalizedLocale, maps: routeMaps });

    const finalPath =
      normalizedLocale === "en"
        ? join(outDir, "docs", ...(sectionDir ? [sectionDir] : []), `${translationSlug}.md`)
        : join(
            outDir,
            "i18n",
            normalizedLocale,
            "docusaurus-plugin-content-docs",
            "current",
            ...(sectionDir ? [sectionDir] : []),
            `${translationSlug}.md`,
          );

    // Stub bodies (empty or only an "[Insert/ADD content here]" marker) carry no
    // real content. Skip translation stubs so Docusaurus falls back to the English
    // content under the localized route; for the default locale, render a friendly
    // placeholder so the page (and its sidebar entry) isn't blank.
    if (isStubBody(content)) {
      if (normalizedLocale !== "en") {
        skippedStubTranslations++;
        continue;
      }
      content = ensurePlaceholderForEmptyBody(content);
    }

    mkdirSync(join(finalPath, ".."), { recursive: true });
    writeFileSync(finalPath, content);
    writtenSectionDirs.add(join(finalPath, ".."));
    count++;

    // Track minimum section_order per section for _category_.json position
    // Use effective section (English section for translations) so categories match
    if (sectionRaw && doc.section_order != null) {
      const locale = normalizedLocale;
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
      // Prefix-less sections (e.g. "Overview") sort first; "Uncategorized" sorts last.
      // Numbered sections ("10-…", "90+ - …") sort by their leading integer.
      const OVERVIEW_ORDER = -1; // set to 9000 to instead place prefix-less sections last
      const getOrder = (name: string) => {
        if (name === SECTION_NAMES.UNCATEGORIZED) return UNCATEGORIZED_ORDER;
        const m = name.match(/^(\d+)/);
        if (m) return parseInt(m[1], 10);
        return OVERVIEW_ORDER;
      };
      const aPos = getOrder(a[0]);
      const bPos = getOrder(b[0]);
      if (aPos !== bPos) return aPos - bPos;
      return a[0].localeCompare(b[0]);
    });
    let position = 1;
    for (const [sectionName] of sortedEntries) {
      // Use translated label from Toggle page if available, otherwise the curated
      // translation map, otherwise the stripped English label.
      // Reject Notion-truncated Toggle titles (ending in …/...) and fall back instead.
      const toggleLabel = sectionLabels.get(locale)?.get(sectionName);
      const strippedEn = stripSectionPrefix(sectionName);
      const curated = SECTION_TRANSLATIONS[locale]?.[strippedEn];
      const isTruncated = (s?: string) => !!s && /(?:…|\.\.\.)$/.test(s.trim());
      const label = toggleLabel && !isTruncated(toggleLabel)
        ? toggleLabel
        : (curated ?? strippedEn);
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
        link: {
          type: "generated-index" as const,
          // Docusaurus uses link.title for the generated index page's <h1> and <title>.
          // The label field only sets the sidebar entry. For translated locales,
          // setting title ensures the category page shows the localized name.
          title: label,
        },
        customProps: { title: label as string | null },
      };
      writeFileSync(categoryPath, JSON.stringify(categoryJson, null, 2));
    }
  }

  // Optimize source images in the asset pool in place (best-effort; never fatal).
  const assetsDir = join(inputDir, "assets");
  await optimizeAssets(assetsDir);

  // Copy only the assets each section actually references — avoids copying the
  // entire pool into every section dir (N×duplication). Each section dir gets
  // only the assets referenced by the .md files written into it.
  if (existsSync(assetsDir)) {
    const assetFiles = readdirSync(assetsDir).filter((f) => statSync(join(assetsDir, f)).isFile());
    const availableAssets = new Set(assetFiles);
    if (availableAssets.size > 0) {
      let assetsCopied = 0;
      let dirsCopied = 0;
      const seenDirs = new Set<string>();
      for (const sectionAbsDir of writtenSectionDirs) {
        if (seenDirs.has(sectionAbsDir)) continue;
        seenDirs.add(sectionAbsDir);
        // Scan the .md files written into this section dir for asset references.
        const referenced = collectReferencedAssets(sectionAbsDir, availableAssets);
        if (referenced.size === 0) continue; // no assets/ subdir unless something is referenced
        const targetDir = join(sectionAbsDir, "assets");
        mkdirSync(targetDir, { recursive: true });
        dirsCopied++;
        for (const f of referenced) {
          const src = join(assetsDir, f);
          const dst = join(targetDir, f);
          if (!existsSync(dst)) {
            writeFileSync(dst, readFileSync(src));
            assetsCopied++;
          }
        }
      }
      if (assetsCopied > 0) {
        console.log(`  Copied ${assetsCopied} assets to ${dirsCopied} section dirs`);
      }
    }
  }

  // Remove orphaned files (pages deleted from Notion but still on disk)
  if (args["clean-orphans"] === "true") {
    const expectedPaths = new Set<string>();
    for (const doc of manifest.docs) {
      if (args.all !== "true" && doc.status !== "active") continue;
      const et = doc.element_type?.select?.name ?? doc.element_type?.name ?? "";
      if (isStructuralPage(et)) continue;
      const orphanTranslation = translationMap.get(doc.page_id);
      const sRaw = orphanTranslation?.section ?? (doc.section || SECTION_NAMES.UNCATEGORIZED);
      const sDir = toSectionDir(sRaw);
      const nLoc = normalizeLocale(doc.locale);
      const orphanSlug = orphanTranslation?.slug ?? doc.slug;
      const expectedPath = nLoc === "en"
        ? join(outDir, "docs", ...(sDir ? [sDir] : []), `${orphanSlug}.md`)
        : join(outDir, "i18n", nLoc, "docusaurus-plugin-content-docs", "current", ...(sDir ? [sDir] : []), `${orphanSlug}.md`);
      expectedPaths.add(expectedPath);
    }
    let removed = 0;
    const removeOrphans = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          removeOrphans(fullPath);
          // Remove empty directories (except assets/)
          if (entry.name !== "assets") {
            try {
              const remaining = readdirSync(fullPath);
              if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === "assets")) {
                if (remaining[0] === "assets") {
                  const assetFiles = readdirSync(join(fullPath, "assets"));
                  for (const af of assetFiles) unlinkSync(join(fullPath, "assets", af));
                  rmdirSync(join(fullPath, "assets"));
                }
                rmdirSync(fullPath);
              }
            } catch { /* ignore */ }
          }
        } else if (entry.name.endsWith(".md") && !expectedPaths.has(fullPath)) {
          unlinkSync(fullPath);
          removed++;
        }
      }
    };
    removeOrphans(join(outDir, "docs"));
    for (const loc of ["es", "pt"]) {
      const i18nDir = join(outDir, "i18n", loc, "docusaurus-plugin-content-docs", "current");
      if (existsSync(i18nDir)) removeOrphans(i18nDir);
    }
    if (removed > 0) console.log(`  Removed ${removed} orphaned files`);
  }

  if (skippedNonPage > 0) {
    console.log(`  (skipped ${skippedNonPage} structural pages: Toggle/Title)`);
  }
  if (skippedTestPages > 0) {
    console.warn(`  (skipped ${skippedTestPages} editorial/internal page${skippedTestPages === 1 ? "" : "s"})`);
  }
  if (skippedStubTranslations > 0) {
    console.warn(`  (skipped ${skippedStubTranslations} stub translation${skippedStubTranslations === 1 ? "" : "s"} → English fallback)`);
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

  // Mirror docs:pull selection: by default only "active" docs, but `--all`
  // includes every status (Notion content is currently all "draft", so the
  // RAG index needs --all to chunk anything). Structural pages (Toggle/Title)
  // are never chunked — they carry section labels, not content.
  const includeAll = args.all === "true";
  const activeDocs = (manifest.docs || []).filter(
    (doc: { status: string; element_type?: { select?: { name?: string }; name?: string } }) => {
      if (!includeAll && doc.status !== "active") return false;
      const et = doc.element_type?.select?.name ?? doc.element_type?.name ?? "";
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
 * Static translations for section sidebar labels.
 * Used as fallback when a locale lacks a Toggle page for a section.
 * Toggle-provided labels always win over these static translations.
 */
const SECTION_TRANSLATIONS: Record<string, Record<string, string>> = {
  pt: {
    "Uncategorized": "Sem Categoria",
    "Overview": "Visão Geral",
    "Preparing to use CoMapeo": "Preparando-se para usar o CoMapeo",
    "Gathering Observations & Tracks": "Coletando Observações e Trayectos",
    "Reviewing Observations & Tracks": "Revisando Observações e Trayectos",
    // TODO: human-review these section translations
    "Exchanging Observations": "Trocando Observações",
    "Managing Data Privacy and Security": "Gestão de Privacidade de Dados e Segurança",
    "Managing Projects": "Gerenciando Projetos",
    "Sharing and Exporting different data types": "Compartilhando e Exportando Diferentes Tipos de Dados",
    "Troubleshooting": "Solução de Problemas",
    "Using Exchange Over the Internet": "Usando Exchange pela Internet",
  },
  es: {
    "Uncategorized": "Sin Categoría",
    "Overview": "Vista General",
    "Preparing to use CoMapeo": "Preparándose para usar CoMapeo",
    "Gathering Observations & Tracks": "Registrando Observaciones y Trayectos",
    "Reviewing Observations & Tracks": "Revisando Observaciones y Trayectos",
    // TODO: human-review these section translations
    "Exchanging Observations": "Intercambiando Observaciones",
    "Managing Data Privacy and Security": "Gestión de Privacidad y Seguridad de Datos",
    "Managing Projects": "Gestión de Proyectos",
    "Sharing and Exporting different data types": "Compartir y Exportar Diferentes Tipos de Datos",
    "Troubleshooting": "Solución de Problemas",
    "Using Exchange Over the Internet": "Usando Exchange por Internet",
  },
};

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

/**
 * Visible body inserted when a page has no content yet, so it doesn't render blank.
 */
const PLACEHOLDER_BODY = `:::note
Content coming soon — this page has no content in Notion yet.
:::`;

/** Notion-authored "no content yet" markers (e.g. "[Insert content here]", "[ADD content here]"). */
const STUB_BODY_MARKER = /\[\s*(insert|add)\s+content\s+here\s*\]/i;

/**
 * The doc body (everything after frontmatter), stripped of spacer divs, `---`
 * thematic-break lines and whitespace — i.e. its meaningful content.
 */
function meaningfulBody(content: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = fmMatch ? fmMatch[2] : content;
  return body
    .replace(/<div class="notion-spacer"[^>]*><\/div>/g, "")
    .replace(/^---\s*$/gm, "")
    .trim();
}

/**
 * A body that carries no real content: empty/whitespace, or only a Notion
 * "[Insert/ADD content here]" placeholder marker.
 */
function isStubBody(content: string): boolean {
  const body = meaningfulBody(content);
  if (body.length === 0) return true;
  return STUB_BODY_MARKER.test(body) && body.replace(STUB_BODY_MARKER, "").trim().length === 0;
}

/**
 * If a doc's body is a stub (empty or only an "[Insert content here]"-style
 * marker), inject the visible placeholder body. Non-stub bodies are unchanged.
 * Used for the default (en) locale; translation stubs are skipped entirely so
 * Docusaurus falls back to the English content.
 */
function ensurePlaceholderForEmptyBody(content: string): string {
  if (!isStubBody(content)) return content;
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return `${PLACEHOLDER_BODY}\n`;
  return `---\n${fmMatch[1]}\n---\n${PLACEHOLDER_BODY}\n`;
}

/**
 * Scan the .md files in a section dir for `assets/<filename>` references and
 * return the subset that exist in the available asset pool.
 */
function collectReferencedAssets(sectionAbsDir: string, availableAssets: Set<string>): Set<string> {
  const referenced = new Set<string>();
  let mdFiles: string[];
  try {
    mdFiles = readdirSync(sectionAbsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return referenced;
  }
  const refRe = /assets\/([A-Za-z0-9._-]+)/g;
  for (const mdFile of mdFiles) {
    let md: string;
    try {
      md = readFileSync(join(sectionAbsDir, mdFile), "utf8");
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    refRe.lastIndex = 0;
    while ((m = refRe.exec(md)) !== null) {
      if (availableAssets.has(m[1])) referenced.add(m[1]);
    }
  }
  return referenced;
}

/**
 * Format a byte count as a compact human-readable string (e.g. "1.2 MB").
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Minimal structural type for the sharp chain we use (avoids importing types). */
type SharpPipeline = {
  resize: (opts: Record<string, unknown>) => SharpPipeline;
  png: (opts: Record<string, unknown>) => SharpPipeline;
  jpeg: (opts: Record<string, unknown>) => SharpPipeline;
  webp: (opts: Record<string, unknown>) => SharpPipeline;
  toBuffer: () => Promise<Buffer>;
};

/**
 * Optimize images in the asset pool in place (best-effort). Resizes to a max
 * width of 1280 (no upscaling via withoutEnlargement) and re-encodes; leaves
 * .svg/.gif and non-images untouched. If `sharp` is missing or any per-file
 * step errors, the failure is logged and the pull continues without that
 * optimization — never fatal. Runs once per docs:pull.
 */
async function optimizeAssets(assetsDir: string): Promise<void> {
  if (!existsSync(assetsDir)) return;

  // Dynamic import via a non-literal specifier so TypeScript does not try to
  // resolve the (optional) sharp module — the import yields `any`, and a failed
  // import is caught so the command still works without sharp installed.
  const SHARP_SPECIFIER = "sharp";
  let sharpFn: (input: string) => SharpPipeline;
  try {
    // Non-literal specifier → import yields `any`; resolve sharp at runtime.
    const mod: { default?: (input: string) => SharpPipeline } = await import(SHARP_SPECIFIER);
    const fn = mod.default ?? (mod as unknown as (input: string) => SharpPipeline);
    if (typeof fn !== "function") throw new Error("sharp import did not expose a function");
    sharpFn = fn;
  } catch (err) {
    console.warn("  ⚠ sharp unavailable — skipping image optimization.");
    console.warn(`    Install sharp (\`npm install sharp\`) to enable it. Cause: ${(err as Error).message}`);
    return;
  }

  const isImage = /\.(png|jpe?g|webp)$/i;
  let files: string[];
  try {
    files = readdirSync(assetsDir).filter((f) => isImage.test(f));
  } catch (err) {
    console.warn("  ⚠ Could not read assets dir for optimization — skipping:", (err as Error).message);
    return;
  }

  let optimized = 0;
  let bytesSaved = 0;
  for (const f of files) {
    const filePath = join(assetsDir, f);
    try {
      const before = statSync(filePath).size;
      let pipeline: SharpPipeline = sharpFn(filePath).resize({ width: 1280, withoutEnlargement: true });
      const lower = f.toLowerCase();
      if (lower.endsWith(".png")) {
        pipeline = pipeline.png({ compressionLevel: 9 });
      } else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
        pipeline = pipeline.jpeg({ quality: 80 });
      } else if (lower.endsWith(".webp")) {
        pipeline = pipeline.webp({ quality: 80 });
      }
      const buffer: Buffer = await pipeline.toBuffer();
      // Overwrite in place — filenames are content-hash keys and markdown
      // references the filename, so refs stay valid.
      writeFileSync(filePath, buffer);
      bytesSaved += before - buffer.length;
      optimized++;
    } catch (err) {
      console.warn(`  ⚠ Failed to optimize ${f} — leaving original:`, (err as Error).message);
    }
  }

  if (optimized > 0) {
    console.log(`  Optimized ${optimized} image(s), saved ${formatBytes(Math.max(bytesSaved, 0))}`);
  } else {
    console.log("  Image optimization skipped (no optimizable images found)");
  }
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
  --clean-orphans         Remove .md files not in manifest (docs:pull)
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
