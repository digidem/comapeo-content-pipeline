import { describe, it, expect } from "vitest";
import { generateManifest, generateSidebarJson } from "./manifest.js";
import type { PageMetadata } from "../schemas/metadata.js";

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
