import { describe, it, expect, vi } from "vitest";
import type { NotionBlockList } from "./notion-converter.js";
import type { PageMetadata } from "../schemas/metadata.js";
import { AITranslator } from "./ai-translator.js";
import { loadGlossary } from "./glossary.js";
import { translatePageContent } from "./page-translator.js";
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
});
