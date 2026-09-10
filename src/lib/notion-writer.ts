/**
 * Notion Write-Back Engine
 *
 * Prepares translated Notion blocks for Notion API insertion and manages
 * page creation, stub updates, and the Human-Edit Safety Lock.
 */

import type { NotionBlock, NotionClient, NotionPage } from "./notion-client.js";
import type { NotionBlockList } from "./notion-converter.js";
import { NOTION_PROPERTIES } from "./notion-properties.js";
import { isStubBody } from "./stub-body.js";

export interface WriteNotionOptions {
  client: NotionClient;
  databaseId: string;
  targetLocale: "pt" | "es";
  targetTitle: string;
  /**
   * The container/parent row in Notion under which the translation should live as a sibling.
   * If not provided, falls back to parentEnglishPageId.
   */
  parentItemId?: string;
  parentEnglishPageId?: string;
  targetPageId?: string;
  translatedBlocks: NotionBlockList;
  force?: boolean;
}

export interface WriteNotionResult {
  written: boolean;
  action: "created" | "updated" | "skipped";
  pageId?: string;
  reason?: string;
}

const SKIP_BLOCK_TYPES = new Set([
  "child_page",
  "child_database",
  "unsupported",
  "link_preview",
]);

/**
 * Prepares a NotionBlockList for insertion via Notion API (appendBlockChildren / createPage).
 *
 * Strips read-only metadata fields, converts Notion S3 images to external URLs,
 * and nests table rows and container children from the children map.
 */
export function prepareBlocksForNotion(blockList: NotionBlockList): Record<string, unknown>[] {
  const childrenMap = blockList.children || {};

  function cleanBlock(block: NotionBlock): Record<string, unknown> | null {
    if (SKIP_BLOCK_TYPES.has(block.type)) {
      return null;
    }

    const cleaned: Record<string, unknown> = {
      object: "block",
      type: block.type,
    };

    // Copy block type payload without mutations to original
    const typePayload = (block[block.type] as Record<string, unknown>) || {};
    const cleanedPayload: Record<string, unknown> = { ...typePayload };

    // Strip null properties from block payload (e.g. icon: null, which Notion rejects on create/append)
    for (const [key, val] of Object.entries(cleanedPayload)) {
      if (val === null) {
        delete cleanedPayload[key];
      }
    }

    // icon is only valid on callout blocks; strip from any other block type
    if (block.type !== "callout" && "icon" in cleanedPayload) {
      delete cleanedPayload.icon;
    }

    // Sanitize rich_text arrays (ensures absolute link URLs and removes read-only href)
    if (Array.isArray(cleanedPayload.rich_text)) {
      cleanedPayload.rich_text = sanitizeRichText(
        cleanedPayload.rich_text as Array<Record<string, unknown>>,
      );
    }

    // Sanitize media captions
    if (Array.isArray(cleanedPayload.caption)) {
      cleanedPayload.caption = sanitizeRichText(
        cleanedPayload.caption as Array<Record<string, unknown>>,
      );
    }

    // Sanitize table_row cells
    if (block.type === "table_row" && Array.isArray(cleanedPayload.cells)) {
      cleanedPayload.cells = (
        cleanedPayload.cells as Array<Array<Record<string, unknown>>>
      ).map((cell) => (Array.isArray(cell) ? sanitizeRichText(cell) : cell));
    }

    // Handle Image Blocks: Convert S3 internal file to external URL
    if (block.type === "image") {
      const img = typePayload as {
        type?: string;
        file?: { url?: string };
        external?: { url?: string };
        caption?: unknown[];
      };
      if (img.type === "file" && img.file?.url) {
        cleaned.image = {
          type: "external",
          external: { url: img.file.url },
          ...(img.caption ? { caption: img.caption } : {}),
        };
        return cleaned;
      }
    }

    // Handle Table Blocks: embed table_row children from childrenMap
    if (block.type === "table") {
      const tableRows = childrenMap[block.id] || [];
      const cleanedRows = tableRows
        .map((row) => cleanBlock(row))
        .filter((r): r is Record<string, unknown> => r !== null);

      cleanedPayload.children = cleanedRows;
      cleaned.table = cleanedPayload;
      return cleaned;
    }

    // Handle Container Blocks (toggle, callout, lists): embed children if present
    if (childrenMap[block.id] && childrenMap[block.id].length > 0) {
      const nestedChildren = childrenMap[block.id]
        .map((child) => cleanBlock(child))
        .filter((c): c is Record<string, unknown> => c !== null);

      if (nestedChildren.length > 0) {
        cleanedPayload.children = nestedChildren;
      }
    }

    cleaned[block.type] = cleanedPayload;
    return cleaned;
  }

  const result: Record<string, unknown>[] = [];
  for (const block of blockList.results) {
    const cleaned = cleanBlock(block);
    if (cleaned) {
      result.push(cleaned);
    }
  }

  return result;
}

/**
 * Determines whether an existing Notion page is an empty or unpopulated stub.
 */
export function isStubPage(
  _page: NotionPage,
  blocks: { results: NotionBlock[]; children?: Record<string, NotionBlock[]> },
): boolean {
  if (!blocks.results || blocks.results.length === 0) {
    return true;
  }

  // Concatenate all text across all blocks in the page
  const allText: string[] = [];
  for (const b of blocks.results) {
    const payload = (b[b.type] as { rich_text?: Array<{ plain_text?: string }> }) || {};
    if (payload.rich_text) {
      const line = payload.rich_text.map((r) => r.plain_text || "").join("");
      if (line.trim().length > 0) {
        allText.push(line.trim());
      }
    }
  }

  const combinedText = allText.join("\n").trim();
  if (combinedText.length === 0) {
    return true;
  }

  if (isStubBody(combinedText)) {
    return true;
  }

  if (/^(\*\*Work in progress\*\*|Work in progress)[\s\S]*$/i.test(combinedText)) {
    return true;
  }

  return false;
}

/**
 * Writes or updates a translated page in Notion with Human-Edit Safety Lock.
 */
export async function writeTranslationToNotion(
  options: WriteNotionOptions,
): Promise<WriteNotionResult> {
  const {
    client,
    databaseId,
    targetLocale,
    targetTitle,
    parentItemId,
    parentEnglishPageId,
    targetPageId,
    translatedBlocks,
    force = false,
  } = options;

  const effectiveParentId = parentItemId || parentEnglishPageId;
  const preparedBlocks = prepareBlocksForNotion(translatedBlocks);
  const localeSelectName = targetLocale === "pt" ? "PT - automated" : "ES - automated";

  // ── Case 1: Target Page already exists (update stub) ──
  if (targetPageId) {
    const page = await client.getPage(targetPageId);
    const existingBlocks = await client.getPageBlocks(targetPageId);

    const publishStatusProp = page.properties?.[NOTION_PROPERTIES.PUBLISH_STATUS] as
      | { select?: { name?: string } | null }
      | undefined;
    const publishStatus = publishStatusProp?.select?.name ?? "";

    const isAutomated = publishStatus === "Automated translations generated";
    const stub = isStubPage(page, existingBlocks);

    // Human-Edit Safety Lock
    if (!stub && !isAutomated && !force) {
      return {
        written: false,
        action: "skipped",
        reason: `Human-edit safety lock: Page ${targetPageId} has existing content and Publish Status "${publishStatus || "none"}". Use force to override.`,
      };
    }

    // Safe to overwrite: delete existing top-level blocks
    for (const b of existingBlocks.results) {
      await client.deleteBlock(b.id);
    }

    // Update page properties
    const updateProperties: Record<string, unknown> = {
      [NOTION_PROPERTIES.TITLE]: {
        title: [{ type: "text", text: { content: targetTitle } }],
      },
      [NOTION_PROPERTIES.LANGUAGE]: {
        select: { name: localeSelectName },
      },
      [NOTION_PROPERTIES.PUBLISH_STATUS]: {
        select: { name: "Automated translations generated" },
      },
    };

    if (effectiveParentId) {
      updateProperties[NOTION_PROPERTIES.PARENT_ITEM] = {
        relation: [{ id: effectiveParentId }],
      };
    }

    await client.updatePage(targetPageId, {
      properties: updateProperties,
    });

    // Append translated blocks
    if (preparedBlocks.length > 0) {
      await client.appendBlockChildren(targetPageId, preparedBlocks);
    }

    return {
      written: true,
      action: "updated",
      pageId: targetPageId,
    };
  }

  // ── Case 2: Target Page does NOT exist (create new page in Notion DB) ──
  const firstChunk = preparedBlocks.slice(0, 100);
  const remainingChunks = preparedBlocks.slice(100);

  const newPage = await client.createPage({
    parent: { database_id: databaseId },
    properties: {
      [NOTION_PROPERTIES.TITLE]: {
        title: [{ type: "text", text: { content: targetTitle } }],
      },
      [NOTION_PROPERTIES.LANGUAGE]: {
        select: { name: localeSelectName },
      },
      [NOTION_PROPERTIES.PUBLISH_STATUS]: {
        select: { name: "Automated translations generated" },
      },
      ...(effectiveParentId
        ? {
            [NOTION_PROPERTIES.PARENT_ITEM]: {
              relation: [{ id: effectiveParentId }],
            },
          }
        : {}),
      [NOTION_PROPERTIES.ELEMENT_TYPE]: {
        select: { name: "Page" },
      },
    },
    children: firstChunk,
  });

  if (remainingChunks.length > 0) {
    await client.appendBlockChildren(newPage.id, remainingChunks);
  }

  return {
    written: true,
    action: "created",
    pageId: newPage.id,
  };
}

/**
 * Sanitizes rich_text items for Notion API create/append calls.
 * Ensures relative links (e.g. /docs/...) are converted to absolute URLs,
 * and strips read-only fields like href.
 */
export function sanitizeRichText(
  richText: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return richText.map((item) => {
    const cloned = { ...item };
    delete cloned.href;

    if (cloned.text && typeof cloned.text === "object") {
      const textObj = { ...(cloned.text as Record<string, unknown>) };
      if (textObj.link && typeof textObj.link === "object") {
        const linkObj = { ...(textObj.link as Record<string, unknown>) };
        const rawUrl = typeof linkObj.url === "string" ? linkObj.url.trim() : "";
        if (!rawUrl) {
          textObj.link = null;
        } else if (rawUrl.startsWith("/")) {
          linkObj.url = `https://docs.comapeo.app${rawUrl}`;
          textObj.link = linkObj;
        } else if (rawUrl.startsWith("#")) {
          linkObj.url = `https://docs.comapeo.app/${rawUrl}`;
          textObj.link = linkObj;
        } else if (!/^(https?|mailto):/i.test(rawUrl)) {
          linkObj.url = `https://${rawUrl}`;
          textObj.link = linkObj;
        }
      }
      cloned.text = textObj;
    }

    return cloned;
  });
}
