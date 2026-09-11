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
  underline: boolean;
  color: NotionRichText["annotations"]["color"];
  url: string | null;
  mention?: unknown;
  equation?: { expression: string };
}

const VALID_NOTION_COLORS = new Set<NotionRichText["annotations"]["color"]>([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "gray_background",
  "brown_background",
  "orange_background",
  "yellow_background",
  "green_background",
  "blue_background",
  "purple_background",
  "pink_background",
  "red_background",
]);

/**
 * Tokenizes and parses inline markdown into Notion rich_text spans.
 */
export function inlineMarkdownToRichText(
  markdown: string,
  emojiMap?: Map<string, string>,
): NotionRichText[] {
  if (!markdown) return [];

  const rawSpans = parseInlineSegments(markdown, emojiMap);
  const result: NotionRichText[] = [];

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

  return result.length > 0
    ? result
    : [
        toNotionRichTextItem("", {
          content: "",
          bold: false,
          italic: false,
          code: false,
          strikethrough: false,
          underline: false,
          color: "default",
          url: null,
        }),
      ];
}

function toNotionRichTextItem(content: string, meta: IntermediateSpan): NotionRichText {
  if (meta.equation) {
    return {
      type: "equation",
      equation: {
        expression: meta.equation.expression,
      },
      annotations: {
        bold: meta.bold,
        italic: meta.italic,
        strikethrough: meta.strikethrough,
        underline: meta.underline,
        code: meta.code,
        color: meta.color,
      },
      plain_text: meta.equation.expression,
      href: meta.url ?? undefined,
    };
  }

  if (meta.mention) {
    return {
      type: "mention",
      mention: meta.mention,
      annotations: {
        bold: meta.bold,
        italic: meta.italic,
        strikethrough: meta.strikethrough,
        underline: meta.underline,
        code: meta.code,
        color: meta.color,
      },
      plain_text: content,
    };
  }

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
      underline: meta.underline,
      code: meta.code,
      color: meta.color,
    },
    plain_text: content,
    href: meta.url ?? undefined,
  };
}

/**
 * Finds the next markdown link `[link text](url)` with balanced parentheses in the URL.
 */
export function findNextLink(
  text: string,
  startIndex: number,
): {
  linkStart: number;
  linkEnd: number;
  linkText: string;
  linkUrl: string;
} | null {
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "[") {
      let bracketDepth = 1;
      let closeBracket = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === "\\") {
          j++;
          continue;
        }
        if (text[j] === "[") {
          bracketDepth++;
        } else if (text[j] === "]") {
          bracketDepth--;
          if (bracketDepth === 0) {
            closeBracket = j;
            break;
          }
        }
      }

      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        let parenDepth = 1;
        let urlEnd = -1;
        for (let k = closeBracket + 2; k < text.length; k++) {
          if (text[k] === "\\") {
            k++;
            continue;
          }
          if (text[k] === "(") {
            parenDepth++;
          } else if (text[k] === ")") {
            parenDepth--;
            if (parenDepth === 0) {
              urlEnd = k;
              break;
            }
          }
        }

        if (urlEnd !== -1) {
          return {
            linkStart: i,
            linkEnd: urlEnd + 1,
            linkText: text.slice(i + 1, closeBracket),
            linkUrl: text.slice(closeBracket + 2, urlEnd),
          };
        }
      }
    }
  }
  return null;
}

/**
 * Top-level inline segment parser that handles links, code, bold, italic, and strikethrough.
 */
function parseInlineSegments(text: string, emojiMap?: Map<string, string>): IntermediateSpan[] {
  const spans: IntermediateSpan[] = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    const linkMatch = findNextLink(text, currentIndex);
    if (!linkMatch) {
      spans.push(...parseFormatting(text.slice(currentIndex), null, emojiMap));
      break;
    }

    if (linkMatch.linkStart > currentIndex) {
      const before = text.slice(currentIndex, linkMatch.linkStart);
      spans.push(...parseFormatting(before, null, emojiMap));
    }

    spans.push(...parseFormatting(linkMatch.linkText, linkMatch.linkUrl, emojiMap));
    currentIndex = linkMatch.linkEnd;
  }

  return spans;
}

interface FormatContext {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  color?: NotionRichText["annotations"]["color"];
}

/**
 * Parses inline formatting (code, bold, italic, strike, underline, color spans, equations) within a non-link or link segment.
 */
function parseFormatting(
  text: string,
  linkUrl: string | null,
  emojiMap?: Map<string, string>,
  ctx: FormatContext = {},
): IntermediateSpan[] {
  const result: IntermediateSpan[] = [];

  const pushPlainText = (plain: string) => {
    if (!plain) return;
    result.push({
      content: plain,
      bold: !!ctx.bold,
      italic: !!ctx.italic,
      code: !!ctx.code,
      strikethrough: !!ctx.strikethrough,
      underline: !!ctx.underline,
      color: ctx.color ?? "default",
      url: linkUrl,
    });
  };

  const tokenRegex =
    /(?<html><img\b[^>]*\/?>|<br\s*\/?>)|(?<underline><u>[\s\S]*?<\/u>)|(?<colorSpan><span\s+style=(?:\{\{\s*color:\s*["'](?<jsxColor>[^"']+)["']\s*\}\}|["']\s*color:\s*(?<htmlColor>[^"';]+);?\s*["'])[^>]*>(?<colorSpanInner>[\s\S]*?)<\/span>)|(?<code>`[^`]+`)|(?<equationDisplay>(?<!\\)\$\$(?<equationDisplayInner>[^$\n]+?)\$\$)|(?<equationInline>(?<![\w\\$])\$(?!\s)(?<equationInlineInner>[^$\n]+?)(?<![\s\\$])\$(?!\d))|(?<boldItalic>(?<![\w*])\*\*\*[^*]+\*\*\*(?![\w*]))|(?<bold>(?<![\w*])\*\*[^*]+\*\*(?![\w*]))|(?<italic>(?<![\w*])\*(?:[^\s*](?:[^*]*?[^\s*])?)\*(?![\w*])|(?<!\w)_(?:[^\s_](?:[^_]*?[^\s_])?)_(?!\w))|(?<strike>~~[^~]+~~)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      pushPlainText(text.slice(lastIndex, match.index));
    }

    const matchedStr = match[0];
    if (match.groups?.underline) {
      const inner = matchedStr.slice(3, -4);
      result.push(
        ...parseFormatting(inner, linkUrl, emojiMap, { ...ctx, underline: true }),
      );
    } else if (match.groups?.colorSpan) {
      const rawColor = (
        match.groups.jsxColor ||
        match.groups.htmlColor ||
        ""
      )
        .trim()
        .toLowerCase();
      const mappedColor = VALID_NOTION_COLORS.has(
        rawColor as NotionRichText["annotations"]["color"],
      )
        ? (rawColor as NotionRichText["annotations"]["color"])
        : (ctx.color ?? "default");
      const inner = match.groups.colorSpanInner ?? "";
      result.push(
        ...parseFormatting(inner, linkUrl, emojiMap, { ...ctx, color: mappedColor }),
      );
    } else if (match.groups?.equationDisplay || match.groups?.equationInline) {
      const rawExpr = match.groups.equationDisplayInner || match.groups.equationInlineInner || "";
      const expr = rawExpr.trim();
      if (expr) {
        result.push({
          content: expr,
          bold: !!ctx.bold,
          italic: !!ctx.italic,
          code: !!ctx.code,
          strikethrough: !!ctx.strikethrough,
          underline: !!ctx.underline,
          color: ctx.color ?? "default",
          url: linkUrl,
          equation: { expression: expr },
        });
      }
    } else if (match.groups?.html) {
      if (matchedStr.startsWith("<img")) {
        const altMatch = matchedStr.match(/alt=["']([^"']*)["']/);
        const srcMatch = matchedStr.match(/src=["']([^"']*)["']/);
        const alt = altMatch ? altMatch[1] : "";
        const src = srcMatch ? srcMatch[1] : "";
        const isEmoji =
          /className=["']emoji["']/.test(matchedStr) ||
          !!(emojiMap && ((alt && emojiMap.has(alt)) || (src && emojiMap.has(src))));
        if (isEmoji) {
          const idMatch = matchedStr.match(/data-emoji-id=["']([^"']+)["']/);

          const emojiId =
            idMatch?.[1] || (emojiMap && (emojiMap.get(alt) || emojiMap.get(src)));
          if (emojiId) {
            result.push({
              content: alt ? `:${alt}:` : ":emoji:",
              bold: !!ctx.bold,
              italic: !!ctx.italic,
              code: !!ctx.code,
              strikethrough: !!ctx.strikethrough,
              underline: !!ctx.underline,
              color: ctx.color ?? "default",
              url: linkUrl,
              mention: {
                type: "custom_emoji",
                custom_emoji: {
                  id: emojiId,
                  ...(src ? { url: src } : {}),
                  ...(alt ? { name: alt } : {}),
                },
              },
            });
            lastIndex = tokenRegex.lastIndex;
            continue;
          }
        }
      }

      result.push({
        content: matchedStr,
        bold: !!ctx.bold,
        italic: !!ctx.italic,
        code: !!ctx.code,
        strikethrough: !!ctx.strikethrough,
        underline: !!ctx.underline,
        color: ctx.color ?? "default",
        url: linkUrl,
      });
    } else if (match.groups?.code) {
      result.push({
        content: matchedStr.slice(1, -1),
        bold: !!ctx.bold,
        italic: !!ctx.italic,
        code: true,
        strikethrough: !!ctx.strikethrough,
        underline: !!ctx.underline,
        color: ctx.color ?? "default",
        url: linkUrl,
      });
    } else if (match.groups?.boldItalic) {
      result.push(
        ...parseFormatting(matchedStr.slice(3, -3), linkUrl, emojiMap, {
          ...ctx,
          bold: true,
          italic: true,
        }),
      );
    } else if (match.groups?.bold) {
      result.push(
        ...parseFormatting(matchedStr.slice(2, -2), linkUrl, emojiMap, {
          ...ctx,
          bold: true,
        }),
      );
    } else if (match.groups?.italic) {
      result.push(
        ...parseFormatting(matchedStr.slice(1, -1), linkUrl, emojiMap, {
          ...ctx,
          italic: true,
        }),
      );
    } else if (match.groups?.strike) {
      result.push(
        ...parseFormatting(matchedStr.slice(2, -2), linkUrl, emojiMap, {
          ...ctx,
          strikethrough: true,
        }),
      );
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    pushPlainText(text.slice(lastIndex));
  }

  return result;
}
