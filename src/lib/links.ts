/**
 * Internal link & anchor resolution for the docs:pull pass.
 *
 * Notion authors cross-references against clean, often *localized* slugs
 * (e.g. `/docs/invita-colaboradores`) and original-cased heading anchors
 * (e.g. `#Edit-an-observation`). Docusaurus, however, publishes every
 * translation under the English source's slug (es/pt are served at
 * `/es/docs/<en-slug>` via i18n fallback), and generates heading IDs in
 * lowercase-hyphenated form.
 *
 * This module rewrites internal links to the actual published route for the
 * file's locale and slugifies `#anchor` fragments to the Docusaurus heading-ID
 * format, leaving genuinely-unknown targets untouched.
 *
 * Runtime-agnostic (no Node APIs).
 */

import GithubSlugger from "github-slugger";
import { slugify } from "./slug.js";

/**
 * Slugify a heading anchor to the Docusaurus heading-ID format.
 *
 * Docusaurus generates heading IDs with github-slugger, so we use the same
 * library to maximize matches (it keeps Unicode letters/accents and, notably,
 * does NOT collapse repeated separators — e.g. `A & B` → `a--b` — so we must
 * not collapse either). A fresh slugger per call avoids the dedup counter.
 */
export function slugifyAnchor(anchor: string): string {
  return new GithubSlugger().slug(anchor.trim());
}

/** Minimal doc shape needed to build the route maps. */
export interface DocLite {
  page_id: string;
  slug: string;
  title?: string;
}

export interface RouteMaps {
  /** slugify(any-known-slug) → canonical published English slug */
  slugMap: Map<string, string>;
  /** dashless page id → canonical published English slug */
  pageIdMap: Map<string, string>;
}

/**
 * Build lookup maps from every reference key an author might use (own slug,
 * title-derived slug, page id) to the canonical published English slug.
 *
 * `canonicalSlugOf` returns the slug a given page is actually published at —
 * for grouped pages this is the (cleaned) English source slug shared by all
 * translations.
 */
export function buildRouteMaps(
  docs: DocLite[],
  canonicalSlugOf: (pageId: string) => string | null,
): RouteMaps {
  const slugMap = new Map<string, string>();
  const pageIdMap = new Map<string, string>();

  // Pass 1: own slug (most reliable — links reference the target's own slug).
  for (const d of docs) {
    const canon = canonicalSlugOf(d.page_id);
    if (!canon) continue;
    pageIdMap.set(d.page_id.replace(/-/g, ""), canon);
    const key = slugify(d.slug);
    if (key && !slugMap.has(key)) slugMap.set(key, canon);
  }

  // Pass 2: title-derived slug (covers clean English references), without
  // overwriting an existing slug-based mapping.
  for (const d of docs) {
    if (!d.title) continue;
    const canon = canonicalSlugOf(d.page_id);
    if (!canon) continue;
    const key = slugify(d.title);
    if (key && !slugMap.has(key)) slugMap.set(key, canon);
  }

  return { slugMap, pageIdMap };
}

function localePrefix(locale: string): string {
  if (locale === "es") return "/es";
  if (locale === "pt") return "/pt";
  return "";
}

/**
 * Resolve a single internal link target to its published route, or return
 * `null` to leave it unchanged (external link or unknown target).
 */
function resolveTarget(
  target: string,
  prefix: string,
  maps: RouteMaps,
): string | null {
  let t = target.trim();

  // Same-page anchor — just slugify the fragment.
  if (t.startsWith("#")) {
    const a = slugifyAnchor(t.slice(1));
    return a ? `#${a}` : null;
  }

  // Strip a Notion host so notion.so/docs/... and notion.so/<id> normalize to
  // an internal path.
  t = t.replace(/^https?:\/\/(?:www\.)?notion\.so/i, "");

  // Only internal absolute paths are candidates.
  if (!t.startsWith("/")) return null;

  // Split off the anchor.
  const hashIdx = t.indexOf("#");
  const rawAnchor = hashIdx === -1 ? "" : t.slice(hashIdx + 1);
  let path = hashIdx === -1 ? t : t.slice(0, hashIdx);

  // Drop trailing slashes and any existing locale prefix.
  path = path.replace(/\/+$/, "");
  path = path.replace(/^\/(?:es|pt)(?=\/)/i, "");

  let canon: string | null = null;

  const docsMatch = path.match(/^\/docs\/(.+)$/i);
  if (docsMatch) {
    // Last path segment is the slug (routes are flat: /docs/<slug>).
    const segs = docsMatch[1].split("/");
    let seg = segs[segs.length - 1] || docsMatch[1];
    try {
      seg = decodeURIComponent(seg);
    } catch {
      /* leave seg as-is on malformed escapes */
    }
    canon = maps.slugMap.get(slugify(seg)) ?? null;
  } else {
    const hexMatch = path.match(/^\/([0-9a-fA-F]{32})/);
    if (hexMatch) {
      canon = maps.pageIdMap.get(hexMatch[1].toLowerCase()) ?? null;
    }
  }

  if (!canon) return null; // genuinely unknown — leave the original link

  const anchor = rawAnchor ? `#${slugifyAnchor(rawAnchor)}` : "";
  return `${prefix}/docs/${canon}${anchor}`;
}

/**
 * Rewrite internal Markdown links in `content` for a file of the given locale.
 * Images (`![alt](…)`) and external/unknown links are left untouched.
 */
export function resolveInternalLinks(
  content: string,
  opts: { locale: string; maps: RouteMaps },
): string {
  const prefix = localePrefix(opts.locale);
  return content.replace(
    /(!?)\[([^\]]*)\]\(([^)]+)\)/g,
    (match, bang: string, text: string, target: string) => {
      if (bang) return match; // image, not a link
      const resolved = resolveTarget(target, prefix, opts.maps);
      return resolved === null ? match : `[${text}](${resolved})`;
    },
  );
}
