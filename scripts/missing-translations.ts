/**
 * missing-translations — report which locale versions are missing for every
 * published markdown page in the documentation.
 *
 * Works exactly like docs:pull: loads the synced manifest, builds the
 * canonical hierarchy plan (translation families resolved via the Sub-item
 * relation), groups canonical pages by their locale-free route key, and
 * compares the locales present in each family against the supported locales.
 *
 * A locale counts as present when the family selected a member for it.
 * A member that carries no real translation is reported in `english_content`:
 * either its language_source is "fallback", or its body is a stub (docs:pull
 * then substitutes the EN body, or skips the file entirely when no EN
 * fallback exists). Note: production deploys use docs:pull --all, so run
 * this script with --all to match the published site.
 *
 * Usage:
 *   bun scripts/missing-translations.ts [--input output/manifest.json]
 *                                       [--input-dir output]
 *                                       [--all] [--only-missing]
 *
 * JSON goes to stdout; hierarchy diagnostics go to stderr.
 * buildReport() is exported for reuse (see translation-report-html.ts).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHierarchyPlan, toSectionDir, type CanonicalPage } from "../src/lib/hierarchy.js";
import { SECTION_NAMES } from "../src/lib/notion-properties.js";
import { isStubBody } from "../src/lib/stub-body.js";
import { ContentManifestSchema, PAGE_ID_REGEX, type ContentManifest, type ManifestDoc } from "../src/schemas/manifest.js";
import { parseArgs } from "./lib/args.js";

const SUPPORTED_LOCALES = ["en", "es", "pt"] as const;
type LanguageSource = "explicit" | "automated" | "fallback";

/** Mirror of preflightMetadata in src/cli/docs-pull.ts. */
function preflight(inputDir: string, docs: ManifestDoc[]): {
  languageSourceById: Record<string, LanguageSource>;
  hasBodyById: Record<string, boolean>;
  hasSourceById: Record<string, boolean>;
} {
  const languageSourceById: Record<string, LanguageSource> = {};
  const hasBodyById: Record<string, boolean> = {};
  const hasSourceById: Record<string, boolean> = {};

  const resolvedInputDir = resolve(inputDir);

  for (const doc of docs) {
    if (doc.language_source) {
      languageSourceById[doc.page_id] = doc.language_source;
    }

    if (!doc.page_id || !PAGE_ID_REGEX.test(doc.page_id)) {
      continue;
    }

    const metaPath = resolve(resolvedInputDir, `${doc.page_id}.metadata.json`);
    if (!metaPath.startsWith(resolvedInputDir + "/") && metaPath !== resolvedInputDir) {
      continue;
    }
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
    } catch { /* ignore unreadable blob */ }

    const mdPath = resolve(resolvedInputDir, `${doc.page_id}.md`);
    if (!mdPath.startsWith(resolvedInputDir + "/") && mdPath !== resolvedInputDir) {
      continue;
    }
    try {
      if (existsSync(mdPath)) {
        hasSourceById[doc.page_id] = true;
        hasBodyById[doc.page_id] = !isStubBody(readFileSync(mdPath, "utf8"));
      }
    } catch { /* ignore unreadable body */ }
  }

  return { languageSourceById, hasBodyById, hasSourceById };
}

/** Mirror of the docs-pull output path formula (src/cli/docs-pull.ts). */
function mdPath(cp: CanonicalPage, locale: string): string {
  const sectionDir = cp.canonicalSection !== SECTION_NAMES.UNCATEGORIZED
    ? toSectionDir(cp.canonicalSection)
    : null;

  const parts: string[] = locale === "en"
    ? ["docs"]
    : ["i18n", locale, "docusaurus-plugin-content-docs", "current"];
  if (sectionDir) parts.push(sectionDir);
  if (cp.toggleDir) parts.push(cp.toggleDir);
  parts.push(`${cp.canonicalSlug}.md`);
  return join(...parts);
}

/**
 * Locale-free route key, mirroring the final-key dedupe in hierarchy.ts
 * (which keys on [locale, section, toggleDir, slug]). canonicalSlug alone
 * is NOT unique — two pages with the same title in different sections or
 * toggle groups would otherwise collapse into one report entry.
 */
function routeKey(cp: CanonicalPage): string {
  const sectionComponent = cp.canonicalSection === SECTION_NAMES.UNCATEGORIZED
    ? ""
    : toSectionDir(cp.canonicalSection);
  return JSON.stringify([sectionComponent, cp.toggleDir ?? "", cp.canonicalSlug]);
}

interface LocaleDetail {
  page_id: string;
  language_source: LanguageSource;
  has_body: boolean;
}

export interface PageReport {
  slug: string;
  title: string;
  section: string;
  parentId?: string;
  toggleDir?: string;
  present: string[];
  missing: string[];
  english_content: string[];
  locales: Record<string, LocaleDetail>;
  paths: Record<string, string>;
}

export interface TranslationReport {
  generated_from: string;
  generated_at?: string;
  include_drafts: boolean;
  supported_locales: readonly string[];
  summary: {
    total_pages: number;
    complete: number;
    missing_translation: number;
    english_content_only: number;
    missing_by_locale: Record<string, number>;
    english_content_by_locale: Record<string, number>;
  };
  pages: PageReport[];
}

export interface ReportOptions {
  input?: string;
  inputDir?: string;
  includeDrafts?: boolean;
  onlyMissing?: boolean;
}

export function buildReport(opts: ReportOptions = {}): TranslationReport {
  const input = opts.input || join(process.cwd(), "output/manifest.json");
  const inputDir = opts.inputDir || join(process.cwd(), "output");
  const includeDrafts = opts.includeDrafts ?? false;
  const onlyMissing = opts.onlyMissing ?? false;

  if (!existsSync(input)) {
    throw new Error(`Manifest not found: ${input}\nRun sync:full first, or pass --input <manifest.json>.`);
  }

  let manifest: ContentManifest;
  try {
    manifest = ContentManifestSchema.parse(JSON.parse(readFileSync(input, "utf8")));
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`Invalid manifest at ${input}: ${detail}`, { cause: err });
  }

  const { languageSourceById, hasBodyById, hasSourceById } = preflight(inputDir, manifest.docs);
  const plan = buildHierarchyPlan({
    docs: manifest.docs,
    includeDrafts,
    languageSourceById,
    hasBodyById,
  });

  for (const d of plan.diagnostics) {
    console.error(`[hierarchy:${d.category}] ${d.pageId} ("${d.title}"): ${d.detail}`);
  }

  // Group published pages (one CanonicalPage per locale member) by route.
  const byRoute = new Map<string, CanonicalPage[]>();
  for (const cp of plan.canonicalPages) {
    const members = byRoute.get(routeKey(cp)) ?? [];
    members.push(cp);
    byRoute.set(routeKey(cp), members);
  }

  const pages: PageReport[] = [];
  const missingByLocale: Record<string, number> = {};
  const englishContentByLocale: Record<string, number> = {};

  const sorted = [...byRoute.entries()].sort((a, b) => {
    const order = (a[1][0]?.canonicalOrder ?? 0) - (b[1][0]?.canonicalOrder ?? 0);
    return order !== 0 ? order : (a[1][0]?.canonicalSlug ?? "").localeCompare(b[1][0]?.canonicalSlug ?? "");
  });

  for (const [, members] of sorted) {
    // normalizeLocale passes unknown locales through, so a family could in
    // theory carry a locale outside the supported set; drop those members so
    // present/missing/locales/paths stay mutually consistent.
    const supported = members.filter((m) => (SUPPORTED_LOCALES as readonly string[]).includes(m.locale));
    if (supported.length === 0) continue;

    const rep = supported.find((m) => m.locale === "en") ?? supported[0];
    const presentMap = new Map(supported.map((m) => [m.locale, m]));

    // A non-EN member with no real body is only rescued by docs:pull's EN-body
    // fallback when an EN sibling with a real body exists (enFallbackPageId set —
    // src/lib/hierarchy.ts). Without that, docs:pull's stub handling skips
    // writing the file entirely (src/cli/docs-pull.ts), so the locale is
    // effectively missing from the published site, not present with English
    // content — report it as missing, matching what actually ships.
    //
    // Similarly, docs:pull checks whether each canonical page's markdown source file
    // exists on disk before doing any work (and if using EN fallback, that the EN
    // source file exists too). If a member's source file is missing from inputDir,
    // docs:pull emits nothing for it, so it must be reported as missing.
    const present: string[] = [];
    const missing: string[] = [];
    const englishContent: string[] = [];
    for (const l of SUPPORTED_LOCALES) {
      const m = presentMap.get(l);
      const hasSource = m ? Boolean(hasSourceById[m.pageId]) : false;
      const hasEnFallbackSource = m?.enFallbackPageId
        ? Boolean(hasSourceById[m.enFallbackPageId])
        : false;

      if (!m || !hasSource || (l !== "en" && !m.hasBody && (!m.enFallbackPageId || !hasEnFallbackSource))) {
        missing.push(l);
        continue;
      }
      present.push(l);
      if (l !== "en" && (m.languageSource === "fallback" || !m.hasBody)) {
        englishContent.push(l);
      }
    }

    for (const l of missing) missingByLocale[l] = (missingByLocale[l] ?? 0) + 1;
    for (const l of englishContent) englishContentByLocale[l] = (englishContentByLocale[l] ?? 0) + 1;

    pages.push({
      slug: rep.canonicalSlug,
      title: rep.title,
      section: rep.canonicalSection,
      parentId: rep.parentId,
      toggleDir: rep.toggleDir,
      present,
      missing,
      english_content: englishContent,
      locales: Object.fromEntries(
        supported.map((m) => [m.locale, {
          page_id: m.pageId,
          language_source: m.languageSource,
          has_body: m.hasBody,
        }]),
      ),
      paths: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, mdPath(presentMap.get(l) ?? rep, l)])),
    });
  }

  const visible = onlyMissing
    ? pages.filter((p) => p.missing.length > 0 || p.english_content.length > 0)
    : pages;

  return {
    generated_from: input,
    include_drafts: includeDrafts,
    supported_locales: SUPPORTED_LOCALES,
    summary: {
      total_pages: pages.length,
      complete: pages.filter((p) => p.missing.length === 0 && p.english_content.length === 0).length,
      missing_translation: pages.filter((p) => p.missing.length > 0).length,
      english_content_only: pages.filter((p) => p.missing.length === 0 && p.english_content.length > 0).length,
      missing_by_locale: missingByLocale,
      english_content_by_locale: englishContentByLocale,
    },
    pages: visible,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = buildReport({
      input: args.input,
      inputDir: args["input-dir"],
      includeDrafts: args.all === "true",
      onlyMissing: args["only-missing"] === "true",
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
