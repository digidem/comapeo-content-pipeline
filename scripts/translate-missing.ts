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

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { R2_PATHS } from "../src/persistence/r2.js";
import { buildSidebarsFromPlan } from "../src/lib/manifest.js";
import { isStubBody } from "../src/lib/stub-body.js";

interface TranslationTarget {
  page: PageReport;
  locale: "pt" | "es";
  enPageId: string;
  targetPageId?: string;
  needsTranslation: boolean;
}

function isSyntheticPageId(id?: string | null): boolean {
  if (!id) return false;
  return /-[a-z]{2}(-[a-z]{2})?$/i.test(id) || !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(id);
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
  let limit = Infinity;
  if (args.limit !== undefined) {
    const raw = String(args.limit).trim();
    const parsedLimit = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsedLimit) || parsedLimit <= 0) {
      console.error(`Invalid --limit: "${args.limit}". Must be a positive integer.`);
      process.exit(1);
    }
    limit = parsedLimit;
  }
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
    const glossaryPath = args.glossary || join(process.cwd(), "config/glossary.json");
    let rawGlossary: unknown = undefined;
    if (existsSync(glossaryPath)) {
      rawGlossary = JSON.parse(readFileSync(glossaryPath, "utf8"));
    }
    glossary = loadGlossary(rawGlossary);
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
        const rawStubId = p.locales[loc]?.page_id;
        const stubPageId = isSyntheticPageId(rawStubId) ? undefined : rawStubId;
        targets.push({
          page: p,
          locale: loc,
          enPageId: enMember.page_id,
          targetPageId: stubPageId,
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

  let timeoutMs: number | undefined;
  if (args.timeout !== undefined) {
    const raw = String(args.timeout).trim();
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      console.error(`Error: --timeout must be a positive finite duration in milliseconds, got "${args.timeout}".`);
      process.exit(1);
    }
    timeoutMs = parsed;
  }

  let batchSize: number | undefined;
  if (args["batch-size"] !== undefined) {
    const raw = String(args["batch-size"]).trim();
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      console.error(`Error: --batch-size must be a positive finite integer, got "${args["batch-size"]}".`);
      process.exit(1);
    }
    batchSize = parsed;
  }

  const translator = new AITranslator({
    apiKey: apiKey || "dummy-key-for-dry-run",
    baseUrl: args["base-url"] || process.env.TRANSLATION_BASE_URL,
    model: args.model || process.env.TRANSLATION_MODEL,
    batchSize,
    timeoutMs,
    env: process.env,
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
      console.log(`    Target ID:    ${targetPageId ?? `${enPageId}-${locale} (provisional)`}`);
      console.log(`    Doc Path:     ${page.paths[locale]}`);
      console.log(`    Blocks:       ${translatable.length} translatable segments`);
      if (writeNotion) {
        console.log(`    Notion:       Would ${targetPageId ? `update stub ${targetPageId}` : "create new page in Notion DB"}`);
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
    let rollbackNotion: (() => Promise<void>) | undefined;
    const fileBackups = new Map<string, Buffer | null>();
    const trackAndWriteFile = (filePath: string, content: string | Buffer) => {
      if (!fileBackups.has(filePath)) {
        fileBackups.set(filePath, existsSync(filePath) ? readFileSync(filePath) : null);
      }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    };

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

      // Optional Notion Write-Back: Run first if enabled so the final page ID is known
      // before local artifacts and manifest are committed. If Notion creation fails,
      // the error is caught, no provisional manifest entry is recorded, and the locale
      // remains eligible for future retry.
      if (writeNotion && client && databaseId) {
        console.log(`${progress} [Notion] Writing translation to Notion database...`);

        // Resolve Container Parent ID so translations are siblings under the container row
        const containerParentId =
          page.parentId ||
          (enMetadata?.properties?.["Parent item"] as { relation?: Array<{ id: string }> } | undefined)
            ?.relation?.[0]?.id;

        const canonicalBaseUrl = process.env.DOCS_BASE_URL || "https://docs.comapeo.app";
        const canonicalUrl = `${canonicalBaseUrl.replace(/\/+$/, "")}/${locale}/docs/${page.slug.replace(/^\/+/, "")}`;

        const notionRes = await writeTranslationToNotion({
          client,
          databaseId,
          targetLocale: locale,
          targetTitle: result.title,
          parentItemId: containerParentId,
          parentEnglishPageId: enPageId,
          targetPageId,
          translatedBlocks: result.translatedBlocks,
          assets: enMetadata?.assets,
          section: page.section,
          toggleDir: page.toggleDir,
          canonicalUrl,
          assetBaseUrl: process.env.PUBLIC_ASSET_BASE_URL,
          force,
        });

        if (notionRes.written) {
          rollbackNotion = notionRes.rollback;
          console.log(
            `${progress} [Notion] ✓ ${notionRes.action === "created" ? "Created new page" : "Updated stub"} [${notionRes.pageId}]`,
          );
          if (notionRes.pageId && notionRes.pageId !== targetPageId) {
            targetPageId = notionRes.pageId;
            result.translatedMetadata.page_id = targetPageId;
            result.translatedMetadata.source_url = `https://notion.so/${targetPageId.replace(/-/g, "")}`;
            const updatedFrontmatter = buildFrontmatter(result.translatedMetadata);
            result.translatedMd = serializeDoc(updatedFrontmatter, result.markdownBody);
          }
        } else {
          console.warn(`${progress} [Notion] ⚠ Skipped write-back: ${notionRes.reason}`);
          skippedCount++;
          continue;
        }
      }

      // If write-back was not enabled or targetPageId was not assigned by Notion,
      // fall back to synthetic ID for local files.
      if (!targetPageId) {
        targetPageId = `${enPageId}-${locale}`;
        result.translatedMetadata.page_id = targetPageId;
        result.translatedMetadata.source_url = `https://notion.so/${targetPageId.replace(/-/g, "")}`;
        const updatedFrontmatter = buildFrontmatter(result.translatedMetadata);
        result.translatedMd = serializeDoc(updatedFrontmatter, result.markdownBody);
      }

      // Write output files in inputDir (pipeline output dir) using final targetPageId
      const outMdPath = join(inputDir, `${targetPageId}.md`);
      const outMetaPath = join(inputDir, `${targetPageId}.metadata.json`);
      const outBlocksPath = join(inputDir, `${targetPageId}.raw-blocks.json`);

      trackAndWriteFile(outMdPath, result.translatedMd);
      trackAndWriteFile(outMetaPath, JSON.stringify(result.translatedMetadata, null, 2));
      trackAndWriteFile(outBlocksPath, JSON.stringify(result.translatedBlocks, null, 2));

      // If outputDir or Docusaurus path specified, write there too
      if (outputDir) {
        const docDest = join(outputDir, page.paths[locale]);
        const rewritten = rewriteRawImgSrcToStatic(result.translatedMd);
        trackAndWriteFile(docDest, rewritten.content);
        copyReferencedAssets(outputDir, inputDir, page.paths[locale], rewritten.assets, enMetadata?.assets, trackAndWriteFile);
      }

      // Snapshot manifest before updating so it can be restored on write error
      if (!fileBackups.has(input)) {
        fileBackups.set(input, existsSync(input) ? readFileSync(input) : null);
      }

      // Update manifest.json with the finalized translation entry using canonical R2 paths
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
        docusaurus_path: `/${meta.slug}`,
        r2_doc_key: R2_PATHS.doc(locale, meta.section, meta.slug),
        r2_metadata_key: R2_PATHS.metadata(id),
        source_url: meta.source_url,
        notion_last_edited_time: meta.notion_last_edited_time,
        content_hash: meta.content_hash,
        status: "draft",
        language_source: "automated",
      });

      updateManifestWithDoc(
        input,
        buildManifestEntry(targetPageId, result.translatedMetadata),
        enPageId,
        target.targetPageId,
        {
          inputDir,
          includeDrafts,
        },
      );

      // Successfully saved locally and in manifest; clear rollback tracking
      fileBackups.clear();
      rollbackNotion = undefined;

      console.log(
        `${progress} ✓ Success! Translated "${page.title}" -> "${result.title}" [${targetPageId}]\n`,
      );
      successCount++;
    } catch (err) {
      if (rollbackNotion) {
        console.warn(
          `${progress} Rolling back Notion changes on [${targetPageId}] due to persistence failure...`,
        );
        try {
          await rollbackNotion();
          console.log(`${progress} ✓ Rollback of Notion changes complete.`);
        } catch (rollErr) {
          console.error(`${progress} Failed to rollback Notion changes on [${targetPageId}]:`, rollErr);
        }
      }

      // Roll back / remove any partially written local files so no orphaned artifacts remain
      for (const [filePath, originalContent] of fileBackups.entries()) {
        try {
          if (originalContent === null) {
            if (existsSync(filePath)) {
              rmSync(filePath, { force: true });
              console.log(`${progress} [Cleanup] Removed orphaned file: ${filePath}`);
            }
          } else {
            writeFileSync(filePath, originalContent);
            console.log(`${progress} [Cleanup] Restored previous file: ${filePath}`);
          }
        } catch (cleanupErr) {
          console.error(`${progress} Failed to clean up file ${filePath}:`, cleanupErr);
        }
      }
      fileBackups.clear();

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
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\nTo generate and write translated files, run with --apply:`);
    console.log(`  bun scripts/translate-missing.ts --apply`);
  }
}

export function updateManifestWithDoc(
  manifestPath: string,
  doc: ManifestDoc,
  enPageId?: string,
  replacedPageId?: string,
  options?: {
    inputDir?: string;
    hasBodyById?: Record<string, boolean>;
    languageSourceById?: Record<string, "explicit" | "automated" | "fallback">;
    includeDrafts?: boolean;
  },
): void {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file does not exist at ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, "utf8");
  const data = JSON.parse(raw) as {
    docs?: ManifestDoc[];
    sidebars?: Record<string, unknown>;
    [key: string]: unknown;
  };
  if (!Array.isArray(data.docs)) {
    throw new Error(`Invalid manifest structure at ${manifestPath}: "docs" array is missing.`);
  }

  const enDoc = enPageId ? data.docs.find((d) => d.page_id === enPageId) : undefined;
  const inputDir = options?.inputDir ?? dirname(manifestPath);

  // Build hasBodyById map so body-quality ranking accurately distinguishes stubs from real content
  const hasBodyById: Record<string, boolean> = {
    ...(options?.hasBodyById ?? {}),
  };
  for (const d of data.docs) {
    if (d.page_id in hasBodyById) continue;
    if (d.page_id === doc.page_id) {
      hasBodyById[d.page_id] = true;
      continue;
    }
    const mdPath = join(inputDir, `${d.page_id}.md`);
    if (existsSync(mdPath)) {
      try {
        hasBodyById[d.page_id] = !isStubBody(readFileSync(mdPath, "utf8"));
      } catch {
        hasBodyById[d.page_id] = false;
      }
    } else {
      hasBodyById[d.page_id] = false;
    }
  }
  hasBodyById[doc.page_id] = true;

  // Build languageSourceById map
  const languageSourceById: Record<string, "explicit" | "automated" | "fallback"> = {
    ...(options?.languageSourceById ?? {}),
  };
  for (const d of data.docs) {
    if (d.page_id in languageSourceById) continue;
    if (d.page_id === doc.page_id) {
      languageSourceById[d.page_id] = "automated";
      continue;
    }
    if (d.language_source) {
      languageSourceById[d.page_id] = d.language_source;
    }
  }
  languageSourceById[doc.page_id] = "automated";

  let previousPageId: string | null = null;
  // 1. Exact page ID match
  let existingIdx = data.docs.findIndex((d) => d.page_id === doc.page_id);

  // 2. Exact replaced page ID match (if translation replaced an existing stub)
  if (existingIdx < 0 && replacedPageId) {
    existingIdx = data.docs.findIndex((d) => d.page_id === replacedPageId);
  }

  // 3. Match within English doc's sub_items family using canonical hierarchy ranking
  if (existingIdx < 0 && enDoc && Array.isArray(enDoc.sub_items) && enDoc.sub_items.length > 0) {
    const siblingCandidates = data.docs.filter(
      (d) => enDoc.sub_items!.includes(d.page_id) && d.locale === doc.locale,
    );

    if (siblingCandidates.length === 1) {
      existingIdx = data.docs.findIndex((d) => d.page_id === siblingCandidates[0].page_id);
    } else if (siblingCandidates.length > 1) {
      // Multiple siblings exist for this locale in the family.
      // Rank candidates so we replace the intended target (stubs before pages with bodies,
      // fallback/automated before explicit, deprecated/archived before active) rather
      // than arbitrarily replacing whichever sibling appears first in manifest order.
      const ranked = [...siblingCandidates].sort((a, b) => {
        // 1. Prefer replacing stubs (no body) before pages with real bodies
        const aBody = hasBodyById[a.page_id] ? 1 : 0;
        const bBody = hasBodyById[b.page_id] ? 1 : 0;
        if (aBody !== bBody) return aBody - bBody;

        // 2. Prefer replacing fallback/automated before explicit human translations
        const srcRank: Record<string, number> = { fallback: 0, automated: 1, explicit: 2 };
        const aSrc = srcRank[languageSourceById[a.page_id] ?? a.language_source ?? "fallback"] ?? 0;
        const bSrc = srcRank[languageSourceById[b.page_id] ?? b.language_source ?? "fallback"] ?? 0;
        if (aSrc !== bSrc) return aSrc - bSrc;

        // 3. Prefer replacing archived/deprecated before draft/active
        const statusRank: Record<string, number> = { archived: 0, deprecated: 1, draft: 2, active: 3 };
        const aStat = statusRank[a.status] ?? 2;
        const bStat = statusRank[b.status] ?? 2;
        if (aStat !== bStat) return aStat - bStat;

        // 4. Section order
        return (a.section_order ?? 9999) - (b.section_order ?? 9999);
      });

      const targetSibling = ranked[0];
      existingIdx = data.docs.findIndex((d) => d.page_id === targetSibling.page_id);
    }
  }

  // 4. Exact canonical route path match
  if (existingIdx < 0) {
    existingIdx = data.docs.findIndex(
      (d) =>
        (d.locale === doc.locale && doc.docusaurus_path && d.docusaurus_path && d.docusaurus_path === doc.docusaurus_path) ||
        (doc.r2_doc_key && d.r2_doc_key && d.r2_doc_key === doc.r2_doc_key),
    );
  }

  // 5. Section + slug + locale match (never slug alone across different sections)
  if (existingIdx < 0) {
    existingIdx = data.docs.findIndex(
      (d) => d.locale === doc.locale && d.slug === doc.slug && d.section === doc.section,
    );
  }

  if (existingIdx >= 0) {
    previousPageId = data.docs[existingIdx].page_id;
    data.docs[existingIdx] = doc;
  } else {
    data.docs.push(doc);
  }

  if (enDoc) {
    if (!Array.isArray(enDoc.sub_items)) enDoc.sub_items = [];
    if (previousPageId && previousPageId !== doc.page_id) {
      enDoc.sub_items = enDoc.sub_items.filter((id) => id !== previousPageId);
    }
    if (!enDoc.sub_items.includes(doc.page_id)) {
      enDoc.sub_items.push(doc.page_id);
    }
  }

  // Regenerate sidebars for all locales so navigation manifest stays consistent with added translations
  data.sidebars = buildSidebarsFromPlan(data.docs, hasBodyById, {
    includeDrafts: options?.includeDrafts ?? false,
    languageSourceById,
  });

  writeFileSync(manifestPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`    [Manifest] ✓ Updated ${manifestPath} with entry [${doc.page_id}] and regenerated sidebars`);
}

export function copyReferencedAssets(
  outputDir: string,
  inputDir: string,
  docRelativePath: string,
  rewrittenAssets: string[],
  pageAssets?: PageAsset[],
  writeFn?: (filePath: string, content: Buffer | string) => void,
): void {
  const assetsSrcDir = resolve(inputDir, "assets");
  if (!existsSync(assetsSrcDir)) return;

  const docDest = resolve(outputDir, docRelativePath);
  const docDir = dirname(docDest);
  const writeFile = writeFn ?? ((filePath: string, content: Buffer | string) => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  });

  // 1. Copy markdown assets to section/assets directory
  if (pageAssets && pageAssets.length > 0) {
    const targetAssetsDir = resolve(docDir, "assets");
    mkdirSync(targetAssetsDir, { recursive: true });
    for (const a of pageAssets) {
      if (typeof a?.r2_key !== "string") continue;
      const filename = a.r2_key.replace(/^assets\//, "");
      // Validate the key as a single safe asset filename before using it in either path
      if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
        continue;
      }
      const src = resolve(assetsSrcDir, filename);
      const dst = resolve(targetAssetsDir, filename);
      if (!src.startsWith(assetsSrcDir + "/") || !dst.startsWith(targetAssetsDir + "/")) {
        continue;
      }
      if (existsSync(src) && !existsSync(dst)) {
        writeFile(dst, readFileSync(src));
      }
    }
  }

  // 2. Copy inline static assets to outputDir/static/images/notion
  if (rewrittenAssets.length > 0) {
    const staticDir = resolve(outputDir, "static", "images", "notion");
    mkdirSync(staticDir, { recursive: true });
    for (const f of rewrittenAssets) {
      if (typeof f !== "string") continue;
      if (!f || f.includes("/") || f.includes("\\") || f.includes("..")) continue;
      const src = resolve(assetsSrcDir, f);
      const dst = resolve(staticDir, f);
      if (!src.startsWith(assetsSrcDir + "/") || !dst.startsWith(staticDir + "/")) {
        continue;
      }
      if (existsSync(src) && !existsSync(dst)) {
        writeFile(dst, readFileSync(src));
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
