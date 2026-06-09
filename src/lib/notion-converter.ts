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
  external?: { url: string };
  file?: { url: string; expiry_time?: string };
  caption: NotionRichText[];
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
      let text = rt.plain_text || "";

      if (rt.annotations.bold) {
        text = `**${text}**`;
      }
      if (rt.annotations.italic) {
        text = `*${text}*`;
      }
      if (rt.annotations.strikethrough) {
        text = `~~${text}~~`;
      }
      if (rt.annotations.underline) {
        text = `<u>${text}</u>`;
      }
      if (rt.annotations.code) {
        text = "`" + text + "`";
      }

      // Color (foreground only — skip "default" and background colors)
      const color = rt.annotations.color;
      if (color && color !== "default" && !color.endsWith("_background")) {
        text = `<span style="color:${color}">${text}</span>`;
      }

      // Links: prefer href from mention, then text.link, then annotations
      const linkUrl = rt.href || rt.text?.link?.url;
      if (linkUrl && !rt.annotations.code) {
        text = `[${rt.plain_text || text}](${linkUrl})`;
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
  const text = richTextToMarkdown(getRichText(block));
  return text || "";
}

function convertHeading(
  block: NotionBlock,
  level: number,
  _children: NotionBlock[],
): string {
  const text = richTextToMarkdown(getRichText(block));
  const prefix = "#".repeat(level);
  return `${prefix} ${text}`;
}

function convertBulletedList(
  block: NotionBlock,
  children: NotionBlock[],
  nestLevel: number,
): string {
  const indent = "  ".repeat(nestLevel);
  const text = richTextToMarkdown(getRichText(block));
  let output = `${indent}- ${text}`;

  if (children.length > 0) {
    for (const child of children) {
      output += "\n" + convertSingleBlock(child, nestLevel + 1);
    }
  }
  return output;
}

function convertNumberedList(
  block: NotionBlock,
  children: NotionBlock[],
  nestLevel: number,
): string {
  const indent = "  ".repeat(nestLevel);
  const text = richTextToMarkdown(getRichText(block));
  let output = `${indent}1. ${text}`;

  if (children.length > 0) {
    for (const child of children) {
      output += "\n" + convertSingleBlock(child, nestLevel + 1);
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
): string {
  const text = richTextToMarkdown(getRichText(block));
  let output = `<details>\n<summary>${text}</summary>\n`;

  if (children.length > 0) {
    output += "\n";
    for (const child of children) {
      output += convertSingleBlock(child, 0) + "\n";
    }
  }

  output += "\n</details>";
  return output;
}

function convertQuote(
  block: NotionBlock,
  children: NotionBlock[],
): string {
  const text = richTextToMarkdown(getRichText(block));
  let output = `> ${text}`;

  if (children.length > 0) {
    output += "\n> ";
    for (const child of children) {
      const childText = convertSingleBlock(child, 0);
      output += "\n> " + childText;
    }
  }
  return output;
}

function convertCallout(
  block: NotionBlock,
  _children: NotionBlock[],
): string {
  const text = richTextToMarkdown(getRichText(block));
  // Emit as a blockquote with NOTE prefix
  const lines = text.split("\n").map((l) => `> ${l}`);
  return `> [!NOTE]\n${lines.join("\n")}`;
}

function convertCode(block: NotionBlock): string {
  const richText = getRichText(block);
  const text = richText.map((rt) => rt.plain_text).join("");
  const language = (block.code as CodeContent)?.language ?? "";
  return "```" + language + "\n" + text + "\n```";
}

function convertImage(block: NotionBlock): string {
  const caption = richTextToMarkdown(getCaption(block));
  const alt = caption || "image";
  const content = block.image as ImageContent;

  let url = "";
  if (content.type === "external" && content.external?.url) {
    url = content.external.url;
  } else if (content.type === "file" && content.file?.url) {
    url = content.file.url;
  }

  return `![${alt}](${url})`;
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
): string {
  if (children.length === 0) return "";

  const rows = children.map((row) => {
    const cells = (row.table_row as TableRowContent)?.cells ?? [];
    return (
      "| " +
      cells.map((cell) => richTextToMarkdown(cell)).join(" | ") +
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
  return "---";
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
  nestLevel: number = 0,
): string {
  const children = getChildren(block.id);

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
      return convertBulletedList(block, children, nestLevel);
    case "numbered_list_item":
      return convertNumberedList(block, children, nestLevel);
    case "to_do":
      return convertToDo(block);

    case "toggle":
      return convertToggle(block, children);

    case "quote":
      return convertQuote(block, children);

    case "callout":
      return convertCallout(block, children);

    case "code":
      return convertCode(block);

    case "image":
      return convertImage(block);
    case "video":
    case "file":
      return convertVideoOrFile(block);

    case "table":
      return convertTable(block, children);

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

    // Silently skip blocks the integration can't access or that we don't render
    case "unsupported":
    case "child_database":
    case "link_to_page":
    case "synced_block":
    case "ai_block":
    case "column_list":
    case "column":
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

  const mergedBlocks = mergeChildren(blockList);

  const lines: string[] = [];

  for (const block of mergedBlocks) {
    const output = convertSingleBlock(block, 0);
    if (output) {
      lines.push(output);
    }
  }

  if (lines.length === 0) return "";
  return lines.join("\n\n") + "\n";
}

/**
 * Merge children map into the block tree so each block has its children
 * accessible directly (for use inside convertSingleBlock).
 *
 * We store children on demand via a closure — the getChildren helper above
 * reads from a module-level map. Here we set it up so convertSingleBlock
 * can find children for any block ID.
 */
let _globalChildrenMap: Record<string, NotionBlock[]> = {};

function getChildren(blockId: string): NotionBlock[] {
  return _globalChildrenMap[blockId] ?? [];
}

function mergeChildren(blockList: NotionBlockList): NotionBlock[] {
  _globalChildrenMap = blockList.children ?? {};
  return blockList.results;
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
