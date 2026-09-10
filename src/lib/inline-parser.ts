import type { NotionRichText } from "./notion-converter.js";

export interface NotionTextRichText extends NotionRichText {
  type: "text";
  text: {
    content: string;
    link: { url: string } | null;
  };
}

export type NotionRichTextItem = NotionTextRichText;

const MAX_RICH_TEXT_LENGTH = 1900;

interface IntermediateSpan {
  content: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  strikethrough: boolean;
  url: string | null;
}

/**
 * Tokenizes and parses inline markdown into Notion rich_text spans.
 */
export function inlineMarkdownToRichText(markdown: string): NotionTextRichText[] {
  if (!markdown) return [];

  const rawSpans = parseInlineSegments(markdown);
  const result: NotionTextRichText[] = [];

  for (const span of rawSpans) {
    if (!span.content) continue;

    // Split text exceeding MAX_RICH_TEXT_LENGTH
    if (span.content.length <= MAX_RICH_TEXT_LENGTH) {
      result.push(toNotionRichTextItem(span.content, span));
    } else {
      let remaining = span.content;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, MAX_RICH_TEXT_LENGTH);
        remaining = remaining.slice(MAX_RICH_TEXT_LENGTH);
        result.push(toNotionRichTextItem(chunk, span));
      }
    }
  }

  return result.length > 0 ? result : [toNotionRichTextItem("", {
    content: "",
    bold: false,
    italic: false,
    code: false,
    strikethrough: false,
    url: null,
  })];
}

function toNotionRichTextItem(content: string, meta: IntermediateSpan): NotionTextRichText {
  return {
    type: "text",
    text: {
      content,
      link: meta.url ? { url: meta.url } : null,
    },
    annotations: {
      bold: meta.bold,
      italic: meta.italic,
      strikethrough: meta.strikethrough,
      underline: false,
      code: meta.code,
      color: "default",
    },
    plain_text: content,
    href: meta.url ?? undefined,
  };
}

/**
 * Top-level inline segment parser that handles links, code, bold, italic, and strikethrough.
 */
function parseInlineSegments(text: string): IntermediateSpan[] {
  const spans: IntermediateSpan[] = [];

  // Match links or code blocks or formatting
  // Link pattern: [link text](url)
  const linkRegex = /\[(?<linkText>[^\]]+)\]\((?<linkUrl>[^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index);
      spans.push(...parseFormatting(before, null));
    }

    const linkText = match.groups?.linkText ?? "";
    const linkUrl = match.groups?.linkUrl ?? "";
    spans.push(...parseFormatting(linkText, linkUrl));

    lastIndex = linkRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    spans.push(...parseFormatting(text.slice(lastIndex), null));
  }

  return spans;
}

/**
 * Parses inline formatting (code, bold, italic, strike) within a non-link or link segment.
 */
function parseFormatting(text: string, linkUrl: string | null): IntermediateSpan[] {
  const result: IntermediateSpan[] = [];

  const tokenRegex = /(?<code>`[^`]+`)|(?<boldItalic>\*\*\*[^*]+\*\*\*)|(?<bold>\*\*[^*]+\*\*)|(?<italic>\*[^*]+\*|_[^_]+_)|(?<strike>~~[^~]+~~)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      result.push({
        content: plain,
        bold: false,
        italic: false,
        code: false,
        strikethrough: false,
        url: linkUrl,
      });
    }

    const matchedStr = match[0];
    if (match.groups?.code) {
      result.push({
        content: matchedStr.slice(1, -1),
        bold: false,
        italic: false,
        code: true,
        strikethrough: false,
        url: linkUrl,
      });
    } else if (match.groups?.boldItalic) {
      result.push({
        content: matchedStr.slice(3, -3),
        bold: true,
        italic: true,
        code: false,
        strikethrough: false,
        url: linkUrl,
      });
    } else if (match.groups?.bold) {
      result.push({
        content: matchedStr.slice(2, -2),
        bold: true,
        italic: false,
        code: false,
        strikethrough: false,
        url: linkUrl,
      });
    } else if (match.groups?.italic) {
      result.push({
        content: matchedStr.slice(1, -1),
        bold: false,
        italic: true,
        code: false,
        strikethrough: false,
        url: linkUrl,
      });
    } else if (match.groups?.strike) {
      result.push({
        content: matchedStr.slice(2, -2),
        bold: false,
        italic: false,
        code: false,
        strikethrough: true,
        url: linkUrl,
      });
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    result.push({
      content: text.slice(lastIndex),
      bold: false,
      italic: false,
      code: false,
      strikethrough: false,
      url: linkUrl,
    });
  }

  return result;
}
