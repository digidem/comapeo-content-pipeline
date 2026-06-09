/**
 * Page sync orchestration: fetch → convert → hash → metadata.
 */

import { NotionClient } from "./notion-client.js";
import type { NotionPage, NotionBlock } from "./notion-client.js";
import { convertBlocks } from "./notion-converter.js";
import type { NotionBlockList } from "./notion-converter.js";
import { postProcessMarkdown } from "./post-process.js";
import { contentHash, hashJSON } from "./hash.js";
import { mapStatus } from "./status.js";
import { generateSlug, slugToDocusaurusId } from "./slug.js";
import { buildFrontmatter, serializeDoc } from "./frontmatter.js";
import type { PageMetadata, PageAsset } from "../schemas/metadata.js";
import { extractAssetUrls, rehostAsset, sha256Hex, assetR2Key } from "./assets.js";

export interface SyncPageInput {
  pageId: string;
  client: NotionClient;
  usedSlugs?: Set<string>;
  section?: string | null;
  sectionOrder?: number | null;
  elementType?: string | null;
  draftingStatus?: string | null;
  locale?: string;
}

export interface AssetBinary {
  r2Key: string;
  data: Uint8Array;
  contentType: string;
}

export interface SyncPageOutput {
  metadata: PageMetadata;
  /** Canonical markdown with frontmatter */
  canoncialMd: string;
  /** Raw page JSON (for raw-page.json) */
  rawPage: unknown;
  /** Raw blocks JSON (for raw-blocks.json) */
  rawBlocks: NotionBlockList;
  /** Content hash */
  hash: string;
  /** Always true from convertPageData — caller determines actual changed state by comparing with stored hash */
  changed: boolean;
  /** Downloaded asset binaries keyed by R2 key (for upload to R2/disk) */
  assetBinaries: AssetBinary[];
}

/** Overrides for page properties — take precedence over values extracted from rawPage. */
export interface ConvertOverrides {
  section?: string | null;
  sectionOrder?: number | null;
  elementType?: string | null;
  draftingStatus?: string | null;
  locale?: string;
}

/**
 * Pure conversion: raw Notion page + blocks → metadata, markdown, hashes.
 *
 * Runtime-agnostic (no Node APIs). Used by both CLI (via syncPage) and Worker.
 *
 * Asset rehosting: Notion image URLs are temporary (~1 hour). This function
 * downloads Notion-hosted images, hashes them, and replaces URLs in the
 * canonical markdown with stable R2 paths. The content_hash is computed
 * BEFORE URL replacement so it's stable across re-syncs.
 */
export async function convertPageData(input: {
  pageId: string;
  rawPage: Record<string, unknown>;
  rawBlocks: NotionBlockList;
  usedSlugs?: Set<string>;
  overrides?: ConvertOverrides;
}): Promise<SyncPageOutput> {
  const { pageId, rawPage, rawBlocks, usedSlugs, overrides } = input;

  const rawHash = hashJSON({ page: rawPage, blocks: rawBlocks });

  // Coerce to shape expected by extract helpers (they only read .id, .properties, .last_edited_time)
  const props = (rawPage.properties ?? {}) as Record<string, unknown>;
  const lastEditedTime = String(rawPage.last_edited_time ?? "");
  const pageLike = { id: pageId, properties: props, last_edited_time: lastEditedTime };

  // Extract properties — overrides take precedence
  const title = extractTitle(pageLike);
  const locale = overrides?.locale || extractLocale(pageLike) || "en";
  const resolvedSection = overrides?.section ?? extractSection(pageLike);
  const resolvedSectionOrder = overrides?.sectionOrder ?? extractSectionOrder(pageLike);
  const resolvedElementType = overrides?.elementType ?? extractProperty(pageLike, "Element Type");
  const resolvedDraftingStatus = overrides?.draftingStatus ?? extractProperty(pageLike, "Drafting Status");
  const status = mapStatus(resolvedDraftingStatus);

  // Generate slug
  const slugSet = usedSlugs ?? new Set<string>();
  const slug = generateSlug(title, pageId, slugSet);
  const docusaurusId = slugToDocusaurusId(slug, resolvedSection);

  // Build markdown body (without frontmatter)
  let markdownBody = convertBlocks(rawBlocks);

  // Post-process for Docusaurus compatibility (strip dup H1, fix headings, sanitize)
  markdownBody = postProcessMarkdown(markdownBody, title);

  // Compute content hash BEFORE asset rehosting (stable across re-syncs)
  const hash = contentHash(markdownBody);

  // ── Asset rehosting ──
  // Download Notion-hosted images, replace URLs with stable R2 paths.
  const assets: PageAsset[] = [];
  const assetBinaries: AssetBinary[] = [];
  const extracted = extractAssetUrls(markdownBody);
  const notionAssets = extracted.filter((a) => a.isNotion);

  for (const { url } of notionAssets) {
    try {
      const { data, contentType, ext } = await rehostAsset(url);
      const sha256 = await sha256Hex(data);
      const r2Key = assetR2Key(sha256, ext);

      assets.push({
        original_url: url,
        r2_key: r2Key,
        sha256,
        mime_type: contentType,
      });

      assetBinaries.push({ r2Key, data, contentType });

      // Replace URL in markdown body
      markdownBody = markdownBody.replaceAll(url, r2Key);
    } catch (err) {
      console.warn(`Failed to download asset: ${url}`, err);
      // Keep original URL — non-fatal
    }
  }

  // Build metadata
  const metadata: PageMetadata = {
    page_id: pageId,
    title,
    source_url: `https://notion.so/${pageId.replace(/-/g, "")}`,
    notion_last_edited_time: lastEditedTime,
    content_hash: hash,
    raw_hash: rawHash,
    locale,
    section: resolvedSection,
    section_order: resolvedSectionOrder,
    slug,
    docusaurus_id: docusaurusId,
    status,
    properties: props,
    assets,
  };

  // Build frontmatter + serialize with url-replaced markdown
  const fm = buildFrontmatter(metadata);
  const canoncialMd = serializeDoc(fm, markdownBody);

  return {
    metadata,
    canoncialMd,
    rawPage,
    rawBlocks,
    hash,
    changed: true, // Caller determines this by comparing with stored hash
    assetBinaries,
  };
}

/**
 * Sync a single page: fetch from Notion, then delegate to convertPageData.
 */
export async function syncPage(input: SyncPageInput): Promise<SyncPageOutput> {
  const { pageId, client, usedSlugs, section, sectionOrder, elementType, draftingStatus, locale } = input;

  // Fetch page metadata and blocks
  const page = await client.getPage(pageId);
  const { results: blocks, children } = await client.getPageBlocks(pageId);

  const rawBlocks: NotionBlockList = {
    object: "list",
    results: blocks as import("./notion-converter.js").NotionBlock[],
    children: children as Record<string, import("./notion-converter.js").NotionBlock[]>,
  };

  return await convertPageData({
    pageId,
    rawPage: page as unknown as Record<string, unknown>,
    rawBlocks,
    usedSlugs,
    overrides: { section, sectionOrder, elementType, draftingStatus, locale },
  });
}

// ── Property extraction helpers ──

function extractTitle(page: NotionPage): string {
  // Try common title property names
  const titleProp =
    page.properties?.["Content elements"] ||
    page.properties?.["Name"] ||
    page.properties?.["title"] ||
    page.properties?.["Title"];

  if (titleProp && typeof titleProp === "object") {
    const tp = titleProp as { title?: Array<{ plain_text?: string }> };
    if (tp.title && tp.title.length > 0) {
      return tp.title.map((t) => t.plain_text || "").join("");
    }
  }

  // Fallback: use page ID
  return page.id;
}

function extractProperty(page: NotionPage, name: string): string | null {
  const prop = page.properties?.[name];
  if (!prop || typeof prop !== "object") return null;

  const p = prop as Record<string, unknown>;

  // Select property
  if (p.select && typeof p.select === "object") {
    return (p.select as { name?: string }).name ?? null;
  }

  // Status property
  if (p.status && typeof p.status === "object") {
    return (p.status as { name?: string }).name ?? null;
  }

  // Rich text property
  if (p.rich_text && Array.isArray(p.rich_text)) {
    return (p.rich_text as Array<{ plain_text?: string }>)
      .map((rt) => rt.plain_text || "")
      .join("");
  }

  // Formula property
  if (p.formula && typeof p.formula === "object") {
    return String((p.formula as Record<string, unknown>).string ?? "");
  }

  return null;
}

/** Extract locale from Notion "Language" property */
function extractLocale(page: NotionPage): string | null {
  const lang = extractProperty(page, "Language");
  if (!lang) return null;

  // Map Notion language names to locale codes
  const localeMap: Record<string, string> = {
    English: "en",
    Portuguese: "pt",
    Spanish: "es",
    "pt-BR": "pt",
    es: "es",
    en: "en",
    pt: "pt",
  };

  return localeMap[lang] ?? lang.toLowerCase();
}

/** Extract content section from Notion page properties */
function extractSection(page: NotionPage): string | null {
  return extractProperty(page, "Content Section");
}

function extractSectionOrder(page: NotionPage): number | null {
  const val = extractProperty(page, "Order");
  if (val !== null) {
    const num = parseInt(val, 10);
    return isNaN(num) ? null : num;
  }
  return null;
}
