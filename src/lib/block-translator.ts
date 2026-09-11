/**
 * Block-level extraction and translation replacement for NotionBlockList.
 *
 * Inverts translation architecture: keeps English block structure (layout,
 * images, spacers, Docusaurus admonition styling) intact while extracting
 * and translating only human-readable text.
 */

import type { NotionBlockList, NotionBlock, NotionRichText } from "./notion-converter.js";
import { richTextToMarkdown } from "./notion-converter.js";
import { inlineMarkdownToRichText, findNextLink } from "./inline-parser.js";

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
      if (type === "table_row") {
        const row = b.table_row as TableRowContent | undefined;
        if (row?.cells) {
          for (const cell of row.cells) {
            items.push(...cell);
          }
        }
      }
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
            const origCell = row.cells![index];
            const restored = restoreEquationDelimiters(trans, origCell);
            row.cells![index] = inlineMarkdownToRichText(restored, emojiMap);
          }
        });
      }
    } else if (type === "code") {
      const trans = translations[`${block.id}:caption`];
      if (trans !== undefined) {
        const codeContent = block.code as BlockWithCaption | undefined;
        if (codeContent) {
          const origCaption = codeContent.caption;
          const restored = restoreEquationDelimiters(trans, origCaption);
          codeContent.caption = inlineMarkdownToRichText(restored, emojiMap);
        }
      }
    } else if (type === "image" || type === "video" || type === "file") {
      const trans = translations[`${block.id}:caption`] ?? translations[block.id];
      if (trans !== undefined) {
        const mediaContent = block[type] as BlockWithCaption | undefined;
        if (mediaContent) {
          const origCaption = mediaContent.caption;
          const restored = restoreEquationDelimiters(trans, origCaption);
          mediaContent.caption = inlineMarkdownToRichText(restored, emojiMap);
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
          const origRichText = content.rich_text;
          const restored = restoreEquationDelimiters(trans, origRichText);
          content.rich_text = inlineMarkdownToRichText(restored, emojiMap);
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

/**
 * Escapes regex special characters in a string.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ParsedEquation {
  raw: string;
  expression: string;
  isDisplay: boolean;
}

/**
 * Extracts display ($$...$$) and inline ($...$) equations from markdown text.
 */
export function extractEquationsFromText(text: string): ParsedEquation[] {
  if (!text) return [];
  const equations: ParsedEquation[] = [];
  const eqRegex =
    /(?<!\\)\$\$(?<display>[^$\n]+?)\$\$|(?<![\w\\$])\$(?!\s)(?<inline>[^$\n]+?)(?<![\s\\$])\$(?!\d)/g;
  let match: RegExpExecArray | null;
  while ((match = eqRegex.exec(text)) !== null) {
    if (match.groups?.display) {
      equations.push({
        raw: match[0],
        expression: match.groups.display.trim(),
        isDisplay: true,
      });
    } else if (match.groups?.inline) {
      equations.push({
        raw: match[0],
        expression: match.groups.inline.trim(),
        isDisplay: false,
      });
    }
  }
  return equations;
}

/**
 * Extracts equations from Notion rich text items (both native equation items and markdown-style math).
 */
export function extractEquationsFromRichText(items?: NotionRichText[]): ParsedEquation[] {
  if (!items || items.length === 0) return [];
  const equations: ParsedEquation[] = [];

  for (const item of items) {
    if (item.type === "equation") {
      const expr = (
        (item.equation as { expression?: string } | undefined)?.expression ??
        item.plain_text ??
        ""
      ).trim();
      if (expr) {
        equations.push({
          raw: `$${expr}$`,
          expression: expr,
          isDisplay: false,
        });
      }
    } else if (item.plain_text) {
      for (const eq of extractEquationsFromText(item.plain_text)) {
        equations.push(eq);
      }
    }
  }

  return equations;
}

interface Segment {
  text: string;
  isProse: boolean;
}

function collectNonLinkSegments(text: string): Segment[] {
  const NON_PROSE_REGEX =
    /(?<code>```[\s\S]*?```|`[^`\n]+`)|(?<html><[^>]+>)|(?<equationDisplay>(?<!\\)\$\$[^$\n]+?\$\$)|(?<equationInline>(?<![\w\\$])\$(?!\s)[^$\n]+?(?<![\s\\$])\$(?!\d))/g;

  const segments: Segment[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = NON_PROSE_REGEX.exec(text)) !== null) {
    if (match.index > lastIdx) {
      segments.push({
        text: text.slice(lastIdx, match.index),
        isProse: true,
      });
    }
    segments.push({
      text: match[0],
      isProse: false,
    });
    lastIdx = NON_PROSE_REGEX.lastIndex;
  }

  if (lastIdx < text.length) {
    segments.push({
      text: text.slice(lastIdx),
      isProse: true,
    });
  }

  return segments;
}

function collectAllSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    const linkMatch = findNextLink(text, currentIndex);
    if (!linkMatch) {
      segments.push(...collectNonLinkSegments(text.slice(currentIndex)));
      break;
    }

    if (linkMatch.linkStart > currentIndex) {
      segments.push(...collectNonLinkSegments(text.slice(currentIndex, linkMatch.linkStart)));
    }

    if (linkMatch.isImage) {
      // For markdown images ![alt](url), treat whole token as non-prose to preserve image syntax intact
      segments.push({
        text: text.slice(linkMatch.linkStart, linkMatch.linkEnd),
        isProse: false,
      });
    } else {
      // For markdown links [linkText](linkUrl), linkText can be prose, linkUrl is non-prose
      segments.push({ text: "[", isProse: false });
      segments.push(...collectNonLinkSegments(linkMatch.linkText));
      segments.push({ text: `](${linkMatch.linkUrl})`, isProse: false });
    }

    currentIndex = linkMatch.linkEnd;
  }

  return segments;
}

/**
 * Restores dropped equation delimiters ($...$ or $$...$$) in translated text
 * if the original source contained equations and the translation dropped their delimiters.
 * Uses token/word boundary checks to prevent corrupting ordinary prose words,
 * limits replacements strictly to the number of missing equations, protects single-letter
 * target language words (e.g. Spanish 'y', Portuguese 'e', 'a', 'o', Spanish 'u'),
 * and preserves code spans, HTML tags, and link destinations untouched.
 */
export function restoreEquationDelimiters(
  translatedText: string,
  original: NotionRichText[] | string | undefined,
): string {
  if (!translatedText || !original) return translatedText;

  const originalEquations = Array.isArray(original)
    ? extractEquationsFromRichText(original)
    : extractEquationsFromText(original);

  if (originalEquations.length === 0) return translatedText;

  // Extract all equations that are ALREADY delimited in the translated text
  const existingEquations = extractEquationsFromText(translatedText);
  const existingCounts = new Map<string, number>();
  for (const eq of existingEquations) {
    existingCounts.set(eq.expression, (existingCounts.get(eq.expression) ?? 0) + 1);
  }

  // Count occurrences of each equation in the original source
  const origCounts = new Map<string, { count: number; isDisplay: boolean }>();
  for (const eq of originalEquations) {
    const entry = origCounts.get(eq.expression) ?? { count: 0, isDisplay: eq.isDisplay };
    entry.count += 1;
    origCounts.set(eq.expression, entry);
  }

  // Identify equations that actually lost delimiters
  const equationsToRestore: Array<{ expression: string; isDisplay: boolean; needed: number }> = [];
  for (const [expr, orig] of origCounts.entries()) {
    const existing = existingCounts.get(expr) ?? 0;
    const needed = orig.count - existing;
    if (needed > 0) {
      // Single-letter target language words / stop words (Spanish 'y', Portuguese 'e', 'a', 'o', Spanish 'u', etc.)
      // must never be recovered from bare prose. If an LLM dropped delimiters for a single-letter word,
      // attempting to wrap bare letters in prose will corrupt ordinary conjunctions and articles.
      if (expr.length === 1 && /^[aeiouyAEIOUY]$/.test(expr)) {
        continue;
      }
      equationsToRestore.push({
        expression: expr,
        isDisplay: orig.isDisplay,
        needed,
      });
    }
  }

  if (equationsToRestore.length === 0) {
    return translatedText;
  }

  // Segment translatedText across links, code blocks, HTML tags, and equations
  const segments = collectAllSegments(translatedText);

  for (const eq of equationsToRestore) {
    const expr = eq.expression;
    if (!expr) continue;

    const escaped = escapeRegExp(expr);
    const startsWithWord = /^\w/.test(expr);
    const endsWithWord = /\w$/.test(expr);
    const prefix = startsWithWord ? "(?<![\\w$])" : "(?<!\\$)";
    const suffix = endsWithWord ? "(?![\\w$])" : "(?!\\$)";
    const searchRegex = new RegExp(`${prefix}${escaped}${suffix}`, "g");

    // Count how many standalone matches exist across all prose segments
    let matchCount = 0;
    for (const seg of segments) {
      if (seg.isProse) {
        const m = seg.text.match(searchRegex);
        if (m) matchCount += m.length;
      }
    }

    if (matchCount === 0) continue;

    // For single-letter equations (e.g. 'x'):
    // If the number of standalone occurrences does not exactly match the number of missing equations,
    // it is ambiguous and could be unrelated characters or duplicate terms. Do not replace.
    if (expr.length === 1 && matchCount !== eq.needed) {
      continue;
    }

    // Replace at most eq.needed occurrences across the prose segments (never unbounded global replace)
    let remainingNeeded = eq.needed;
    const delimiter = eq.isDisplay ? `$$${expr}$$` : `$${expr}$`;

    for (const seg of segments) {
      if (!seg.isProse || remainingNeeded <= 0) continue;
      seg.text = seg.text.replace(searchRegex, (matched) => {
        if (remainingNeeded > 0) {
          remainingNeeded -= 1;
          return delimiter;
        }
        return matched;
      });
    }
  }

  return segments.map((s) => s.text).join("");
}


