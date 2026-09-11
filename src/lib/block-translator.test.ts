import { describe, it, expect } from "vitest";
import type { NotionBlockList, NotionBlock, NotionRichText } from "./notion-converter.js";
import { convertBlocks } from "./notion-converter.js";
import {
  extractTranslatableBlocks,
  applyTranslatedBlocks,
  restoreEquationDelimiters,
} from "./block-translator.js";

describe("extractTranslatableBlocks", () => {
  it("extracts translatable text from standard blocks", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: "Tap " },
                plain_text: "Tap ",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "text",
                text: { content: "Observations" },
                plain_text: "Observations",
                annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "text",
                text: { content: " to begin." },
                plain_text: " to begin.",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
        {
          object: "block",
          id: "h1",
          type: "heading_1",
          has_children: false,
          heading_1: {
            rich_text: [
              {
                type: "text",
                text: { content: "Overview" },
                plain_text: "Overview",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
    };

    const extracted = extractTranslatableBlocks(blockList);
    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toEqual({
      id: "p1",
      type: "paragraph",
      text: "Tap **Observations** to begin.",
    });
    expect(extracted[1]).toEqual({
      id: "h1",
      type: "heading_1",
      text: "Overview",
    });
  });

  it("extracts nested blocks from children map", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "toggle1",
          type: "toggle",
          has_children: true,
          toggle: {
            rich_text: [
              {
                type: "text",
                text: { content: "Advanced settings" },
                plain_text: "Advanced settings",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
      children: {
        toggle1: [
          {
            object: "block",
            id: "nested-p",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: { content: "Configure port and host." },
                  plain_text: "Configure port and host.",
                  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
                },
              ],
            },
          },
        ],
      },
    };

    const extracted = extractTranslatableBlocks(blockList);
    expect(extracted).toHaveLength(2);
    expect(extracted[0].id).toBe("toggle1");
    expect(extracted[0].text).toBe("Advanced settings");
    expect(extracted[1].id).toBe("nested-p");
    expect(extracted[1].text).toBe("Configure port and host.");
  });

  it("extracts table rows with cell-specific IDs", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "tbl1",
          type: "table",
          has_children: true,
          table: {},
        },
      ],
      children: {
        tbl1: [
          {
            object: "block",
            id: "row1",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [
                  {
                    type: "text",
                    text: { content: "Role" },
                    plain_text: "Role",
                    annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
                  },
                ],
                [
                  {
                    type: "text",
                    text: { content: "Permission" },
                    plain_text: "Permission",
                    annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
                  },
                ],
              ],
            },
          },
        ],
      },
    };

    const extracted = extractTranslatableBlocks(blockList);
    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toEqual({
      id: "row1:cell:0",
      type: "table_cell",
      text: "**Role**",
    });
    expect(extracted[1]).toEqual({
      id: "row1:cell:1",
      type: "table_cell",
      text: "**Permission**",
    });
  });

  it("skips code body but extracts code caption if present", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "code1",
          type: "code",
          has_children: false,
          code: {
            language: "bash",
            rich_text: [
              {
                type: "text",
                text: { content: "bun run build" },
                plain_text: "bun run build",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
            caption: [
              {
                type: "text",
                text: { content: "Build command" },
                plain_text: "Build command",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
        {
          object: "block",
          id: "code2",
          type: "code",
          has_children: false,
          code: {
            language: "json",
            rich_text: [
              {
                type: "text",
                text: { content: "{}" },
                plain_text: "{}",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
            caption: [],
          },
        },
      ],
    };

    const extracted = extractTranslatableBlocks(blockList);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toEqual({
      id: "code1:caption",
      type: "code_caption",
      text: "Build command",
    });
  });

  it("extracts image captions and skips empty blocks or visual spacers", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "spacer",
          type: "paragraph",
          has_children: false,
          paragraph: { rich_text: [] },
        },
        {
          object: "block",
          id: "divider1",
          type: "divider",
          has_children: false,
          divider: {},
        },
        {
          object: "block",
          id: "img1",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: { url: "https://example.com/map.png" },
            caption: [
              {
                type: "text",
                text: { content: "Map view of the project" },
                plain_text: "Map view of the project",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
    };

    const extracted = extractTranslatableBlocks(blockList);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toEqual({
      id: "img1:caption",
      type: "image_caption",
      text: "Map view of the project",
    });
  });

  it("extracts child_page title", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "cp1",
          type: "child_page",
          has_children: false,
          child_page: {
            title: "Subpage Title",
          },
        },
      ],
    };

    const extracted = extractTranslatableBlocks(blockList);
    expect(extracted).toEqual([
      {
        id: "cp1",
        type: "child_page",
        text: "Subpage Title",
      },
    ]);
  });
});

describe("applyTranslatedBlocks", () => {
  it("deep clones and replaces rich_text without mutating original", () => {
    const original: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: "Hello world" },
                plain_text: "Hello world",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
    };

    const translations = {
      p1: "Olá mundo com **destaque**",
    };

    const updated = applyTranslatedBlocks(original, translations);

    // Original must remain untouched
    const origText = (original.results[0].paragraph as { rich_text: Array<{ plain_text: string }> }).rich_text[0].plain_text;
    expect(origText).toBe("Hello world");

    // Updated must have new rich text with formatting parsed
    const updatedRt = (updated.results[0].paragraph as { rich_text: NotionBlock[] }).rich_text as unknown as import("./notion-converter.js").NotionRichText[];
    expect(updatedRt).toHaveLength(2);
    expect(updatedRt[0].plain_text).toBe("Olá mundo com ");
    expect(updatedRt[1].plain_text).toBe("destaque");
    expect(updatedRt[1].annotations.bold).toBe(true);
  });

  it("updates table cells and captions correctly", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img1",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: { url: "https://example.com/photo.jpg" },
            caption: [
              {
                type: "text",
                text: { content: "Old caption" },
                plain_text: "Old caption",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
        {
          object: "block",
          id: "tbl",
          type: "table",
          has_children: true,
          table: {},
        },
      ],
      children: {
        tbl: [
          {
            object: "block",
            id: "row1",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [
                  {
                    type: "text",
                    text: { content: "English Cell 1" },
                    plain_text: "English Cell 1",
                    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
                  },
                ],
                [
                  {
                    type: "text",
                    text: { content: "English Cell 2" },
                    plain_text: "English Cell 2",
                    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
                  },
                ],
              ],
            },
          },
        ],
      },
    };

    const translations = {
      "img1:caption": "Nova legenda",
      "row1:cell:0": "Célula 1",
      "row1:cell:1": "Célula 2",
    };

    const updated = applyTranslatedBlocks(blockList, translations);

    // Image caption updated, external URL preserved
    const imgData = updated.results[0].image as { external: { url: string }; caption: Array<{ plain_text: string }> };
    expect(imgData.external.url).toBe("https://example.com/photo.jpg");
    expect(imgData.caption[0].plain_text).toBe("Nova legenda");

    // Table cells updated
    const row = updated.children!.tbl[0].table_row as { cells: Array<Array<{ plain_text: string }>> };
    expect(row.cells[0][0].plain_text).toBe("Célula 1");
    expect(row.cells[1][0].plain_text).toBe("Célula 2");
  });

  it("roundtrips cleanly through convertBlocks into localized markdown", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "h2",
          type: "heading_2",
          has_children: false,
          heading_2: {
            rich_text: [
              {
                type: "text",
                text: { content: "Getting Started" },
                plain_text: "Getting Started",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
        {
          object: "block",
          id: "callout1",
          type: "callout",
          has_children: false,
          callout: {
            color: "blue",
            icon: { type: "emoji", emoji: "💡" },
            rich_text: [
              {
                type: "text",
                text: { content: "Tip: Keep your GPS turned on." },
                plain_text: "Tip: Keep your GPS turned on.",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
    };

    const translations = {
      h2: "Primeiros passos",
      callout1: "Dica: Mantenha seu GPS ligado.",
    };

    const translatedBlocks = applyTranslatedBlocks(blockList, translations);
    const md = convertBlocks(translatedBlocks);

    expect(md).toContain("## Primeiros passos");
    expect(md).toContain(":::note 💡 Dica");
    expect(md).toContain("Mantenha seu GPS ligado.");
  });

  it("updates child_page title", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "cp1",
          type: "child_page",
          has_children: false,
          child_page: {
            title: "Old Title",
          },
        },
      ],
    };

    const updated = applyTranslatedBlocks(blockList, {
      cp1: "Novo Título",
    });

    const cp = updated.results[0].child_page as { title?: string };
    expect(cp.title).toBe("Novo Título");
  });

  it("preserves literal pipes in Notion cell rich text while convertTable escapes them in markdown", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "tbl",
          type: "table",
          has_children: true,
          table: { table_width: 1, has_column_header: false, has_row_header: false },
        },
      ],
      children: {
        tbl: [
          {
            object: "block",
            id: "row1",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [{ type: "text", plain_text: "A", text: { content: "A" }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
              ],
            },
          },
        ],
      },
    };

    const updated = applyTranslatedBlocks(blockList, {
      "row1:cell:0": "Option A | Option B",
    });

    // Notion rich text preserves literal pipe without backslash leakage
    const row = updated.children!.tbl[0].table_row as { cells: Array<Array<{ plain_text: string }>> };
    expect(row.cells[0][0].plain_text).toBe("Option A | Option B");

    // Markdown conversion correctly escapes the pipe to prevent column misalignment
    const md = convertBlocks(updated);
    expect(md).toContain("| Option A \\| Option B |");
  });

  it("extracts inline equations as $expression$ and reconstructs native equation rich text items", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              {
                type: "text",
                plain_text: "Energy formula: ",
                text: { content: "Energy formula: " },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "equation",
                plain_text: "E = mc^2",
                equation: { expression: "E = mc^2" },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "text",
                plain_text: " in physics.",
                text: { content: " in physics." },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
    };

    // 1. Extraction converts equation to $E = mc^2$
    const extracted = extractTranslatableBlocks(blockList);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].text).toBe("Energy formula: $E = mc^2$ in physics.");

    // 2. Application reconstructs native equation rich text item
    const updated = applyTranslatedBlocks(blockList, {
      p1: "Fórmula de energía: $E = mc^2$ en física.",
    });

    const p = updated.results[0].paragraph as { rich_text: NotionRichText[] };
    expect(p.rich_text).toHaveLength(3);
    expect(p.rich_text[0].type).toBe("text");
    expect(p.rich_text[0].plain_text).toBe("Fórmula de energía: ");
    expect(p.rich_text[1].type).toBe("equation");
    expect(p.rich_text[1].equation).toEqual({ expression: "E = mc^2" });
    expect(p.rich_text[1].plain_text).toBe("E = mc^2");
    expect(p.rich_text[2].type).toBe("text");
    expect(p.rich_text[2].plain_text).toBe(" en física.");
  });

  it("preserves custom emojis inside table_row cells when translating tables", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "tbl1",
          type: "table",
          has_children: true,
          table: {
            table_width: 2,
            has_column_header: false,
            has_row_header: false,
          },
        },
      ],
      children: {
        tbl1: [
          {
            object: "block",
            id: "row1",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [
                  {
                    type: "mention",
                    plain_text: "@custom_star",
                    mention: {
                      type: "custom_emoji",
                      custom_emoji: {
                        id: "emoji-uuid-12345",
                        name: "custom_star",
                        url: "https://notion.so/custom_star.png",
                      },
                    },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: "default",
                    },
                  },
                  {
                    type: "text",
                    plain_text: " Star feature",
                    text: { content: " Star feature" },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: "default",
                    },
                  },
                ],
                [
                  {
                    type: "text",
                    plain_text: "Description",
                    text: { content: "Description" },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: "default",
                    },
                  },
                ],
              ],
            },
          },
        ],
      },
    };

    // 1. Extract translatable blocks
    const extracted = extractTranslatableBlocks(blockList);
    expect(extracted).toHaveLength(2);
    expect(extracted[0].id).toBe("row1:cell:0");
    expect(extracted[0].text).toContain("custom_star.png");

    // 2. Apply translation where LLM preserved the img tag with URL but omitted data-emoji-id
    const updated = applyTranslatedBlocks(blockList, {
      "row1:cell:0":
        '<img src="https://notion.so/custom_star.png" alt="custom_star" /> Recurso estrela',
      "row1:cell:1": "Descrição",
    });

    const row = updated.children!.tbl1[0].table_row as { cells: NotionRichText[][] };
    const cell0 = row.cells[0];

    // Verify cell 0 still receives a native custom_emoji mention thanks to collectEmojis scanning table_row.cells
    expect(cell0[0].type).toBe("mention");
    expect(cell0[0].mention).toEqual({
      type: "custom_emoji",
      custom_emoji: {
        id: "emoji-uuid-12345",
        name: "custom_star",
        url: "https://notion.so/custom_star.png",
      },
    });
    expect(cell0[1].plain_text).toBe(" Recurso estrela");
  });

  it("restores dropped equation delimiters across prose, captions, and table cells without corrupting words", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              {
                type: "text",
                plain_text: "A variable ",
                text: { content: "A variable " },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "equation",
                plain_text: "x",
                equation: { expression: "x" },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "text",
                plain_text: " in the rate equation.",
                text: { content: " in the rate equation." },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
        {
          object: "block",
          id: "img1",
          type: "image",
          has_children: false,
          image: {
            caption: [
              {
                type: "text",
                plain_text: "Plot of ",
                text: { content: "Plot of " },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "equation",
                plain_text: "f(x)",
                equation: { expression: "f(x)" },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
        {
          object: "block",
          id: "tbl1",
          type: "table",
          has_children: true,
          table: { table_width: 1, has_column_header: false, has_row_header: false },
        },
      ],
      children: {
        tbl1: [
          {
            object: "block",
            id: "row1",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [
                  {
                    type: "text",
                    plain_text: "Compute ",
                    text: { content: "Compute " },
                    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
                  },
                  {
                    type: "equation",
                    plain_text: "a + b",
                    equation: { expression: "a + b" },
                    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
                  },
                ],
              ],
            },
          },
        ],
      },
    };

    // Translation where equation delimiters were dropped by LLM
    // Notice that p1 translation contains words with 'x' ("taxa", "avaliação")
    const updated = applyTranslatedBlocks(blockList, {
      p1: "A taxa para avaliação de x é alta.",
      "img1:caption": "Gráfico de f(x)",
      "row1:cell:0": "Calcular a + b",
    });

    // Verify paragraph: x is restored as an equation, and "taxa" is NOT split or corrupted
    const p = updated.results[0].paragraph as { rich_text: NotionRichText[] };
    expect(p.rich_text.some((r) => r.type === "equation" && r.equation?.expression === "x")).toBe(true);
    const plainTextFull = p.rich_text.map((r) => r.plain_text).join("");
    expect(plainTextFull).toBe("A taxa para avaliação de x é alta.");
    // Confirm "taxa" is intact text item, not corrupted
    expect(p.rich_text[0].plain_text).toContain("taxa");

    // Verify image caption: f(x) is restored as an equation
    const img = updated.results[1].image as { caption: NotionRichText[] };
    expect(img.caption.some((r) => r.type === "equation" && r.equation?.expression === "f(x)")).toBe(true);

    // Verify table cell: a + b is restored as an equation
    const row = updated.children!.tbl1[0].table_row as { cells: NotionRichText[][] };
    expect(row.cells[0].some((r) => r.type === "equation" && r.equation?.expression === "a + b")).toBe(true);
  });

  it("does not double-wrap equations when delimiters are already preserved in translation", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              {
                type: "equation",
                plain_text: "E = mc^2",
                equation: { expression: "E = mc^2" },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
    };

    const updated = applyTranslatedBlocks(blockList, {
      p1: "Fórmula $E = mc^2$ preservada.",
    });

    const p = updated.results[0].paragraph as { rich_text: NotionRichText[] };
    expect(p.rich_text).toHaveLength(3);
    expect(p.rich_text[1].type).toBe("equation");
    expect(p.rich_text[1].equation).toEqual({ expression: "E = mc^2" });
  });

  it("does not corrupt markdown link URLs, inline code, or HTML tags during equation restoration", () => {
    const blockList: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p1",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              {
                type: "equation",
                plain_text: "x",
                equation: { expression: "x" },
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
    };

    // Translation where equation delimiters were dropped around 'x',
    // but the text also contains [details](https://example.com/x), `x`, and `<img src="https://example.com/x" />`
    const updated = applyTranslatedBlocks(blockList, {
      p1: 'Veja [detalhes](https://example.com/x) onde o código `x` difere da variável x em <img src="https://example.com/x" alt="x" />.',
    });

    const p = updated.results[0].paragraph as { rich_text: NotionRichText[] };

    // Find the link rich text item
    const linkItem = p.rich_text.find((r) => r.href);
    expect(linkItem).toBeDefined();
    // Link URL must NOT have $x$ injected
    expect(linkItem!.href).toBe("https://example.com/x");

    // Find the code rich text item
    const codeItem = p.rich_text.find((r) => r.annotations?.code);
    expect(codeItem).toBeDefined();
    // Inline code must NOT have $x$ injected
    expect(codeItem!.plain_text).toBe("x");

    // Verify equation item was restored for the prose variable
    const eqItem = p.rich_text.find((r) => r.type === "equation");
    expect(eqItem).toBeDefined();
    expect(eqItem!.equation?.expression).toBe("x");
  });

  it("preserves markdown image syntax ![alt](url) and does not turn images into links during equation restoration", () => {
    const originalText = "Original with equation $x$.";
    const translatedWithImage = "Texto com imagem ![diagrama do fluxo](https://example.com/flow.png) e a variável x no final.";

    const restored = restoreEquationDelimiters(translatedWithImage, originalText);

    expect(restored).toContain("![diagrama do fluxo](https://example.com/flow.png)");
    expect(restored).not.toMatch(/(?<!!)\[diagrama do fluxo\]\(https:\/\/example\.com\/flow\.png\)/);
    expect(restored).toContain("$x$");
  });

  it("restores duplicate equations when one occurrence was preserved but another lost its delimiters", () => {
    const originalText = "First equation $x$ and second equation $x$.";
    const translatedWithLostSecond = "Primeira equação $x$ e segunda equação x.";

    const restored = restoreEquationDelimiters(translatedWithLostSecond, originalText);
    expect(restored).toBe("Primeira equação $x$ e segunda equação $x$.");
  });
});

