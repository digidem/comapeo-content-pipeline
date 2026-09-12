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
import { translatePageContent, type TranslatePageResult } from "../src/lib/page-translator.js";
import { NotionClient } from "../src/lib/notion-client.js";
import { writeTranslationToNotion } from "../src/lib/notion-writer.js";
import { buildFrontmatter, serializeDoc } from "../src/lib/frontmatter.js";
import { rewriteRawImgSrcToStatic } from "../src/lib/img-rewrite.js";
import type { NotionBlockList } from "../src/lib/notion-converter.js";
import type { PageMetadata, PageAsset } from "../src/schemas/metadata.js";
import { type ManifestDoc, PAGE_ID_REGEX } from "../src/schemas/manifest.js";
import { R2_PATHS } from "../src/persistence/r2.js";
import { buildSidebarsFromPlan } from "../src/lib/manifest.js";
import { isStubBody } from "../src/lib/stub-body.js";

interface TranslationTarget {
  page: PageReport;
  locale: "pt" | "es";
  enPageId: string;
  targetPageId?: string;
  replaceablePageId?: string;
  needsTranslation: boolean;
}

/** Validates that a page ID does not contain path traversal or invalid characters */
export function assertSafePageId(pageId: string, label = "page ID"): string {
  if (!pageId || typeof pageId !== "string" || !PAGE_ID_REGEX.test(pageId)) {
    throw new Error(`Security error: invalid or unsafe ${label} [${pageId}]`);
  }
  return pageId;
}

/** Resolves a path beneath baseDir and ensures it does not escape baseDir */
export function resolveSafePath(baseDir: string, relativeOrChildPath: string, label = "path"): string {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, relativeOrChildPath);
  if (!resolvedTarget.startsWith(resolvedBase + "/") && resolvedTarget !== resolvedBase) {
    throw new Error(
      `Security error: resolved ${label} [${resolvedTarget}] escapes base directory [${resolvedBase}]`,
    );
  }
  return resolvedTarget;
}

export function buildManifestDoc(id: string, meta: PageMetadata, locale: string): ManifestDoc {
  assertSafePageId(id, "manifest doc page ID");
  return {
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
  };
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
        const existingMember = p.locales[loc];
        if (existingMember?.language_source === "explicit" && !force) {
          console.log(
            `[skip] Skipping "${p.title}" (${loc}): explicit human translation exists (use --force to override)`,
          );
          continue;
        }

        const rawStubId = existingMember?.page_id;
        const stubPageId = isSyntheticPageId(rawStubId) ? undefined : rawStubId;
        targets.push({
          page: p,
          locale: loc,
          enPageId: enMember.page_id,
          targetPageId: stubPageId,
          replaceablePageId: rawStubId,
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

    assertSafePageId(enPageId, "English source page ID");
    if (targetPageId) {
      assertSafePageId(targetPageId, "target page ID");
    }
    if (target.replaceablePageId) {
      assertSafePageId(target.replaceablePageId, "replaceable page ID");
    }

    // A. Load English Blocks
    const rawBlocksPath = resolveSafePath(inputDir, `${enPageId}.raw-blocks.json`, "English raw-blocks path");
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
    const metaPath = resolveSafePath(inputDir, `${enPageId}.metadata.json`, "English metadata path");
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
    let rollbackNotion: (() => Promise<boolean>) | undefined;
    let result: TranslatePageResult | undefined;
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
      result = await translatePageContent({
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
            targetPageId = assertSafePageId(notionRes.pageId, "Notion page ID");
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
        targetPageId = assertSafePageId(`${enPageId}-${locale}`, "synthetic page ID");
        result.translatedMetadata.page_id = targetPageId;
        result.translatedMetadata.source_url = `https://notion.so/${targetPageId.replace(/-/g, "")}`;
        const updatedFrontmatter = buildFrontmatter(result.translatedMetadata);
        result.translatedMd = serializeDoc(updatedFrontmatter, result.markdownBody);
      }

      assertSafePageId(targetPageId, "target page ID");

      // Write output files in inputDir (pipeline output dir) using final targetPageId
      const outMdPath = resolveSafePath(inputDir, `${targetPageId}.md`, "output markdown path");
      const outMetaPath = resolveSafePath(inputDir, `${targetPageId}.metadata.json`, "output metadata path");
      const outBlocksPath = resolveSafePath(inputDir, `${targetPageId}.raw-blocks.json`, "output raw blocks path");

      trackAndWriteFile(outMdPath, result.translatedMd);
      trackAndWriteFile(outMetaPath, JSON.stringify(result.translatedMetadata, null, 2));
      trackAndWriteFile(outBlocksPath, JSON.stringify(result.translatedBlocks, null, 2));

      // If outputDir or Docusaurus path specified, write there too
      if (outputDir) {
        const docRelativePath = page.paths[locale];
        const docDest = resolveSafePath(outputDir, docRelativePath, "document destination");
        const rewritten = rewriteRawImgSrcToStatic(result.translatedMd);
        trackAndWriteFile(docDest, rewritten.content);
        copyReferencedAssets(outputDir, inputDir, page.paths[locale], rewritten.assets, enMetadata?.assets, trackAndWriteFile);
      }

      // Snapshot manifest before updating so it can be restored on write error
      if (!fileBackups.has(input)) {
        fileBackups.set(input, existsSync(input) ? readFileSync(input) : null);
      }

      // Update manifest.json with the finalized translation entry using canonical R2 paths
      updateManifestWithDoc(
        input,
        buildManifestDoc(targetPageId, result.translatedMetadata, locale),
        enPageId,
        target.replaceablePageId ?? target.targetPageId,
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
      let notionRolledBack = false;
      if (rollbackNotion) {
        console.warn(
          `${progress} Rolling back Notion changes on [${targetPageId}] due to persistence failure...`,
        );
        try {
          notionRolledBack = (await rollbackNotion()) === true;
          if (notionRolledBack) {
            console.log(`${progress} ✓ Rollback of Notion changes complete.`);
          } else {
            console.warn(
              `${progress} ⚠ Rollback of Notion changes declined or failed on [${targetPageId}]. Notion retained translated page.`,
            );
          }
        } catch (rollErr) {
          console.error(`${progress} Failed to rollback Notion changes on [${targetPageId}]:`, rollErr);
          notionRolledBack = false;
        }
      }

      const restorePreAttemptBackups = () => {
        restoreFileBackups(fileBackups, progress);
      };

      if (!rollbackNotion || notionRolledBack) {
        // Notion was either never touched or was cleanly rolled back.
        // Revert local files and manifest to avoid orphaned/partial artifacts.
        restorePreAttemptBackups();
      } else {
        // Rollback was declined or failed: Notion retained the translation.
        // Attempt to preserve generated local files and synchronize manifest so local state
        // remains consistent with Notion and avoids duplicate creation on retry.
        console.warn(
          `${progress} [Warning] Notion retained translation for [${targetPageId}]. Preserving local files and synchronizing manifest to prevent divergent state.`,
        );
        let recoveryCommitted = false;
        if (result) {
          const trackRecovery = (filePath: string, content: string | Buffer) => {
            if (!fileBackups.has(filePath)) {
              fileBackups.set(filePath, existsSync(filePath) ? readFileSync(filePath) : null);
            }
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, content);
          };
          try {
            const finalPageId = assertSafePageId(
              targetPageId || result.translatedMetadata.page_id || `${enPageId}-${locale}`,
              "recovery page ID",
            );
            const outMdPath = resolveSafePath(inputDir, `${finalPageId}.md`, "recovery markdown path");
            const outMetaPath = resolveSafePath(inputDir, `${finalPageId}.metadata.json`, "recovery metadata path");
            const outBlocksPath = resolveSafePath(inputDir, `${finalPageId}.raw-blocks.json`, "recovery raw blocks path");
            trackRecovery(outMdPath, result.translatedMd);
            trackRecovery(outMetaPath, JSON.stringify(result.translatedMetadata, null, 2));
            trackRecovery(outBlocksPath, JSON.stringify(result.translatedBlocks, null, 2));

            if (outputDir && page.paths[locale]) {
              try {
                const docDest = resolveSafePath(outputDir, page.paths[locale], "recovery document destination");
                const rewritten = rewriteRawImgSrcToStatic(result.translatedMd);
                trackRecovery(docDest, rewritten.content);
                copyReferencedAssets(
                  outputDir,
                  inputDir,
                  page.paths[locale],
                  rewritten.assets,
                  enMetadata?.assets,
                  trackRecovery,
                );
              } catch (destErr) {
                console.warn(`${progress} Skipping recovery doc in outputDir:`, destErr);
              }
            }

            if (!fileBackups.has(input)) {
              fileBackups.set(input, existsSync(input) ? readFileSync(input) : null);
            }
            updateManifestWithDoc(
              input,
              buildManifestDoc(finalPageId, result.translatedMetadata, locale),
              enPageId,
              target.replaceablePageId ?? target.targetPageId,
              {
                inputDir,
                includeDrafts,
              },
            );
            recoveryCommitted = true;
            console.log(
              `${progress} [Recovery] Successfully recorded retained translation [${finalPageId}] in manifest and local storage.`,
            );
          } catch (syncErr) {
            console.error(
              `${progress} Failed to persist retained translation [${targetPageId ?? "unknown"}] to manifest:`,
              syncErr,
            );
          }
        }

        // If manifest update could not be committed during recovery, restore pre-attempt backups
        // so no untracked/unrecorded files remain on disk without a manifest entry
        if (!recoveryCommitted) {
          restorePreAttemptBackups();
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

export function restoreFileBackups(
  fileBackups: Map<string, Buffer | null>,
  logPrefix?: string,
): void {
  for (const [filePath, originalContent] of fileBackups.entries()) {
    try {
      if (originalContent === null) {
        if (existsSync(filePath)) {
          rmSync(filePath, { force: true });
          if (logPrefix) {
            console.log(`${logPrefix} [Cleanup] Removed orphaned file: ${filePath}`);
          }
        }
      } else {
        writeFileSync(filePath, originalContent);
        if (logPrefix) {
          console.log(`${logPrefix} [Cleanup] Restored previous file: ${filePath}`);
        }
      }
    } catch (cleanupErr) {
      if (logPrefix) {
        console.error(`${logPrefix} Failed to clean up file ${filePath}:`, cleanupErr);
      }
    }
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
  assertSafePageId(doc.page_id, "document page ID");
  if (enPageId) {
    assertSafePageId(enPageId, "English parent page ID");
  }
  if (replacedPageId) {
    assertSafePageId(replacedPageId, "replaced page ID");
  }

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
  // Container mode: when the English doc is itself a Sub-item inside a container's
  // sub_items (section/toggle row), the translation family root is the container —
  // container-mode translations are siblings under the container, not children of
  // the English page. Recording the translation in enDoc.sub_items as well would
  // double-parent it and trip nested-family-skipped detection in buildHierarchyPlan.
  const containerDoc = enDoc
    ? data.docs.find(
        (d) =>
          d.page_id !== enDoc.page_id &&
          Array.isArray(d.sub_items) &&
          d.sub_items.includes(enDoc.page_id),
      )
    : undefined;
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
    assertSafePageId(d.page_id, "manifest doc page ID");
    const mdPath = resolveSafePath(inputDir, `${d.page_id}.md`, "manifest markdown path");
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

  // Helper to check if a doc is an explicit human translation
  const isExplicit = (d: ManifestDoc) =>
    (languageSourceById[d.page_id] ?? d.language_source) === "explicit";

  // 3. Match within the translation family (canonical hierarchy ranking).
  //    In container mode the family root is the container's sub_items; otherwise
  //    it is the English doc's own sub_items.
  // Reject explicit human translations: automated translation generation must never
  // silently overwrite an explicit human translation unless the caller explicitly supplied its page ID.
  const familyIds: string[] =
    containerDoc && Array.isArray(containerDoc.sub_items)
      ? containerDoc.sub_items
      : enDoc && Array.isArray(enDoc.sub_items)
        ? enDoc.sub_items
        : [];
  if (existingIdx < 0 && familyIds.length > 0) {
    const siblingCandidates = data.docs.filter(
      (d) =>
        familyIds.includes(d.page_id) &&
        d.locale === doc.locale &&
        !isExplicit(d),
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

        // 2. Prefer replacing fallback before automated
        const srcRank: Record<string, number> = { fallback: 0, automated: 1 };
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

  // 4. Section + slug + locale match (never slug alone across different sections)
  // Reject explicit candidates here unless the caller supplied their exact page ID as the intended replaceable stub.
  if (existingIdx < 0) {
    existingIdx = data.docs.findIndex(
      (d) =>
        d.locale === doc.locale &&
        d.slug === doc.slug &&
        d.section === doc.section &&
        !isExplicit(d),
    );
  }

  // 5. Exact storage key or canonical route path match within the same section
  // Reject explicit candidates here unless the caller supplied their exact page ID as the intended replaceable stub.
  if (existingIdx < 0) {
    existingIdx = data.docs.findIndex(
      (d) =>
        !isExplicit(d) &&
        ((doc.r2_doc_key && d.r2_doc_key && d.r2_doc_key === doc.r2_doc_key) ||
          (d.locale === doc.locale &&
            d.section === doc.section &&
            doc.docusaurus_path &&
            d.docusaurus_path &&
            d.docusaurus_path === doc.docusaurus_path)),
    );
  }

  // If an explicit human translation already exists for this locale + section + slug (or route),
  // reject replacing or shadowing it with an automated translation unless caller explicitly supplied its page ID.
  if (existingIdx < 0) {
    const explicitConflict = data.docs.find(
      (d) =>
        isExplicit(d) &&
        ((d.locale === doc.locale && d.slug === doc.slug && d.section === doc.section) ||
          (doc.r2_doc_key && d.r2_doc_key && d.r2_doc_key === doc.r2_doc_key) ||
          (d.locale === doc.locale &&
            d.section === doc.section &&
            doc.docusaurus_path &&
            d.docusaurus_path &&
            d.docusaurus_path === doc.docusaurus_path)),
    );
    if (explicitConflict) {
      throw new Error(
        `[manifest] Cannot replace explicit human translation [${explicitConflict.page_id}] for "${doc.slug}" (${doc.locale}) with automated translation without exact page ID or --force.`,
      );
    }
  }

  if (existingIdx >= 0) {
    previousPageId = data.docs[existingIdx].page_id;
    data.docs[existingIdx] = doc;
  } else {
    data.docs.push(doc);
  }

  if (containerDoc && Array.isArray(containerDoc.sub_items)) {
    // Container mode: record the translation as a sibling under the container
    // family root, and make sure the English doc does not claim it in its own
    // sub_items (which would double-parent it).
    if (previousPageId && previousPageId !== doc.page_id) {
      containerDoc.sub_items = containerDoc.sub_items.filter((id) => id !== previousPageId);
    }
    if (!containerDoc.sub_items.includes(doc.page_id)) {
      containerDoc.sub_items.push(doc.page_id);
    }
    if (enDoc && Array.isArray(enDoc.sub_items)) {
      enDoc.sub_items = enDoc.sub_items.filter(
        (id) => id !== doc.page_id && id !== previousPageId,
      );
    }
  } else if (enDoc) {
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
  const resolvedInputDir = resolve(inputDir);
  const assetsSrcDir = resolve(resolvedInputDir, "assets");
  if (!assetsSrcDir.startsWith(resolvedInputDir + "/") && assetsSrcDir !== resolvedInputDir) {
    return;
  }
  if (!existsSync(assetsSrcDir)) return;

  const resolvedOutputDir = resolve(outputDir);
  const docDest = resolve(resolvedOutputDir, docRelativePath);
  if (!docDest.startsWith(resolvedOutputDir + "/") && docDest !== resolvedOutputDir) {
    return;
  }
  const docDir = dirname(docDest);
  if (!docDir.startsWith(resolvedOutputDir + "/") && docDir !== resolvedOutputDir) {
    return;
  }
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
