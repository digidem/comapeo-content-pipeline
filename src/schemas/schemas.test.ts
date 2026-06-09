import { describe, it, expect } from "vitest";
import {
  ContentManifestSchema,
  ManifestDocSchema,
  PageMetadataSchema,
  RagChunkSchema,
  RagChunksManifestSchema,
} from "./index.js";

describe("ManifestDocSchema", () => {
  const validDoc = {
    page_id: "abc123",
    title: "Getting Started",
    locale: "en",
    section: "basics",
    section_order: 1,
    element_type: "Page",
    drafting_status: "EN Done",
    slug: "getting-started",
    docusaurus_id: "getting-started",
    docusaurus_path: "/docs/getting-started",
    r2_doc_key: "docs/en/docs/getting-started.md",
    r2_metadata_key: "pages/abc123/metadata.json",
    source_url: "https://notion.so/abc123",
    notion_last_edited_time: "2026-04-23T04:19:00.000Z",
    content_hash: "sha256:abc",
    status: "active" as const,
  };

  it("accepts a valid manifest doc", () => {
    expect(() => ManifestDocSchema.parse(validDoc)).not.toThrow();
  });

  it("rejects invalid status", () => {
    expect(() =>
      ManifestDocSchema.parse({ ...validDoc, status: "unknown" })
    ).toThrow();
  });

  it("accepts null section", () => {
    expect(() =>
      ManifestDocSchema.parse({ ...validDoc, section: null, section_order: null })
    ).not.toThrow();
  });
});

describe("ContentManifestSchema", () => {
  it("validates a minimal manifest", () => {
    const manifest = {
      schema_version: "1.0" as const,
      generated_at: new Date().toISOString(),
      source: {
        type: "notion" as const,
        database_id: "db1",
        data_source_id: "ds1",
      },
      docs: [],
      sidebars: {},
    };
    expect(() => ContentManifestSchema.parse(manifest)).not.toThrow();
  });

  it("validates manifest with optional rag field", () => {
    const manifest = {
      schema_version: "1.0" as const,
      generated_at: new Date().toISOString(),
      source: { type: "notion" as const, database_id: "db1", data_source_id: "ds1" },
      docs: [],
      sidebars: {},
      rag: { chunks_manifest_key: "rag/chunks-manifest.json" },
    };
    expect(() => ContentManifestSchema.parse(manifest)).not.toThrow();
  });

  it("rejects wrong schema_version", () => {
    expect(() =>
      ContentManifestSchema.parse({
        schema_version: "2.0",
        generated_at: new Date().toISOString(),
        source: { type: "notion", database_id: "db1", data_source_id: "ds1" },
        docs: [],
        sidebars: {},
      })
    ).toThrow();
  });
});

describe("PageMetadataSchema", () => {
  const validMetadata = {
    page_id: "abc123",
    title: "Test Page",
    source_url: "https://notion.so/abc123",
    notion_last_edited_time: "2026-04-23T04:19:00.000Z",
    content_hash: "sha256:abc",
    raw_hash: "sha256:def",
    locale: "en",
    section: "basics",
    section_order: 1,
    slug: "test-page",
    docusaurus_id: "test-page",
    status: "active" as const,
    properties: { tags: ["docs"] },
    assets: [],
  };

  it("accepts valid page metadata", () => {
    expect(() => PageMetadataSchema.parse(validMetadata)).not.toThrow();
  });

  it("accepts metadata with assets", () => {
    expect(() =>
      PageMetadataSchema.parse({
        ...validMetadata,
        assets: [
          {
            original_url: "https://notion.so/image.png",
            r2_key: "assets/abc123.png",
            sha256: "abc123",
            mime_type: "image/png",
          },
        ],
      })
    ).not.toThrow();
  });
});

describe("RagChunkSchema", () => {
  it("validates a RAG chunk", () => {
    const chunk = {
      chunk_id: "sha256:def456",
      page_id: "abc123",
      title: "Getting Started",
      locale: "en",
      slug: "getting-started",
      heading_path: ["Getting Started", "Installation"],
      text: "Step-by-step installation instructions...",
      source_url: "https://notion.so/abc123",
      docusaurus_path: "/docs/getting-started",
      content_hash: "sha256:abc",
      status: "active" as const,
    };
    expect(() => RagChunkSchema.parse(chunk)).not.toThrow();
  });

  it("rejects non-active status", () => {
    expect(() =>
      RagChunkSchema.parse({
        chunk_id: "id",
        page_id: "abc",
        title: "T",
        locale: "en",
        slug: "t",
        heading_path: [],
        text: "x",
        source_url: "url",
        docusaurus_path: "/t",
        content_hash: "h",
        status: "draft",
      })
    ).toThrow();
  });
});

describe("RagChunksManifestSchema", () => {
  it("validates a chunks manifest", () => {
    const manifest = {
      schema_version: "1.0" as const,
      generated_at: new Date().toISOString(),
      chunks: [],
    };
    expect(() => RagChunksManifestSchema.parse(manifest)).not.toThrow();
  });
});
