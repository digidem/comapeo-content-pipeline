/**
 * Notion Write-Back Engine
 *
 * Prepares translated Notion blocks for Notion API insertion and manages
 * page creation, stub updates, and the Human-Edit Safety Lock.
 */

import type { NotionBlock, NotionClient, NotionPage } from "./notion-client.js";
import type { NotionBlockList } from "./notion-converter.js";
import { NOTION_PROPERTIES, DEAD_STATUSES, normalizeLocale } from "./notion-properties.js";
import { mapStatus } from "./status.js";
import { isStubBody } from "./stub-body.js";
import { toSectionDir } from "./hierarchy.js";
import type { PageAsset } from "../schemas/metadata.js";
import { stripUrlSignature } from "./assets.js";
import type { ClassifiedError } from "./errors.js";

export interface WriteNotionOptions {
  client: NotionClient;
  databaseId: string;
  targetLocale: "pt" | "es";
  targetTitle: string;
  /**
   * The container/parent row in Notion under which the translation should live as a sibling.
   * If not provided, falls back to parentEnglishPageId for standalone translation family linkage.
   */
  parentItemId?: string;
  /**
   * English page ID used as the family root when no container parent exists.
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
  rollback?: () => Promise<void>;
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
 * Determines whether a Notion page is archived, deleted, or marked with a dead Publish Status.
 */
export function isDeadPage(page: NotionPage): boolean {
  if (page.archived || (page as Record<string, unknown>).in_trash) {
    return true;
  }
  const statusProp = page.properties?.[NOTION_PROPERTIES.PUBLISH_STATUS] as
    | { select?: { name?: string } | null }
    | undefined;
  const statusName = statusProp?.select?.name?.trim();
  if (!statusName) return false;
  if (DEAD_STATUSES.some((d) => d.toLowerCase() === statusName.toLowerCase())) {
    return true;
  }
  const mapped = mapStatus(statusName);
  return mapped === "deprecated" || mapped === "archived";
}

export function getPageLanguage(page: NotionPage): string | null {
  const langProp = page.properties?.[NOTION_PROPERTIES.LANGUAGE] as
    | { select?: { name?: string } | null }
    | undefined;
  return langProp?.select?.name ?? null;
}

export function getPageLanguageSource(page: NotionPage): "explicit" | "automated" | "fallback" {
  const langName = getPageLanguage(page);
  if (!langName) return "fallback";
  if (/\bautomated\b/i.test(langName)) return "automated";
  return "explicit";
}

export function getPageElementType(page: NotionPage): string {
  const etProp = page.properties?.[NOTION_PROPERTIES.ELEMENT_TYPE] as
    | { select?: { name?: string } | null }
    | undefined;
  return etProp?.select?.name ?? "";
}

export function getPageTitle(page: NotionPage): string {
  const titleProp =
    page.properties?.[NOTION_PROPERTIES.TITLE] ||
    page.properties?.[NOTION_PROPERTIES.TITLE_FALLBACK_NAME] ||
    page.properties?.[NOTION_PROPERTIES.TITLE_FALLBACK_TITLE] ||
    page.properties?.[NOTION_PROPERTIES.TITLE_FALLBACK_LOWERCASE];
  const tp = titleProp as { title?: Array<{ plain_text?: string }> } | undefined;
  if (tp?.title && tp.title.length > 0) {
    return tp.title.map((t) => t.plain_text || "").join("");
  }
  return "";
}

export function getPageOrder(page: NotionPage): number {
  const orderProp = page.properties?.[NOTION_PROPERTIES.ORDER] as
    | { number?: number | null }
    | undefined;
  return typeof orderProp?.number === "number" ? orderProp.number : 99999;
}

const STAGING_SUFFIX = /[-_]\s*\d{4}-\d{2}-\d{2}\s*translation/i;

/**
 * Applies the hierarchy's canonical-member ranking across translation candidate pages:
 * 1. Filter out dead / archived / removed pages.
 * 2. Real body over stub (matches hierarchy.ts selectLocaleMember).
 * 3. Language source: explicit > automated > fallback.
 * 4. Typed element over untyped.
 * 5. Non-staging over staging suffix.
 * 6. Exact targetTitle match over alternate title.
 * 7. Lower order number.
 * 8. Tie-breaker: newest last_edited_time.
 */
export function rankTranslationCandidates(
  candidates: NotionPage[],
  targetTitle: string,
  hasBodyById?: Record<string, boolean | undefined>,
): NotionPage[] {
  const alive = candidates.filter((p) => !isDeadPage(p));
  if (alive.length <= 1) return alive;

  const srcRank: Record<string, number> = { explicit: 0, automated: 1, fallback: 2 };

  return [...alive].sort((a, b) => {
    // 1. Real body over unknown over stub:
    // A candidate confirmed to contain content (true) ranks first.
    // An unavailable/unknown candidate (undefined) ranks second (never demoted to a confirmed stub).
    // A confirmed empty stub (false) ranks last.
    if (hasBodyById) {
      const getBodyRank = (body: boolean | undefined): number => {
        if (body === true) return 0;
        if (body === undefined) return 1;
        return 2;
      };
      const aRank = getBodyRank(hasBodyById[a.id]);
      const bRank = getBodyRank(hasBodyById[b.id]);
      if (aRank !== bRank) return aRank - bRank;
    }

    // 2. Language source: explicit > automated > fallback
    const sa = srcRank[getPageLanguageSource(a)] ?? 2;
    const sb = srcRank[getPageLanguageSource(b)] ?? 2;
    if (sa !== sb) return sa - sb;

    // 3. Typed over untyped
    const at = getPageElementType(a) !== "" ? 0 : 1;
    const bt = getPageElementType(b) !== "" ? 0 : 1;
    if (at !== bt) return at - bt;

    // 4. Non-staging over staging suffix
    const aTitle = getPageTitle(a);
    const bTitle = getPageTitle(b);
    const as = STAGING_SUFFIX.test(aTitle) ? 1 : 0;
    const bs = STAGING_SUFFIX.test(bTitle) ? 1 : 0;
    if (as !== bs) return as - bs;

    // 5. Exact targetTitle match over alternate title
    const aExact = aTitle === targetTitle ? 0 : 1;
    const bExact = bTitle === targetTitle ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    // 6. Lower order number
    const ao = getPageOrder(a);
    const bo = getPageOrder(b);
    if (ao !== bo) return ao - bo;

    // 7. Most recently edited time
    const aTime = a.last_edited_time ? new Date(a.last_edited_time).getTime() : 0;
    const bTime = b.last_edited_time ? new Date(b.last_edited_time).getTime() : 0;
    return bTime - aTime;
  });
}

/**
 * Verifies that the Notion page state has not been concurrently modified by human editors
 * or changed to a non-automated status before applying a destructive rollback.
 * Returns true if safe to proceed with rollback, false if rollback should be aborted.
 */
async function verifyPageStateBeforeRollback(
  client: NotionClient,
  pageId: string,
  options?: {
    committedLastEditedTime?: string;
    expectedTitle?: string;
    expectedLocale?: string;
  },
): Promise<boolean> {
  const {
    committedLastEditedTime,
    expectedTitle,
    expectedLocale,
  } = options ?? {};

  try {
    const currentPage = await client.getPage(pageId);
    if (!currentPage) {
      console.error(
        `[notion-writer] Rollback aborted on ${pageId}: page could not be retrieved before rollback. Preserving content to prevent destroying concurrent edits.`,
      );
      return false;
    }

    if (
      committedLastEditedTime &&
      currentPage.last_edited_time &&
      currentPage.last_edited_time !== committedLastEditedTime
    ) {
      console.warn(
        `[notion-writer] Rollback aborted on ${pageId}: page was modified concurrently after translation write (committed at ${committedLastEditedTime}, current at ${currentPage.last_edited_time}). Preserving concurrent edits.`,
      );
      return false;
    }

    const currentPublishStatus = (
      currentPage.properties?.[NOTION_PROPERTIES.PUBLISH_STATUS] as {
        select?: { name?: string };
      }
    )?.select?.name;
    if (
      currentPublishStatus &&
      currentPublishStatus !== "Automated translations generated"
    ) {
      console.warn(
        `[notion-writer] Rollback aborted on ${pageId}: publish status changed to "${currentPublishStatus}" after translation write. Preserving concurrent edits.`,
      );
      return false;
    }

    if (expectedTitle !== undefined) {
      const currentTitle = getPageTitle(currentPage);
      if (currentTitle && currentTitle !== expectedTitle) {
        console.warn(
          `[notion-writer] Rollback aborted on ${pageId}: page title was modified concurrently (expected "${expectedTitle}", current "${currentTitle}"). Preserving concurrent edits.`,
        );
        return false;
      }
    }

    if (expectedLocale !== undefined) {
      const langProp = (
        currentPage.properties?.[NOTION_PROPERTIES.LANGUAGE] as {
          select?: { name?: string };
        }
      )?.select?.name;
      if (langProp && langProp !== expectedLocale) {
        console.warn(
          `[notion-writer] Rollback aborted on ${pageId}: page language was modified concurrently (expected "${expectedLocale}", current "${langProp}"). Preserving concurrent edits.`,
        );
        return false;
      }
    }

    return true;
  } catch (fetchErr) {
    console.error(
      `[notion-writer] Rollback aborted on ${pageId}: could not verify page state before rollback. Preserving content to prevent destroying concurrent edits:`,
      fetchErr,
    );
    return false;
  }
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
  const preparedBlocks = prepareBlocksForNotion(translatedBlocks, {
    assets: options.assets,
    section: options.section,
    toggleDir: options.toggleDir,
    assetBaseUrl: options.assetBaseUrl,
    canonicalUrl: options.canonicalUrl,
  });

  if (preparedBlocks.length === 0) {
    console.warn(
      `[notion-writer] Translation for "${targetTitle}" (${targetLocale}) resulted in 0 writeable blocks after preparation. Skipping write to prevent erasing existing content or creating empty page in Notion.`,
    );
    return {
      written: false,
      action: "skipped",
      pageId: targetPageId,
      reason: "No writeable blocks after preparation (empty translation)",
    };
  }

  const localeSelectName = targetLocale === "pt" ? "PT - automated" : "ES - automated";

  // ── Case 1: Target Page already exists (update stub) ──
  if (targetPageId) {
    let page: NotionPage | null = null;
    let existingBlocks: Awaited<ReturnType<NotionClient["getPageBlocks"]>> | null = null;
    try {
      page = await client.getPage(targetPageId);
      existingBlocks = await client.getPageBlocks(targetPageId);
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number }).statusCode ??
        (err as { status?: number }).status;
      const code = (err as { code?: string }).code;
      const isNotFound =
        statusCode === 404 ||
        code === "object_not_found" ||
        (err instanceof Error &&
          err.name === "ClassifiedError" &&
          (err as ClassifiedError).statusCode === 404);

      if (isNotFound) {
        console.warn(
          `[notion-writer] Target page ${targetPageId} not found in Notion (404 / object_not_found); falling back to page creation.`,
        );
      } else {
        throw err;
      }
    }

    if (page && existingBlocks) {
      const publishStatusProp = page.properties?.[NOTION_PROPERTIES.PUBLISH_STATUS] as
        | { select?: { name?: string } | null }
        | undefined;
      const publishStatus = publishStatusProp?.select?.name ?? "";

      const stub = isStubPage(page, existingBlocks);
      const isAutomated = publishStatus === "Automated translations generated";
      const isSafeToOverwrite = stub || isAutomated;

      // Human-Edit Safety Lock: require force to overwrite any page with non-stub, human-edited content
      if (!isSafeToOverwrite && !force) {
        return {
          written: false,
          action: "skipped",
          reason: `Human-edit safety lock: Page ${targetPageId} has existing content and Publish Status "${publishStatus || "none"}". Use force to override.`,
        };
      }

      // Atomic replacement: Append new blocks first so if it fails, old content is preserved
      const newlyAppended: NotionBlock[] = [];

      // Snapshot original properties before updating so we can restore them if deletion fails.
      // Explicitly clear properties that did not exist on the original page so rollback
      // does not leave newly added properties behind on the stub.
      const originalPropertiesToRestore: Record<string, unknown> = {
        [NOTION_PROPERTIES.TITLE]:
          page.properties?.[NOTION_PROPERTIES.TITLE] ?? {
            title: [],
          },
        [NOTION_PROPERTIES.LANGUAGE]:
          page.properties?.[NOTION_PROPERTIES.LANGUAGE] ?? {
            select: null,
          },
        [NOTION_PROPERTIES.PUBLISH_STATUS]:
          page.properties?.[NOTION_PROPERTIES.PUBLISH_STATUS] ?? {
            select: null,
          },
      };
      if (effectiveParentId) {
        originalPropertiesToRestore[NOTION_PROPERTIES.PARENT_ITEM] =
          page.properties?.[NOTION_PROPERTIES.PARENT_ITEM] ?? {
            relation: [],
          };
      }

      let updatedPage: NotionPage | undefined;
      let committedLastEditedTime: string | undefined;
      try {
        if (preparedBlocks.length > 0) {
          const appendRes = await client.appendBlockChildren(targetPageId, preparedBlocks, {
            onChunk: (blocks) => {
              newlyAppended.push(...blocks);
            },
          });
          if (appendRes?.results) {
            for (const b of appendRes.results) {
              if (!newlyAppended.some((existing) => existing.id === b.id)) {
                newlyAppended.push(b);
              }
            }
          }
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

        updatedPage = await client.updatePage(targetPageId, {
          properties: updateProperties,
        });
        committedLastEditedTime = updatedPage?.last_edited_time;
      } catch (err) {
        // Rollback newly appended blocks on error to keep existing content intact.
        // Include any chunks appended before a chunk error occurred.
        const partialBlocks = (err as { appendedBlocks?: NotionBlock[] })?.appendedBlocks;
        if (partialBlocks) {
          for (const b of partialBlocks) {
            if (!newlyAppended.some((existing) => existing.id === b.id)) {
              newlyAppended.push(b);
            }
          }
        }
        for (const b of newlyAppended) {
          try {
            await client.deleteBlock(b.id);
          } catch {
            // ignore secondary errors during rollback
          }
        }
        throw err;
      }

      // Delete old blocks only after new blocks and properties have committed successfully.
      // If deletion fails, attempt to restore deleted old blocks.
      // If restore fails on any old block, PRESERVE newly appended blocks to prevent total data loss.
      // Only delete newly appended blocks and restore original properties if all deleted old blocks were safely restored
      // AND the page has not been concurrently modified.
      const deletedOldBlockIds: string[] = [];
      try {
        for (const b of existingBlocks.results) {
          await client.deleteBlock(b.id);
          deletedOldBlockIds.push(b.id);
        }
      } catch (deleteErr) {
        const failedRestoreIds: string[] = [];
        const restoredBlockIds: string[] = [];
        if (typeof client.restoreBlock === "function") {
          for (const id of deletedOldBlockIds) {
            try {
              const restored = await client.restoreBlock(id);
              restoredBlockIds.push(id);
              if (typeof restored?.last_edited_time === "string") {
                committedLastEditedTime = restored.last_edited_time;
              }
            } catch {
              failedRestoreIds.push(id);
            }
          }
        } else if (deletedOldBlockIds.length > 0) {
          failedRestoreIds.push(...deletedOldBlockIds);
        }

        // Only delete newly appended replacement blocks if ALL deleted old blocks were restored,
        // avoiding total content loss if restore fails, AND if the page was not concurrently modified.
        if (failedRestoreIds.length === 0) {
          // Check for concurrent body edits: verify that no unexpected blocks were added or existing blocks removed
          let hasConcurrentBodyEdit = false;
          try {
            const currentBlocks = await client.getPageBlocks(targetPageId);
            if (Array.isArray(currentBlocks?.results)) {
              const expectedIds = new Set([
                ...existingBlocks.results.map((b) => b.id),
                ...newlyAppended.map((b) => b.id),
              ]);
              if (currentBlocks.results.length !== expectedIds.size) {
                hasConcurrentBodyEdit = true;
              } else {
                for (const b of currentBlocks.results) {
                  if (!expectedIds.has(b.id)) {
                    hasConcurrentBodyEdit = true;
                    break;
                  }
                }
              }
            }
          } catch {
            // Ignore if block retrieval is not supported/mocked
          }

          if (hasConcurrentBodyEdit) {
            console.warn(
              `[notion-writer] Rollback aborted on ${targetPageId}: page body was modified concurrently during deletion recovery. Preserving concurrent edits and replacement blocks.`,
            );
          }

          const isSafeToRollback =
            !hasConcurrentBodyEdit &&
            (await verifyPageStateBeforeRollback(client, targetPageId, {
              committedLastEditedTime,
              expectedTitle: targetTitle,
              expectedLocale: localeSelectName,
            }));
          if (isSafeToRollback) {
            for (const b of newlyAppended) {
              try {
                await client.deleteBlock(b.id);
              } catch {
                // ignore secondary errors during rollback
              }
            }
            if (Object.keys(originalPropertiesToRestore).length > 0) {
              try {
                await client.updatePage(targetPageId, {
                  properties: originalPropertiesToRestore,
                });
              } catch {
                // ignore secondary errors during rollback
              }
            }
            throw new Error(
              `Failed to delete old blocks during atomic replacement on ${targetPageId}. Restored ${restoredBlockIds.length} deleted old blocks, rolled back newly appended blocks, and restored original page properties. Error: ${String(deleteErr)}`,
              { cause: deleteErr },
            );
          } else {
            throw new Error(
              `Failed to delete old blocks during atomic replacement on ${targetPageId}. Restored ${restoredBlockIds.length} deleted old blocks, but rollback was aborted because the page was concurrently modified or unverified; preserved newly appended blocks and properties to prevent destroying concurrent edits. Error: ${String(deleteErr)}`,
              { cause: deleteErr },
            );
          }
        } else {
          throw new Error(
            `Failed to delete old blocks during atomic replacement on ${targetPageId}. Rollback failed to restore ${failedRestoreIds.length} deleted old block(s) [${failedRestoreIds.join(", ")}]; preserved newly appended replacement blocks to prevent complete content loss. Error: ${String(deleteErr)}`,
            { cause: deleteErr },
          );
        }
      }

      // Capture committed page version to guard against destroying concurrent human edits on rollback
      try {
        const postCommitPage = await client.getPage(targetPageId);
        if (postCommitPage?.last_edited_time) {
          committedLastEditedTime = postCommitPage.last_edited_time;
        }
      } catch {
        // fallback to updatedPage timestamp
      }

      const rollback = async (): Promise<void> => {
        const isSafeToRollback = await verifyPageStateBeforeRollback(
          client,
          targetPageId,
          {
            committedLastEditedTime,
            expectedTitle: targetTitle,
            expectedLocale: localeSelectName,
          },
        );
        if (!isSafeToRollback) {
          return;
        }

        const failedRestoreIds: string[] = [];
        if (typeof client.restoreBlock === "function") {
          for (const b of existingBlocks.results) {
            try {
              await client.restoreBlock(b.id);
            } catch {
              failedRestoreIds.push(b.id);
            }
          }
        } else if (existingBlocks.results.length > 0) {
          failedRestoreIds.push(...existingBlocks.results.map((b) => b.id));
        }

        // Only delete new replacement blocks if old blocks were safely restored
        if (failedRestoreIds.length === 0) {
          for (const b of newlyAppended) {
            try {
              await client.deleteBlock(b.id);
            } catch {
              // ignore secondary errors during rollback
            }
          }
          if (Object.keys(originalPropertiesToRestore).length > 0) {
            try {
              await client.updatePage(targetPageId, {
                properties: originalPropertiesToRestore,
              });
            } catch {
              // ignore secondary errors during rollback
            }
          }
        } else {
          console.error(
            `[notion-writer] Rollback on ${targetPageId} failed to restore ${failedRestoreIds.length} old block(s) [${failedRestoreIds.join(", ")}]. Preserved newly appended blocks to prevent content loss.`,
          );
        }
      };

      return {
        written: true,
        action: "updated",
        pageId: targetPageId,
        rollback,
      };
    }
  }

  // ── Case 2: Target Page does NOT exist (create new page in Notion DB) ──
  // Reconcile ambiguous responses and prevent duplicate page creation:
  if (typeof client.queryDatabase === "function") {
    // 1. If parentEnglishPageId is provided and differs from parentItemId, check if a translation
    //    page already exists directly under this English family root.
    if (parentEnglishPageId && parentEnglishPageId !== parentItemId) {
      try {
        const directFamilyMatch = await client.queryDatabase({
          filter: {
            and: [
              {
                property: NOTION_PROPERTIES.LANGUAGE,
                select: { equals: localeSelectName },
              },
              {
                property: NOTION_PROPERTIES.PARENT_ITEM,
                relation: { contains: parentEnglishPageId },
              },
            ],
          },
          pageSize: 10,
        });
        const rawCandidates = directFamilyMatch?.results ?? [];
        const candidates = rawCandidates.filter((p) => {
          const lang = getPageLanguage(p);
          return normalizeLocale(lang) === targetLocale;
        });
        if (candidates.length > 0) {
          let hasBodyById: Record<string, boolean | undefined> | undefined;
          if (candidates.length > 1 && typeof client.getPageBlocks === "function") {
            const bodies: Record<string, boolean | undefined> = {};
            await Promise.all(
              candidates.map(async (cand) => {
                try {
                  const blocks = await client.getPageBlocks(cand.id);
                  bodies[cand.id] = blocks ? !isStubPage(cand, blocks) : false;
                } catch (fetchErr) {
                  console.warn(
                    `[notion-writer] Failed to fetch blocks for candidate [${cand.id}]: ${fetchErr}`,
                  );
                  bodies[cand.id] = undefined;
                }
              }),
            );
            hasBodyById = bodies;
          }
          const ranked = rankTranslationCandidates(candidates, targetTitle, hasBodyById);
          if (ranked.length > 0) {
            const winner = ranked[0];
            console.warn(
              `[notion-writer] Found existing translation page [${winner.id}] parented by English page ${parentEnglishPageId}. Reusing canonical member instead of creating duplicate.`,
            );
            return writeTranslationToNotion({
              ...options,
              targetPageId: winner.id,
            });
          }
        }
      } catch (queryErr) {
        console.warn(`[notion-writer] Could not query by parentEnglishPageId: ${queryErr}`);
      }
    }

    // 2. Under a shared container parent (parentItemId) or database root, match by language AND title
    //    to strictly prevent reusing an unrelated sibling article under the same container.
    try {
      const filterConditions: Record<string, unknown>[] = [
        {
          property: NOTION_PROPERTIES.LANGUAGE,
          select: { equals: localeSelectName },
        },
        {
          property: NOTION_PROPERTIES.TITLE,
          title: { equals: targetTitle },
        },
      ];
      if (effectiveParentId) {
        filterConditions.push({
          property: NOTION_PROPERTIES.PARENT_ITEM,
          relation: { contains: effectiveParentId },
        });
      }

      const existing = await client.queryDatabase({
        filter: { and: filterConditions },
        pageSize: 10,
      });

      const rawCandidates = existing?.results ?? [];
      const candidates = rawCandidates.filter((p) => {
        const lang = getPageLanguage(p);
        return normalizeLocale(lang) === targetLocale;
      });

      if (candidates.length > 0) {
        let hasBodyById: Record<string, boolean | undefined> | undefined;
        if (candidates.length > 1 && typeof client.getPageBlocks === "function") {
          const bodies: Record<string, boolean | undefined> = {};
          await Promise.all(
            candidates.map(async (cand) => {
              try {
                const blocks = await client.getPageBlocks(cand.id);
                bodies[cand.id] = blocks ? !isStubPage(cand, blocks) : false;
              } catch (fetchErr) {
                console.warn(
                  `[notion-writer] Failed to fetch blocks for candidate [${cand.id}]: ${fetchErr}`,
                );
                bodies[cand.id] = undefined;
              }
            }),
          );
          hasBodyById = bodies;
        }
        const ranked = rankTranslationCandidates(candidates, targetTitle, hasBodyById);
        if (ranked.length > 0) {
          const winner = ranked[0];
          console.warn(
            `[notion-writer] Found existing translation page [${winner.id}] matching ${targetLocale} and title "${targetTitle}". Reusing canonical member instead of creating duplicate.`,
          );
          return writeTranslationToNotion({
            ...options,
            targetPageId: winner.id,
          });
        }
      }
    } catch (queryErr) {
      console.warn(`[notion-writer] Could not query for existing translation before creation: ${queryErr}`);
    }
  }

  // 3. Fallback: check if parentEnglishPageId has sub-item relations pointing to this locale's translation
  if (parentEnglishPageId && typeof client.getPage === "function") {
    try {
      const enPage = await client.getPage(parentEnglishPageId);
      const subItemProp = enPage?.properties?.[NOTION_PROPERTIES.SUB_ITEM] as
        | { relation?: Array<{ id: string }> }
        | undefined;
      const subItemIds = subItemProp?.relation?.map((r) => r.id) || [];
      const subItemPages: NotionPage[] = [];
      for (const childId of subItemIds) {
        try {
          const childPage = await client.getPage(childId);
          if (childPage) {
            const childLang = getPageLanguage(childPage);
            if (normalizeLocale(childLang) === targetLocale) {
              subItemPages.push(childPage);
            }
          }
        } catch {
          // ignore individual child fetch error
        }
      }
      if (subItemPages.length > 0) {
        let hasBodyById: Record<string, boolean | undefined> | undefined;
        if (subItemPages.length > 1 && typeof client.getPageBlocks === "function") {
          const bodies: Record<string, boolean | undefined> = {};
          await Promise.all(
            subItemPages.map(async (cand) => {
              try {
                const blocks = await client.getPageBlocks(cand.id);
                bodies[cand.id] = blocks ? !isStubPage(cand, blocks) : false;
              } catch (fetchErr) {
                console.warn(
                  `[notion-writer] Failed to fetch blocks for candidate [${cand.id}]: ${fetchErr}`,
                );
                bodies[cand.id] = undefined;
              }
            }),
          );
          hasBodyById = bodies;
        }
        const ranked = rankTranslationCandidates(subItemPages, targetTitle, hasBodyById);
        if (ranked.length > 0) {
          const winner = ranked[0];
          console.warn(
            `[notion-writer] Found existing translation page [${winner.id}] in sub-items of English page ${parentEnglishPageId}. Reusing canonical member instead of creating duplicate.`,
          );
          return writeTranslationToNotion({
            ...options,
            targetPageId: winner.id,
          });
        }
      }
    } catch (err) {
      console.warn(`[notion-writer] Could not inspect parentEnglishPageId sub-items: ${err}`);
    }
  }
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

  if (!newPage?.id) {
    throw new Error(
      `Failed to create page for "${targetTitle}" in database ${databaseId}: Notion API returned no page`,
    );
  }

  let committedLastEditedTime: string | undefined = newPage.last_edited_time;
  try {
    const postCommitPage = await client.getPage(newPage.id);
    if (postCommitPage?.last_edited_time) {
      committedLastEditedTime = postCommitPage.last_edited_time;
    }
  } catch {
    // ignore
  }

  const rollback = async (): Promise<void> => {
    if (newPage?.id) {
      const isSafeToRollback = await verifyPageStateBeforeRollback(
        client,
        newPage.id,
        {
          committedLastEditedTime,
          expectedTitle: targetTitle,
          expectedLocale: localeSelectName,
        },
      );
      if (!isSafeToRollback) {
        return;
      }

      try {
        await client.deleteBlock(newPage.id);
      } catch {
        // ignore
      }
    }
  };

  return {
    written: true,
    action: "created",
    pageId: newPage.id,
    rollback,
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
