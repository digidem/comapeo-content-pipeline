import { describe, it, expect, vi } from "vitest";
import type { NotionBlockList } from "./notion-converter.js";
import type { PageMetadata } from "../schemas/metadata.js";
import { AITranslator } from "./ai-translator.js";
import { loadGlossary } from "./glossary.js";
import { translatePageContent, maskHtmlTags, unmaskHtmlTags } from "./page-translator.js";
import { findMdxHazards } from "./mdx-safety.js";

describe("translatePageContent", () => {
  const glossary = loadGlossary();

  const mockEnMetadata: PageMetadata = {
    page_id: "en-123",
    title: "Recording Tracks",
    source_url: "https://notion.so/en123",
    notion_last_edited_time: "2026-03-01T10:00:00.000Z",
    content_hash: "hash123",
    raw_hash: "rawhash123",
    locale: "en",
    section: "Tracks",
    section_order: 2,
    slug: "recording-tracks",
    docusaurus_id: "tracks/recording-tracks",
    status: "active",
    properties: {},
    assets: [],
    keywords: ["tracks", "gps"],
    tags: ["comapeo"],
    language_source: "explicit",
  };

  const mockEnBlocks: NotionBlockList = {
    object: "list",
    results: [
      {
        object: "block",
        id: "b1",
        type: "paragraph",
        has_children: false,
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { content: "Start recording a new " },
              plain_text: "Start recording a new ",
              annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
            },
            {
              type: "text",
              text: { content: "Track" },
              plain_text: "Track",
              annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
            },
            {
              type: "text",
              text: { content: " by tapping the button." },
              plain_text: " by tapping the button.",
              annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
            },
          ],
        },
      },
      {
        object: "block",
        id: "b2",
        type: "callout",
        has_children: false,
        callout: {
          color: "blue_background",
          icon: { type: "emoji", emoji: "💡" },
          rich_text: [
            {
              type: "text",
              text: { content: "Note: Ensure background maps are downloaded." },
              plain_text: "Note: Ensure background maps are downloaded.",
              annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
            },
          ],
        },
      },
    ],
  };

  it("translates page title, content, frontmatter, and preserves canonical slug", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                __page_title__: "Gravando Trajetos",
                b1: "Comece a gravar um novo **Trajeto** tocando no botão.",
                b2: "Nota: Certifique-se de que os mapas de fundo estejam baixados.",
              }),
            },
          },
        ],
      }),
    });

    const translator = new AITranslator({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translatePageContent({
      enRawBlocks: mockEnBlocks,
      enMetadata: mockEnMetadata,
      targetLocale: "pt",
      targetPageId: "pt-stub-456",
      translator,
      glossary,
    });

    expect(result.targetLocale).toBe("pt");
    expect(result.targetPageId).toBe("pt-stub-456");
    expect(result.title).toBe("Gravando Trajetos");

    // Slug and docusaurus_id must match English canonical slug
    expect(result.translatedMetadata.slug).toBe("recording-tracks");
    expect(result.translatedMetadata.docusaurus_id).toBe("tracks/recording-tracks");
    expect(result.translatedMetadata.language_source).toBe("automated");
    expect(result.translatedMetadata.drafting_status).toBe("automated translations generated");

    // Check markdown body contains translated content and admonition
    expect(result.translatedMd).toContain("title: Gravando Trajetos");
    expect(result.translatedMd).toContain("locale: pt");
    expect(result.translatedMd).toContain('slug: "/recording-tracks"');
    expect(result.translatedMd).toContain("Comece a gravar um novo **Trajeto**");
    expect(result.translatedMd).toContain(":::info 💡 Nota");

    // MDX safety check
    const hazards = findMdxHazards(result.translatedMd);
    expect(hazards).toEqual([]);
  });

  it("rehosts assets and protects inline HTML tags from LLM corruption", async () => {
    const assetsMeta: PageMetadata = {
      ...mockEnMetadata,
      assets: [
        {
          original_url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/uuid/switch_projects.jpg?X-Amz-Signature=111",
          r2_key: "assets/ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4.jpg",
          sha256: "sha256:ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4",
          mime_type: "image/jpeg",
        },
        {
          original_url: "https://s3-us-west-2.amazonaws.com/public.notion-static.com/uuid/photo_2026-04-18_09-03-07.jpg",
          r2_key: "assets/ce83f9d3ea687047295a17cb3e9e090b3f7b1e1196ac2c200404927cae1c1a25.jpg",
          sha256: "sha256:ce83f9d3ea687047295a17cb3e9e090b3f7b1e1196ac2c200404927cae1c1a25",
          mime_type: "image/jpeg",
        },
      ],
    };

    const blocksWithAssets: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img1",
          type: "image",
          has_children: false,
          image: {
            type: "file",
            file: {
              url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/uuid/switch_projects.jpg?X-Amz-Signature=222",
              expiry_time: "2026-09-10T12:00:00.000Z",
            },
            caption: [],
          },
        },
        {
          object: "block",
          id: "p_emoji",
          type: "paragraph",
          has_children: false,
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: "Click on " },
                plain_text: "Click on ",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "mention",
                mention: {
                  type: "custom_emoji",
                  custom_emoji: {
                    url: "https://s3-us-west-2.amazonaws.com/public.notion-static.com/uuid/photo_2026-04-18_09-03-07.jpg",
                    name: "app-icon-comapeo-switch-project",
                  },
                },
                plain_text: "app-icon-comapeo-switch-project",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
              {
                type: "text",
                text: { content: " to switch projects." },
                plain_text: " to switch projects.",
                annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
              },
            ],
          },
        },
      ],
    };

    const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      const userPrompt = JSON.parse(body.messages[1].content);
      const blocks = userPrompt.blocks as Array<{ id: string; text: string }>;

      // Verify that HTML tag was masked before reaching the LLM
      const emojiBlock = blocks.find((b) => b.id === "p_emoji");
      expect(emojiBlock).toBeDefined();
      expect(emojiBlock!.text).toContain("⟦TAG_0⟧");
      expect(emojiBlock!.text).not.toContain("https://");

      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  __page_title__: "Gravando Trajetos",
                  p_emoji: "Clique em ⟦TAG_0⟧ para alternar projetos.",
                }),
              },
            },
          ],
        }),
      };
    });

    const translator = new AITranslator({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translatePageContent({
      enRawBlocks: blocksWithAssets,
      enMetadata: assetsMeta,
      targetLocale: "pt",
      translator,
      glossary,
    });

    // Both the block image and the inline HTML img tag must be rehosted
    expect(result.translatedMd).toContain("assets/ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4.jpg");
    expect(result.translatedMd).toContain('src="assets/ce83f9d3ea687047295a17cb3e9e090b3f7b1e1196ac2c200404927cae1c1a25.jpg"');
    expect(result.translatedMd).not.toContain("https://prod-files-secure.s3");
    expect(result.translatedMd).not.toContain("https://s3-us-west-2.amazonaws.com");

    // Metadata assets must be preserved
    expect(result.translatedMetadata.assets).toHaveLength(2);
    expect(result.translatedMetadata.assets[0].r2_key).toBe("assets/ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4.jpg");
  });
});

describe("maskHtmlTags / unmaskHtmlTags", () => {
  it("masks and unmasks <img ... /> tags", () => {
    const original = 'Select <img src="https://example.com/icon.png" alt="icon" className="emoji" style={{display:"inline"}} /> to proceed';
    const { masked, tagMap } = maskHtmlTags(original);
    expect(masked).toBe("Select ⟦TAG_0⟧ to proceed");
    expect(tagMap.get("⟦TAG_0⟧")).toBe('<img src="https://example.com/icon.png" alt="icon" className="emoji" style={{display:"inline"}} />');

    const restored = unmaskHtmlTags(masked, tagMap);
    expect(restored).toBe(original);
  });

  it("handles loose formatting variations from LLM output", () => {
    const originalTag = '<img src="https://example.com/icon.png" alt="icon" />';
    const tagMap = new Map([["⟦TAG_0⟧", originalTag]]);

    // Spaced bracket
    expect(unmaskHtmlTags("Selecione ⟦ TAG_0 ⟧ para prosseguir", tagMap)).toBe(
      'Selecione <img src="https://example.com/icon.png" alt="icon" /> para prosseguir',
    );

    // Single square bracket
    expect(unmaskHtmlTags("Selecione [TAG_0] para prosseguir", tagMap)).toBe(
      'Selecione <img src="https://example.com/icon.png" alt="icon" /> para prosseguir',
    );
  });
});
