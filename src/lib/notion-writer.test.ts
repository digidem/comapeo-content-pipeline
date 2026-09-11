import { describe, it, expect, vi, beforeEach } from "vitest";
import { prepareBlocksForNotion, writeTranslationToNotion, isStubPage } from "./notion-writer.js";
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

  it("strips null properties like icon: null from block payloads", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p-1",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: "Text" } }],
            icon: null,
            color: "default",
          },
        } as unknown as NotionBlock,
      ],
    };

    const prepared = prepareBlocksForNotion(rawBlocks);
    expect((prepared[0] as { paragraph: Record<string, unknown> }).paragraph.icon).toBeUndefined();
  });

  it("converts relative link URLs in rich_text to absolute URLs for Notion API compatibility", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "p-1",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "Link Text",
                  link: { url: "/docs/planning-and-preparing" },
                },
                href: "/docs/planning-and-preparing",
              },
            ],
          },
        } as unknown as NotionBlock,
      ],
    };

    const prepared = prepareBlocksForNotion(rawBlocks);
    const p = prepared[0] as {
      paragraph: { rich_text: Array<{ text: { link: { url: string } }; href?: string }> };
    };
    expect(p.paragraph.rich_text[0].text.link.url).toBe(
      "https://docs.comapeo.app/docs/planning-and-preparing",
    );
    expect(p.paragraph.rich_text[0].href).toBeUndefined();
  });

  it("omits Notion S3 file image blocks without rehosted asset metadata to prevent expired links", () => {
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
    expect(prepared).toHaveLength(0);
  });

  it("preserves external image blocks with permanent public URLs", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-1",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: {
              url: "https://example.com/images/logo.png",
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
          url: "https://example.com/images/logo.png",
        },
        caption: [{ type: "text", text: { content: "Legenda" } }],
      },
    });
  });

  it("resolves Notion S3 file image blocks to permanent public URLs using assets and section", () => {
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
              url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/doc/switch_projects.jpg?X-Amz-Expires=3600",
              expiry_time: "2026-01-01T00:00:00.000Z",
            },
            caption: [],
          },
        } as unknown as NotionBlock,
      ],
    };

    const assets = [
      {
        original_url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/doc/switch_projects.jpg",
        r2_key: "assets/ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4.jpg",
        sha256: "sha256:ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4",
        mime_type: "image/jpeg",
      },
    ];

    const prepared = prepareBlocksForNotion(rawBlocks, {
      assets,
      section: "50-Managing Projects",
    });

    expect(prepared[0]).toEqual({
      object: "block",
      type: "image",
      image: {
        type: "external",
        external: {
          url: "https://raw.githubusercontent.com/digidem/comapeo-docs/content/docs/managing-projects/assets/ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4.jpg",
        },
      },
    });
  });

  it("resolves base64 data URI external image blocks to permanent public URLs", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-base64",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: {
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
            },
            caption: [],
          },
        } as unknown as NotionBlock,
      ],
    };

    const assets = [
      {
        original_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
        r2_key: "assets/17a4cbb2d33868f59af24c6139d2c54efe50ca43a39d1179f8708c427715f584.png",
        sha256: "sha256:17a4cbb2d33868f59af24c6139d2c54efe50ca43a39d1179f8708c427715f584",
        mime_type: "image/png",
      },
    ];

    const prepared = prepareBlocksForNotion(rawBlocks, {
      assets,
      section: "60-Exchanging Observations",
    });

    expect(prepared[0]).toEqual({
      object: "block",
      type: "image",
      image: {
        type: "external",
        external: {
          url: "https://raw.githubusercontent.com/digidem/comapeo-docs/content/docs/exchanging-observations/assets/17a4cbb2d33868f59af24c6139d2c54efe50ca43a39d1179f8708c427715f584.png",
        },
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

  it("skips unsupported and structural blocks like child_page and child_database", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        { object: "block", id: "cp-1", type: "child_page", child_page: { title: "Subpage" } } as unknown as NotionBlock,
        { object: "block", id: "cd-1", type: "child_database", child_database: { title: "DB" } } as unknown as NotionBlock,
        { object: "block", id: "u-1", type: "unsupported" } as unknown as NotionBlock,
        {
          object: "block",
          id: "p-1",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "Valid" } }] },
        } as unknown as NotionBlock,
      ],
    };

    const prepared = prepareBlocksForNotion(rawBlocks);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].type).toBe("paragraph");
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
      parentItemId: "container-parent-id",
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
      relation: [{ id: "container-parent-id" }],
    });
    expect(createArgs.children).toHaveLength(1);
  });

  it("falls back to parentEnglishPageId when parentItemId is not provided", async () => {
    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "root-page-id",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Título Raiz",
      parentEnglishPageId: "en-parent-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    const createArgs = vi.mocked(mockClient.createPage).mock.calls[0][0];
    expect(createArgs.properties["Parent item"]).toEqual({
      relation: [{ id: "en-parent-id" }],
    });
  });

  it("leaves Parent item undefined when neither parentItemId nor parentEnglishPageId is provided", async () => {
    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "root-page-id",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Título Raiz",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    const createArgs = vi.mocked(mockClient.createPage).mock.calls[0][0];
    expect(createArgs.properties["Parent item"]).toBeUndefined();
  });


  it("uses parentItemId as relation when creating a new page as a sibling", async () => {
    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "sibling-page-id",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Título em Português",
      parentItemId: "container-parent-row-id",
      parentEnglishPageId: "en-child-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    const createArgs = vi.mocked(mockClient.createPage).mock.calls[0][0];
    expect(createArgs.properties["Parent item"]).toEqual({
      relation: [{ id: "container-parent-row-id" }],
    });
  });

  it("uses parentItemId as relation when updating an existing stub", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "stub-page-id",
      properties: {
        "Publish Status": { select: { name: "Automated translations generated" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [],
      children: {},
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-page-id",
      object: "page",
    } as unknown as NotionPage);

    await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Título em Português",
      parentItemId: "container-parent-row-id",
      targetPageId: "stub-page-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    const updateArgs = vi.mocked(mockClient.updatePage).mock.calls[0];
    expect(updateArgs![1].properties!["Parent item"]).toEqual({
      relation: [{ id: "container-parent-row-id" }],
    });
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

  it("chunks children during page creation when blocks exceed 100", async () => {
    const manyBlocks: NotionBlockList = {
      object: "list",
      results: Array.from({ length: 130 }, (_, i) => ({
        object: "block",
        id: `block-${i}`,
        type: "paragraph",
        has_children: false,
        paragraph: { rich_text: [{ type: "text", text: { content: `Paragraph ${i}` } }] },
      })) as unknown as NotionBlock[],
    };

    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "big-page-id",
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
      targetTitle: "Big Page",
      parentEnglishPageId: "en-parent-id",
      translatedBlocks: manyBlocks,
    });

    expect(result.written).toBe(true);
    expect(mockClient.createPage).toHaveBeenCalledTimes(1);
    const createArgs = vi.mocked(mockClient.createPage).mock.calls[0][0];
    expect(createArgs.children).toHaveLength(100);

    expect(mockClient.appendBlockChildren).toHaveBeenCalledTimes(1);
    const [appendId, appendBlocks] = vi.mocked(mockClient.appendBlockChildren).mock.calls[0];
    expect(appendId).toBe("big-page-id");
    expect(appendBlocks).toHaveLength(30);
  });

  it("safely re-translates a page when Publish Status is Automated translations generated", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "automated-stub-id",
      properties: {
        "Publish Status": { select: { name: "Automated translations generated" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
        { id: "old-2", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.deleteBlock).mockResolvedValue({
      id: "del",
      object: "block",
      archived: true,
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "automated-stub-id",
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
      targetTitle: "Re-translated Title",
      parentEnglishPageId: "en-parent-id",
      targetPageId: "automated-stub-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(mockClient.deleteBlock).toHaveBeenCalledTimes(2);
  });

  it("detects placeholder stub text like [Insert content here] as safe to overwrite", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "stub-with-placeholder",
      properties: {
        "Publish Status": { select: { name: "Draft published" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        {
          id: "placeholder-block",
          type: "paragraph",
          object: "block",
          paragraph: { rich_text: [{ plain_text: "[Insert content here]" }] },
        } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.deleteBlock).mockResolvedValueOnce({
      id: "placeholder-block",
      object: "block",
      archived: true,
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-with-placeholder",
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
      targetTitle: "Novo Conteúdo",
      parentEnglishPageId: "en-parent-id",
      targetPageId: "stub-with-placeholder",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(mockClient.deleteBlock).toHaveBeenCalledWith("placeholder-block");
  });

  it("does not classify pages with nested table rows or toggle children as stubs", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "nested-content-page",
      properties: {
        "Publish Status": { select: { name: "Draft published" } },
      },
    } as unknown as NotionPage);

    // Top-level block has no rich_text (e.g. table), but nested child has text
    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        {
          id: "table-1",
          type: "table",
          object: "block",
          table: {},
        } as unknown as NotionBlock,
      ],
      children: {
        "table-1": [
          {
            id: "row-1",
            type: "table_row",
            object: "block",
            table_row: {
              cells: [[{ plain_text: "Nested table cell content" }]],
            },
          } as unknown as NotionBlock,
        ],
      },
    });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Tentativa de sobrescrever",
      parentEnglishPageId: "en-parent-id",
      targetPageId: "nested-content-page",
      translatedBlocks: mockTranslatedBlocks,
    });

    // Should be protected by Human-Edit Safety Lock
    expect(result.written).toBe(false);
    expect(result.action).toBe("skipped");
    expect(mockClient.deleteBlock).not.toHaveBeenCalled();
  });

  it("appends new blocks BEFORE deleting old blocks (atomic replacement)", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "stub-page-123",
      properties: {
        "Publish Status": { select: { name: "Draft published" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    const callOrder: string[] = [];
    vi.mocked(mockClient.appendBlockChildren).mockImplementationOnce(async () => {
      callOrder.push("append");
      return { object: "list", results: [], next_cursor: null, has_more: false };
    });
    vi.mocked(mockClient.updatePage).mockImplementationOnce(async () => {
      callOrder.push("update");
      return { id: "stub-page-123", object: "page" } as unknown as NotionPage;
    });
    vi.mocked(mockClient.deleteBlock).mockImplementationOnce(async () => {
      callOrder.push("delete");
      return { id: "old-1", object: "block", archived: true };
    });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Novo",
      parentEnglishPageId: "en-parent-id",
      targetPageId: "stub-page-123",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(callOrder).toEqual(["append", "update", "delete"]);
  });

  it("rolls back newly appended blocks if deleting old blocks fails during atomic replacement", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "stub-page-rollback",
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

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-block-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-page-rollback",
      object: "page",
    } as unknown as NotionPage);
    vi.mocked(mockClient.deleteBlock).mockRejectedValueOnce(new Error("Notion API delete failure"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Falha de Rollback",
        parentEnglishPageId: "en-parent-id",
        targetPageId: "stub-page-rollback",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("Failed to delete old blocks during atomic replacement");

    // Must attempt to delete the newly appended block during rollback
    expect(mockClient.deleteBlock).toHaveBeenCalledWith("new-block-1");
  });

  describe("isStubPage block type checks", () => {
    it("recognizes bookmark blocks as non-stub content", () => {
      const page = { id: "p1" } as unknown as NotionPage;
      const blocks = {
        results: [
          {
            id: "b1",
            type: "bookmark",
            object: "block",
            bookmark: { url: "https://example.com/docs" },
          } as unknown as NotionBlock,
        ],
      };
      expect(isStubPage(page, blocks)).toBe(false);
    });

    it("recognizes link_preview blocks as non-stub content", () => {
      const page = { id: "p2" } as unknown as NotionPage;
      const blocks = {
        results: [
          {
            id: "b2",
            type: "link_preview",
            object: "block",
            link_preview: { url: "https://example.com/preview" },
          } as unknown as NotionBlock,
        ],
      };
      expect(isStubPage(page, blocks)).toBe(false);
    });

    it("recognizes truly empty pages as stubs", () => {
      const page = { id: "p3" } as unknown as NotionPage;
      const blocks = {
        results: [
          {
            id: "b3",
            type: "paragraph",
            object: "block",
            paragraph: { rich_text: [] },
          } as unknown as NotionBlock,
        ],
      };
      expect(isStubPage(page, blocks)).toBe(true);
    });
  });
});
