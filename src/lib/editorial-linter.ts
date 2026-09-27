/**
 * Editorial Linter & Diagnostics Engine.
 *
 * Scans fetched Notion content (metadata, markdown, and raw blocks) for
 * upstream editorial issues that currently accumulate technical debt:
 *  1. Broken anchors targeting missing or placeholder sections.
 *  2. Blocks containing raw base64 data URIs (>10 KB).
 *  3. Localized slug drift and unmapped internal Notion references.
 *
 * Emits structured diagnostics with human-readable guidance for Notion editors.
 *
 * Runtime-agnostic (no Node APIs).
 */

import { slugifyAnchor, KNOWN_SLUG_ALIASES, KNOWN_DOC_ANCHOR_ALIASES } from "./links.js";
import { slugify } from "./slug.js";
import type {
  EditorialDiagnosticItem,
  EditorialDiagnosticsReport,
} from "../schemas/index.js";

export interface EditorialLinterPageInput {
  pageId: string;
  title: string;
  slug: string;
  locale: string;
  markdown: string;
  rawBlocks?: unknown;
}

export interface EditorialLinterOptions {
  base64ThresholdBytes?: number;
}

const DEFAULT_BASE64_THRESHOLD = 10 * 1024; // 10 KB

/** Extract clean heading slugs from markdown content */
export function extractHeadingsFromMarkdown(markdown: string): Set<string> {
  const headings = new Set<string>();
  if (!markdown) return headings;

  let inFence = false;
  const lines = markdown.split("\n");

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match && match[1]) {
      // Strip formatting from heading before slugifying
      const rawText = match[1]
        .replace(/[*_~`]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .trim();
      if (rawText) {
        headings.add(slugifyAnchor(rawText));
        headings.add(slugify(rawText));
        headings.add(rawText.toLowerCase());
      }
    }
  }

  return headings;
}

/** Recursively scan raw Notion blocks for inline base64 image data */
function findBase64InBlocks(
  blocks: unknown,
  thresholdBytes: number
): Array<{ blockId?: string; sizeBytes: number }> {
  const hits: Array<{ blockId?: string; sizeBytes: number }> = [];

  function walk(node: unknown, currentBlockId?: string) {
    if (!node || typeof node !== "object") return;

    const obj = node as Record<string, unknown>;
    const blockId = (typeof obj.id === "string" ? obj.id : undefined) || currentBlockId;

    for (const val of Object.values(obj)) {
      if (typeof val === "string") {
        if (val.startsWith("data:image/") || val.includes(";base64,")) {
          if (val.length >= thresholdBytes) {
            hits.push({ blockId, sizeBytes: val.length });
          }
        }
      } else if (typeof val === "object" && val !== null) {
        walk(val, blockId);
      }
    }
  }

  walk(blocks);
  return hits;
}

/**
 * Execute the editorial diagnostics linter on a collection of documentation pages.
 */
export function runEditorialLinter(
  pages: EditorialLinterPageInput[],
  options?: EditorialLinterOptions
): EditorialDiagnosticsReport {
  const threshold = options?.base64ThresholdBytes ?? DEFAULT_BASE64_THRESHOLD;
  const items: EditorialDiagnosticItem[] = [];

  // 1. Build lookup tables for target pages and heading sets
  // Lookup by: pageId, slug, and canonical aliases
  const pageLookup = new Map<string, EditorialLinterPageInput>();
  const pageHeadings = new Map<string, Set<string>>();

  for (const page of pages) {
    const cleanId = page.pageId.replace(/-/g, "");
    pageLookup.set(page.pageId, page);
    pageLookup.set(cleanId, page);

    const normSlug = slugify(page.slug);
    if (normSlug) {
      pageLookup.set(normSlug, page);
      pageLookup.set(`${page.locale}:${normSlug}`, page);
    }

    const headings = extractHeadingsFromMarkdown(page.markdown);
    pageHeadings.set(page.pageId, headings);
    if (normSlug) {
      pageHeadings.set(normSlug, headings);
      pageHeadings.set(`${page.locale}:${normSlug}`, headings);
    }
  }

  // 2. Scan each page for diagnostics
  for (const page of pages) {
    const seenBase64 = new Set<string>();

    // Pass A: Base64 inspection in raw blocks
    if (page.rawBlocks) {
      const rawHits = findBase64InBlocks(page.rawBlocks, threshold);
      for (const hit of rawHits) {
        const key = `${hit.blockId || "unknown"}:${hit.sizeBytes}`;
        if (!seenBase64.has(key)) {
          seenBase64.add(key);
          const sizeKb = Math.round(hit.sizeBytes / 1024);
          items.push({
            category: "base64_blob",
            severity: "error",
            page_id: page.pageId,
            page_title: page.title,
            locale: page.locale,
            block_id: hit.blockId,
            details: {
              size_bytes: hit.sizeBytes,
              size_kb: sizeKb,
            },
            guidance: `Block contains a raw ${sizeKb} KB base64 image data URI. Replace the pasted image in Notion with a standard uploaded image.`,
          });
        }
      }
    }

    // Pass B: Base64 inspection in markdown
    const mdBase64Matches = page.markdown.matchAll(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g);
    for (const match of mdBase64Matches) {
      const val = match[0];
      if (val.length >= threshold) {
        const sizeKb = Math.round(val.length / 1024);
        const key = `md:${sizeKb}`;
        if (!seenBase64.has(key) && seenBase64.size === 0) {
          seenBase64.add(key);
          items.push({
            category: "base64_blob",
            severity: "error",
            page_id: page.pageId,
            page_title: page.title,
            locale: page.locale,
            details: {
              size_bytes: val.length,
              size_kb: sizeKb,
            },
            guidance: `Page contains a raw ${sizeKb} KB base64 image data URI in markdown. Replace the pasted image in Notion with a standard uploaded image.`,
          });
        }
      }
    }

    // Pass C: Links and Anchors inspection
    // Extract markdown links: [link text](url)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const linkMatches = page.markdown.matchAll(linkRegex);

    for (const match of linkMatches) {
      const linkText = match[1].trim();
      const href = match[2].trim();

      // Check for unmapped Notion URLs (notion.so internal references)
      if (/https?:\/\/(www\.)?notion\.so\//i.test(href)) {
        // Exclude general marketing links; look for workspace doc or UUID links
        const uuidMatch = href.match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (uuidMatch) {
          const targetId = uuidMatch[0].replace(/-/g, "");
          if (!pageLookup.has(targetId)) {
            items.push({
              category: "unmapped_reference",
              severity: "warning",
              page_id: page.pageId,
              page_title: page.title,
              locale: page.locale,
              details: {
                raw_reference: href,
                unresolved_id: targetId,
                link_text: linkText,
              },
              guidance: `Internal Notion link "${href}" references page ID "${targetId}" which is not found in the content database.`,
            });
            continue;
          }
        }
      }

      // Check internal documentation links
      // Ignore external protocols (https, http, mailto) unless notion.so
      if (/^(https?:|mailto:)/i.test(href) && !/https?:\/\/(www\.)?notion\.so\/.*docs\//i.test(href)) {
        continue;
      }

      // Normalize path & anchor parts
      let cleanUrl = href;
      // Strip domain prefix if it's notion.so/docs or lab.digital-democracy.org
      cleanUrl = cleanUrl.replace(/^https?:\/\/[^/]+(?:\/digidem)?/, "");
      // Strip leading locale prefix (/es/, /pt/)
      cleanUrl = cleanUrl.replace(/^\/(?:es|pt)\//, "/");

      const [pathPart, ...anchorParts] = cleanUrl.split("#");
      const rawAnchor = anchorParts.join("#"); // handle any accidental multi-hash
      const cleanPath = pathPart.replace(/^\/+|\/+$/g, "");

      // Pass C1: Localized slug drift
      // Extract target slug from path: e.g. "docs/mi-slug" -> "mi-slug"
      const slugCandidate = cleanPath.replace(/^docs\//, "");
      if (slugCandidate) {
        const canonical = KNOWN_SLUG_ALIASES[slugCandidate];
        if (canonical) {
          items.push({
            category: "slug_drift",
            severity: "warning",
            page_id: page.pageId,
            page_title: page.title,
            locale: page.locale,
            details: {
              used_slug: slugCandidate,
              canonical_slug: canonical,
              link_text: linkText,
            },
            guidance: `Link uses localized or historical slug "${slugCandidate}". Update the link in Notion to point to canonical route "/docs/${canonical}".`,
          });
        }
      }

      // Pass C2: Broken anchors targeting missing or placeholder sections
      if (rawAnchor) {
        const targetAnchorSlug = slugifyAnchor(rawAnchor);
        let targetPage: EditorialLinterPageInput | undefined;

        if (!cleanPath || cleanPath === "docs") {
          // Self-anchor
          targetPage = page;
        } else {
          // Target page lookup
          const targetSlug = slugCandidate;
          const canonical = KNOWN_SLUG_ALIASES[targetSlug] || targetSlug;
          targetPage =
            pageLookup.get(`${page.locale}:${canonical}`) ||
            pageLookup.get(canonical) ||
            pageLookup.get(targetSlug);
        }

        if (targetPage) {
          const targetHeadings = pageHeadings.get(targetPage.pageId);
          const hasHeading =
            targetHeadings?.has(targetAnchorSlug) ||
            targetHeadings?.has(rawAnchor.toLowerCase()) ||
            targetHeadings?.has(slugify(rawAnchor));

          // Check if this anchor is compensated by KNOWN_DOC_ANCHOR_ALIASES
          const docAliases = KNOWN_DOC_ANCHOR_ALIASES[targetPage.slug] ||
            KNOWN_DOC_ANCHOR_ALIASES[KNOWN_SLUG_ALIASES[targetPage.slug] || ""];
          const localeAliases = docAliases?.[page.locale];
          const hasAlias = Boolean(
            localeAliases?.[targetAnchorSlug] ||
            localeAliases?.[rawAnchor] ||
            localeAliases?.[rawAnchor.toLowerCase()]
          );

          if (!hasHeading) {
            items.push({
              category: "broken_anchor",
              severity: "error",
              page_id: page.pageId,
              page_title: page.title,
              locale: page.locale,
              details: {
                target_slug: targetPage.slug,
                target_page_title: targetPage.title,
                anchor: rawAnchor,
                normalized_anchor: targetAnchorSlug,
                healed_by_pipeline_alias: hasAlias,
                link_text: linkText,
              },
              guidance: hasAlias
                ? `Target page "${targetPage.slug}" has no heading for anchor "#${rawAnchor}" (currently masked by pipeline alias). Author the heading in Notion or fix the link.`
                : `Target page "${targetPage.slug}" does not contain heading anchor "#${rawAnchor}". Author the missing section in Notion or update the incoming link.`,
            });
          }
        }
      }
    }
  }

  // 3. Compute summary statistics
  const summary = {
    broken_anchors: 0,
    base64_blobs: 0,
    slug_drift: 0,
    unmapped_references: 0,
  };

  for (const item of items) {
    if (item.category === "broken_anchor") summary.broken_anchors++;
    else if (item.category === "base64_blob") summary.base64_blobs++;
    else if (item.category === "slug_drift") summary.slug_drift++;
    else if (item.category === "unmapped_reference") summary.unmapped_references++;
  }

  return {
    generated_at: new Date().toISOString(),
    total_issues: items.length,
    summary,
    items,
  };
}
