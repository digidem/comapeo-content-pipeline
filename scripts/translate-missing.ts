/**
 * translate-missing — CLI tool to generate AI-assisted translations for missing
 * documentation pages in Portuguese (pt) and Spanish (es).
 *
 * Uses the inverted translation architecture: extracts text from English raw Notion
 * blocks, translates via OpenAI-compatible LLM with CoMapeo domain glossary,
 * and serializes to clean Docusaurus markdown.
 *
 * Usage:
 *   bun scripts/translate-missing.ts [--dry-run]
 *   bun scripts/translate-missing.ts --apply [--locale es|pt] [--limit 5]
 *   bun scripts/translate-missing.ts --apply --page <slug-or-id>
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "./lib/args.js";
import { buildReport, type PageReport } from "./missing-translations.js";
import { loadGlossary } from "../src/lib/glossary.js";
import { AITranslator } from "../src/lib/ai-translator.js";
import { extractTranslatableBlocks } from "../src/lib/block-translator.js";
import { translatePageContent } from "../src/lib/page-translator.js";
import { NotionClient } from "../src/lib/notion-client.js";
import { writeTranslationToNotion } from "../src/lib/notion-writer.js";
import { buildFrontmatter, serializeDoc } from "../src/lib/frontmatter.js";
import { rewriteRawImgSrcToStatic } from "../src/lib/img-rewrite.js";
import type { NotionBlockList } from "../src/lib/notion-converter.js";
import type { PageMetadata, PageAsset } from "../src/schemas/metadata.js";
import type { ManifestDoc } from "../src/schemas/manifest.js";

interface TranslationTarget {
  page: PageReport;
  locale: "pt" | "es";
  enPageId: string;
  targetPageId: string;
  needsTranslation: boolean;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apply = args.apply === "true";
  const dryRun = args["dry-run"] === "true" || !apply;
  const includeDrafts = args.all === "true";
  const writeNotion = args["write-notion"] === "true";
  const force = args.force === "true";
  const databaseId = args["database-id"] || process.env.NOTION_DATABASE_ID;
  const targetLocaleArg = args.locale as "pt" | "es" | undefined;
  const pageFilter = args.page;
  const limit = args.limit ? parseInt(args.limit, 10) : Infinity;
  const input = args.input || join(process.cwd(), "output/manifest.json");
  const inputDir = args["input-dir"] || join(process.cwd(), "output");
  const outputDir = args["output-dir"];

  if (targetLocaleArg && !["pt", "es"].includes(targetLocaleArg)) {
    console.error(`Invalid --locale: "${targetLocaleArg}". Supported locales: "pt", "es".`);
    process.exit(1);
  }

  console.log(`=== CoMapeo AI Translation Generator ===`);
  console.log(`Mode:         ${dryRun ? "DRY RUN (preview only)" : "APPLY (writing changes)"}`);
  if (writeNotion) console.log(`Write Notion: ENABLED (target database: ${databaseId || "not set"})`);
  if (force) console.log(`Force:        ENABLED (override human-edit safety lock)`);
  if (targetLocaleArg) console.log(`Locale:       ${targetLocaleArg}`);
  if (pageFilter) console.log(`Filter:       ${pageFilter}`);
  if (Number.isFinite(limit)) console.log(`Limit:        ${limit}`);
  console.log(`Input:        ${input}`);
  console.log(``);

  // 1. Load Glossary
  let glossary;
  try {
    glossary = loadGlossary();
    console.log(`Loaded domain glossary with ${glossary.terms.length} terms.`);
  } catch (err) {
    console.error("Failed to load domain glossary:", err);
    process.exit(1);
  }

  // 2. Build Missing Translation Report
  console.log(`Analyzing translation status from manifest...`);
  const report = buildReport({
    input,
    inputDir,
    onlyMissing: !force && !pageFilter,
    includeDrafts,
  });

  // 3. Filter Candidate Targets
  const localesToProcess: Array<"pt" | "es"> = targetLocaleArg
    ? [targetLocaleArg]
    : ["es", "pt"];

  let candidatePages = report.pages;
  if (pageFilter) {
    candidatePages = candidatePages.filter(
      (p) =>
        p.slug === pageFilter ||
        Object.values(p.locales).some((loc) => loc.page_id === pageFilter),
    );
  }

  const targets: TranslationTarget[] = [];

  for (const p of candidatePages) {
    const enMember = p.locales.en;
    if (!enMember) {
      console.warn(`[skip] No English source page found for "${p.title}" (${p.slug})`);
      continue;
    }

    for (const loc of localesToProcess) {
      const isMissing = p.missing.includes(loc);
      const isStub = p.english_content.includes(loc);
      if (isMissing || isStub || force) {
        const stubPageId = p.locales[loc]?.page_id;
        targets.push({
          page: p,
          locale: loc,
          enPageId: enMember.page_id,
          targetPageId: stubPageId ?? `${enMember.page_id}-${loc}`,
          needsTranslation: true,
        });
      }
    }
  }

  console.log(`Found ${targets.length} translation target(s) needing generation.`);
  if (targets.length === 0) {
    console.log("No missing translations matching criteria. All up to date!");
    return;
  }

  // 4. Initialize Clients
  const notionToken = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  const client = notionToken ? new NotionClient({ token: notionToken }) : null;

  const apiKey =
    args["api-key"] ||
    process.env.TRANSLATION_API_KEY ||
    process.env.POOLSIDE_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!dryRun && !apiKey) {
    console.error("Error: TRANSLATION_API_KEY or POOLSIDE_API_KEY is required to generate translations with --apply.");
    console.error("Set TRANSLATION_API_KEY in environment or pass --api-key <key>.");
    process.exit(1);
  }

  if (writeNotion && !dryRun) {
    if (!notionToken) {
      console.error("Error: NOTION_TOKEN or NOTION_API_KEY is required to write back to Notion with --write-notion.");
      process.exit(1);
    }
    if (!databaseId) {
      console.error("Error: NOTION_DATABASE_ID is required to write back to Notion with --write-notion.");
      process.exit(1);
    }
  }

  const translator = new AITranslator({
    apiKey: apiKey || "dummy-key-for-dry-run",
    baseUrl: args["base-url"] || process.env.TRANSLATION_BASE_URL,
    model: args.model || process.env.TRANSLATION_MODEL,
    batchSize: args["batch-size"] ? parseInt(args["batch-size"], 10) : undefined,
    timeoutMs: args.timeout ? parseInt(args.timeout, 10) : undefined,
  });

  // 5. Execute translations
  const queue = targets.slice(0, limit);
  console.log(`Processing ${queue.length} target(s)...\n`);

  let successCount = 0;
  let skippedCount = 0;
  let failureCount = 0;

  for (let i = 0; i < queue.length; i++) {
    const target = queue[i];
    const { page, locale, enPageId } = target;
    let { targetPageId } = target;
    const progress = `[${i + 1}/${queue.length}]`;

    // A. Load English Blocks
    const rawBlocksPath = join(inputDir, `${enPageId}.raw-blocks.json`);
    let enRawBlocks: NotionBlockList | null = null;

    if (existsSync(rawBlocksPath)) {
      try {
        enRawBlocks = JSON.parse(readFileSync(rawBlocksPath, "utf8")) as NotionBlockList;
      } catch (err) {
        console.warn(`${progress} Failed to read cached ${rawBlocksPath}:`, err);
      }
    }

    if (!enRawBlocks && client) {
      try {
        console.log(`${progress} Fetching Notion blocks for English source ${enPageId}...`);
        const { results, children } = await client.getPageBlocks(enPageId);
        enRawBlocks = { object: "list", results, children };
        writeFileSync(rawBlocksPath, JSON.stringify(enRawBlocks, null, 2));
      } catch (err) {
        console.error(`${progress} Failed to fetch Notion blocks for ${enPageId}:`, err);
      }
    }

    if (!enRawBlocks) {
      console.warn(
        `${progress} [SKIP] ${page.title} (${page.slug}) -> ${locale}: English blocks not found at ${rawBlocksPath} and Notion token not configured.`,
      );
      skippedCount++;
      continue;
    }

    // B. Load English Metadata
    const metaPath = join(inputDir, `${enPageId}.metadata.json`);
    let enMetadata: PageMetadata | null = null;

    if (existsSync(metaPath)) {
      try {
        enMetadata = JSON.parse(readFileSync(metaPath, "utf8")) as PageMetadata;
      } catch (err) {
        console.warn(`${progress} Failed to read metadata at ${metaPath}:`, err);
      }
    }

    if (!enMetadata) {
      // Synthesize basic metadata from page report if metadata file missing
      enMetadata = {
        page_id: enPageId,
        title: page.title,
        source_url: `https://notion.so/${enPageId.replace(/-/g, "")}`,
        notion_last_edited_time: new Date().toISOString(),
        content_hash: "",
        raw_hash: "",
        locale: "en",
        section: page.section,
        section_order: 1,
        slug: page.slug,
        docusaurus_id: page.slug,
        status: "active",
        properties: {},
        assets: [],
        keywords: ["docs", "comapeo"],
        tags: ["comapeo"],
        language_source: "explicit",
      };
    }

    // C. Dry-Run or Translation Execution
    const translatable = extractTranslatableBlocks(enRawBlocks);

    if (dryRun) {
      console.log(
        `${progress} [DRY RUN] "${page.title}" (${page.slug}) -> ${locale.toUpperCase()}`,
      );
      console.log(`    Target ID:    ${targetPageId}`);
      console.log(`    Doc Path:     ${page.paths[locale]}`);
      console.log(`    Blocks:       ${translatable.length} translatable segments`);
      if (writeNotion) {
        const stubId = page.locales[locale]?.page_id;
        console.log(`    Notion:       Would ${stubId ? `update stub ${stubId}` : "create new page in Notion DB"}`);
      }
      if (translatable.length > 0) {
        const preview = translatable[0].text.slice(0, 70).replace(/\n/g, " ");
        console.log(`    Sample:       "${preview}..."`);
      }
      console.log(``);
      successCount++;
      continue;
    }

    // D. Apply Mode
    try {
      console.log(
        `${progress} Translating "${page.title}" to ${locale.toUpperCase()} (${translatable.length} blocks)...`,
      );
      const result = await translatePageContent({
        enRawBlocks,
        enMetadata,
        targetLocale: locale,
        targetPageId,
        translator,
        glossary,
      });

      // Write output files in inputDir (pipeline output dir)
      const outMdPath = join(inputDir, `${targetPageId}.md`);
      const outMetaPath = join(inputDir, `${targetPageId}.metadata.json`);
      const outBlocksPath = join(inputDir, `${targetPageId}.raw-blocks.json`);

      writeFileSync(outMdPath, result.translatedMd, "utf8");
      writeFileSync(outMetaPath, JSON.stringify(result.translatedMetadata, null, 2), "utf8");
      writeFileSync(outBlocksPath, JSON.stringify(result.translatedBlocks, null, 2), "utf8");

      // If outputDir or Docusaurus path specified, write there too
      if (outputDir) {
        const docDest = join(outputDir, page.paths[locale]);
        mkdirSync(dirname(docDest), { recursive: true });
        const rewritten = rewriteRawImgSrcToStatic(result.translatedMd);
        writeFileSync(docDest, rewritten.content, "utf8");
        copyReferencedAssets(outputDir, inputDir, page.paths[locale], rewritten.assets, enMetadata?.assets);
      }

      // Update manifest.json with initial translation entry
      const buildManifestEntry = (id: string, meta: PageMetadata): ManifestDoc => ({
        page_id: id,
        title: meta.title,
        locale,
        section: meta.section,
        section_order: meta.section_order,
        element_type: meta.element_type ?? "Page",
        drafting_status: meta.drafting_status ?? "automated translations generated",
        slug: meta.slug,
        docusaurus_id: meta.docusaurus_id,
        docusaurus_path: page.paths[locale],
        r2_doc_key: `docs/${id}.md`,
        r2_metadata_key: `metadata/${id}.json`,
        source_url: meta.source_url,
        notion_last_edited_time: meta.notion_last_edited_time,
        content_hash: meta.content_hash,
        status: "draft",
        language_source: "automated",
      });

      updateManifestWithDoc(input, buildManifestEntry(targetPageId, result.translatedMetadata), enPageId);

      // Optional Notion Write-Back
      if (writeNotion && client && databaseId) {
        const stubId = page.locales[locale]?.page_id;
        console.log(`${progress} [Notion] Writing translation to Notion database...`);

        // Resolve Container Parent ID so translations are siblings under the container row
        const containerParentId =
          page.parentId ||
          (enMetadata?.properties?.["Parent item"] as { relation?: Array<{ id: string }> } | undefined)
            ?.relation?.[0]?.id;

        const notionRes = await writeTranslationToNotion({
          client,
          databaseId,
          targetLocale: locale,
          targetTitle: result.title,
          parentItemId: containerParentId,
          parentEnglishPageId: enPageId,
          targetPageId: stubId,
          translatedBlocks: result.translatedBlocks,
          assets: enMetadata?.assets,
          section: page.section,
          assetBaseUrl: process.env.PUBLIC_ASSET_BASE_URL,
          force,
        });

        if (notionRes.written) {
          console.log(
            `${progress} [Notion] ✓ ${notionRes.action === "created" ? "Created new page" : "Updated stub"} [${notionRes.pageId}]`,
          );
          if (notionRes.action === "created" && notionRes.pageId && notionRes.pageId !== targetPageId) {
            const newId = notionRes.pageId;
            result.translatedMetadata.page_id = newId;
            const updatedFrontmatter = buildFrontmatter(result.translatedMetadata);
            const updatedMd = serializeDoc(updatedFrontmatter, result.markdownBody);

            if (existsSync(outMdPath)) unlinkSync(outMdPath);
            if (existsSync(outMetaPath)) unlinkSync(outMetaPath);
            if (existsSync(outBlocksPath)) unlinkSync(outBlocksPath);

            writeFileSync(join(inputDir, `${newId}.md`), updatedMd, "utf8");
            writeFileSync(join(inputDir, `${newId}.metadata.json`), JSON.stringify(result.translatedMetadata, null, 2), "utf8");
            writeFileSync(join(inputDir, `${newId}.raw-blocks.json`), JSON.stringify(result.translatedBlocks, null, 2), "utf8");

            if (outputDir) {
              const docDest = join(outputDir, page.paths[locale]);
              const rewritten = rewriteRawImgSrcToStatic(updatedMd);
              writeFileSync(docDest, rewritten.content, "utf8");
              copyReferencedAssets(outputDir, inputDir, page.paths[locale], rewritten.assets, enMetadata?.assets);
            }
            targetPageId = newId;
            updateManifestWithDoc(input, buildManifestEntry(newId, result.translatedMetadata), enPageId);
          }
        } else {
          console.warn(`${progress} [Notion] ⚠ Skipped write-back: ${notionRes.reason}`);
        }
      }

      console.log(
        `${progress} ✓ Success! Translated "${page.title}" -> "${result.title}" [${targetPageId}]\n`,
      );
      successCount++;
    } catch (err) {
      console.error(`${progress} ✗ Translation failed for "${page.title}":`, err);
      failureCount++;
    }
  }

  console.log(`=== Translation Summary ===`);
  console.log(`Total queued:   ${queue.length}`);
  console.log(`Successful:     ${successCount}`);
  console.log(`Skipped:        ${skippedCount}`);
  console.log(`Failed:         ${failureCount}`);

  if (failureCount > 0) {
    process.exitCode = 1;
  }

  if (dryRun) {
    console.log(`\nTo generate and write translated files, run with --apply:`);
    console.log(`  bun scripts/translate-missing.ts --apply`);
  }
}

function updateManifestWithDoc(manifestPath: string, doc: ManifestDoc, enPageId?: string): void {
  if (!existsSync(manifestPath)) return;
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const data = JSON.parse(raw) as {
      docs?: ManifestDoc[];
      [key: string]: unknown;
    };
    if (!Array.isArray(data.docs)) return;

    const existingIdx = data.docs.findIndex(
      (d) => d.page_id === doc.page_id || (d.slug === doc.slug && d.locale === doc.locale),
    );
    if (existingIdx >= 0) {
      data.docs[existingIdx] = doc;
    } else {
      data.docs.push(doc);
    }

    if (enPageId) {
      const enDoc = data.docs.find((d) => d.page_id === enPageId);
      if (enDoc) {
        if (!Array.isArray(enDoc.sub_items)) enDoc.sub_items = [];
        if (!enDoc.sub_items.includes(doc.page_id)) {
          enDoc.sub_items.push(doc.page_id);
        }
      }
    }

    writeFileSync(manifestPath, JSON.stringify(data, null, 2), "utf8");
    console.log(`    [Manifest] ✓ Updated ${manifestPath} with entry [${doc.page_id}]`);
  } catch (err) {
    console.warn(`    [Manifest] ⚠ Could not update manifest: ${err}`);
  }
}

function copyReferencedAssets(
  outputDir: string,
  inputDir: string,
  docRelativePath: string,
  rewrittenAssets: string[],
  pageAssets?: PageAsset[],
): void {
  const assetsSrcDir = join(inputDir, "assets");
  if (!existsSync(assetsSrcDir)) return;

  const docDest = join(outputDir, docRelativePath);
  const docDir = dirname(docDest);

  // 1. Copy markdown assets to section/assets directory
  if (pageAssets && pageAssets.length > 0) {
    const targetAssetsDir = join(docDir, "assets");
    mkdirSync(targetAssetsDir, { recursive: true });
    for (const a of pageAssets) {
      const filename = a.r2_key.replace(/^assets\//, "");
      const src = join(assetsSrcDir, filename);
      const dst = join(targetAssetsDir, filename);
      if (existsSync(src) && !existsSync(dst)) {
        writeFileSync(dst, readFileSync(src));
      }
    }
  }

  // 2. Copy inline static assets to outputDir/static/images/notion
  if (rewrittenAssets.length > 0) {
    const staticDir = join(outputDir, "static", "images", "notion");
    mkdirSync(staticDir, { recursive: true });
    for (const f of rewrittenAssets) {
      if (f.includes("/") || f.includes("\\") || f.includes("..")) continue;
      const src = join(assetsSrcDir, f);
      const dst = join(staticDir, f);
      if (existsSync(src) && !existsSync(dst)) {
        writeFileSync(dst, readFileSync(src));
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
