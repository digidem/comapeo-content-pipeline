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
    expect(text).toBe('<span style="color:blue">colored</span>');
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
    expect(text).toBe('<span style="color:green"><u>~~***fancy***~~</u></span>');
  });

  it("handles empty input", () => {
    expect(richTextToMarkdown([])).toBe("");
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
