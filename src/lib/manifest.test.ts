import { describe, it, expect } from "vitest";
import { generateManifest, generateSidebarJson, buildManifestFromStorage } from "./manifest.js";
import type { ManifestStorage } from "./manifest.js";
import type { PageMetadata } from "../schemas/metadata.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../test/fixtures");

const basePage: PageMetadata = {
  page_id: "abc123",
  title: "Getting Started",
  source_url: "https://notion.so/abc123",
  notion_last_edited_time: "2026-04-23T04:19:00.000Z",
  content_hash: "sha256:abc",
  raw_hash: "sha256:def",
  locale: "en",
  section: "basics",
  section_order: 1,
  slug: "getting-started",
  docusaurus_id: "basics/getting-started",
  status: "active",
  properties: {},
  assets: [],
};

describe("generateManifest", () => {
  it("generates manifest from page list", () => {
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage],
    });

    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.source.database_id).toBe("db1");
    expect(manifest.docs).toHaveLength(1);
    expect(manifest.docs[0].page_id).toBe("abc123");
    expect(manifest.docs[0].slug).toBe("getting-started");
    expect(manifest.docs[0].r2_doc_key).toBe("docs/en/docs/basics/getting-started.md");
    expect(manifest.sidebars).toBeDefined();
  });

  it("includes rag reference when provided", () => {
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage],
      ragChunksManifestKey: "rag/chunks-manifest.json",
    });

    expect(manifest.rag?.chunks_manifest_key).toBe("rag/chunks-manifest.json");
  });

  it("filters non-active pages from sidebar defaults", () => {
    const draftPage: PageMetadata = { ...basePage, page_id: "draft1", status: "draft" };
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage, draftPage],
    });

    // Both appear in docs array
    expect(manifest.docs).toHaveLength(2);

    // But sidebar only contains active
    const enSidebar = manifest.sidebars.en;
    const sidebarIds = JSON.stringify(enSidebar);
    expect(sidebarIds).toContain("basics/getting-started");
    expect(sidebarIds).not.toContain("draft1");
  });

  it("generates correct R2 keys", () => {
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage],
    });

    expect(manifest.docs[0].r2_doc_key).toBe("docs/en/docs/basics/getting-started.md");
    expect(manifest.docs[0].r2_metadata_key).toBe("pages/abc123/metadata.json");
  });

  it("produces Docusaurus sidebar format", () => {
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage],
    });

    const sidebar = manifest.sidebars.en;
    expect(sidebar).toHaveLength(1);
    expect(sidebar[0]).toEqual({
      type: "category",
      label: "basics",
      items: ["basics/getting-started"],
    });
  });
});

// ── Golden fixture (spec §15.2) ──

describe("generateManifest — golden fixture", () => {
  it("deep-equals test/fixtures/expected/manifest.json", () => {
    // Deterministic input: 3 hand-written PageMetadata (EN sectioned, ES
    // translation, EN unsectioned). properties carry the raw Notion property
    // objects for Element Type / Publish Status, but the manifest must read the
    // extracted top-level element_type / drafting_status fields.
    const pages = JSON.parse(
      readFileSync(join(fixturesDir, "golden", "golden-pages.json"), "utf8"),
    ) as PageMetadata[];

    const manifest = generateManifest({
      databaseId: "db-golden",
      dataSourceId: "ds-golden",
      pages,
    });

    // generated_at is the only volatile field — normalize to a literal.
    (manifest as { generated_at: string }).generated_at = "<GENERATED_AT>";

    const expected = JSON.parse(
      readFileSync(join(fixturesDir, "expected", "manifest.json"), "utf8"),
    );

    // Round-trip both sides through JSON so key order / undefined handling is
    // identical, then deep-equal against the frozen golden file.
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(expected);
  });
});

describe("generateSidebarJson", () => {
  it("groups pages by section into categories", () => {
    const pages: PageMetadata[] = [
      { ...basePage, docusaurus_id: "intro", section: null, section_order: 0 },
      { ...basePage, docusaurus_id: "install", section: "Getting Started", section_order: 1 },
      { ...basePage, docusaurus_id: "account", section: "Getting Started", section_order: 2 },
      { ...basePage, docusaurus_id: "advanced", section: "Advanced", section_order: 10 },
    ];

    const sidebar = generateSidebarJson(pages);

    // "Getting Started" (min order 1) comes before "Advanced" (min order 10)
    expect(sidebar).toHaveLength(3);
    expect(sidebar[0]).toEqual({
      type: "category",
      label: "Getting Started",
      items: ["install", "account"],
    });
    expect(sidebar[1]).toEqual({
      type: "category",
      label: "Advanced",
      items: ["advanced"],
    });
    // Uncategorized at the end
    expect(sidebar[2]).toBe("intro");
  });

  it("returns empty array for no active pages", () => {
    const pages: PageMetadata[] = [
      { ...basePage, status: "draft" },
    ];
    expect(generateSidebarJson(pages)).toEqual([]);
  });

  it("handles all uncategorized pages", () => {
    const pages: PageMetadata[] = [
      { ...basePage, docusaurus_id: "doc-a", section: null, section_order: 2 },
      { ...basePage, docusaurus_id: "doc-b", section: null, section_order: 1 },
    ];

    const sidebar = generateSidebarJson(pages);
    expect(sidebar).toEqual(["doc-b", "doc-a"]);
  });
});

// ── buildManifestFromStorage ──

/** In-memory ManifestStorage stub backed by a key→body map. */
function memStorage(entries: Record<string, string>): ManifestStorage {
  const map = new Map(Object.entries(entries));
  return {
    get: async (key) => map.get(key) ?? null,
    list: async (prefix) =>
      [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, size: v.length })),
  };
}

describe("buildManifestFromStorage", () => {
  it("builds manifest from valid blobs, skips corrupt ones, populates required doc fields", async () => {
    const one: PageMetadata = {
      ...basePage,
      page_id: "p1",
      slug: "page-one",
      section: "intro",
      section_order: 1,
      status: "active",
      element_type: "page",
      drafting_status: "Draft published",
      // Raw Notion property objects, as sync actually stores them — the manifest
      // must read the extracted top-level fields above, never these (regression:
      // casting these to string shipped objects inside element_type).
      properties: {
        "Element Type": { id: "nqRr", type: "select", select: { name: "Page" } },
        "Publish Status": { id: "BQMv", type: "select", select: { name: "Draft published" } },
      },
      sub_items: ["p2"],
    };
    const two: PageMetadata = {
      ...basePage,
      page_id: "p2",
      slug: "page-two",
      section: null,
      section_order: null,
      status: "active",
    };

    const storage = memStorage({
      "pages/p1/metadata.json": JSON.stringify(one),
      "pages/p2/metadata.json": JSON.stringify(two),
      "pages/p3/metadata.json": "{not valid json",
      // Non-metadata blobs under pages/ must be ignored by the filter.
      "pages/p1/raw-page.json": "{}",
      "pages/p1/raw-blocks.json": "[]",
    });

    const { manifest, skipped } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    expect(manifest.docs).toHaveLength(2);

    const d1 = manifest.docs.find((d) => d.page_id === "p1");
    expect(d1).toBeDefined();
    // Required fields that D1 rows omit — now sourced from the metadata blobs.
    expect(d1!.element_type).toBe("page");
    expect(d1!.drafting_status).toBe("Draft published");
    expect(d1!.sub_items).toEqual(["p2"]);

    // sidebars must be populated (not {}), built from the active pages.
    expect(Object.keys(manifest.sidebars)).toContain("en");
    expect(manifest.sidebars.en.length).toBeGreaterThan(0);

    expect(skipped).toEqual(["pages/p3/metadata.json"]);
  });

  it("skips blobs that fail PageMetadataSchema validation", async () => {
    const valid: PageMetadata = { ...basePage, page_id: "p1", status: "active" };
    // Missing required fields (no content_hash, no status) → schema rejects.
    const invalid = { page_id: "p2", title: "No hash" };

    const storage = memStorage({
      "pages/p1/metadata.json": JSON.stringify(valid),
      "pages/p2/metadata.json": JSON.stringify(invalid),
    });

    const { manifest, skipped } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    expect(manifest.docs).toHaveLength(1);
    expect(manifest.docs[0].page_id).toBe("p1");
    expect(skipped).toEqual(["pages/p2/metadata.json"]);
  });

  it("returns an empty doc set when no metadata blobs exist", async () => {
    const storage = memStorage({});
    const { manifest, skipped } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });
    expect(manifest.docs).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
