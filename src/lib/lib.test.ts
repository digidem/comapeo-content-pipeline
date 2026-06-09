import { describe, it, expect } from "vitest";
import {
  slugify,
  generateSlug,
  slugToDocusaurusId,
  mapStatus,
  contentHash,
  hashJSON,
  hashesEqual,
  contentChanged,
  buildFrontmatter,
  serializeDoc,
  parseDoc,
} from "./index.js";

// ── slug ──

describe("slugify", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(slugify("Getting Started")).toBe("getting-started");
  });

  it("removes accents", () => {
    expect(slugify("Instalação do CoMapeo")).toBe("instalacao-do-comapeo");
  });

  it("handles special characters", () => {
    expect(slugify("Hello! @#$%^&*() World")).toBe("hello-world");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("collapses multiple dashes", () => {
    expect(slugify("a---b")).toBe("a-b");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("--hello--")).toBe("hello");
  });
});

describe("generateSlug", () => {
  it("returns base slug when no collision", () => {
    expect(generateSlug("Test", "page-123")).toBe("test");
  });

  it("appends page ID suffix on collision", () => {
    const used = new Set<string>(["test"]);
    const result = generateSlug("Test", "abcdef1234567890", used);
    expect(result).toBe("test-abcdef12");
  });

  it("tracks unique slugs across calls via shared set", () => {
    const used = new Set<string>();
    expect(generateSlug("Test", "id1", used)).toBe("test");
    expect(generateSlug("Test", "id2", used)).toBe("test-" + "id2".replace(/-/g, "").slice(0, 8));
  });
});

describe("slugToDocusaurusId", () => {
  it("returns slug directly when no section", () => {
    expect(slugToDocusaurusId("intro", null)).toBe("intro");
  });

  it("prepends section", () => {
    expect(slugToDocusaurusId("intro", "basics")).toBe("basics/intro");
  });
});

// ── status ──

describe("mapStatus", () => {
  it('maps "EN Done" → active', () => {
    expect(mapStatus("EN Done")).toBe("active");
  });

  it('maps "PT Done" → active', () => {
    expect(mapStatus("PT Done")).toBe("active");
  });

  it('maps "ES Done" → active', () => {
    expect(mapStatus("ES Done")).toBe("active");
  });

  it('maps "Translations Validated" → active', () => {
    expect(mapStatus("Translations Validated")).toBe("active");
  });

  it('maps "Pre-publish done" → active', () => {
    expect(mapStatus("Pre-publish done")).toBe("active");
  });

  it('maps "Not started" → draft', () => {
    expect(mapStatus("Not started")).toBe("draft");
  });

  it('maps "Editing in progress" → draft', () => {
    expect(mapStatus("Editing in progress")).toBe("draft");
  });

  it('maps "Ready for review" → draft', () => {
    expect(mapStatus("Ready for review")).toBe("draft");
  });

  it('maps "Ready for copy edit" → draft', () => {
    expect(mapStatus("Ready for copy edit")).toBe("draft");
  });

  it('maps "X - Depreciated" → deprecated', () => {
    expect(mapStatus("X - Depreciated")).toBe("deprecated");
  });

  it('maps "deprecated" → deprecated', () => {
    expect(mapStatus("deprecated")).toBe("deprecated");
  });

  it('maps "archived" → deprecated', () => {
    expect(mapStatus("archived")).toBe("deprecated");
  });

  it('maps "Deleted" → archived', () => {
    expect(mapStatus("Deleted")).toBe("archived");
  });

  it("defaults null/undefined to draft", () => {
    expect(mapStatus(null)).toBe("draft");
    expect(mapStatus(undefined)).toBe("draft");
    expect(mapStatus("")).toBe("draft");
  });
});

// ── hash ──

describe("contentHash", () => {
  it("produces deterministic prefixed hash", () => {
    const h = contentHash("hello");
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("same input → same hash", () => {
    expect(contentHash("test")).toBe(contentHash("test"));
  });

  it("different input → different hash", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});

describe("hashJSON", () => {
  it("produces same hash for key-reordered objects", () => {
    const a = hashJSON({ b: 2, a: 1 });
    const b_ordered = hashJSON({ a: 1, b: 2 });
    expect(a).toBe(b_ordered);
  });
});

describe("contentChanged", () => {
  it("returns true when previous is null", () => {
    expect(contentChanged(null, "sha256:abc")).toBe(true);
  });

  it("returns true when hashes differ", () => {
    expect(contentChanged("sha256:abc", "sha256:def")).toBe(true);
  });

  it("returns false when hashes match", () => {
    expect(contentChanged("sha256:abc", "sha256:abc")).toBe(false);
  });
});

describe("hashesEqual", () => {
  it("compares hashes", () => {
    expect(hashesEqual("abc", "abc")).toBe(true);
    expect(hashesEqual("abc", "def")).toBe(false);
  });
});

// ── frontmatter ──

describe("buildFrontmatter", () => {
  const baseMeta = {
    page_id: "abc123",
    title: "Getting Started",
    slug: "getting-started",
    locale: "en",
    status: "active" as const,
    content_hash: "sha256:abc",
    notion_last_edited_time: "2026-04-23T04:19:00.000Z",
    section: null,
    section_order: null,
  };

  it("builds frontmatter from metadata", () => {
    const fm = buildFrontmatter(baseMeta);
    expect(fm.source).toBe("notion");
    expect(fm.slug).toBe("/getting-started");
    expect(fm.notion_page_id).toBe("abc123");
    expect(fm.sidebar_position).toBeUndefined();
  });

  it("includes sidebar_position when section_order is set", () => {
    const fm = buildFrontmatter({ ...baseMeta, section_order: 10 });
    expect(fm.sidebar_position).toBe(10);
  });

  it("uses section/slug for id when section present", () => {
    const fm = buildFrontmatter({
      ...baseMeta,
      section: "basics",
      section_order: 5,
    });
    expect(fm.id).toBe("basics/getting-started");
    expect(fm.section).toBe("basics");
  });
});

describe("serializeDoc / parseDoc", () => {
  it("round-trips frontmatter + body", () => {
    const fm = buildFrontmatter({
      page_id: "abc",
      title: "Test",
      slug: "test",
      locale: "en",
      status: "active",
      content_hash: "sha256:abc",
      notion_last_edited_time: "2026-01-01T00:00:00.000Z",
      section: null,
      section_order: null,
    });

    const body = "## Hello\n\nThis is a test.";
    const serialized = serializeDoc(fm, body);
    const parsed = parseDoc(serialized);

    expect(parsed.frontmatter.id).toBe("test");
    expect(parsed.frontmatter.slug).toBe("/test");
    expect(parsed.body.trim()).toBe(body);
  });
});
