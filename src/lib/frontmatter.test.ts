import { describe, it, expect } from "vitest";
import { buildFrontmatter } from "./frontmatter.js";

function baseMetadata(overrides: Record<string, unknown> = {}): Parameters<typeof buildFrontmatter>[0] {
  return {
    page_id: "abc12345-6789-0123-4567-89abcdef0123",
    title: "Welcome",
    slug: "welcome",
    locale: "en",
    status: "active",
    content_hash: "hash123",
    notion_last_edited_time: "2026-05-25T15:49:00.000Z",
    section: "10 - Tutorials",
    section_order: 1,
    keywords: [],
    tags: [],
    icon: undefined,
    published_date: "2026-05-25",
    ...overrides,
  } as Parameters<typeof buildFrontmatter>[0];
}

describe("buildFrontmatter", () => {
  describe("custom_edit_url", () => {
    it("points at the Notion source page with dashes stripped", () => {
      const fm = buildFrontmatter(baseMetadata());
      expect(fm.custom_edit_url).toBe(
        "https://www.notion.so/abc1234567890123456789abcdef0123",
      );
    });

    it("is omitted when page id is empty", () => {
      const fm = buildFrontmatter(baseMetadata({ page_id: "" }));
      expect(fm.custom_edit_url).toBeUndefined();
    });

    it("is omitted when page id is absent", () => {
      const fm = buildFrontmatter(baseMetadata({ page_id: undefined }));
      expect(fm.custom_edit_url).toBeUndefined();
    });

    it("handles an already dashless page id", () => {
      const fm = buildFrontmatter(
        baseMetadata({ page_id: "abc1234567890123456789abcdef0123" }),
      );
      expect(fm.custom_edit_url).toBe(
        "https://www.notion.so/abc1234567890123456789abcdef0123",
      );
    });
  });
});
