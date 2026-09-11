/**
 * Block-level extraction and translation replacement for NotionBlockList.
 *
 * Inverts translation architecture: keeps English block structure (layout,
 * images, spacers, Docusaurus admonition styling) intact while extracting
 * and translating only human-readable text.
 */

import type { NotionBlockList, NotionBlock, NotionRichText } from "./notion-converter.js";
import { richTextToMarkdown } from "./notion-converter.js";
import { inlineMarkdownToRichText } from "./inline-parser.js";

export interface ExtractedBlock {
  id: string;
  type: string;
  text: string;
}

interface BlockWithRichText {
  rich_text?: NotionRichText[];
}

interface BlockWithCaption {
  caption?: NotionRichText[];
}

interface TableRowContent {
  cells?: NotionRichText[][];
}

/**
 * Extract translatable text strings from a NotionBlockList.
 *
 * Walks results and children maps recursively.
 * - Standard blocks (p, headings, lists, quotes, callouts, etc.): extracts rich_text
 * - Tables: extracts cells with composite IDs `${rowId}:cell:${colIndex}`
 * - Images/Videos/Files: extracts caption with `${blockId}:caption`
 * - Code: skips code body, extracts caption with `${blockId}:caption` if present
 * - Spacers/Dividers/Empty blocks: skipped
 */
export function extractTranslatableBlocks(blockList: NotionBlockList): ExtractedBlock[] {
  const extracted: ExtractedBlock[] = [];
  const visited = new Set<string>();

  const childrenMap = blockList.children ?? {};

  function processBlock(block: NotionBlock): void {
    if (!block || visited.has(block.id)) return;
    visited.add(block.id);

    const type = block.type;
    const content = block[type] as (BlockWithRichText & BlockWithCaption) | undefined;

    if (type === "table_row") {
      const row = block.table_row as TableRowContent | undefined;
      if (row?.cells) {
        row.cells.forEach((cell, index) => {
          const text = richTextToMarkdown(cell).trim();
          if (text.length > 0) {
            extracted.push({
              id: `${block.id}:cell:${index}`,
              type: "table_cell",
              text,
            });
          }
        });
      }
    } else if (type === "code") {
      // Never translate code body. Only translate caption if present.
      if (content?.caption && content.caption.length > 0) {
        const text = richTextToMarkdown(content.caption).trim();
        if (text.length > 0) {
          extracted.push({
            id: `${block.id}:caption`,
            type: "code_caption",
            text,
          });
        }
      }
    } else if (type === "image" || type === "video" || type === "file") {
      if (content?.caption && content.caption.length > 0) {
        const text = richTextToMarkdown(content.caption).trim();
        if (text.length > 0) {
          extracted.push({
            id: `${block.id}:caption`,
            type: `${type}_caption`,
            text,
          });
        }
      }
    } else if (type === "child_page") {
      const title = (block.child_page as { title?: string } | undefined)?.title?.trim();
      if (title && title.length > 0) {
        extracted.push({
          id: block.id,
          type: "child_page",
          text: title,
        });
      }
    } else if (content?.rich_text) {
      const text = richTextToMarkdown(content.rich_text).trim();
      if (text.length > 0) {
        extracted.push({
          id: block.id,
          type,
          text,
        });
      }
    }

    // Traverse children if present
    if (childrenMap[block.id]) {
      for (const child of childrenMap[block.id]) {
        processBlock(child);
      }
    }
  }

  for (const block of blockList.results) {
    processBlock(block);
  }

  // Cover any orphaned children in childrenMap that weren't in results tree
  for (const [parentId, children] of Object.entries(childrenMap)) {
    if (!visited.has(parentId)) {
      for (const child of children) {
        processBlock(child);
      }
    }
  }

  return extracted;
}

/**
 * Deep-clone a NotionBlockList and apply translations.
 *
 * For each translated key:
 * - `${blockId}:cell:${i}` → updates table row cell
 * - `${blockId}:caption` (or fallback `${blockId}` on media) → updates caption
 * - `${blockId}` → updates rich_text
 *
 * Original blockList is never mutated.
 */
export function applyTranslatedBlocks(
  blockList: NotionBlockList,
  translations: Record<string, string>,
): NotionBlockList {
  const cloned: NotionBlockList = structuredClone(blockList);
  const visited = new Set<string>();
  const childrenMap = cloned.children ?? {};

  // Build emoji map from original blocks (name/url -> emojiId)
  const emojiMap = new Map<string, string>();
  function collectEmojis(blocks: NotionBlock[]): void {
    for (const b of blocks) {
      if (!b) continue;
      const type = b.type;
      const content = b[type] as (BlockWithRichText & BlockWithCaption) | undefined;
      const items = [...(content?.rich_text ?? []), ...(content?.caption ?? [])];
      for (const item of items) {
        if (item.type === "mention") {
          const mention = item.mention as
            | { type?: string; custom_emoji?: { id?: string; name?: string; url?: string } }
            | undefined;
          if (mention?.type === "custom_emoji" && mention.custom_emoji?.id) {
            if (mention.custom_emoji.name) emojiMap.set(mention.custom_emoji.name, mention.custom_emoji.id);
            if (mention.custom_emoji.url) emojiMap.set(mention.custom_emoji.url, mention.custom_emoji.id);
          }
        }
      }
    }
  }
  collectEmojis(blockList.results);
  if (blockList.children) {
    for (const children of Object.values(blockList.children)) {
      collectEmojis(children);
    }
  }

  function updateBlock(block: NotionBlock): void {
    if (!block || visited.has(block.id)) return;
    visited.add(block.id);

    const type = block.type;

    if (type === "table_row") {
      const row = block.table_row as TableRowContent | undefined;
      if (row?.cells) {
        row.cells.forEach((_, index) => {
          const key = `${block.id}:cell:${index}`;
          const trans = translations[key];
          if (trans !== undefined) {
            // Escape literal unescaped pipes to prevent corrupting Markdown table columns
            const safeTrans = trans.replace(/(?<!\\)\|/g, "\\|");
            row.cells![index] = inlineMarkdownToRichText(safeTrans, emojiMap);
          }
        });
      }
    } else if (type === "code") {
      const trans = translations[`${block.id}:caption`];
      if (trans !== undefined) {
        const codeContent = block.code as BlockWithCaption | undefined;
        if (codeContent) {
          codeContent.caption = inlineMarkdownToRichText(trans, emojiMap);
        }
      }
    } else if (type === "image" || type === "video" || type === "file") {
      const trans = translations[`${block.id}:caption`] ?? translations[block.id];
      if (trans !== undefined) {
        const mediaContent = block[type] as BlockWithCaption | undefined;
        if (mediaContent) {
          mediaContent.caption = inlineMarkdownToRichText(trans, emojiMap);
        }
      }
    } else if (type === "child_page") {
      const trans = translations[block.id];
      if (trans !== undefined) {
        const childPage = block.child_page as { title?: string } | undefined;
        if (childPage) {
          childPage.title = trans.trim();
        }
      }
    } else {
      const trans = translations[block.id];
      if (trans !== undefined) {
        const content = block[type] as BlockWithRichText | undefined;
        if (content) {
          content.rich_text = inlineMarkdownToRichText(trans, emojiMap);
        }
      }
    }

    if (childrenMap[block.id]) {
      for (const child of childrenMap[block.id]) {
        updateBlock(child);
      }
    }
  }

  for (const block of cloned.results) {
    updateBlock(block);
  }

  for (const [parentId, children] of Object.entries(childrenMap)) {
    if (!visited.has(parentId)) {
      for (const child of children) {
        updateBlock(child);
      }
    }
  }

  return cloned;
}
