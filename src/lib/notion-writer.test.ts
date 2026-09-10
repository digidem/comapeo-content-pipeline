import { describe, it, expect, vi, beforeEach } from "vitest";
import { prepareBlocksForNotion, writeTranslationToNotion } from "./notion-writer.js";
import type { NotionBlockList } from "./notion-converter.js";
import type { NotionBlock, NotionClient, NotionPage } from "./notion-client.js";

describe("prepareBlocksForNotion", () => {
  it("strips read-only metadata fields from blocks", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "block-1",
          type: "paragraph",
          created_time: "2026-01-01T00:00:00.000Z",
          last_edited_time: "2026-01-01T00:00:00.000Z",
          created_by: { id: "user-1" },
          last_edited_by: { id: "user-1" },
          has_children: false,
          archived: false,
          in_trash: false,
          parent: { type: "page_id", page_id: "page-1" },
          paragraph: {
            rich_text: [{ type: "text", text: { content: "Olá Mundo" }, plain_text: "Olá Mundo" }],
          },
        } as unknown as NotionBlock,
      ],
    };

    const prepared = prepareBlocksForNotion(rawBlocks);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toEqual({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "Olá Mundo" }, plain_text: "Olá Mundo" }],
      },
    });
    expect((prepared[0] as Record<string, unknown>).id).toBeUndefined();
    expect((prepared[0] as Record<string, unknown>).created_time).toBeUndefined();
    expect((prepared[0] as Record<string, unknown>).parent).toBeUndefined();
  });

  it("converts Notion S3 file image blocks to external image blocks", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-1",
          type: "image",
          has_children: false,
          image: {
            type: "file",
            file: {
              url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/image.png?sig=123",
              expiry_time: "2026-01-01T00:00:00.000Z",
            },
            caption: [{ type: "text", text: { content: "Legenda" } }],
          },
        } as unknown as NotionBlock,
      ],
    };

    const prepared = prepareBlocksForNotion(rawBlocks);
    expect(prepared[0]).toEqual({
      object: "block",
      type: "image",
      image: {
        type: "external",
        external: {
          url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/image.png?sig=123",
        },
        caption: [{ type: "text", text: { content: "Legenda" } }],
      },
    });
  });

  it("embeds table_row children inside table blocks", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "table-1",
          type: "table",
          has_children: true,
          table: {
            table_width: 2,
            has_column_header: true,
            has_row_header: false,
          },
        } as unknown as NotionBlock,
      ],
      children: {
        "table-1": [
          {
            object: "block",
            id: "row-1",
            type: "table_row",
            has_children: false,
            table_row: {
              cells: [
                [{ type: "text", text: { content: "Header 1" } }],
                [{ type: "text", text: { content: "Header 2" } }],
              ],
            },
          } as unknown as NotionBlock,
        ],
      },
    };

    const prepared = prepareBlocksForNotion(rawBlocks);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].type).toBe("table");
    const tableData = (prepared[0] as { table: { children: unknown[] } }).table;
    expect(tableData.children).toHaveLength(1);
    expect(tableData.children[0]).toEqual({
      object: "block",
      type: "table_row",
      table_row: {
        cells: [
          [{ type: "text", text: { content: "Header 1" } }],
          [{ type: "text", text: { content: "Header 2" } }],
        ],
      },
    });
  });

  it("embeds nested children for toggles and callouts", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "toggle-1",
          type: "toggle",
          has_children: true,
          toggle: {
            rich_text: [{ type: "text", text: { content: "Instruções" } }],
          },
        } as unknown as NotionBlock,
      ],
      children: {
        "toggle-1": [
          {
            object: "block",
            id: "p-1",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [{ type: "text", text: { content: "Passo 1" } }],
            },
          } as unknown as NotionBlock,
        ],
      },
    };

    const prepared = prepareBlocksForNotion(rawBlocks);
    expect(prepared).toHaveLength(1);
    const toggleData = (prepared[0] as { toggle: { children: unknown[] } }).toggle;
    expect(toggleData.children).toHaveLength(1);
    expect(toggleData.children[0]).toEqual({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "Passo 1" } }],
      },
    });
  });
});

describe("writeTranslationToNotion", () => {
  let mockClient: NotionClient;
  const mockTranslatedBlocks: NotionBlockList = {
    object: "list",
    results: [
      {
        object: "block",
        id: "b1",
        type: "paragraph",
        has_children: false,
        paragraph: { rich_text: [{ type: "text", text: { content: "Conteúdo traduzido" } }] },
      } as unknown as NotionBlock,
    ],
  };

  beforeEach(() => {
    mockClient = {
      createPage: vi.fn(),
      updatePage: vi.fn(),
      deleteBlock: vi.fn(),
      appendBlockChildren: vi.fn(),
      getPage: vi.fn(),
      getPageBlocks: vi.fn(),
    } as unknown as NotionClient;
  });

  it("creates a new Notion page when targetPageId is not provided", async () => {
    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "new-notion-page-id",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Título em Português",
      parentEnglishPageId: "en-parent-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result).toEqual({
      written: true,
      action: "created",
      pageId: "new-notion-page-id",
    });

    expect(mockClient.createPage).toHaveBeenCalledTimes(1);
    const createArgs = vi.mocked(mockClient.createPage).mock.calls[0][0];
    expect(createArgs.parent).toEqual({ database_id: "db-123" });
    expect(createArgs.properties["Content elements"]).toBeDefined();
    expect(createArgs.properties["Language"]).toEqual({ select: { name: "PT - automated" } });
    expect(createArgs.properties["Publish Status"]).toEqual({
      select: { name: "Automated translations generated" },
    });
    expect(createArgs.properties["Parent item"]).toEqual({
      relation: [{ id: "en-parent-id" }],
    });
    expect(createArgs.children).toHaveLength(1);
  });

  it("updates existing stub page when safe (empty page)", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "stub-page-id",
      properties: {
        "Publish Status": { select: { name: "Draft published" } },
      },
    } as unknown as NotionPage);

    // Empty blocks = safe stub
    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [],
      children: {},
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-page-id",
      object: "page",
    } as unknown as NotionPage);

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Título en Español",
      parentEnglishPageId: "en-parent-id",
      targetPageId: "stub-page-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result).toEqual({
      written: true,
      action: "updated",
      pageId: "stub-page-id",
    });

    expect(mockClient.updatePage).toHaveBeenCalledTimes(1);
    expect(mockClient.appendBlockChildren).toHaveBeenCalledTimes(1);
    expect(mockClient.deleteBlock).not.toHaveBeenCalled(); // No existing blocks to delete
  });

  it("updates existing stub page and deletes old stub blocks", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "stub-page-id",
      properties: {
        "Publish Status": { select: { name: "Automated translations generated" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-block-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.deleteBlock).mockResolvedValueOnce({
      id: "old-block-1",
      object: "block",
      archived: true,
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-page-id",
      object: "page",
    } as unknown as NotionPage);

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Título PT",
      parentEnglishPageId: "en-parent-id",
      targetPageId: "stub-page-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(mockClient.deleteBlock).toHaveBeenCalledWith("old-block-1");
    expect(mockClient.appendBlockChildren).toHaveBeenCalledTimes(1);
  });

  it("blocks write-back when human edits exist and publish status is not automated (Human-Edit Safety Lock)", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "edited-page-id",
      properties: {
        "Publish Status": { select: { name: "Draft published" } },
      },
    } as unknown as NotionPage);

    // Page has substantial human-written content
    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        {
          id: "b1",
          type: "paragraph",
          object: "block",
          paragraph: { rich_text: [{ plain_text: "Manual human translation in Spanish." }] },
        } as unknown as NotionBlock,
        {
          id: "b2",
          type: "paragraph",
          object: "block",
          paragraph: { rich_text: [{ plain_text: "More human content." }] },
        } as unknown as NotionBlock,
      ],
      children: {},
    });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Título en Español",
      parentEnglishPageId: "en-parent-id",
      targetPageId: "edited-page-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(false);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("Human-edit safety lock");

    // Must NOT touch Notion
    expect(mockClient.deleteBlock).not.toHaveBeenCalled();
    expect(mockClient.updatePage).not.toHaveBeenCalled();
    expect(mockClient.appendBlockChildren).not.toHaveBeenCalled();
  });

  it("allows override of human-edit safety lock when force: true", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "edited-page-id",
      properties: {
        "Publish Status": { select: { name: "Draft published" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [{ id: "b1", type: "paragraph", object: "block" } as unknown as NotionBlock],
      children: {},
    });

    vi.mocked(mockClient.deleteBlock).mockResolvedValueOnce({
      id: "b1",
      object: "block",
      archived: true,
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "edited-page-id",
      object: "page",
    } as unknown as NotionPage);

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Título forçado",
      parentEnglishPageId: "en-parent-id",
      targetPageId: "edited-page-id",
      translatedBlocks: mockTranslatedBlocks,
      force: true,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(mockClient.deleteBlock).toHaveBeenCalledWith("b1");
  });
});
