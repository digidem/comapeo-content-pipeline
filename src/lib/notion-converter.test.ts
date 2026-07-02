import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convertBlocks,
  richTextToMarkdown,
  isSupportedBlock,
  blockPlainText,
} from "./notion-converter.js";
import type { NotionBlockList, NotionBlock } from "./notion-converter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../test/fixtures");

// ── Unit tests ──

describe("richTextToMarkdown", () => {
  it("converts plain text", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "Hello",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("Hello");
  });

  it("handles bold", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "bold",
        annotations: {
          bold: true, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("**bold**");
  });

  it("handles italic", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "italic",
        annotations: {
          bold: false, italic: true, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("*italic*");
  });

  it("handles code", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "const x = 1;",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: true, color: "default",
        },
      },
    ]);
    expect(text).toBe("`const x = 1;`");
  });

  it("handles links", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "click here",
        text: { content: "click here", link: { url: "https://example.com" } },
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("[click here](https://example.com)");
  });

  it("handles strikethrough", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "deleted",
        annotations: {
          bold: false, italic: false, strikethrough: true,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("~~deleted~~");
  });

  it("handles underline", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "underlined",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: true, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("<u>underlined</u>");
  });

  it("handles color (foreground)", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "colored",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "blue",
        },
      },
    ]);
    expect(text).toBe('<span style={{color:"blue"}}>colored</span>');
  });

  it("ignores default color", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "plain",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("plain");
  });

  it("ignores background colors", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "bg",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "blue_background",
        },
      },
    ]);
    // background colors are skipped — no span wrapper
    expect(text).toBe("bg");
  });

  it("combines multiple annotations", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "fancy",
        annotations: {
          bold: true, italic: true, strikethrough: true,
          underline: true, code: false, color: "green",
        },
      },
    ]);
    // Order: bold → italic → strikethrough → underline → code → color
    expect(text).toBe('<span style={{color:"green"}}><u>~~***fancy***~~</u></span>');
  });

  it("handles empty input", () => {
    expect(richTextToMarkdown([])).toBe("");
  });

  it("applies bold per line so markers don't dangle across newlines", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "Data Privacy & Security\nProtected by encryption",
        annotations: {
          bold: true, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    // Each line is wrapped independently — no `**` spans the newline.
    expect(text).toBe("**Data Privacy & Security**\n**Protected by encryption**");
    // Sanity: every line has an even number of `**` markers.
    for (const line of text.split("\n")) {
      expect((line.match(/\*\*/g) ?? []).length % 2).toBe(0);
    }
  });

  it("preserves blank lines without wrapping when annotating across newlines", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "First\n\nThird",
        annotations: {
          bold: true, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("**First**\n\n**Third**");
  });

  it("renders custom emoji mention as an inline sized img (not markdown image)", () => {
    const text = richTextToMarkdown([
      {
        type: "mention",
        mention: {
          type: "custom_emoji",
          custom_emoji: {
            url: "https://s3.us-west-2.amazonaws.com/secure.notion-static.com/abc123.png",
            name: "party-parrot",
          },
        },
        plain_text: ":party-parrot:",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    // Inline <img> styled as a 1.2em glyph — never a full-size markdown image
    expect(text).not.toContain("![");
    expect(text).toBe(
      '<img src="https://s3.us-west-2.amazonaws.com/secure.notion-static.com/abc123.png" alt="party-parrot" className="emoji" style={{display:"inline",height:"1.2em",width:"auto",verticalAlign:"text-bottom",margin:"0 0.1em"}} />',
    );
  });

  it("custom emoji ignores bold/italic annotations", () => {
    const text = richTextToMarkdown([
      {
        type: "mention",
        mention: {
          type: "custom_emoji",
          custom_emoji: {
            url: "https://example.com/emoji.png",
            name: "wave",
          },
        },
        plain_text: ":wave:",
        annotations: {
          bold: true, italic: true, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    // No bold/italic wrapping — inline img only
    expect(text).toBe(
      '<img src="https://example.com/emoji.png" alt="wave" className="emoji" style={{display:"inline",height:"1.2em",width:"auto",verticalAlign:"text-bottom",margin:"0 0.1em"}} />',
    );
  });

  it("custom emoji falls back to 'emoji' name when missing", () => {
    const text = richTextToMarkdown([
      {
        type: "mention",
        mention: {
          type: "custom_emoji",
          custom_emoji: {
            url: "https://example.com/emoji.png",
          },
        },
        plain_text: ":unknown:",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe(
      '<img src="https://example.com/emoji.png" alt="emoji" className="emoji" style={{display:"inline",height:"1.2em",width:"auto",verticalAlign:"text-bottom",margin:"0 0.1em"}} />',
    );
  });

  it("escapes quotes in custom emoji name", () => {
    const text = richTextToMarkdown([
      {
        type: "mention",
        mention: {
          type: "custom_emoji",
          custom_emoji: {
            url: "https://example.com/emoji.png",
            name: 'say "hi"',
          },
        },
        plain_text: ":hi:",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toContain('alt="say &quot;hi&quot;"');
  });

  // ── Defect A: MD037 — whitespace inside emphasis markers ──

  it("MD037: hoists trailing whitespace outside bold markers", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "Step 2: ",
        annotations: {
          bold: true, italic: true, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
      {
        type: "text",
        plain_text: "Choose a category.",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    // Space must be outside the closing ***…*** markers, not inside
    expect(text).toBe("***Step 2:*** Choose a category.");
    // Verify: the bold+italic span closes with *** and then the space follows outside
    expect(text).toMatch(/\*\*\*Step 2:\*\*\* /); // closing *** then space (not space before ***)
  });

  it("MD037: hoists leading whitespace outside bold markers", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: " bold",
        annotations: {
          bold: true, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe(" **bold**");
  });

  it("MD037: whitespace-only bold span emits space without markers", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: " ",
        annotations: {
          bold: true, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    // No asterisks at all — plain space
    expect(text).toBe(" ");
    expect(text).not.toContain("*");
  });

  it("MD037: hoists surrounding whitespace outside code span", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: " code ",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: true, color: "default",
        },
      },
    ]);
    // Spaces go outside the backtick pair
    expect(text).toBe(" `code` ");
  });

  it("MD037: preserves interior whitespace in code span while hoisting edges", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: " a b ",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: true, color: "default",
        },
      },
    ]);
    // Leading/trailing spaces hoisted; interior space preserved
    expect(text).toBe(" `a b` ");
  });

  // ── Defect B: MD039 — spaces inside link brackets ──

  it("MD039: hoists trailing whitespace outside link brackets", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: "CoMapeo Categories ",
        text: { content: "CoMapeo Categories ", link: { url: "/docs/categories" } },
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("[CoMapeo Categories](/docs/categories) ");
    expect(text).not.toMatch(/\[\s/); // no space after opening bracket
    expect(text).not.toMatch(/\s\]/); // no space before closing bracket
  });

  it("MD039: hoists leading whitespace outside link brackets", () => {
    const text = richTextToMarkdown([
      {
        type: "text",
        plain_text: " link text",
        text: { content: " link text", link: { url: "https://example.com" } },
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe(" [link text](https://example.com)");
  });

  // ── Defect C: MD056 — newlines inside table cells ──

  it("MD056: newlines inside table cells are replaced with <br />", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "tbl-newline",
          type: "table",
          has_children: true,
          table: { table_width: 2, has_column_header: true, has_row_header: false },
        },
      ],
      children: {
        "tbl-newline": [
          {
            object: "block",
            id: "row-h",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [{ type: "text", plain_text: "Header A", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
                [{ type: "text", plain_text: "Header B", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
              ],
            },
          },
          {
            object: "block",
            id: "row-1",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                // Cell with trailing newline — the real corpus defect
                [{ type: "text", plain_text: "Cell value\n", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
                [{ type: "text", plain_text: "Normal", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
              ],
            },
          },
        ],
      },
    };
    const output = convertBlocks(blockList);
    // Trailing newline in cell value must be trimmed (not converted to <br />)
    expect(output).toContain("| Cell value | Normal |");
    // No literal newlines should appear inside a cell (would break the row)
    const dataRow = output.split("\n").find((l) => l.includes("Cell value"));
    expect(dataRow).toBeDefined();
    expect(dataRow).toMatch(/^\|.*\|$/);
  });

  it("MD056: interior newline in a cell becomes <br />", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "tbl-int-nl",
          type: "table",
          has_children: true,
          table: { table_width: 1, has_column_header: true, has_row_header: false },
        },
      ],
      children: {
        "tbl-int-nl": [
          {
            object: "block",
            id: "row-hh",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [{ type: "text", plain_text: "Col", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
              ],
            },
          },
          {
            object: "block",
            id: "row-11",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [{ type: "text", plain_text: "Line1\nLine2", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
              ],
            },
          },
        ],
      },
    };
    const output = convertBlocks(blockList);
    expect(output).toContain("| Line1<br />Line2 |");
  });

  // ── Defect D: MD003 — divider after text becomes setext heading ──

  it("MD003: divider inside callout children has blank line before ---", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "callout-div",
          type: "callout",
          has_children: true,
          callout: {
            rich_text: [
              {
                type: "text",
                plain_text: "Step 1: do the thing.",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
            color: "default",
          },
        },
      ],
      children: {
        "callout-div": [
          {
            object: "block",
            id: "div-1",
            type: "divider",
            has_children: false,
            divider: {},
          },
          {
            object: "block",
            id: "p-after",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  plain_text: "Step 2: next thing.",
                  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
                },
              ],
            },
          },
        ],
      },
    };
    const output = convertBlocks(blockList);
    // The "---" must not directly follow a text line (setext H2 rule).
    // There must be a blank line between the preceding content and "---".
    expect(output).not.toMatch(/[^\n]\n---/);
    // The divider must still be present
    expect(output).toContain("---");
  });

  // ── Punctuation-only spans must not carry emphasis markers ──

  it("drops emphasis markers on punctuation-only spans (e.g. bolded colon)", () => {
    const rt = (plain: string, ann: Partial<{ bold: boolean; italic: boolean }>) => ({
      type: "text" as const,
      plain_text: plain,
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default", ...ann },
    });
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p-punct",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              rt("Step 1", { bold: true }),
              rt(": ", { italic: true }),
              rt("do the thing.", {}),
            ],
          },
        },
      ],
      children: {},
    };
    const output = convertBlocks(blockList);
    expect(output).toContain("**Step 1**: do the thing.");
    expect(output).not.toContain("*:*");
    expect(output).not.toContain("**:**");
  });

  // ── Defect F: nested callouts need increasing-colon fences ──

  it("nested callout: outer fence uses 4 colons, inner keeps 3, all balanced", () => {
    const text = (plain: string) => [
      {
        type: "text" as const,
        plain_text: plain,
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
      },
    ];
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "outer-callout",
          type: "callout",
          has_children: true,
          callout: { rich_text: text("Outer step-by-step."), color: "default" },
        },
      ],
      children: {
        "outer-callout": [
          {
            object: "block",
            id: "inner-callout",
            type: "callout",
            has_children: false,
            callout: { rich_text: text("Inner warning content."), color: "red_background" },
          },
          {
            object: "block",
            id: "p-tail",
            type: "paragraph",
            has_children: false,
            paragraph: { rich_text: text("Text after the inner callout.") },
          },
        ],
      },
    };
    const output = convertBlocks(blockList);
    // Outer opens/closes with 4 colons, inner with exactly 3.
    expect(output).toMatch(/^::::note/m);
    expect(output).toMatch(/^:::danger/m);
    // Balanced: exactly one 4-colon close and one 3-colon close.
    const closes4 = output.match(/^::::$/gm) ?? [];
    const closes3 = output.match(/^:::$/gm) ?? [];
    expect(closes4).toHaveLength(1);
    expect(closes3).toHaveLength(1);
    // Closing fences are preceded by a blank line (never lazy-continued).
    expect(output).not.toMatch(/[^\n]\n:{3,}$/m);
  });

  it("MD003: top-level divider block does not create setext heading", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "para-before",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              { type: "text", plain_text: "Some text", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } },
            ],
          },
        },
        {
          object: "block",
          id: "div-top",
          type: "divider",
          has_children: false,
          divider: {},
        },
      ],
      children: {},
    };
    const output = convertBlocks(blockList);
    // Must not parse as "Some text\n---" setext heading
    expect(output).not.toMatch(/[^\n]\n---/);
    expect(output).toContain("---");
  });

  // ── Defect E: MD019 — heading text with leading whitespace ──

  it("MD019: leading whitespace in heading rich-text is trimmed", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "h2-space",
          type: "heading_2",
          has_children: false,
          heading_2: {
            rich_text: [
              {
                type: "text",
                plain_text: " Site do CoMapeo",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
      children: {},
    };
    const output = convertBlocks(blockList);
    // Must have exactly one space between ## and the heading text
    expect(output).toContain("## Site do CoMapeo");
    expect(output).not.toMatch(/## {2}/); // no double-space
  });

  it("MD019: trailing whitespace in heading rich-text is trimmed", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "h1-trail",
          type: "heading_1",
          has_children: false,
          heading_1: {
            rich_text: [
              {
                type: "text",
                plain_text: "Title  ",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
      children: {},
    };
    const output = convertBlocks(blockList);
    expect(output).toContain("# Title\n");
  });

  it("non-custom-emoji mention falls through to plain text", () => {
    const text = richTextToMarkdown([
      {
        type: "mention",
        mention: {
          type: "user",
          user: { name: "Alice" },
        },
        plain_text: "@Alice",
        annotations: {
          bold: false, italic: false, strikethrough: false,
          underline: false, code: false, color: "default",
        },
      },
    ]);
    expect(text).toBe("@Alice");
  });
});

describe("isSupportedBlock", () => {
  it("paragraph is supported", () => expect(isSupportedBlock("paragraph")).toBe(true));
  it("heading_1 is supported", () => expect(isSupportedBlock("heading_1")).toBe(true));
  it("toggle is supported", () => expect(isSupportedBlock("toggle")).toBe(true));
  it("unknown type is not supported", () =>
    expect(isSupportedBlock("unknown_type")).toBe(false));
});

describe("blockPlainText", () => {
  it("extracts plain text from a block", () => {
    const block: NotionBlock = {
      object: "block",
      id: "b1",
      type: "paragraph",
      has_children: false,
      paragraph: {
        rich_text: [
          {
            type: "text",
            plain_text: "Hello world",
            annotations: {
              bold: false, italic: false, strikethrough: false,
              underline: false, code: false, color: "default",
            },
          },
        ],
      },
    };
    expect(blockPlainText(block)).toBe("Hello world");
  });
});

describe("convertBlocks — recovered blocks", () => {
  it("inlines synced_block children instead of dropping them", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "synced-1",
          type: "synced_block",
          has_children: true,
          synced_block: { synced_from: null },
        },
      ],
      children: {
        "synced-1": [
          {
            object: "block",
            id: "p-1",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  plain_text: "synced content",
                  annotations: {
                    bold: false, italic: false, strikethrough: false,
                    underline: false, code: false, color: "default",
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const output = convertBlocks(blockList);
    expect(output).toContain("synced content");
    expect(output.trim()).toBe("synced content");
  });

  it("emits a best-effort link for link_to_page", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "ltp-1",
          type: "link_to_page",
          has_children: false,
          link_to_page: {
            type: "page_id",
            page_id: "abc-123-def",
          },
        },
      ],
      children: {},
    };
    const output = convertBlocks(blockList);
    // dashes stripped, reference preserved (no longer dropped)
    expect(output.trim()).toBe(
      "[Linked page](https://www.notion.so/abc123def)",
    );
  });
});

// ── Golden fixture tests ──

/**
 * Each fixture has:
 *   test/fixtures/notion/<name>.json  — Notion block list input
 *   test/fixtures/expected/<name>.md   — expected Markdown output
 */
const fixtureNames = readdirSync(join(fixturesDir, "notion"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""));

describe.each(fixtureNames)("golden fixture: %s", (name) => {
  it("produces expected output", () => {
    const inputPath = join(fixturesDir, "notion", `${name}.json`);
    const expectedPath = join(fixturesDir, "expected", `${name}.md`);

    const input: NotionBlockList = JSON.parse(
      readFileSync(inputPath, "utf8"),
    );
    const expected = readFileSync(expectedPath, "utf8");

    const output = convertBlocks(input);
    expect(output).toBe(expected);
  });
});
