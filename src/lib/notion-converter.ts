/**
 * Notion block → Markdown conversion.
 *
 * Supports the block types listed in spec §9.1. Unsupported blocks
 * emit a visible callout placeholder.
 */

// ── Types ──

export interface NotionRichText {
  type: "text" | "mention" | "equation";
  text?: { content: string; link?: { url: string } | null };
  plain_text: string;
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  };
  href?: string;
  mention?: unknown;
  equation?: unknown;
}

export interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children: boolean;
  [blockContent: string]: unknown;
}

export interface NotionBlockList {
  object: "list";
  results: NotionBlock[];
  children?: Record<string, NotionBlock[]>;
}

// Block content accessors with type-specific payloads
interface HeadingContent {
  rich_text: NotionRichText[];
}

interface ParagraphContent {
  rich_text: NotionRichText[];
}

interface BulletedListItemContent {
  rich_text: NotionRichText[];
}

interface NumberedListItemContent {
  rich_text: NotionRichText[];
}

interface ToDoContent {
  rich_text: NotionRichText[];
  checked?: boolean;
}

interface ToggleContent {
  rich_text: NotionRichText[];
}

interface QuoteContent {
  rich_text: NotionRichText[];
}

interface CalloutContent {
  rich_text: NotionRichText[];
  icon?: unknown;
}

interface CodeContent {
  rich_text: NotionRichText[];
  language?: string;
}

interface ImageContent {
  type: "external" | "file";
  external?: { url: string; link?: { url: string } };
  file?: { url: string; expiry_time?: string; link?: { url: string } };
  caption: NotionRichText[];
  link?: { url: string };
}

interface TableContent {
  table_width: number;
  has_column_header: boolean;
  has_row_header: boolean;
}

interface TableRowContent {
  cells: NotionRichText[][];
}

interface DividerContent {
  // no content
}

// ── Rich text → Markdown ──

const SUPPORTED_BLOCKS = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "image",
  "video",
  "file",
  "table",
  "table_row",
  "divider",
  "bookmark",
  "link_preview",
  "child_page",
  "unsupported",
  "child_database",
  "link_to_page",
  "synced_block",
  "ai_block",
  "column_list",
  "column",
  "table_of_contents",
  "embed",
  "pdf",
  "equation",
  "breadcrumb",
]);

export function isSupportedBlock(type: string): boolean {
  return SUPPORTED_BLOCKS.has(type);
}

/**
 * Convert a Notion rich text array to a Markdown string.
 */
export function richTextToMarkdown(richText: NotionRichText[]): string {
  if (!richText || richText.length === 0) return "";

  return richText
    .map((rt) => {
      // Custom emoji mention → inline image sized as a 1.2em glyph
      // (asset pipeline rehosts <img src> URLs to local assets/ paths)
      if (rt.type === "mention") {
        const mention = rt.mention as
          | { type?: string; custom_emoji?: { url?: string; name?: string } }
          | undefined;
        if (mention?.type === "custom_emoji" && mention.custom_emoji?.url) {
          const emojiName = (mention.custom_emoji.name || "emoji").replace(/"/g, "&quot;");
          return `<img src="${mention.custom_emoji.url}" alt="${emojiName}" className="emoji" style={{display:"inline",height:"1.2em",width:"auto",verticalAlign:"text-bottom",margin:"0 0.1em"}} />`;
        }
      }

      let text = rt.plain_text || "";

      // Apply inline annotations to a single line segment. Markdown inline
      // markers (**bold**, *italic*, ~~strike~~, `code`) must open and close on
      // the same line, so wrapping is done per-line below — otherwise a run
      // whose text spans a newline produces a dangling marker (e.g. `**Data`).
      const applyInline = (segment: string): string => {
        // Don't wrap empty segments (blank lines) — keeps them blank.
        if (segment === "") return "";
        // Whitespace-only segments must not receive inline markers.
        // Markers that open or close adjacent to whitespace are not valid
        // emphasis delimiters in CommonMark — they render as literal asterisks.
        if (segment.trim() === "") return segment;

        // Punctuation/symbol-only segments (no letters or digits) must not be
        // emphasized either: authors sometimes bold/italicize just a ":" after
        // a word ("Step 1*:*"), and per CommonMark flanking rules an emphasis
        // delimiter between an alphanumeric and punctuation is not left-flanking
        // — the markers render literally. Styling bare punctuation is visually
        // meaningless, so drop the markers (keep color spans, which still work).
        if (!/[\p{L}\p{N}]/u.test(segment) && !rt.annotations.code) {
          const color = rt.annotations.color;
          if (color && color !== "default" && !color.endsWith("_background")) {
            return `<span style={{color:"${color}"}}>${segment}</span>`;
          }
          return segment;
        }

        // Hoist leading/trailing whitespace outside inline markers (MD037).
        // e.g. bold(" Step 2: ") → " **Step 2:** " not "** Step 2: **"
        const leadMatch = segment.match(/^(\s+)/);
        const leadingWs = leadMatch ? leadMatch[1] : "";
        const trailMatch = segment.match(/(\s+)$/);
        const trailingWs = trailMatch ? trailMatch[1] : "";
        let s = segment.slice(leadingWs.length, segment.length - trailingWs.length);

        if (rt.annotations.bold) {
          s = `**${s}**`;
        }
        if (rt.annotations.italic) {
          s = `*${s}*`;
        }
        if (rt.annotations.strikethrough) {
          s = `~~${s}~~`;
        }
        if (rt.annotations.underline) {
          s = `<u>${s}</u>`;
        }
        if (rt.annotations.code) {
          // For code spans, hoist surrounding whitespace but preserve interior.
          s = "`" + s + "`";
        }

        // Color (foreground only — skip "default" and background colors).
        // Docusaurus parses .md as MDX, so the style prop must be a JSX object
        // (style={{color:"red"}}), not an HTML string — a string style throws
        // at static-site-generation time.
        const color = rt.annotations.color;
        if (color && color !== "default" && !color.endsWith("_background")) {
          s = `<span style={{color:"${color}"}}>${s}</span>`;
        }
        return leadingWs + s + trailingWs;
      };

      text = text.includes("\n")
        ? text.split("\n").map(applyInline).join("\n")
        : applyInline(text);

      // Links: prefer href from mention, then text.link, then annotations
      const linkUrl = rt.href || rt.text?.link?.url;
      if (linkUrl && !rt.annotations.code) {
        // Hoist leading/trailing whitespace outside the bracket syntax (MD039).
        // e.g. plain_text=" text " → " [text](url) " not "[ text ](url)"
        const rawLinkText = rt.plain_text || text;
        const linkLeadMatch = rawLinkText.match(/^(\s+)/);
        const linkLeadWs = linkLeadMatch ? linkLeadMatch[1] : "";
        const linkTrailMatch = rawLinkText.match(/(\s+)$/);
        const linkTrailWs = linkTrailMatch ? linkTrailMatch[1] : "";
        const innerText = rawLinkText.slice(linkLeadWs.length, rawLinkText.length - linkTrailWs.length);
        if (innerText) {
          text = linkLeadWs + `[${innerText}](${linkUrl})` + linkTrailWs;
        } else {
          // Whitespace-only link text: emit the whitespace without brackets.
          text = rawLinkText;
        }
      }

      return text;
    })
    .join("");
}

/**
 * Extract rich text content from a block's data by property name.
 */
function getRichText(block: NotionBlock): NotionRichText[] {
  const content = block[block.type] as { rich_text?: NotionRichText[] } | undefined;
  return content?.rich_text ?? [];
}

/**
 * Extract caption from image/video/file blocks.
 */
function getCaption(block: NotionBlock): NotionRichText[] {
  const content = block[block.type] as { caption?: NotionRichText[] } | undefined;
  return content?.caption ?? [];
}

// ── Block converters ──

function convertParagraph(block: NotionBlock, _children: NotionBlock[]): string {
  const richText = getRichText(block);
  // Empty paragraphs (visual spacers in Notion) → notion-spacer div
  if (!richText || richText.length === 0) {
    return '<div class="notion-spacer" aria-hidden="true" role="presentation"></div>';
  }
  const text = richTextToMarkdown(richText);
  return text || '<div class="notion-spacer" aria-hidden="true" role="presentation"></div>';
}

function convertHeading(
  block: NotionBlock,
  level: number,
  _children: NotionBlock[],
): string {
  // Trim heading text to remove leading/trailing whitespace that Notion can
  // produce (e.g. a leading space from a padded rich-text span), which would
  // generate `##  Title` (double-space) failing MD019.
  const text = richTextToMarkdown(getRichText(block)).trim();
  const prefix = "#".repeat(level);
  return `${prefix} ${text}`;
}

function convertBulletedList(
  block: NotionBlock,
  children: NotionBlock[],
  nestLevel: number,
  childrenMap: Record<string, NotionBlock[]>,
): string {
  const indent = "  ".repeat(nestLevel);
  const text = richTextToMarkdown(getRichText(block));
  let output = `${indent}- ${text}`;

  if (children.length > 0) {
    for (const child of children) {
      output += "\n" + convertSingleBlock(child, nestLevel + 1, childrenMap);
    }
  }
  return output;
}

function convertNumberedList(
  block: NotionBlock,
  children: NotionBlock[],
  nestLevel: number,
  childrenMap: Record<string, NotionBlock[]>,
): string {
  const indent = "  ".repeat(nestLevel);
  const text = richTextToMarkdown(getRichText(block));
  let output = `${indent}1. ${text}`;

  if (children.length > 0) {
    for (const child of children) {
      output += "\n" + convertSingleBlock(child, nestLevel + 1, childrenMap);
    }
  }
  return output;
}

function convertToDo(block: NotionBlock): string {
  const checked = (block.to_do as ToDoContent)?.checked ?? false;
  const marker = checked ? "[x]" : "[ ]";
  const text = richTextToMarkdown(getRichText(block));
  return `- ${marker} ${text}`;
}

function convertToggle(
  block: NotionBlock,
  children: NotionBlock[],
  childrenMap: Record<string, NotionBlock[]>,
): string {
  const text = richTextToMarkdown(getRichText(block));
  let output = `<details>\n<summary>${text}</summary>\n`;

  if (children.length > 0) {
    output += "\n";
    for (const child of children) {
      output += convertSingleBlock(child, 0, childrenMap) + "\n";
    }
  }

  output += "\n</details>";
  return output;
}

function convertQuote(
  block: NotionBlock,
  children: NotionBlock[],
  childrenMap: Record<string, NotionBlock[]>,
): string {
  const text = richTextToMarkdown(getRichText(block));
  let output = `> ${text}`;

  if (children.length > 0) {
    for (const child of children) {
      const childText = convertSingleBlock(child, 0, childrenMap);
      const prefixedLines = childText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      output += "\n" + prefixedLines;
    }
  }
  return output;
}

function convertCallout(
  block: NotionBlock,
  children: NotionBlock[],
  childrenMap: Record<string, NotionBlock[]>,
): string {
  const richText = getRichText(block);
  const calloutData = block.callout as {
    rich_text?: NotionRichText[];
    icon?: { type: string; emoji?: string } | null;
    color?: string;
  } | undefined;

  const color = calloutData?.color ?? "default";
  const admonitionType = CALLOUT_COLOR_MAP[color] ?? "note";

  // Extract emoji icon
  let icon: string | null = null;
  if (calloutData?.icon?.type === "emoji" && calloutData.icon.emoji) {
    icon = calloutData.icon.emoji;
  }

  // Convert rich text to markdown and split into lines, preserving leading whitespace
  const text = richTextToMarkdown(richText);
  let lines = text.split("\n").map((l) => l.replace(/\s+$/u, ""));

  // Strip emoji icon from first line if present
  if (icon && lines.length > 0) {
    const firstLine = lines[0];
    const leading = firstLine.match(/^\s*/)?.[0] ?? "";
    const trimmed = firstLine.slice(leading.length);

    if (trimmed.startsWith(icon)) {
      let remainder = trimmed.slice(icon.length);
      // Strip whitespace/separators after icon
      const sepMatch = remainder.match(/^[\s   :;!?¡¿\-–—–—−‑‒：﹕꞉；，、。．·•・.]+/u);
      if (sepMatch) {
        remainder = remainder.slice(sepMatch[0].length);
      }
      if (remainder) {
        lines[0] = leading + remainder;
      } else {
        lines = lines.slice(1);
      }
    }
  }

  // Extract title from first line
  let derivedTitle: string | undefined;
  let contentLines = lines;

  if (lines.length > 0) {
    const firstLine = lines[0].trimStart();
    const leading = lines[0].match(/^\s*/)?.[0] ?? "";

    // Try bold title: **Title** separator? remainder
    const boldMatch = firstLine.match(/^\*\*(.+?)\*\*(?:\s*[:;!?\-–—–—−‑‒：﹕꞉]+)?\s*(.*)$/u);
    if (boldMatch && boldMatch[2]) {
      const rawTitle = boldMatch[1].trim();
      // Strip trailing punctuation
      const cleanTitle = rawTitle.replace(/[:.!?;：﹕꞉。！？；]+$/u, "");
      derivedTitle = icon ? `${icon} ${cleanTitle}` : cleanTitle;
      contentLines = boldMatch[2] ? [`${leading}${boldMatch[2]}`, ...lines.slice(1)] : lines.slice(1);
    } else if (boldMatch && lines.length > 1) {
      // Bold title is the whole first line, content on next lines
      const rawTitle = boldMatch[1].trim();
      const cleanTitle = rawTitle.replace(/[:.!?;：﹕꞉。！？；]+$/u, "");
      derivedTitle = icon ? `${icon} ${cleanTitle}` : cleanTitle;
      contentLines = lines.slice(1);
    }

    // Try plain "Title: content" pattern if no bold title found
    if (!derivedTitle) {
      const plainMatch = firstLine.match(/^([\p{L}][^:：﹕꞉\n]{0,49}?)\s*[:：﹕꞉]\s*(.*)$/u);
      if (plainMatch && plainMatch[2]) {
        const titleCandidate = plainMatch[1].trim();
        const remainder = plainMatch[2].trimStart();
        if (titleCandidate && remainder) {
          derivedTitle = icon ? `${icon} ${titleCandidate}` : titleCandidate;
          contentLines = [`${leading}${remainder}`, ...lines.slice(1)];
        }
      }
    }

    // If icon present but no textual title extracted, use icon alone
    if (icon && !derivedTitle) {
      derivedTitle = icon;
    }
  }

  // Convert children to markdown
  let childrenOutput = "";
  if (children.length > 0) {
    childrenOutput = children
      .map((child) => convertSingleBlock(child, 0, childrenMap))
      .filter(Boolean)
      .join("\n\n");
  }

  const joinedContent = contentLines.join("\n").replace(/^[\s\t]*\n+/u, "").replace(/\n+[\s\t]*$/u, "");

  // Nested admonitions (a Notion callout inside a callout/toggle) require the
  // OUTER fence to use more colons than any fence it contains — with equal
  // colons the first inner `:::` closes the outer container early and the
  // outer's own close renders as literal ":::" text (Docusaurus/remark-directive
  // rule). Scan the already-converted inner content for its deepest fence and
  // go one colon deeper (minimum 3).
  const innerContent = [joinedContent, childrenOutput].filter(Boolean).join("\n\n");
  let maxInnerColons = 2;
  for (const line of innerContent.split("\n")) {
    const m = line.match(/^(:{3,})/);
    if (m && m[1].length > maxInnerColons) maxInnerColons = m[1].length;
  }
  const fence = ":".repeat(Math.max(3, maxInnerColons + 1));

  // Build admonition
  const result: string[] = [];
  result.push(`${fence}${admonitionType}${derivedTitle ? " " + derivedTitle : ""}`);

  if (innerContent) {
    result.push(innerContent);
  }

  // Blank line before the closing fence so it can never be swallowed as a lazy
  // continuation of the preceding paragraph/image line.
  result.push("");
  result.push(fence);
  return result.join("\n");
}

// Callout color → Docusaurus admonition type mapping
const CALLOUT_COLOR_MAP: Record<string, string> = {
  blue_background: "info",
  yellow_background: "warning",
  red_background: "danger",
  green_background: "tip",
  gray_background: "note",
  orange_background: "caution",
  purple_background: "note",
  pink_background: "note",
  brown_background: "note",
  default: "note",
};

function convertCode(block: NotionBlock): string {
  const richText = getRichText(block);
  const text = richText.map((rt) => rt.plain_text).join("");
  const language = (block.code as CodeContent)?.language ?? "";
  return "```" + language + "\n" + text + "\n```";
}

function convertImage(block: NotionBlock): string {
  const captionRichText = getCaption(block);
  const content = block.image as ImageContent;

  let imgUrl = "";
  if (content.type === "external" && content.external?.url) {
    imgUrl = content.external.url;
  } else if (content.type === "file" && content.file?.url) {
    imgUrl = content.file.url;
  }

  // Check for link URL in priority order:
  // 1. Block-level image link (block.image.link)
  // 2. Content-level link (external.link or file.link)
  // 3. Caption-based link (from rich text)
  let linkUrl: string | null =
    content.link?.url ??
    content.external?.link?.url ??
    content.file?.link?.url ??
    null;

  // Fall back to caption-based link extraction
  if (!linkUrl) {
    linkUrl = extractCaptionLink(captionRichText);
  }

  if (linkUrl) {
    // Use plain text for alt (no link formatting) when image itself is linked
    const plainAlt = captionRichText.map((rt) => rt.plain_text || "").join("") || "image";
    return `[![${plainAlt}](${imgUrl})](${linkUrl})`;
  }

  // Normal image — use plain text for alt (formatting doesn't render in HTML alt attributes)
  const alt = captionRichText.map((rt) => rt.plain_text || "").join("") || "image";
  return `![${alt}](${imgUrl})`;
}

/** Extract the first hyperlink URL from caption rich text, if any. */
function extractCaptionLink(caption: NotionRichText[]): string | null {
  if (!caption || caption.length === 0) return null;

  for (const rt of caption) {
    // 1. Check dedicated link property on text items
    if (rt.text?.link?.url) {
      return rt.text.link.url;
    }
    // 2. Check href property
    if (rt.href) {
      return rt.href;
    }
    // 3. Check plain-text for URLs (old pipeline regex fallback)
    const plainText = rt.plain_text || "";
    const urlMatch = plainText.match(/https?:\/\/[^\s<>"]+/);
    if (urlMatch) {
      return urlMatch[0];
    }
  }
  return null;
}

function convertVideoOrFile(block: NotionBlock): string {
  const caption = richTextToMarkdown(getCaption(block));
  const alt = caption || block.type;
  const content = block[block.type] as ImageContent;

  let url = "";
  if (content?.type === "external" && content.external?.url) {
    url = content.external.url;
  } else if (content?.type === "file" && content.file?.url) {
    url = content.file.url;
  }

  if (caption) {
    return `[${alt}](${url})`;
  }
  return `[${block.type}](${url})`;
}

function convertTable(
  block: NotionBlock,
  children: NotionBlock[],
  _childrenMap: Record<string, NotionBlock[]>,
): string {
  if (children.length === 0) return "";

  const rows = children.map((row) => {
    const cells = (row.table_row as TableRowContent)?.cells ?? [];
    return (
      "| " +
      cells.map((cell) => {
        const raw = richTextToMarkdown(cell);
        // Newlines inside table cells break Markdown table syntax (MD056).
        // Trim edge whitespace first (which handles trailing-newline artifacts),
        // then replace any remaining interior newlines with <br />.
        return raw.trim().replace(/\n/g, "<br />");
      }).join(" | ") +
      " |"
    );
  });

  if (rows.length === 0) return "";

  // Build separator row after header
  const colCount =
    (children[0].table_row as TableRowContent)?.cells?.length ?? 1;
  const separator =
    "| " + Array(colCount).fill("---").join(" | ") + " |";

  const result = [rows[0], separator, ...rows.slice(1)];
  return result.join("\n");
}

function convertDivider(): string {
  // Prepend a blank line so a `---` that follows body text (e.g. inside a
  // callout where children are joined with a single newline) is never parsed
  // as a setext H2 heading (MD003).  At the top level, `convertBlocks` already
  // joins blocks with `\n\n`, so the extra leading newline creates at most one
  // additional blank line, which Markdown renderers collapse harmlessly.
  return "\n---";
}

function convertEmbed(block: NotionBlock): string {
  const url = (block.embed as { url?: string })?.url ?? "";
  return url ? `[Embedded content](${url})` : "";
}

function convertPdf(block: NotionBlock): string {
  const content = block.pdf as
    | { external?: { url: string }; file?: { url: string }; caption?: NotionRichText[] }
    | undefined;
  const url = content?.external?.url ?? content?.file?.url ?? "";
  const caption = richTextToMarkdown(getCaption(block));
  const label = caption || "PDF";
  return url ? `[PDF: ${label}](${url})` : "";
}

function convertEquation(block: NotionBlock): string {
  const expression = (block.equation as { expression?: string })?.expression ?? "";
  return expression ? `$$${expression}$$` : "";
}

function convertBookmarkOrLinkPreview(block: NotionBlock): string {
  const url = (block[block.type] as { url?: string })?.url ?? "";
  const caption = richTextToMarkdown(getCaption(block));
  if (caption) {
    return `[${caption}](${url})`;
  }
  return url ? `[${url}](${url})` : "";
}

function convertChildPage(block: NotionBlock): string {
  const title = (block.child_page as { title?: string })?.title ?? "child page";
  return `📄 ${title}`;
}

function convertUnsupportedBlock(block: NotionBlock): string {
  return `> [!NOTE]\n> Unsupported Notion block: \`${block.type}\``;
}

// ── Main conversion ──

function convertSingleBlock(
  block: NotionBlock,
  nestLevel: number,
  childrenMap: Record<string, NotionBlock[]>,
): string {
  const children = childrenMap[block.id] ?? [];

  switch (block.type) {
    case "paragraph":
      return convertParagraph(block, children);

    case "heading_1":
      return convertHeading(block, 1, children);
    case "heading_2":
      return convertHeading(block, 2, children);
    case "heading_3":
      return convertHeading(block, 3, children);

    case "bulleted_list_item":
      return convertBulletedList(block, children, nestLevel, childrenMap);
    case "numbered_list_item":
      return convertNumberedList(block, children, nestLevel, childrenMap);
    case "to_do":
      return convertToDo(block);

    case "toggle":
      return convertToggle(block, children, childrenMap);

    case "quote":
      return convertQuote(block, children, childrenMap);

    case "callout":
      return convertCallout(block, children, childrenMap);

    case "code":
      return convertCode(block);

    case "image":
      return convertImage(block);
    case "video":
    case "file":
      return convertVideoOrFile(block);

    case "table":
      return convertTable(block, children, childrenMap);

    case "table_row":
      // Handled inside convertTable; standalone rows shouldn't exist
      return "";

    case "divider":
      return convertDivider();

    case "bookmark":
    case "link_preview":
      return convertBookmarkOrLinkPreview(block);

    case "child_page":
      return convertChildPage(block);

    case "synced_block": {
      // Inline resolved children of a synced block (original or duplicate).
      const syncedChildren = childrenMap[block.id] ?? [];
      if (syncedChildren.length === 0) return "";
      return syncedChildren
        .map((child) => convertSingleBlock(child, 0, childrenMap))
        .filter(Boolean)
        .join("\n");
    }

    case "link_to_page": {
      // Best-effort link so the page reference is not lost.
      const link = block.link_to_page as
        | { type?: string; page_id?: string; database_id?: string }
        | undefined;
      const id = link?.page_id ?? link?.database_id;
      if (!id) return "";
      return `[Linked page](https://www.notion.so/${id.replace(/-/g, "")})`;
    }

    case "child_database":
      // A Notion database view cannot be rendered statically.
      return "";

    // Silently skip blocks the integration can't access or that we don't render
    case "unsupported":
    case "ai_block":
    case "column_list": {
      // Flatten column layout: iterate column children, then each column's children
      const columnBlocks = childrenMap[block.id] ?? [];
      const columnOutputs: string[] = [];
      for (const col of columnBlocks) {
        const colChildren = childrenMap[col.id] ?? [];
        if (colChildren.length > 0) {
          for (const child of colChildren) {
            const output = convertSingleBlock(child, 0, childrenMap);
            if (output) {
              columnOutputs.push(output);
            }
          }
        }
      }
      return columnOutputs.join("\n\n");
    }

    case "column":
      // Individual column blocks are handled inside column_list above.
      // If encountered standalone (shouldn't happen), convert their children.
      return (childrenMap[block.id] ?? [])
        .map((child) => convertSingleBlock(child, 0, childrenMap))
        .filter(Boolean)
        .join("\n\n");

    case "embed":
      return convertEmbed(block);

    case "pdf":
      return convertPdf(block);

    case "equation":
      return convertEquation(block);

    case "breadcrumb":
      return "";

    case "table_of_contents":
      return "";

    default:
      return convertUnsupportedBlock(block);
  }
}

/**
 * Convert a Notion block list (with optional children) to Markdown.
 *
 * Handles the children map for nested block structures.
 */
export function convertBlocks(blockList: NotionBlockList): string {
  if (!blockList?.results || blockList.results.length === 0) return "";

  const childrenMap = blockList.children ?? {};

  const lines: string[] = [];

  for (const block of blockList.results) {
    const output = convertSingleBlock(block, 0, childrenMap);
    if (output) {
      lines.push(output);
    }
  }

  if (lines.length === 0) return "";
  return lines.join("\n\n") + "\n";
}



/**
 * Get the plain text representation of all rich text in a block.
 */
export function blockPlainText(block: NotionBlock): string {
  const richText = getRichText(block);
  if (richText.length === 0) {
    // Try caption for image/video blocks
    const caption = getCaption(block);
    if (caption.length > 0) {
      return caption.map((rt) => rt.plain_text).join("");
    }
  }
  return richText.map((rt) => rt.plain_text).join("");
}
