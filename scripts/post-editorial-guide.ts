/**
 * post-editorial-guide.ts
 *
 * Posts docs/editorial-review-workflow.md directly into Notion under section
 * "90+ - Miscellaneous" (Order 94) in the CoMapeo Docs database.
 *
 * Usage:
 *   bun scripts/post-editorial-guide.ts [--dry-run]
 *   bun scripts/post-editorial-guide.ts --apply
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@notionhq/client";

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || "1d81b08162d581d397d0fbd08ee35a0c";
const NOTION_DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID || "1d81b081-62d5-81e5-8d77-000b94415449";

const DOC_PATH = join(process.cwd(), "docs/editorial-review-workflow.md");
const SECTION_NAME = "90+ - Miscellaneous";
const ORDER_NUMBER = 94;
const PAGE_TITLE = "Editorial Review Workflow for AI Translations (internal)";

export interface NotionRichTextItem {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
  plain_text?: string;
}

export function sanitizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("mailto:")) {
    return trimmed;
  }
  if (trimmed.startsWith("#")) {
    return `https://docs.comapeo.app/${trimmed}`;
  }
  if (trimmed.startsWith("../") || trimmed.startsWith("./")) {
    const clean = trimmed.replace(/^\.\.\//, "").replace(/^\.\//, "");
    return `https://github.com/digidem/comapeo-content-pipeline/blob/main/${clean}`;
  }
  if (trimmed.startsWith("/")) {
    return `https://docs.comapeo.app${trimmed}`;
  }
  return `https://${trimmed}`;
}

export function parseInlineText(text: string): NotionRichTextItem[] {
  const parts: NotionRichTextItem[] = [];
  const regex = /(\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const content = text.slice(lastIndex, match.index);
      if (content) {
        parts.push({
          type: "text",
          text: { content },
          plain_text: content,
        });
      }
    }

    if (match[2] && match[3]) {
      // Markdown link [text](url)
      const content = match[2];
      const url = sanitizeUrl(match[3]);
      parts.push({
        type: "text",
        text: { content, link: { url } },
        plain_text: content,
      });
    } else if (match[4]) {
      // Bold **text**
      const content = match[4];
      parts.push({
        type: "text",
        text: { content },
        annotations: { bold: true },
        plain_text: content,
      });
    } else if (match[5]) {
      // Italic *text*
      const content = match[5];
      parts.push({
        type: "text",
        text: { content },
        annotations: { italic: true },
        plain_text: content,
      });
    } else if (match[6]) {
      // Code `code`
      const content = match[6];
      parts.push({
        type: "text",
        text: { content },
        annotations: { code: true },
        plain_text: content,
      });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    const content = text.slice(lastIndex);
    if (content) {
      parts.push({
        type: "text",
        text: { content },
        plain_text: content,
      });
    }
  }

  return parts.length > 0 ? parts : [{ type: "text", text: { content: "" }, plain_text: "" }];
}

export function parseMarkdownToBlocks(md: string): Array<Record<string, unknown>> {
  const lines = md.split("\n");
  const blocks: Array<Record<string, unknown>> = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: codeLines.join("\n") } }],
          language: lang === "bash" ? "bash" : "plain text",
        },
      });
      continue;
    }

    // Table
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const parseRow = (rowStr: string) => {
        const cells = rowStr.slice(1, -1).split("|").map((c) => c.trim());
        return cells.map((cell) => parseInlineText(cell));
      };
      const headerRow = parseRow(tableLines[0]);
      const tableWidth = headerRow.length;
      const rows: Array<Record<string, unknown>> = [
        {
          type: "table_row",
          table_row: { cells: headerRow },
        },
      ];
      for (let r = 2; r < tableLines.length; r++) {
        const dataRow = parseRow(tableLines[r]);
        while (dataRow.length < tableWidth) {
          dataRow.push([{ type: "text", text: { content: "" } }]);
        }
        rows.push({
          type: "table_row",
          table_row: { cells: dataRow.slice(0, tableWidth) },
        });
      }
      blocks.push({
        object: "block",
        type: "table",
        table: {
          table_width: tableWidth,
          has_column_header: true,
          children: rows,
        },
      });
      continue;
    }

    // Callout (warning ⚠️)
    if (line.startsWith("⚠️")) {
      const calloutText = line.replace(/^⚠️\s*/, "");
      blocks.push({
        object: "block",
        type: "callout",
        callout: {
          icon: { type: "emoji", emoji: "⚠️" },
          rich_text: parseInlineText(calloutText),
        },
      });
      i++;
      continue;
    }

    // Heading 1
    if (line.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: parseInlineText(line.slice(2).trim()) },
      });
      i++;
      continue;
    }

    // Heading 2
    if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: parseInlineText(line.slice(3).trim()) },
      });
      i++;
      continue;
    }

    // Heading 3
    if (line.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: parseInlineText(line.slice(4).trim()) },
      });
      i++;
      continue;
    }

    // Numbered list item
    if (/^\d+\.\s/.test(line)) {
      const content = line.replace(/^\d+\.\s/, "");
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: parseInlineText(content) },
      });
      i++;
      continue;
    }

    // Bulleted list item
    if (/^[-*]\s/.test(line)) {
      const content = line.replace(/^[-*]\s/, "");
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: parseInlineText(content) },
      });
      i++;
      continue;
    }

    // Multi-line paragraph
    let paragraphText = line;
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("|") &&
      !lines[i].startsWith("⚠️") &&
      !/^\d+\.\s/.test(lines[i]) &&
      !/^[-*]\s/.test(lines[i])
    ) {
      paragraphText += " " + lines[i].trim();
      i++;
    }
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: parseInlineText(paragraphText) },
    });
  }

  return blocks;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  console.log(`Reading editorial guide from ${DOC_PATH}...`);
  const mdContent = readFileSync(DOC_PATH, "utf8");
  const blocks = parseMarkdownToBlocks(mdContent);
  console.log(`Parsed ${blocks.length} Notion blocks.`);

  if (!apply) {
    console.log("Running in --dry-run mode. Pass --apply to write to Notion.");
    console.log(`Target: Database ${NOTION_DATABASE_ID}, Section "${SECTION_NAME}", Order ${ORDER_NUMBER}`);
    console.log(`Title: "${PAGE_TITLE}"`);
    console.log("Blocks preview:");
    for (const b of blocks.slice(0, 5)) {
      console.log(`  - [${b.type}]`);
    }
    return;
  }

  if (!NOTION_TOKEN) {
    throw new Error("Missing NOTION_API_KEY or NOTION_TOKEN environment variable.");
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  // Check if an existing page exists
  console.log(`Checking for existing page in data source ${NOTION_DATA_SOURCE_ID}...`);
  const existingQuery = await notion.dataSources.query({
    data_source_id: NOTION_DATA_SOURCE_ID,
    filter: {
      property: "Content Section",
      select: { equals: SECTION_NAME },
    },
  });

  type NotionItem = {
    id: string;
    properties?: Record<string, {
      title?: Array<{ plain_text?: string }>;
      relation?: Array<{ id: string }>;
    }>;
  };

  const existing = existingQuery.results.find((p) => {
    const item = p as unknown as NotionItem;
    const title = item.properties?.["Content elements"]?.title?.[0]?.plain_text || "";
    return title.includes("Editorial Review Workflow") || title.includes("Editorial review workflow");
  }) as unknown as NotionItem | undefined;

  let containerPageId: string;
  let englishPageId: string;

  if (existing) {
    console.log(`Found existing container page ${existing.id}.`);
    containerPageId = existing.id;
    // Check if English sub-item exists
    const subItems = existing.properties?.["Sub-item"]?.relation || [];
    if (subItems.length > 0) {
      englishPageId = subItems[0].id;
      console.log(`Found existing English sub-item page ${englishPageId}.`);
    } else {
      console.log("Creating English sub-item page under existing container...");
      const enPage = await notion.pages.create({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          "Content elements": {
            title: [{ text: { content: PAGE_TITLE } }],
          },
          "Content Section": {
            select: { name: SECTION_NAME },
          },
          "Element Type": {
            select: { name: "Page" },
          },
          Language: {
            select: { name: "English" },
          },
          "Publish Status": {
            select: { name: "Draft published" },
          },
          "Parent item": {
            relation: [{ id: containerPageId }],
          },
        },
      });
      englishPageId = enPage.id;
    }
  } else {
    console.log("Creating container page in Notion...");
    const containerPage = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        "Content elements": {
          title: [{ text: { content: PAGE_TITLE } }],
        },
        "Content Section": {
          select: { name: SECTION_NAME },
        },
        Order: {
          number: ORDER_NUMBER,
        },
        "Element Type": {
          select: { name: "Page" },
        },
      },
    });
    containerPageId = containerPage.id;
    console.log(`Created container page: ${containerPageId}`);

    console.log("Creating English child page under container...");
    const enPage = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        "Content elements": {
          title: [{ text: { content: PAGE_TITLE } }],
        },
        "Content Section": {
          select: { name: SECTION_NAME },
        },
        "Element Type": {
          select: { name: "Page" },
        },
        Language: {
          select: { name: "English" },
        },
        "Publish Status": {
          select: { name: "Draft published" },
        },
        "Parent item": {
          relation: [{ id: containerPageId }],
        },
      },
    });
    englishPageId = enPage.id;
    console.log(`Created English sub-item page: ${englishPageId}`);
  }

  // Append blocks to both the container page and English page
  // Chunk into batches of 50 blocks for safety
  const chunkSize = 50;
  for (const targetId of [containerPageId, englishPageId]) {
    console.log(`Appending ${blocks.length} blocks to page ${targetId}...`);
    for (let c = 0; c < blocks.length; c += chunkSize) {
      const chunk = blocks.slice(c, c + chunkSize);
      await notion.blocks.children.append({
        block_id: targetId,
        children: chunk as unknown as Parameters<typeof notion.blocks.children.append>[0]["children"],
      });
      console.log(`  Appended chunk ${c / chunkSize + 1} (${chunk.length} blocks)`);
    }
  }

  const containerUrl = `https://app.notion.com/p/${PAGE_TITLE.replace(/\s+/g, "-").replace(/[()]/g, "")}-${containerPageId.replace(/-/g, "")}`;
  console.log("\n✅ Successfully posted editorial guide to Notion!");
  console.log(`Container Page ID: ${containerPageId}`);
  console.log(`English Page ID:   ${englishPageId}`);
  console.log(`Notion URL:        ${containerUrl}`);
}

main().catch((err) => {
  console.error("Error posting editorial guide:", err);
  process.exit(1);
});
