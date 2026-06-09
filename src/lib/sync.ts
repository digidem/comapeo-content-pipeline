/**
 * Page sync orchestration: fetch → convert → hash → metadata.
 */

import { NotionClient } from "./notion-client.js";
import type { NotionPage, NotionBlock } from "./notion-client.js";
import { convertBlocks } from "./notion-converter.js";
import type { NotionBlockList } from "./notion-converter.js";
import { contentHash, hashJSON } from "./hash.js";
import { mapStatus } from "./status.js";
import { generateSlug, slugToDocusaurusId } from "./slug.js";
import { buildFrontmatter, serializeDoc } from "./frontmatter.js";
import type { PageMetadata } from "../schemas/metadata.js";

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
  /** Whether content changed (true if no previous hash to compare) */
  changed: boolean;
}

/**
 * Sync a single page: fetch from Notion, convert to Markdown, compute metadata.
 */
export async function syncPage(input: SyncPageInput): Promise<SyncPageOutput> {
  const { pageId, client, usedSlugs, section, sectionOrder, elementType, draftingStatus } = input;

  // Fetch page metadata and blocks
  const page = await client.getPage(pageId);
  const { results: blocks, children } = await client.getPageBlocks(pageId);

  const blockList: NotionBlockList = {
    object: "list",
    results: blocks as import("./notion-converter.js").NotionBlock[],
    children: children as Record<string, import("./notion-converter.js").NotionBlock[]>,
  };

  // Convert to markdown
  const rawPage = page as unknown;
  const rawBlocks = blockList;
  const rawHash = hashJSON({ page: rawPage, blocks: rawBlocks });

  // Extract properties
  const title = extractTitle(page);
  const locale = input.locale || extractLocale(page) || "en";
  const resolvedSection = section ?? extractSection(page);
  const resolvedSectionOrder = sectionOrder ?? extractSectionOrder(page);
  const resolvedElementType = elementType ?? extractProperty(page, "Element Type");
  const resolvedDraftingStatus = draftingStatus ?? extractProperty(page, "Drafting Status");
  const status = mapStatus(resolvedDraftingStatus);

  // Generate slug
  const slugSet = usedSlugs ?? new Set<string>();
  const slug = generateSlug(title, pageId, slugSet);
  const docusaurusId = slugToDocusaurusId(slug, resolvedSection);

  // Build markdown body (without frontmatter)
  const markdownBody = convertBlocks(blockList);

  // Compute content hash
  const hash = contentHash(markdownBody);

  // Build metadata
  const metadata: PageMetadata = {
    page_id: pageId,
    title,
    source_url: `https://notion.so/${pageId.replace(/-/g, "")}`,
    notion_last_edited_time: page.last_edited_time,
    content_hash: hash,
    raw_hash: rawHash,
    locale,
    section: resolvedSection,
    section_order: resolvedSectionOrder,
    slug,
    docusaurus_id: docusaurusId,
    status,
    properties: page.properties,
    assets: [],
  };

  // Build frontmatter + serialize
  const fm = buildFrontmatter(metadata);
  const canoncialMd = serializeDoc(fm, markdownBody);

  return {
    metadata,
    canoncialMd,
    rawPage,
    rawBlocks,
    hash,
    changed: true, // Caller determines this by comparing with stored hash
  };
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
