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
