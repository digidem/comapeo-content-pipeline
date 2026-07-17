/**
 * docs:pull implementation — turns the synced manifest + per-page markdown into
 * a local Docusaurus-compatible docs tree (default locale under docs/, translations
 * under i18n/<locale>/docusaurus-plugin-content-docs/current/).
 *
 * Extracted verbatim from src/cli/index.ts so it can be unit-tested in isolation.
 * The thin cmdDocsPull wrapper in index.ts catches DocsPullError and exits(1).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { buildHierarchyPlan, toSectionDir, type CategoryEntry } from "../lib/hierarchy.js";
import { buildRouteMaps, resolveInternalLinks, type DocLite } from "../lib/links.js";
import { rewriteRawImgSrcToStatic } from "../lib/img-rewrite.js";
import { isStubBody } from "../lib/stub-body.js";
import {
  SECTION_NAMES,
  UNCATEGORIZED_ORDER,
} from "../lib/notion-properties.js";

export { toSectionDir };

/** Escape a raw string for embedding in a double-quoted YAML scalar. */
function yamlQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Error thrown by docsPull for fatal-but-recoverable conditions (missing manifest, etc.). */
export class DocsPullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsPullError";
  }
}

/** Node-side preflight: read language_source and body availability from disk. */
function preflightMetadata(inputDir: string, docs: Array<{ page_id: string; language_source?: string }>): {
  languageSourceById: Record<string, "explicit" | "automated" | "fallback">;
  hasBodyById: Record<string, boolean>;
} {
  const languageSourceById: Record<string, "explicit" | "automated" | "fallback"> = {};
  const hasBodyById: Record<string, boolean> = {};

  for (const doc of docs) {
    // First check manifest's own language_source
    if (doc.language_source) {
      languageSourceById[doc.page_id] = doc.language_source as "explicit" | "automated" | "fallback";
    }

    const metaPath = join(inputDir, `${doc.page_id}.metadata.json`);
    try {
      if (existsSync(metaPath)) {
        const raw = JSON.parse(readFileSync(metaPath, "utf8"));
        if (raw.language_source && !languageSourceById[doc.page_id]) {
          languageSourceById[doc.page_id] = raw.language_source;
        }
        const langProp = raw.properties?.["Language"];
        if (langProp && typeof langProp === "object" && !languageSourceById[doc.page_id]) {
          const name = (langProp as Record<string, unknown>).select
            ? ((langProp as Record<string, unknown>).select as Record<string, unknown>).name
            : (langProp as Record<string, unknown>).name;
          if (typeof name === "string") {
            languageSourceById[doc.page_id] = /\bautomated\b/i.test(name) ? "automated" : "explicit";
          }
        }
      }
    } catch { /* ignore */ }

    // Check body availability using exact same logic as isStubBody
    const mdPath = join(inputDir, `${doc.page_id}.md`);
    try {
      if (existsSync(mdPath)) {
        const raw = readFileSync(mdPath, "utf8");
        hasBodyById[doc.page_id] = !isStubBody(raw);
      }
    } catch { /* ignore */ }
  }

  return { languageSourceById, hasBodyById };
}

export async function docsPull(args: Record<string, string>): Promise<void> {
  const input = args.input || args.manifest || join(process.cwd(), "output/manifest.json");
  const outDir = args.out || "./docs";

  if (!existsSync(input)) {
    throw new DocsPullError(
      `Manifest not found: ${input}\nRun sync:full first, or specify --input pointing to manifest.json`,
    );
  }

  const manifest = JSON.parse(readFileSync(input, "utf8"));
  const inputDir = args["input-dir"] || join(process.cwd(), "output");

  mkdirSync(outDir, { recursive: true });

  // Node-side preflight: read language_source and body availability from disk
  const preflight = preflightMetadata(inputDir, manifest.docs);

  // ── Build canonical hierarchy plan ──
  const plan = buildHierarchyPlan({
    docs: manifest.docs,
    includeDrafts: args.all === "true",
    languageSourceById: preflight.languageSourceById,
    hasBodyById: preflight.hasBodyById,
  });

  // ── Report diagnostics ──
  if (plan.diagnostics.length > 0) {
    console.warn(`\n  Translation validation: ${plan.diagnostics.length} issue(s) found:`);
    for (const d of plan.diagnostics) {
      console.warn(`    [${d.category}] ${d.pageId} ("${d.title}") — ${d.detail}`);
    }
  }

  // ── Build route maps (needs canonicalSlugOf) ──
  const docById = new Map<string, (typeof manifest.docs)[number]>();
  for (const doc of manifest.docs) {
    docById.set(doc.page_id, doc);
  }

  // Build pageId → canonicalSlug for all canonical pages + route aliases
  const pageIdToCanonicalSlug = new Map<string, string>();
  for (const cp of plan.canonicalPages) {
    pageIdToCanonicalSlug.set(cp.pageId, cp.canonicalSlug);
  }
  // Include route aliases for family members
  for (const alias of plan.routeAliases) {
    if (!pageIdToCanonicalSlug.has(alias.pageId)) {
      pageIdToCanonicalSlug.set(alias.pageId, alias.canonicalSlug);
    }
  }

  const canonicalSlugOf = (pageId: string): string | null => {
    return pageIdToCanonicalSlug.get(pageId) ?? null;
  };
  const routeMaps = buildRouteMaps(manifest.docs as DocLite[], canonicalSlugOf);

  // ── Emit canonical pages ──
  let count = 0;
  let skippedStubTranslations = 0;
  let stubBodyFallbacks = 0;
  const writtenDocPaths = new Set<string>();
  const writtenSectionDirs = new Set<string>();
  const writtenCategoryPaths = new Set<string>();
  const inlineStaticAssets = new Set<string>();
  const emitDiagnostics: Array<{ category: string; pageId: string; title: string; detail: string }> = [];

  // Collect pending headings for content page emission
  // buildHierarchyPlan returns pendingHeadings from the hierarchy pass

  for (const cp of plan.canonicalPages) {
    const srcFile = join(inputDir, `${cp.pageId}.md`);
    if (!existsSync(srcFile)) {
      emitDiagnostics.push({ category: "missing-source", pageId: cp.pageId, title: cp.title, detail: srcFile });
      continue;
    }

    let content = readFileSync(srcFile, "utf8");

    // Repair broken image placeholders left by upstream translation tooling.
    // A translated page can otherwise be real, fully-translated content with
    // one or more images replaced by an inline text placeholder (e.g. a raw
    // "static/images/<name>_<n>.<ext>" path, or a bracketed "[Image
    // Placeholder]" marker) inside a `:::note 🖼️ ... :::` callout — this is
    // NOT a whole-page stub, so it doesn't go through the EN-body-fallback
    // path below. Recover each placeholder positionally: the Nth 🖼️ callout
    // in this page is replaced with the Nth real image from its EN sibling,
    // for as many EN images as are available; any placeholder beyond that is
    // left untouched (nothing to recover it with).
    if (cp.locale !== "en" && cp.enSiblingPageId) {
      const enSrcForImages = join(inputDir, `${cp.enSiblingPageId}.md`);
      if (existsSync(enSrcForImages)) {
        content = repairBrokenImagePlaceholders(content, readFileSync(enSrcForImages, "utf8"));
      }
    }

    // Rewrite id/slug/position to canonical values
    if (cp.canonicalSlug !== cp.doc.slug) {
      content = content
        .replace(/^id: .*$/m, `id: "${cp.canonicalSlug}"`)
        .replace(/^slug: .*$/m, `slug: /${cp.canonicalSlug}`);
    }
    if (cp.canonicalOrder !== (cp.doc.section_order ?? UNCATEGORIZED_ORDER)) {
      content = content.replace(/^sidebar_position: .*$/m, `sidebar_position: ${cp.canonicalOrder}`);
    }

    // Strip stray Notion "[Insert/ADD content here]" placeholder lines
    content = content.replace(/^[ \t]*\[\s*(?:insert|add)\s+content\s+here\s*\][ \t]*\r?\n?/gim, "");

    // Strip trailing `---` divider inserted by Notion converter after a
    // single-image block. Must NOT strip the closing YAML frontmatter `---`
    // delimiter — only strip an extra `---` that appears after the frontmatter
    // pair (i.e. when there are ≥3 `---` separators in the file, remove the
    // trailing one that a single-block Notion converter adds as an <hr>).
    const fmEnd = content.indexOf("\n---\n", 4);
    if (fmEnd !== -1) {
      const bodyStart = fmEnd + 5; // after the closing `\n---\n`
      const body = content.slice(bodyStart);
      const strippedBody = body.replace(/\n*---\n*$/, "\n");
      if (strippedBody !== body) {
        content = content.slice(0, bodyStart) + strippedBody;
      }
    }

    // Build Docusaurus path. Pages inside a Toggle group go into the Toggle
    // directory (nested under the section dir). Pages outside any Toggle go
    // directly under the section dir (or locale root for Uncategorized).
    const sectionDir = cp.canonicalSection !== SECTION_NAMES.UNCATEGORIZED
      ? toSectionDir(cp.canonicalSection)
      : null;

    const pathParts: string[] = [];
    if (cp.locale === "en") {
      pathParts.push(outDir, "docs");
    } else {
      pathParts.push(outDir, "i18n", cp.locale, "docusaurus-plugin-content-docs", "current");
    }
    if (sectionDir) pathParts.push(sectionDir);
    if (cp.toggleDir) pathParts.push(cp.toggleDir);
    pathParts.push(`${cp.canonicalSlug}.md`);

    const finalPath = join(...pathParts);

    // Inject sidebar_custom_props.title from pending heading if present
    if (cp.customPropsTitle) {
      const quotedTitle = yamlQuote(cp.customPropsTitle);
      if (content.includes("sidebar_custom_props:")) {
        // Use a replacer function so quotedTitle is inserted literally — a string
        // replacement would reinterpret $-patterns (e.g. $1, $&) inside the title.
        content = content.replace(
          /^sidebar_custom_props:.*$/m,
          () => `sidebar_custom_props:\n  title: "${quotedTitle}"`,
        );
      } else {
        content = content.replace(
          /^(sidebar_position: .*\n)/m,
          (_match, g1: string) => `${g1}sidebar_custom_props:\n  title: "${quotedTitle}"\n`,
        );
      }
    }

    // Stub body handling
    const isStub = isStubBody(content);
    if (isStub) {
      if (cp.locale !== "en") {
        // Try EN body fallback for header-preserving stub
        if (cp.enFallbackPageId) {
          const enSrc = join(inputDir, `${cp.enFallbackPageId}.md`);
          if (existsSync(enSrc)) {
            const enBody = readFileSync(enSrc, "utf8");
            const enFm = enBody.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
            if (enFm && enFm[2] && enFm[2].trim().length > 0) {
              // Replace body with EN body, keep localized frontmatter
              const localFm = content.match(/^---\n([\s\S]*?)\n---\n?/);
              if (localFm) {
                content = `---\n${localFm[1]}\n---\n${enFm[2]}`;
                stubBodyFallbacks++;
                emitDiagnostics.push({ category: "stub-translation-body-fallback", pageId: cp.pageId, title: cp.title, detail: "Using EN body fallback; preserving localized title" });
              }
            }
          }
        }
        if (isStubBody(content)) {
          skippedStubTranslations++;
          emitDiagnostics.push({ category: "stub-translation", pageId: cp.pageId, title: cp.title, detail: "Empty/stub body; skipped for Docusaurus EN fallback" });
          continue;
        }
      } else {
        content = ensurePlaceholderForEmptyBody(content);
      }
    }

    // Resolve internal cross-references (after EN body fallback so links are locale-correct)
    content = resolveInternalLinks(content, { locale: cp.locale, maps: routeMaps });

    mkdirSync(join(finalPath, ".."), { recursive: true });

    // Rewrite inline <img> assets
    const rewritten = rewriteRawImgSrcToStatic(content);
    content = rewritten.content;
    for (const assetFile of rewritten.assets) inlineStaticAssets.add(assetFile);
    writeFileSync(finalPath, content);
    writtenDocPaths.add(finalPath);
    writtenSectionDirs.add(join(finalPath, ".."));
    count++;
  }

  // ── Emit _category_.json from plan ──
  // The synthetic "Uncategorized" section has no directory of its own — its
  // pages are written straight into the locale root (see the sectionDir ??
  // null branch in the page-emission loop above), and root pages render as
  // plain sidebar IDs, not inside a category (see projectSidebars). Skip the
  // section-level entry entirely so no empty _category_.json is left behind;
  // a Toggle nested under it still gets a real directory, just without the
  // "uncategorized" path segment.
  const UNCATEGORIZED_DIR = toSectionDir(SECTION_NAMES.UNCATEGORIZED);
  for (const cat of plan.categories) {
    const isRootSection = cat.sectionDir === UNCATEGORIZED_DIR;
    if (isRootSection && !cat.toggleDir) continue;

    const localePrefix =
      cat.locale === "en"
        ? join(outDir, "docs")
        : join(outDir, "i18n", cat.locale, "docusaurus-plugin-content-docs", "current");

    const parts = [localePrefix];
    if (!isRootSection) parts.push(cat.sectionDir);
    if (cat.toggleDir) parts.push(cat.toggleDir);
    const categoryDir = join(...parts);

    // Skip Toggle category if no Markdown file has this directory as its parent
    if (cat.toggleDir) {
      const parentDir = categoryDir;
      let hasPage = false;
      for (const p of writtenDocPaths) {
        if (dirname(p) === parentDir) { hasPage = true; break; }
      }
      if (!hasPage) continue;
    }

    if (!existsSync(categoryDir)) {
      mkdirSync(categoryDir, { recursive: true });
    }

    const catPath = join(categoryDir, "_category_.json");
    writtenCategoryPaths.add(catPath);

    const categoryJson = {
      key: cat.key,
      label: cat.label,
      position: cat.position,
      collapsible: true,
      collapsed: true,
      link: {
        type: "generated-index" as const,
        title: cat.label,
      },
      customProps: { title: cat.customPropsTitle ?? null },
    };
    writeFileSync(join(categoryDir, "_category_.json"), JSON.stringify(categoryJson, null, 2));
  }

  // ── Emit current.json for non-default locales ──
  // Docusaurus 3.10.1 ignores localized _category_.json labels for sidebar
  // translation; it reads i18n/<locale>/docusaurus-plugin-content-docs/current.json
  // with keys derived from each CategoryEntry.key. See docs-pull.test.ts
  // → "current.json" describe block for full coverage.
  //
  // Keys are driven by EN source-sidebar categories so that ES/PT key sets
  // exactly match the rendered English category keys.  Empty toggle
  // categories are excluded unless at least one EN canonical page lives in
  // the same sectionDir + toggleDir (matching projectSidebars exclusion).
  // The root ("Uncategorized") section-level entry is excluded because Docusaurus
  // renders those docs as plain sidebar IDs — write-translations emits no category
  // key for it. A Toggle nested under the root section is still a real category.
  const nonEnLocales = new Set(
    plan.categories
      .filter((c) => c.locale !== "en")
      .map((c) => c.locale),
  );

  if (nonEnLocales.size > 0) {
    // Build set of EN toggle keys backed by at least one EN canonical page
    const enPageToggleKeys = new Set<string>();
    for (const cp of plan.canonicalPages) {
      if (cp.locale === "en" && cp.toggleDir) {
        enPageToggleKeys.add(`${toSectionDir(cp.canonicalSection)}/${cp.toggleDir}`);
      }
    }

    // Build fast lookup: locale / sectionDir / toggleDir → CategoryEntry
    const catBySlot = new Map<string, CategoryEntry>();
    for (const cat of plan.categories) {
      catBySlot.set(`${cat.locale}/${cat.sectionDir}/${cat.toggleDir ?? ""}`, cat);
    }

    // English categories define the key set (Docusaurus write-translations parity)
    const enCats = plan.categories.filter((c) => c.locale === "en");

    for (const locale of nonEnLocales) {
      const currentJson: Record<string, { message: string; description: string }> = {};

      // version.label — matches Docusaurus write-translations output
      currentJson["version.label"] = {
        message: "Latest",
        description: "The label for version current",
      };

      for (const enCat of enCats) {
        // Uncategorized pages are plain sidebar IDs; Docusaurus emits no category
        // key for the section itself. A Toggle nested under it still gets a real
        // directory and category, so only skip the section-level entry.
        if (enCat.sectionDir === UNCATEGORIZED_DIR && !enCat.toggleDir) continue;
        // Exclude EN toggle categories backed by zero EN canonical pages
        if (enCat.toggleDir && !enPageToggleKeys.has(enCat.key)) continue;

        const locCat = catBySlot.get(`${locale}/${enCat.sectionDir}/${enCat.toggleDir ?? ""}`);
        const locLabel = locCat?.label ?? enCat.label;

        const categoryKey = `sidebar.docsSidebar.category.${enCat.key}`;
        currentJson[categoryKey] = {
          message: locLabel,
          description: `The label for category '${enCat.label}' in sidebar 'docsSidebar'`,
        };
        currentJson[`${categoryKey}.link.generated-index.title`] = {
          message: locLabel,
          description: `The generated-index page title for category '${enCat.label}' in sidebar 'docsSidebar'`,
        };
      }

      const i18nPluginsDir = join(outDir, "i18n", locale, "docusaurus-plugin-content-docs");
      mkdirSync(i18nPluginsDir, { recursive: true });
      writeFileSync(join(i18nPluginsDir, "current.json"), JSON.stringify(currentJson, null, 2));
    }
  }

  // ── Copy assets ──
  const assetsDir = join(inputDir, "assets");
  await optimizeAssets(assetsDir);

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
        const referenced = collectReferencedAssets(sectionAbsDir, availableAssets);
        if (referenced.size === 0) continue;
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

    if (inlineStaticAssets.size > 0) {
      const staticDir = join(outDir, "static", "images", "notion");
      mkdirSync(staticDir, { recursive: true });
      let staticCopied = 0;
      for (const f of inlineStaticAssets) {
        if (f.includes("/") || f.includes("\\") || f.includes("..")) {
          console.warn(`  Skipping unsafe inline asset name (path segment): ${f}`);
          continue;
        }
        const src = join(assetsDir, f);
        if (!existsSync(src)) {
          console.warn(`  Missing inline asset in pool: ${f}`);
          continue;
        }
        writeFileSync(join(staticDir, f), readFileSync(src));
        staticCopied++;
      }
      console.log(`  Published ${staticCopied} inline assets to static/images/notion/`);
    }
  }

  // ── Clean orphans ──
  if (args["clean-orphans"] === "true") {
    const expectedPaths = writtenDocPaths;
    let removed = 0;
    const removeOrphans = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          removeOrphans(fullPath);
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
        } else if (entry.name === "_category_.json" && !writtenCategoryPaths.has(fullPath)) {
          unlinkSync(fullPath);
          removed++;
        } else if (entry.name.endsWith(".md") && !expectedPaths.has(fullPath)) {
          unlinkSync(fullPath);
          removed++;
        }
      }
    };
    removeOrphans(join(outDir, "docs"));
    const i18nRoot = join(outDir, "i18n");
    if (existsSync(i18nRoot)) {
      for (const entry of readdirSync(i18nRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const i18nDir = join(i18nRoot, entry.name, "docusaurus-plugin-content-docs", "current");
        if (existsSync(i18nDir)) removeOrphans(i18nDir);
      }
    }
    if (removed > 0) console.log(`  Removed ${removed} orphaned files`);
  }

  if (stubBodyFallbacks > 0) {
    console.warn(`  (${stubBodyFallbacks} stub translation${stubBodyFallbacks === 1 ? "" : "s"} → EN body fallback with localized title)`);
  }
  if (skippedStubTranslations > 0) {
    console.warn(`  (skipped ${skippedStubTranslations} stub translation${skippedStubTranslations === 1 ? "" : "s"} → English fallback)`);
  }
  if (emitDiagnostics.length > 0) {
    console.warn(`  Emit diagnostics: ${emitDiagnostics.length} issue(s):`);
    for (const d of emitDiagnostics) {
      console.warn(`    [${d.category}] ${d.pageId} ("${d.title}") — ${d.detail}`);
    }
  }
  console.log(`Pulled ${count} active docs to ${outDir}`);
}

// ── Helpers ──

const PLACEHOLDER_BODY = `:::note
Content coming soon — this page has no content in Notion yet.
:::`;

function ensurePlaceholderForEmptyBody(content: string): string {
  if (!isStubBody(content)) return content;
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return `${PLACEHOLDER_BODY}\n`;
  return `---\n${fmMatch[1]}\n---\n${PLACEHOLDER_BODY}\n`;
}

/** A single-line untranslatable-image marker left inside a picture-frame callout
 * by upstream translation tooling — either a guessed static path (e.g.
 * "static/images/name_0.png") or a bracketed marker (e.g. "[Image Placeholder]",
 * "[Espaço Reservado para Imagem]", "[Marcador de Imagen]"). Constrained to
 * these two known shapes (rather than any single-line 🖼️ callout body) so a
 * legitimate human-authored note that happens to use the same icon is never
 * mistaken for a broken-image marker.
 */
const IMAGE_PLACEHOLDER_CALLOUT = /:::note 🖼️\n(?:static\/images\/[^\n]+|\[[^\]\n]+\])\n\n:::/g;
const REAL_IMAGE_MARKDOWN = /!\[[^\]]*\]\(assets\/[^)]+\)/g;

/** Matches either a broken-image placeholder or a surviving real image, in document order. */
const IMAGE_SLOT_PATTERN = new RegExp(`${IMAGE_PLACEHOLDER_CALLOUT.source}|${REAL_IMAGE_MARKDOWN.source}`, "g");

/**
 * Replace each broken image-placeholder callout in a translated page's body
 * with the real image at the same position in its EN sibling, positionally
 * (Nth image slot here ↔ Nth real image there). Counts every image slot in
 * document order — placeholders AND surviving real images — so a page where
 * some images survived translation and others became placeholders still maps
 * each placeholder to its correct EN counterpart instead of shifting by the
 * number of images that already survived. A placeholder beyond the EN
 * sibling's image count is left untouched.
 */
function repairBrokenImagePlaceholders(content: string, enBody: string): string {
  const enImages = enBody.match(REAL_IMAGE_MARKDOWN);
  if (!enImages || enImages.length === 0) return content;
  let i = 0;
  return content.replace(IMAGE_SLOT_PATTERN, (match) => {
    const isPlaceholder = match.startsWith(":::note");
    const enImage = i < enImages.length ? enImages[i] : null;
    i++;
    return isPlaceholder && enImage ? enImage : match;
  });
}

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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

type SharpPipeline = {
  resize: (opts: Record<string, unknown>) => SharpPipeline;
  png: (opts: Record<string, unknown>) => SharpPipeline;
  jpeg: (opts: Record<string, unknown>) => SharpPipeline;
  webp: (opts: Record<string, unknown>) => SharpPipeline;
  toBuffer: () => Promise<Buffer>;
};

async function optimizeAssets(assetsDir: string): Promise<void> {
  if (!existsSync(assetsDir)) return;

  const SHARP_SPECIFIER = "sharp";
  let sharpFn: (input: string) => SharpPipeline;
  try {
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
