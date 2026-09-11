import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  prepareBlocksForNotion,
  writeTranslationToNotion,
  isStubPage,
  isDeadPage,
  rankTranslationCandidates,
} from "./notion-writer.js";
import type { NotionBlockList } from "./notion-converter.js";
import type { NotionBlock, NotionClient, NotionPage } from "./notion-client.js";
import { ClassifiedError, ErrorCategory } from "./errors.js";
import { NOTION_PROPERTIES } from "./notion-properties.js";

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

  it("preserves clickable links on image blocks from block.image.link", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-link-1",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: {
              url: "https://example.com/images/diagram.png",
            },
            link: { url: "https://example.com/dest" },
            caption: [{ type: "text", text: { content: "Diagram" } }],
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
          url: "https://example.com/images/diagram.png",
        },
        caption: [
          {
            type: "text",
            text: {
              content: "Diagram",
              link: { url: "https://example.com/dest" },
            },
          },
        ],
      },
    });
  });

  it("preserves clickable links on image blocks from block.image.external.link", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-link-2",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: {
              url: "https://example.com/images/diagram.png",
              link: { url: "https://example.com/content-dest" },
            },
            caption: [],
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
          url: "https://example.com/images/diagram.png",
        },
        caption: [
          {
            type: "text",
            text: {
              content: "image",
              link: { url: "https://example.com/content-dest" },
            },
            plain_text: "image",
          },
        ],
      },
    });
  });

  it("preserves clickable links on image blocks from S3 file.link when resolved to external", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-link-3",
          type: "image",
          has_children: false,
          image: {
            type: "file",
            file: {
              url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/doc/switch.jpg",
              expiry_time: "2026-01-01T00:00:00.000Z",
              link: { url: "https://example.com/file-dest" },
            },
            caption: [],
          },
        } as unknown as NotionBlock,
      ],
    };

    const assets = [
      {
        original_url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/doc/switch.jpg",
        r2_key: "assets/switch.jpg",
        sha256: "sha256:123",
        mime_type: "image/jpeg",
      },
    ];

    const prepared = prepareBlocksForNotion(rawBlocks, {
      assets,
      section: "intro",
    });

    expect(prepared[0]).toEqual({
      object: "block",
      type: "image",
      image: {
        type: "external",
        external: {
          url: "https://raw.githubusercontent.com/digidem/comapeo-docs/content/docs/intro/assets/switch.jpg",
        },
        caption: [
          {
            type: "text",
            text: {
              content: "image",
              link: { url: "https://example.com/file-dest" },
            },
            plain_text: "image",
          },
        ],
      },
    });
  });

  it("sanitizes relative and hash image links to absolute URLs", () => {
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-rel",
          type: "image",
          has_children: false,
          image: {
            type: "external",
            external: {
              url: "https://example.com/img.png",
            },
            link: { url: "/docs/overview" },
            caption: [],
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
          url: "https://example.com/img.png",
        },
        caption: [
          {
            type: "text",
            text: {
              content: "image",
              link: { url: "https://docs.comapeo.app/docs/overview" },
            },
            plain_text: "image",
          },
        ],
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
      queryDatabase: vi.fn().mockResolvedValue({ results: [], next_cursor: null, has_more: false }),
      restoreBlock: vi.fn().mockResolvedValue({ id: "restored", object: "block" }),
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

    expect(result).toMatchObject({
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

  it("reconciles and updates existing page when queryDatabase finds a matching translation during page creation", async () => {
    vi.mocked(mockClient.queryDatabase).mockResolvedValueOnce({
      results: [
        {
          id: "already-created-id",
          object: "page",
          properties: {
            [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Título Reconciliado" }] },
            [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "PT - automated" } },
            "Publish Status": { select: { name: "Automated translations generated" } },
          },
        } as unknown as NotionPage,
      ],
      next_cursor: null,
      has_more: false,
    });

    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "already-created-id",
      properties: {
        "Publish Status": { select: { name: "Automated translations generated" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [],
      children: {},
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "already-created-id",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Título Reconciliado",
      parentItemId: "container-parent-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(result.pageId).toBe("already-created-id");
    expect(mockClient.createPage).not.toHaveBeenCalled();
    expect(mockClient.queryDatabase).toHaveBeenCalledWith({
      filter: {
        and: [
          { property: NOTION_PROPERTIES.LANGUAGE, select: { equals: "PT - automated" } },
          { property: NOTION_PROPERTIES.TITLE, title: { equals: "Título Reconciliado" } },
          { property: NOTION_PROPERTIES.PARENT_ITEM, relation: { contains: "container-parent-id" } },
        ],
      },
      pageSize: 10,
    });
  });

  it("reconciles existing page in family even if the title was renamed or differs from targetTitle via parentEnglishPageId", async () => {
    vi.mocked(mockClient.queryDatabase).mockResolvedValueOnce({
      results: [
        {
          id: "renamed-translation-id",
          object: "page",
          properties: {
            [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Old Renamed Title" }] },
            [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES - automated" } },
            [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
          },
        } as unknown as NotionPage,
      ],
      next_cursor: null,
      has_more: false,
    });

    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "renamed-translation-id",
      properties: {
        [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [],
      children: {},
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "renamed-translation-id",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Newly Generated Title",
      parentEnglishPageId: "en-family-root",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(result.pageId).toBe("renamed-translation-id");
    expect(mockClient.createPage).not.toHaveBeenCalled();
    expect(mockClient.queryDatabase).toHaveBeenCalledWith({
      filter: {
        and: [
          { property: NOTION_PROPERTIES.LANGUAGE, select: { equals: "ES - automated" } },
          { property: NOTION_PROPERTIES.PARENT_ITEM, relation: { contains: "en-family-root" } },
        ],
      },
      pageSize: 10,
    });
  });

  it("ranks candidate with unavailable body ahead of confirmed stub during reconciliation", async () => {
    vi.mocked(mockClient.queryDatabase).mockResolvedValueOnce({
      results: [
        {
          id: "canonical-id",
          object: "page",
          properties: {
            [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target Title" }] },
            [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES" } },
            [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
          },
        } as unknown as NotionPage,
        {
          id: "stub-id",
          object: "page",
          properties: {
            [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target Title" }] },
            [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES - automated" } },
            [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
          },
        } as unknown as NotionPage,
      ],
      next_cursor: null,
      has_more: false,
    });

    vi.mocked(mockClient.getPageBlocks)
      .mockRejectedValueOnce(new Error("Transient Notion 500 error"))
      .mockResolvedValueOnce({
        results: [],
        children: {},
      })
      .mockResolvedValueOnce({
        results: [],
        children: {},
      });

    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "canonical-id",
      properties: {
        [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "canonical-id",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Target Title",
      parentEnglishPageId: "en-family-root",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(result.pageId).toBe("canonical-id");
    expect(mockClient.createPage).not.toHaveBeenCalled();
  });

  it("reconciles existing page via parentEnglishPageId sub-items even if title differs", async () => {
    vi.mocked(mockClient.getPage)
      // Call 1: parentEnglishPageId
      .mockResolvedValueOnce({
        id: "en-family-root",
        properties: {
          [NOTION_PROPERTIES.SUB_ITEM]: { relation: [{ id: "sub-item-es-id" }] },
        },
      } as unknown as NotionPage)
      // Call 2: child page in sub-items
      .mockResolvedValueOnce({
        id: "sub-item-es-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Renamed Title in Notion" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES - automated" } },
        },
      } as unknown as NotionPage)
      // Call 3: getPage inside writeTranslationToNotion update flow
      .mockResolvedValueOnce({
        id: "sub-item-es-id",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [],
      children: {},
    });

    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "sub-item-es-id",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Completely Different AI Title",
      parentEnglishPageId: "en-family-root",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(result.pageId).toBe("sub-item-es-id");
    expect(mockClient.createPage).not.toHaveBeenCalled();
  });

  it("queries by title and language when effectiveParentId is not provided", async () => {
    vi.mocked(mockClient.queryDatabase).mockResolvedValueOnce({
      results: [],
      next_cursor: null,
      has_more: false,
    });

    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "standalone-new-page",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Standalone Page",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("created");
    expect(mockClient.queryDatabase).toHaveBeenCalledWith({
      filter: {
        and: [
          { property: NOTION_PROPERTIES.LANGUAGE, select: { equals: "ES - automated" } },
          { property: NOTION_PROPERTIES.TITLE, title: { equals: "Standalone Page" } },
        ],
      },
      pageSize: 10,
    });
  });

  it("aborts safely and never calls createPage if queryDatabase fails during parentEnglishPageId query", async () => {
    vi.mocked(mockClient.queryDatabase).mockRejectedValueOnce(
      new Error("Notion API 500 Internal Server Error"),
    );

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "es",
        targetTitle: "New Translation Page",
        parentEnglishPageId: "en-family-root",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow(/Failed to query existing translations for parentEnglishPageId/);

    expect(mockClient.createPage).not.toHaveBeenCalled();
  });

  it("aborts safely and never calls createPage if queryDatabase fails during title and language query", async () => {
    vi.mocked(mockClient.queryDatabase).mockRejectedValueOnce(
      new Error("Notion API 429 Rate Limit Exceeded"),
    );

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "es",
        targetTitle: "Standalone Page",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow(/Failed to query existing translations by language and title/);

    expect(mockClient.createPage).not.toHaveBeenCalled();
  });

  it("aborts safely and never calls createPage if getPage fails during parentEnglishPageId sub-items inspection", async () => {
    vi.mocked(mockClient.queryDatabase).mockResolvedValueOnce({
      results: [],
      next_cursor: null,
      has_more: false,
    });

    vi.mocked(mockClient.getPage).mockRejectedValueOnce(
      new Error("Notion API Network Timeout"),
    );

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "es",
        targetTitle: "New Translation Page",
        parentEnglishPageId: "en-family-root",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow(/Failed to inspect parentEnglishPageId/);

    expect(mockClient.createPage).not.toHaveBeenCalled();
  });

  it("skips write and preserves Notion content when translated blocks result in 0 writeable blocks after preparation", async () => {
    const emptyBlocks: NotionBlockList = {
      object: "list",
      results: [],
    };

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Empty Translation Page",
      targetPageId: "existing-page-to-preserve",
      translatedBlocks: emptyBlocks,
    });

    expect(result.written).toBe(false);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("empty translation");
    expect(mockClient.deleteBlock).not.toHaveBeenCalled();
    expect(mockClient.updatePage).not.toHaveBeenCalled();
    expect(mockClient.appendBlockChildren).not.toHaveBeenCalled();
    expect(mockClient.createPage).not.toHaveBeenCalled();
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

  it("falls back to creating a new page if targetPageId returns 404 from Notion", async () => {
    // Test with real ClassifiedError shape from NotionClient
    vi.mocked(mockClient.getPage).mockRejectedValueOnce(
      new ClassifiedError(
        "[Notion /pages/nonexistent-page-id] Notion API error 404: Not Found — object_not_found",
        ErrorCategory.HTTP_CLIENT,
        404,
      ),
    );
    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "new-page-after-404",
      object: "page",
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Título Nuevo",
      targetPageId: "nonexistent-page-id",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("created");
    expect(result.pageId).toBe("new-page-after-404");
    expect(mockClient.createPage).toHaveBeenCalled();
  });

  it("rethrows error when targetPageId returns 400 (does NOT fall back to page creation)", async () => {
    vi.mocked(mockClient.getPage).mockRejectedValueOnce({ status: 400, code: "validation_error" });

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "es",
        targetTitle: "Título Nuevo",
        targetPageId: "invalid-page-id",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toEqual({ status: 400, code: "validation_error" });

    expect(mockClient.createPage).not.toHaveBeenCalled();
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

    expect(result).toMatchObject({
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
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-page-rollback",
        properties: {
          "Publish Status": { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "stub-page-rollback",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
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
    // Must restore original page properties
    expect(mockClient.updatePage).toHaveBeenCalledTimes(2);
    expect(mockClient.updatePage).toHaveBeenLastCalledWith("stub-page-rollback", {
      properties: {
        [NOTION_PROPERTIES.TITLE]: { title: [] },
        [NOTION_PROPERTIES.LANGUAGE]: { select: null },
        [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        [NOTION_PROPERTIES.PARENT_ITEM]: { relation: [] },
      },
    });
  });

  it("restores previously deleted old blocks using restoreBlock if deletion fails midway", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-partial-delete",
        properties: {},
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "stub-partial-delete",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
        { id: "old-2", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-partial-delete",
      object: "page",
    } as unknown as NotionPage);

    // First deleteBlock succeeds (old-1), second fails (old-2)
    vi.mocked(mockClient.deleteBlock)
      .mockResolvedValueOnce({ id: "old-1", object: "block", archived: true })
      .mockRejectedValueOnce(new Error("Midway delete failure"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Falha Meio",
        parentEnglishPageId: "en-parent-id",
        targetPageId: "stub-partial-delete",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("Failed to delete old blocks during atomic replacement");

    // old-1 was deleted before the error, so it must be restored
    expect(mockClient.restoreBlock).toHaveBeenCalledWith("old-1");
    // new-1 was appended, so it must be deleted during rollback
    expect(mockClient.deleteBlock).toHaveBeenCalledWith("new-1");
    // Stub properties that were not present on page must be explicitly reset to null/empty
    expect(mockClient.updatePage).toHaveBeenLastCalledWith("stub-partial-delete", {
      properties: {
        [NOTION_PROPERTIES.TITLE]: { title: [] },
        [NOTION_PROPERTIES.LANGUAGE]: { select: null },
        [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: null },
        [NOTION_PROPERTIES.PARENT_ITEM]: { relation: [] },
      },
    });
  });

  it("aborts deletion failure rollback if concurrent edits changed last_edited_time", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-concurrent-edit",
        last_edited_time: "2026-09-01T10:00:00Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "stub-concurrent-edit",
        last_edited_time: "2026-09-01T10:06:00Z", // modified concurrently
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-concurrent-edit",
      last_edited_time: "2026-09-01T10:05:00Z",
      object: "page",
    } as unknown as NotionPage);

    vi.mocked(mockClient.deleteBlock).mockRejectedValueOnce(new Error("Delete failed"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Concurrent Edit Test",
        targetPageId: "stub-concurrent-edit",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("preserved newly appended blocks and properties to prevent destroying concurrent edits");

    // Must NOT delete the newly appended block
    expect(mockClient.deleteBlock).not.toHaveBeenCalledWith("new-b");
    // Must NOT restore original properties (updatePage only called once for original translation write)
    expect(mockClient.updatePage).toHaveBeenCalledTimes(1);
  });

  it("aborts deletion failure rollback if publish status changed to a human review state", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-status-change",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "stub-status-change",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Published" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-status-change",
      object: "page",
    } as unknown as NotionPage);

    vi.mocked(mockClient.deleteBlock).mockRejectedValueOnce(new Error("Delete failed"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Status Change Test",
        targetPageId: "stub-status-change",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("preserved newly appended blocks and properties to prevent destroying concurrent edits");

    // Must NOT delete the newly appended block
    expect(mockClient.deleteBlock).not.toHaveBeenCalledWith("new-b");
    // Must NOT restore original properties
    expect(mockClient.updatePage).toHaveBeenCalledTimes(1);
  });

  it("aborts deletion failure rollback if concurrent body edits added unexpected blocks", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-concurrent-body-add",
        last_edited_time: "2026-09-01T10:00:00Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "stub-concurrent-body-add",
        last_edited_time: "2026-09-01T10:05:00Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage);

    // Initial getPageBlocks before translation
    vi.mocked(mockClient.getPageBlocks)
      .mockResolvedValueOnce({
        results: [
          { id: "old-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
        ],
        children: {},
      })
      // Second getPageBlocks during deletion-failure rollback verification has a concurrent block added
      .mockResolvedValueOnce({
        results: [
          { id: "old-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
          { id: "new-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
          { id: "concurrent-block", type: "paragraph", object: "block" } as unknown as NotionBlock,
        ],
        children: {},
      });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-concurrent-body-add",
      last_edited_time: "2026-09-01T10:05:00Z",
      object: "page",
    } as unknown as NotionPage);

    vi.mocked(mockClient.deleteBlock).mockRejectedValueOnce(new Error("Delete failed"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Concurrent Body Add Test",
        targetPageId: "stub-concurrent-body-add",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("preserved newly appended blocks and properties to prevent destroying concurrent edits");

    // Must NOT delete the newly appended block
    expect(mockClient.deleteBlock).not.toHaveBeenCalledWith("new-b");
    // Must NOT restore original properties (updatePage only called once for original translation write)
    expect(mockClient.updatePage).toHaveBeenCalledTimes(1);
  });

  it("aborts deletion failure rollback if concurrent body edits removed blocks", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-concurrent-body-del",
        last_edited_time: "2026-09-01T10:00:00Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "stub-concurrent-body-del",
        last_edited_time: "2026-09-01T10:05:00Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks)
      .mockResolvedValueOnce({
        results: [
          { id: "old-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
          { id: "old-2", type: "paragraph", object: "block" } as unknown as NotionBlock,
        ],
        children: {},
      })
      // During rollback, an existing block was removed concurrently
      .mockResolvedValueOnce({
        results: [
          { id: "old-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
          { id: "new-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
        ],
        children: {},
      });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-concurrent-body-del",
      last_edited_time: "2026-09-01T10:05:00Z",
      object: "page",
    } as unknown as NotionPage);

    vi.mocked(mockClient.deleteBlock).mockRejectedValueOnce(new Error("Delete failed"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Concurrent Body Del Test",
        targetPageId: "stub-concurrent-body-del",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("preserved newly appended blocks and properties to prevent destroying concurrent edits");

    expect(mockClient.deleteBlock).not.toHaveBeenCalledWith("new-b");
    expect(mockClient.updatePage).toHaveBeenCalledTimes(1);
  });

  it("aborts deletion failure rollback if a non-restored block was modified concurrently during recovery", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-concurrent-block-mod",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "stub-concurrent-block-mod",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks)
      .mockResolvedValueOnce({
        results: [
          { id: "old-1", last_edited_time: "2026-09-01T10:00:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock,
          { id: "old-2", last_edited_time: "2026-09-01T10:00:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock,
        ],
        children: {},
      })
      .mockResolvedValueOnce({
        results: [
          { id: "old-1", last_edited_time: "2026-09-01T10:07:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock, // restored by writer
          { id: "old-2", last_edited_time: "2026-09-01T10:08:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock, // modified concurrently by human
          { id: "new-b", last_edited_time: "2026-09-01T10:05:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock,
        ],
        children: {},
      });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-b", last_edited_time: "2026-09-01T10:05:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-concurrent-block-mod",
      last_edited_time: "2026-09-01T10:05:00Z",
      object: "page",
    } as unknown as NotionPage);

    // old-1 delete succeeds, old-2 delete fails
    vi.mocked(mockClient.deleteBlock)
      .mockResolvedValueOnce({ id: "old-1", object: "block", archived: true })
      .mockRejectedValueOnce(new Error("Delete old-2 failed"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Concurrent Block Mod Test",
        targetPageId: "stub-concurrent-block-mod",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("preserved newly appended blocks and properties to prevent destroying concurrent edits");

    expect(mockClient.restoreBlock).toHaveBeenCalledWith("old-1");
    expect(mockClient.deleteBlock).not.toHaveBeenCalledWith("new-b");
    expect(mockClient.updatePage).toHaveBeenCalledTimes(1);
  });

  it("successfully rolls back newly appended blocks when restoreBlock succeeds and no concurrent edits occurred", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-successful-restore",
        last_edited_time: "2026-09-01T10:00:00Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "stub-successful-restore",
        last_edited_time: "2026-09-01T10:07:00Z", // page time advanced by restoreBlock
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks)
      .mockResolvedValueOnce({
        results: [
          { id: "old-1", last_edited_time: "2026-09-01T10:00:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock,
          { id: "old-2", last_edited_time: "2026-09-01T10:00:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock,
        ],
        children: {},
      })
      .mockResolvedValueOnce({
        results: [
          { id: "old-1", last_edited_time: "2026-09-01T10:07:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock, // restored by writer
          { id: "old-2", last_edited_time: "2026-09-01T10:00:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock, // untouched
          { id: "new-b", last_edited_time: "2026-09-01T10:05:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock,
        ],
        children: {},
      });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-b", last_edited_time: "2026-09-01T10:05:00Z", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-successful-restore",
      last_edited_time: "2026-09-01T10:05:00Z",
      object: "page",
    } as unknown as NotionPage);

    // old-1 delete succeeds, old-2 delete fails
    vi.mocked(mockClient.deleteBlock)
      .mockResolvedValueOnce({ id: "old-1", object: "block", archived: true })
      .mockRejectedValueOnce(new Error("Delete old-2 failed"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Successful Restore Rollback Test",
        targetPageId: "stub-successful-restore",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("rolled back newly appended blocks, and restored original page properties");

    expect(mockClient.restoreBlock).toHaveBeenCalledWith("old-1");
    // new-b should be deleted during rollback because no concurrent edits occurred
    expect(mockClient.deleteBlock).toHaveBeenCalledWith("new-b");
    // Properties should be restored
    expect(mockClient.updatePage).toHaveBeenCalledTimes(2);
  });

  it("aborts deletion failure rollback if getPage fails during rollback verification", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "stub-fetch-fail",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockRejectedValueOnce(new Error("Network failure during verification"));

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-fetch-fail",
      object: "page",
    } as unknown as NotionPage);

    vi.mocked(mockClient.deleteBlock).mockRejectedValueOnce(new Error("Delete failed"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Fetch Fail Test",
        targetPageId: "stub-fetch-fail",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("preserved newly appended blocks and properties to prevent destroying concurrent edits");

    // Must NOT delete the newly appended block
    expect(mockClient.deleteBlock).not.toHaveBeenCalledWith("new-b");
    // Must NOT restore original properties
    expect(mockClient.updatePage).toHaveBeenCalledTimes(1);
  });

  it("preserves newly appended replacement blocks and reports failed block IDs if restoreBlock fails during delete rollback", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "stub-restore-fail",
      properties: {},
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
        { id: "old-b", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-preserved-1", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValueOnce({
      id: "stub-restore-fail",
      object: "page",
    } as unknown as NotionPage);

    // Delete old-a succeeds, old-b fails
    vi.mocked(mockClient.deleteBlock)
      .mockResolvedValueOnce({ id: "old-a", object: "block", archived: true })
      .mockRejectedValueOnce(new Error("Delete error on old-b"));

    // Restoring old-a fails
    vi.mocked(mockClient.restoreBlock).mockRejectedValueOnce(new Error("Restore error on old-a"));

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Restore Fail",
        parentEnglishPageId: "en-parent-id",
        targetPageId: "stub-restore-fail",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow(/Rollback failed to restore 1 deleted old block\(s\) \[old-a\]; preserved newly appended replacement blocks/);

    // new-preserved-1 must NOT be deleted so content is not completely lost
    expect(mockClient.deleteBlock).not.toHaveBeenCalledWith("new-preserved-1");
  });

  it("rolls back all previously appended chunks when appendBlockChildren fails on a later chunk", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValueOnce({
      id: "stub-multi-chunk",
      properties: {},
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [],
      children: {},
    });

    const chunk1 = [{ id: "chunk1-b1", type: "paragraph", object: "block" } as unknown as NotionBlock];
    const chunkError = Object.assign(new Error("Append chunk 2 failed"), {
      appendedBlocks: chunk1,
    });

    vi.mocked(mockClient.appendBlockChildren).mockImplementationOnce(async (_pageId, _blocks, options) => {
      options?.onChunk?.(chunk1);
      throw chunkError;
    });

    await expect(
      writeTranslationToNotion({
        client: mockClient,
        databaseId: "db-123",
        targetLocale: "pt",
        targetTitle: "Multi Chunk",
        targetPageId: "stub-multi-chunk",
        translatedBlocks: mockTranslatedBlocks,
      }),
    ).rejects.toThrow("Append chunk 2 failed");

    expect(mockClient.deleteBlock).toHaveBeenCalledWith("chunk1-b1");
  });

  it("provides a rollback function when creating a new page that deletes the created page", async () => {
    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "created-page-to-rollback",
      object: "page",
    } as unknown as NotionPage);
    vi.mocked(mockClient.getPage).mockResolvedValue({
      id: "created-page-to-rollback",
      properties: {
        [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
      },
    } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Rollback Test",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("created");
    expect(typeof result.rollback).toBe("function");

    const rolledBack = await result.rollback!();
    expect(rolledBack).toBe(true);
    expect(mockClient.deleteBlock).toHaveBeenCalledWith("created-page-to-rollback");
  });

  it("aborts rollback on created page if getPage rejects or returns null", async () => {
    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "created-page-abort-test",
      object: "page",
    } as unknown as NotionPage);
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "created-page-abort-test",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockRejectedValueOnce(new Error("Network error fetching page"));

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Rollback Abort Test",
      translatedBlocks: mockTranslatedBlocks,
    });

    vi.mocked(mockClient.deleteBlock).mockClear();

    const rolledBack = await result.rollback!();
    expect(rolledBack).toBe(false);
    expect(mockClient.deleteBlock).not.toHaveBeenCalled();
  });

  it("aborts rollback on created page if publish status changed to a human review state", async () => {
    vi.mocked(mockClient.createPage).mockResolvedValueOnce({
      id: "created-page-status-test",
      object: "page",
    } as unknown as NotionPage);
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "created-page-status-test",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "created-page-status-test",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Published" } },
        },
      } as unknown as NotionPage);

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "es",
      targetTitle: "Rollback Status Test",
      translatedBlocks: mockTranslatedBlocks,
    });

    vi.mocked(mockClient.deleteBlock).mockClear();

    const rolledBack = await result.rollback!();
    expect(rolledBack).toBe(false);
    expect(mockClient.deleteBlock).not.toHaveBeenCalled();
  });

  it("provides a rollback function when updating an existing page that restores old blocks and original properties", async () => {
    vi.mocked(mockClient.getPage).mockResolvedValue({
      id: "updated-page-to-rollback",
      properties: {
        [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
      },
    } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-block-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-block-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Update Rollback",
      targetPageId: "updated-page-to-rollback",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(result.action).toBe("updated");
    expect(typeof result.rollback).toBe("function");

    const rolledBackUpdate = await result.rollback!();
    expect(rolledBackUpdate).toBe(true);

    expect(mockClient.restoreBlock).toHaveBeenCalledWith("old-block-a");
    expect(mockClient.deleteBlock).toHaveBeenCalledWith("new-block-a");
    expect(mockClient.updatePage).toHaveBeenLastCalledWith("updated-page-to-rollback", {
      properties: {
        [NOTION_PROPERTIES.TITLE]: { title: [] },
        [NOTION_PROPERTIES.LANGUAGE]: { select: null },
        [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
      },
    });
  });

  it("aborts rollback on an updated page if getPage rejects during rollback", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "fetch-error-rollback-page",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "fetch-error-rollback-page",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockRejectedValueOnce(new Error("Network timeout during rollback verification"));

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-block-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-block-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValue({
      id: "fetch-error-rollback-page",
      object: "page",
    } as unknown as NotionPage);
    vi.mocked(mockClient.deleteBlock).mockResolvedValue({ id: "old-block-a", object: "block", archived: true });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Fetch Error Check",
      targetPageId: "fetch-error-rollback-page",
      translatedBlocks: mockTranslatedBlocks,
    });

    // Clear calls from the successful write
    vi.mocked(mockClient.deleteBlock).mockClear();
    vi.mocked(mockClient.restoreBlock!).mockClear();
    vi.mocked(mockClient.updatePage).mockClear();

    await result.rollback!();

    // Must NOT delete new blocks or restore old blocks
    expect(mockClient.deleteBlock).not.toHaveBeenCalled();
    expect(mockClient.restoreBlock).not.toHaveBeenCalled();
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });

  it("aborts rollback on an updated page if concurrent edits changed last_edited_time", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "concurrent-page",
        last_edited_time: "2026-09-11T10:00:00.000Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "concurrent-page",
        last_edited_time: "2026-09-11T10:05:00.000Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "concurrent-page",
        last_edited_time: "2026-09-11T10:10:00.000Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-block-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-block-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValue({
      id: "concurrent-page",
      last_edited_time: "2026-09-11T10:05:00.000Z",
      object: "page",
    } as unknown as NotionPage);
    vi.mocked(mockClient.deleteBlock).mockResolvedValue({ id: "old-block-a", object: "block", archived: true });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Concurrent Edit Check",
      targetPageId: "concurrent-page",
      translatedBlocks: mockTranslatedBlocks,
    });

    expect(result.written).toBe(true);
    expect(typeof result.rollback).toBe("function");

    // Clear calls from the successful write
    vi.mocked(mockClient.deleteBlock).mockClear();
    vi.mocked(mockClient.restoreBlock!).mockClear();
    vi.mocked(mockClient.updatePage).mockClear();

    await result.rollback!();

    // Must NOT delete new blocks, restore old blocks, or update page properties because concurrent edits occurred
    expect(mockClient.deleteBlock).not.toHaveBeenCalled();
    expect(mockClient.restoreBlock).not.toHaveBeenCalled();
    expect(mockClient.updatePage).not.toHaveBeenCalled();
  });

  it("aborts rollback on an updated page if publish status changed to a human review state", async () => {
    vi.mocked(mockClient.getPage)
      .mockResolvedValueOnce({
        id: "status-change-page",
        last_edited_time: "2026-09-11T10:00:00.000Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "status-change-page",
        last_edited_time: "2026-09-11T10:05:00.000Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Automated translations generated" } },
        },
      } as unknown as NotionPage)
      .mockResolvedValueOnce({
        id: "status-change-page",
        last_edited_time: "2026-09-11T10:05:00.000Z",
        properties: {
          [NOTION_PROPERTIES.PUBLISH_STATUS]: { select: { name: "Published" } },
        },
      } as unknown as NotionPage);

    vi.mocked(mockClient.getPageBlocks).mockResolvedValueOnce({
      results: [
        { id: "old-block-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      children: {},
    });

    vi.mocked(mockClient.appendBlockChildren).mockResolvedValueOnce({
      object: "list",
      results: [
        { id: "new-block-a", type: "paragraph", object: "block" } as unknown as NotionBlock,
      ],
      next_cursor: null,
      has_more: false,
    });
    vi.mocked(mockClient.updatePage).mockResolvedValue({
      id: "status-change-page",
      last_edited_time: "2026-09-11T10:05:00.000Z",
      object: "page",
    } as unknown as NotionPage);
    vi.mocked(mockClient.deleteBlock).mockResolvedValue({ id: "old-block-a", object: "block", archived: true });

    const result = await writeTranslationToNotion({
      client: mockClient,
      databaseId: "db-123",
      targetLocale: "pt",
      targetTitle: "Status Change Check",
      targetPageId: "status-change-page",
      translatedBlocks: mockTranslatedBlocks,
    });

    // Clear calls from the successful write
    vi.mocked(mockClient.deleteBlock).mockClear();
    vi.mocked(mockClient.restoreBlock!).mockClear();
    vi.mocked(mockClient.updatePage).mockClear();

    await result.rollback!();

    // Must NOT delete new blocks or restore old blocks
    expect(mockClient.deleteBlock).not.toHaveBeenCalled();
    expect(mockClient.restoreBlock).not.toHaveBeenCalled();
    expect(mockClient.updatePage).not.toHaveBeenCalled();
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

  describe("isDeadPage", () => {
    it("returns true for archived or in_trash pages", () => {
      expect(isDeadPage({ id: "p1", archived: true } as unknown as NotionPage)).toBe(true);
      expect(isDeadPage({ id: "p2", in_trash: true } as unknown as NotionPage)).toBe(true);
    });

    it("returns true for pages with dead Publish Status values", () => {
      const makePage = (status: string) =>
        ({
          id: "p",
          properties: {
            "Publish Status": { select: { name: status } },
          },
        }) as unknown as NotionPage;

      expect(isDeadPage(makePage("Remove"))).toBe(true);
      expect(isDeadPage(makePage("remove"))).toBe(true);
      expect(isDeadPage(makePage("Unplublished"))).toBe(true);
      expect(isDeadPage(makePage("Unpublished"))).toBe(true);
      expect(isDeadPage(makePage("Deleted"))).toBe(true);
      expect(isDeadPage(makePage("deprecated"))).toBe(true);
    });

    it("returns false for live or draft Publish Status values and missing statuses", () => {
      const makePage = (status?: string) =>
        ({
          id: "p",
          properties: status
            ? { "Publish Status": { select: { name: status } } }
            : {},
        }) as unknown as NotionPage;

      expect(isDeadPage(makePage("Published"))).toBe(false);
      expect(isDeadPage(makePage("Draft published"))).toBe(false);
      expect(isDeadPage(makePage("Ready to publish"))).toBe(false);
      expect(isDeadPage(makePage("Automated translations generated"))).toBe(false);
      expect(isDeadPage(makePage("Not started"))).toBe(false);
      expect(isDeadPage(makePage())).toBe(false);
    });
  });

  describe("rankTranslationCandidates", () => {
    it("filters out dead/archived candidates even if they match targetTitle exactly", () => {
      const deadCandidate = {
        id: "dead-id",
        archived: true,
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target Title" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES - automated" } },
        },
      } as unknown as NotionPage;

      const liveCandidate = {
        id: "live-id",
        archived: false,
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Old Title" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES - automated" } },
        },
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates([deadCandidate, liveCandidate], "Target Title");
      expect(ranked).toHaveLength(1);
      expect(ranked[0].id).toBe("live-id");
    });

    it("returns empty array if all candidates are dead", () => {
      const dead1 = {
        id: "d1",
        properties: { "Publish Status": { select: { name: "Remove" } } },
      } as unknown as NotionPage;
      const dead2 = {
        id: "d2",
        properties: { "Publish Status": { select: { name: "Unplublished" } } },
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates([dead1, dead2], "Any Title");
      expect(ranked).toHaveLength(0);
    });

    it("ranks candidates with real body ahead of stubs", () => {
      const stub = {
        id: "stub-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target" }] },
        },
      } as unknown as NotionPage;

      const withBody = {
        id: "body-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target" }] },
        },
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates(
        [stub, withBody],
        "Target",
        { "stub-id": false, "body-id": true },
      );
      expect(ranked[0].id).toBe("body-id");
    });

    it("treats unavailable candidate bodies (undefined) as unknown rather than stubs, avoiding demoting candidate", () => {
      const failedFetchCanonical = {
        id: "canonical-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES" } }, // explicit source
        },
      } as unknown as NotionPage;

      const automatedWithBody = {
        id: "auto-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES - automated" } }, // automated source
        },
      } as unknown as NotionPage;

      // A candidate known to contain content (auto-id, true) ranks ahead of unavailable candidate (canonical-id, undefined)
      const ranked = rankTranslationCandidates(
        [failedFetchCanonical, automatedWithBody],
        "Target",
        { "canonical-id": undefined, "auto-id": true },
      );
      expect(ranked[0].id).toBe("auto-id");

      // An unavailable candidate (canonical-id, undefined) ranks ahead of a confirmed stub (stub-id, false)
      const confirmedStub = {
        id: "stub-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES" } },
        },
      } as unknown as NotionPage;
      const rankedWithStub = rankTranslationCandidates(
        [failedFetchCanonical, confirmedStub],
        "Target",
        { "canonical-id": undefined, "stub-id": false },
      );
      expect(rankedWithStub[0].id).toBe("canonical-id");
    });

    it("ranks candidates according to 3-tier body presence: true > undefined > false", () => {
      const failedFetch = {
        id: "failed-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES" } },
        },
      } as unknown as NotionPage;

      const automatedWithBody = {
        id: "auto-body-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES - automated" } },
        },
      } as unknown as NotionPage;

      const explicitStub = {
        id: "explicit-stub-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Target" }] },
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES" } },
        },
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates(
        [explicitStub, automatedWithBody, failedFetch],
        "Target",
        {
          "failed-id": undefined,
          "auto-body-id": true,
          "explicit-stub-id": false,
        },
      );

      // auto-body-id (true) > failed-id (undefined) > explicit-stub-id (false)
      expect(ranked.map((p) => p.id)).toEqual(["auto-body-id", "failed-id", "explicit-stub-id"]);
    });

    it("ranks explicit language source over automated over fallback", () => {
      const explicit = {
        id: "exp-id",
        properties: {
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES" } },
        },
      } as unknown as NotionPage;

      const automated = {
        id: "auto-id",
        properties: {
          [NOTION_PROPERTIES.LANGUAGE]: { select: { name: "ES - automated" } },
        },
      } as unknown as NotionPage;

      const fallback = {
        id: "fb-id",
        properties: {},
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates([fallback, automated, explicit], "Title");
      expect(ranked.map((p) => p.id)).toEqual(["exp-id", "auto-id", "fb-id"]);
    });

    it("ranks typed element type over untyped", () => {
      const untyped = {
        id: "untyped-id",
        properties: {},
      } as unknown as NotionPage;

      const typed = {
        id: "typed-id",
        properties: {
          [NOTION_PROPERTIES.ELEMENT_TYPE]: { select: { name: "page" } },
        },
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates([untyped, typed], "Title");
      expect(ranked.map((p) => p.id)).toEqual(["typed-id", "untyped-id"]);
    });

    it("ranks non-staging title over staging suffix", () => {
      const staging = {
        id: "staging-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Doc - 2026-05-12 translation" }] },
        },
      } as unknown as NotionPage;

      const normal = {
        id: "normal-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Doc" }] },
        },
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates([staging, normal], "Other Title");
      expect(ranked.map((p) => p.id)).toEqual(["normal-id", "staging-id"]);
    });

    it("ranks exact title match over alternate title", () => {
      const alternate = {
        id: "alt-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Alternate Title" }] },
        },
      } as unknown as NotionPage;

      const exact = {
        id: "exact-id",
        properties: {
          [NOTION_PROPERTIES.TITLE]: { title: [{ plain_text: "Exact Target Title" }] },
        },
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates([alternate, exact], "Exact Target Title");
      expect(ranked.map((p) => p.id)).toEqual(["exact-id", "alt-id"]);
    });

    it("ranks lower order number ahead of higher order number", () => {
      const order2 = {
        id: "o2",
        properties: {
          [NOTION_PROPERTIES.ORDER]: { number: 2 },
        },
      } as unknown as NotionPage;

      const order1 = {
        id: "o1",
        properties: {
          [NOTION_PROPERTIES.ORDER]: { number: 1 },
        },
      } as unknown as NotionPage;

      const ranked = rankTranslationCandidates([order2, order1], "Title");
      expect(ranked.map((p) => p.id)).toEqual(["o1", "o2"]);
    });
  });
});
