import { describe, it, expect } from "vitest";
import { generateManifest } from "./manifest.js";
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
    expect(enSidebar).toContain("basics/getting-started");
    expect(enSidebar).not.toContain("draft1");
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
});
