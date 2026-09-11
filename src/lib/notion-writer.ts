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
import { toSectionDir } from "./hierarchy.js";
import type { PageAsset } from "../schemas/metadata.js";
import { stripUrlSignature } from "./assets.js";

export interface WriteNotionOptions {
  client: NotionClient;
  databaseId: string;
  targetLocale: "pt" | "es";
  targetTitle: string;
  /**
   * The container/parent row in Notion under which the translation should live as a sibling.
   * If not provided, leaves Parent item unset so root pages remain unparented.
   */
  parentItemId?: string;
  /**
   * @deprecated Do not use parentEnglishPageId as Parent item relation;
   * translations are siblings under parentItemId, not children of the English page.
   */
  parentEnglishPageId?: string;
  targetPageId?: string;
  translatedBlocks: NotionBlockList;
  assets?: PageAsset[];
  section?: string;
  toggleDir?: string;
  assetBaseUrl?: string;
  canonicalUrl?: string;
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
export function prepareBlocksForNotion(
  blockList: NotionBlockList,
  options: {
    assets?: PageAsset[];
    section?: string;
    toggleDir?: string;
    assetBaseUrl?: string;
    canonicalUrl?: string;
  } = {},
): Record<string, unknown>[] {
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
        options.canonicalUrl,
      );
    }

    // Sanitize media captions
    if (Array.isArray(cleanedPayload.caption)) {
      cleanedPayload.caption = sanitizeRichText(
        cleanedPayload.caption as Array<Record<string, unknown>>,
        options.canonicalUrl,
      );
    }

    // Sanitize table_row cells
    if (block.type === "table_row" && Array.isArray(cleanedPayload.cells)) {
      cleanedPayload.cells = (
        cleanedPayload.cells as Array<Array<Record<string, unknown>>>
      ).map((cell) => (Array.isArray(cell) ? sanitizeRichText(cell, options.canonicalUrl) : cell));
    }

    // Handle Image Blocks: Convert S3 internal file to external URL
    if (block.type === "image") {
      const img = typePayload as {
        type?: string;
        file?: { url?: string };
        external?: { url?: string };
        caption?: unknown[];
      };

      let externalUrl = img.external?.url;
      const rawUrl = img.file?.url || externalUrl;

      // If missing, pointing to Notion's private/temporary S3, or an inline data URI, resolve to permanent public URL
      const needsResolution =
        !externalUrl ||
        externalUrl.includes("prod-files-secure.s3") ||
        externalUrl.startsWith("data:");

      if (needsResolution && rawUrl) {
        const rawNoSig = stripUrlSignature(rawUrl);
        const matchedAsset = options.assets?.find((a) => {
          if (a.original_url === rawUrl) return true;
          return stripUrlSignature(a.original_url) === rawNoSig;
        });

        const isTemporaryS3 =
          rawUrl.includes("prod-files-secure.s3") ||
          rawUrl.includes("s3.us-west-2.amazonaws.com");

        if (matchedAsset) {
          const filename = matchedAsset.r2_key.replace(/^assets\//, "");
          const baseUrl =
            options.assetBaseUrl ||
            "https://raw.githubusercontent.com/digidem/comapeo-docs/content";
          const sectionDir = options.section ? toSectionDir(options.section) : null;
          const togglePath = options.toggleDir ? `/${options.toggleDir}` : "";
          externalUrl = sectionDir
            ? `${baseUrl}/docs/${sectionDir}${togglePath}/assets/${filename}`
            : `${baseUrl}/docs/assets/${filename}`;
        } else if (isTemporaryS3) {
          console.warn(
            `[notion-writer] Image at ${rawUrl} was not found in rehosted assets; omitting external block to avoid expired link.`,
          );
          return null;
        } else {
          externalUrl = rawUrl;
        }
      }

      // If externalUrl is present and not a raw data URI (which Notion rejects), write external image block
      if (externalUrl && !externalUrl.startsWith("data:")) {
        cleaned.image = {
          type: "external",
          external: { url: externalUrl },
          ...(img.caption && Array.isArray(img.caption) && img.caption.length > 0
            ? { caption: sanitizeRichText(img.caption as Array<Record<string, unknown>>, options.canonicalUrl) }
            : {}),
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

function extractBlockText(
  block: NotionBlock,
  childrenMap?: Record<string, NotionBlock[]>,
): string[] {
  const texts: string[] = [];
  const payload = (block[block.type] as Record<string, unknown>) || {};

  if (Array.isArray(payload.rich_text)) {
    const line = (payload.rich_text as Array<{ plain_text?: string }>).map((r) => r.plain_text || "").join("");
    if (line.trim().length > 0) texts.push(line.trim());
  }

  if (Array.isArray(payload.caption)) {
    const line = (payload.caption as Array<{ plain_text?: string }>).map((r) => r.plain_text || "").join("");
    if (line.trim().length > 0) texts.push(line.trim());
  }

  if (typeof payload.expression === "string" && payload.expression.trim().length > 0) {
    texts.push(payload.expression.trim());
  }

  if (block.type === "table_row" && Array.isArray(payload.cells)) {
    for (const cell of payload.cells as Array<Array<{ plain_text?: string }>>) {
      if (Array.isArray(cell)) {
        const line = cell.map((r) => r.plain_text || "").join("");
        if (line.trim().length > 0) texts.push(line.trim());
      }
    }
  }

  if (typeof payload.url === "string" && payload.url.trim().length > 0) {
    texts.push(payload.url.trim());
  }

  // Media, interactive elements, bookmarks, and links indicate non-empty content
  if (
    [
      "image",
      "video",
      "file",
      "pdf",
      "embed",
      "audio",
      "bookmark",
      "link_preview",
      "link_to_page",
    ].includes(block.type)
  ) {
    texts.push(`[${block.type}]`);
  }

  if (childrenMap && childrenMap[block.id]) {
    for (const child of childrenMap[block.id]) {
      texts.push(...extractBlockText(child, childrenMap));
    }
  }

  return texts;
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

  const allText: string[] = [];
  for (const b of blocks.results) {
    allText.push(...extractBlockText(b, blocks.children));
  }

  const combinedText = allText.join("\n").trim();
  if (combinedText.length === 0) {
    return true;
  }

  if (isStubBody(combinedText)) {
    return true;
  }

  // A page is only a WIP stub if "Work in progress" is the ENTIRE content (no substantive content afterwards)
  const wipStripped = combinedText.replace(/^(\*\*Work in progress\*\*|Work in progress)/i, "").trim();
  if (wipStripped.length === 0) {
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
    parentEnglishPageId: _parentEnglishPageId,
    targetPageId,
    translatedBlocks,
    force = false,
  } = options;

  const effectiveParentId = parentItemId;
  const preparedBlocks = prepareBlocksForNotion(translatedBlocks, {
    assets: options.assets,
    section: options.section,
    toggleDir: options.toggleDir,
    assetBaseUrl: options.assetBaseUrl,
    canonicalUrl: options.canonicalUrl,
  });
  const localeSelectName = targetLocale === "pt" ? "PT - automated" : "ES - automated";

  // ── Case 1: Target Page already exists (update stub) ──
  if (targetPageId) {
    const page = await client.getPage(targetPageId);
    const existingBlocks = await client.getPageBlocks(targetPageId);

    const publishStatusProp = page.properties?.[NOTION_PROPERTIES.PUBLISH_STATUS] as
      | { select?: { name?: string } | null }
      | undefined;
    const publishStatus = publishStatusProp?.select?.name ?? "";

    const stub = isStubPage(page, existingBlocks);

    // Human-Edit Safety Lock: require force to overwrite any page with non-stub content
    if (!stub && !force) {
      return {
        written: false,
        action: "skipped",
        reason: `Human-edit safety lock: Page ${targetPageId} has existing content and Publish Status "${publishStatus || "none"}". Use force to override.`,
      };
    }

    // Atomic replacement: Append new blocks first so if it fails, old content is preserved
    const newlyAppended: NotionBlock[] = [];
    try {
      if (preparedBlocks.length > 0) {
        const appendRes = await client.appendBlockChildren(targetPageId, preparedBlocks);
        if (appendRes?.results) newlyAppended.push(...appendRes.results);
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
    } catch (err) {
      // Rollback newly appended blocks on error to keep existing content intact
      for (const b of newlyAppended) {
        await client.deleteBlock(b.id).catch(() => {});
      }
      throw err;
    }

    // Delete old blocks only after new blocks and properties have committed successfully
    for (const b of existingBlocks.results) {
      await client.deleteBlock(b.id);
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

  let newPage: NotionPage | null = null;
  try {
    newPage = await client.createPage({
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
  } catch (err) {
    if (newPage) {
      await client.updatePage(newPage.id, { archived: true }).catch(() => {});
    }
    throw err;
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
  canonicalUrl?: string,
): Array<Record<string, unknown>> {
  return richText.map((item) => {
    const cloned = { ...item };
    delete cloned.href;

    // Sanitize custom_emoji mentions for Notion API
    if (cloned.type === "mention" && cloned.mention && typeof cloned.mention === "object") {
      delete cloned.plain_text;
      const mentionObj = cloned.mention as Record<string, unknown>;
      if (
        mentionObj.type === "custom_emoji" &&
        mentionObj.custom_emoji &&
        typeof mentionObj.custom_emoji === "object"
      ) {
        const emojiObj = mentionObj.custom_emoji as Record<string, unknown>;
        if (emojiObj.id) {
          cloned.mention = {
            type: "custom_emoji",
            custom_emoji: { id: emojiObj.id },
          };
        }
      }
    }

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
          linkObj.url = canonicalUrl
            ? `${canonicalUrl.replace(/\/+$/, "")}${rawUrl}`
            : `https://docs.comapeo.app/${rawUrl}`;
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
