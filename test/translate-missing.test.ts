import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyReferencedAssets, updateManifestWithDoc, buildManifestDoc } from "../scripts/translate-missing.js";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("copyReferencedAssets", () => {
  const testDir = join(tmpdir(), "test-copy-assets-" + Date.now());
  const inputDir = join(testDir, "input");
  const assetsDir = join(inputDir, "assets");
  const outputDir = join(testDir, "output");

  beforeEach(() => {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "safe-image.png"), "image-content");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("skips asset keys attempting path traversal", () => {
    const writtenFiles: Record<string, string> = {};
    const mockWrite = vi.fn((filePath: string, content: Buffer | string) => {
      writtenFiles[filePath] = content.toString();
    });

    copyReferencedAssets(
      outputDir,
      inputDir,
      "section/doc.md",
      ["safe-image.png", "../../etc/passwd", "../evil.png", "sub/nested.png"],
      [
        { r2_key: "assets/safe-image.png", url: "https://example.com/1.png" },
        { r2_key: "assets/../../etc/shadow", url: "https://example.com/2.png" },
        { r2_key: "assets/../escaped.png", url: "https://example.com/3.png" },
        { r2_key: "assets/nested/deep.png", url: "https://example.com/4.png" },
      ],
      mockWrite,
    );

    // Only safe-image.png should be copied; all traversal keys should be rejected
    const writtenPaths = Object.keys(writtenFiles);
    for (const p of writtenPaths) {
      expect(p).not.toContain("etc");
      expect(p).not.toContain("escaped");
      expect(p).not.toContain("deep");
      expect(p).not.toContain("..");
    }
    expect(writtenPaths.some((p) => p.endsWith("safe-image.png"))).toBe(true);
  });
});

describe("manifest docusaurus_path contract", () => {
  const testDir = join(tmpdir(), "test-manifest-" + Date.now());

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("stores public document route instead of filesystem path", () => {
    mkdirSync(testDir, { recursive: true });
    const manifestPath = join(testDir, "manifest.json");

    const initialManifest = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      source: { type: "notion", database_id: "db", data_source_id: "ds" },
      docs: [
        {
          page_id: "en-1",
          title: "Introduction",
          locale: "en",
          section: "getting-started",
          slug: "introduction",
          docusaurus_path: "/introduction",
          status: "published",
        },
      ],
      sidebars: {},
    };
    writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2), "utf8");

    updateManifestWithDoc(
      manifestPath,
      {
        page_id: "es-1",
        title: "Introducción",
        locale: "es",
        section: "getting-started",
        slug: "introduccion",
        docusaurus_path: "/introduccion",
        docusaurus_id: "getting-started/introduccion",
        r2_doc_key: "docs/es/getting-started/introduccion.md",
        r2_metadata_key: "metadata/es-1.json",
        source_url: "https://notion.so/es-1",
        notion_last_edited_time: new Date().toISOString(),
        content_hash: "hash123",
        status: "draft",
        language_source: "automated",
      },
      "en-1",
      undefined,
      { inputDir: testDir },
    );

    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    const esDoc = updated.docs.find((d: { page_id: string }) => d.page_id === "es-1");
    expect(esDoc).toBeDefined();
    expect(esDoc.docusaurus_path).toBe("/introduccion");
    expect(esDoc.docusaurus_path).not.toContain("i18n");
    expect(esDoc.docusaurus_path).not.toContain(".md");
  });

  it("does not overwrite a doc in another section when slugs / docusaurus_paths match", () => {
    mkdirSync(testDir, { recursive: true });
    const manifestPath = join(testDir, "manifest.json");

    const initialManifest = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      source: { type: "notion", database_id: "db", data_source_id: "ds" },
      docs: [
        {
          page_id: "es-secA",
          title: "Overview Section A",
          locale: "es",
          section: "section-a",
          slug: "overview",
          docusaurus_path: "/overview",
          status: "published",
        },
        {
          page_id: "en-secB",
          title: "Overview Section B",
          locale: "en",
          section: "section-b",
          slug: "overview",
          docusaurus_path: "/overview",
          status: "published",
        },
      ],
      sidebars: {},
    };
    writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2), "utf8");

    updateManifestWithDoc(
      manifestPath,
      {
        page_id: "es-secB",
        title: "Overview Section B",
        locale: "es",
        section: "section-b",
        slug: "overview",
        docusaurus_path: "/overview",
        docusaurus_id: "section-b/overview",
        r2_doc_key: "docs/es/section-b/overview.md",
        r2_metadata_key: "metadata/es-secB.json",
        source_url: "https://notion.so/es-secB",
        notion_last_edited_time: new Date().toISOString(),
        content_hash: "hash456",
        status: "draft",
        language_source: "automated",
      },
      "en-secB",
      undefined,
      { inputDir: testDir },
    );

    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    const secADoc = updated.docs.find((d: { page_id: string }) => d.page_id === "es-secA");
    const secBDoc = updated.docs.find((d: { page_id: string }) => d.page_id === "es-secB");

    expect(secADoc).toBeDefined();
    expect(secADoc.section).toBe("section-a");
    expect(secBDoc).toBeDefined();
    expect(secBDoc.section).toBe("section-b");
    expect(updated.docs.filter((d: { locale: string }) => d.locale === "es")).toHaveLength(2);
  });

  it("rejects replacing explicit human translation when matched by section + slug + locale without exact page ID", () => {
    mkdirSync(testDir, { recursive: true });
    const manifestPath = join(testDir, "manifest.json");

    const initialManifest = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      source: { type: "notion", database_id: "db", data_source_id: "ds" },
      docs: [
        {
          page_id: "en-1",
          title: "Setup Guide",
          locale: "en",
          section: "setup",
          slug: "setup-guide",
          docusaurus_path: "/setup-guide",
          status: "published",
        },
        {
          page_id: "es-human-1",
          title: "Guía de Configuración (Humano)",
          locale: "es",
          section: "setup",
          slug: "setup-guide",
          docusaurus_path: "/setup-guide",
          status: "published",
          language_source: "explicit",
        },
      ],
      sidebars: {},
    };
    writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2), "utf8");

    // Attempt to update manifest with automated translation without supplying replacedPageId must throw
    expect(() =>
      updateManifestWithDoc(
        manifestPath,
        {
          page_id: "es-auto-new",
          title: "Guía de Configuración (Auto)",
          locale: "es",
          section: "setup",
          slug: "setup-guide",
          docusaurus_path: "/setup-guide",
          docusaurus_id: "setup/setup-guide",
          r2_doc_key: "docs/es/setup/setup-guide.md",
          r2_metadata_key: "metadata/es-auto-new.json",
          source_url: "https://notion.so/es-auto-new",
          notion_last_edited_time: new Date().toISOString(),
          content_hash: "hash-auto",
          status: "draft",
          language_source: "automated",
        },
        "en-1",
        undefined, // No replacedPageId supplied
        { inputDir: testDir },
      ),
    ).toThrow(/Cannot replace explicit human translation/);

    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Explicit human translation must NOT be overwritten
    const esHuman = updated.docs.find((d: { page_id: string }) => d.page_id === "es-human-1");
    expect(esHuman).toBeDefined();
    expect(esHuman.title).toBe("Guía de Configuración (Humano)");
    expect(esHuman.language_source).toBe("explicit");

    // Automated doc must not have been added as a duplicate conflicting entry
    const esAuto = updated.docs.find((d: { page_id: string }) => d.page_id === "es-auto-new");
    expect(esAuto).toBeUndefined();
  });

  it("permits replacing explicit human translation when caller explicitly supplies exact page ID as replacedPageId", () => {
    mkdirSync(testDir, { recursive: true });
    const manifestPath = join(testDir, "manifest.json");

    const initialManifest = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      source: { type: "notion", database_id: "db", data_source_id: "ds" },
      docs: [
        {
          page_id: "en-1",
          title: "Setup Guide",
          locale: "en",
          section: "setup",
          slug: "setup-guide",
          docusaurus_path: "/setup-guide",
          status: "published",
        },
        {
          page_id: "es-human-1",
          title: "Guía de Configuración (Humano)",
          locale: "es",
          section: "setup",
          slug: "setup-guide",
          docusaurus_path: "/setup-guide",
          status: "published",
          language_source: "explicit",
        },
      ],
      sidebars: {},
    };
    writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2), "utf8");

    // Caller explicitly supplies replacedPageId === "es-human-1"
    updateManifestWithDoc(
      manifestPath,
      {
        page_id: "es-replacement",
        title: "Guía de Configuración (Reemplazada)",
        locale: "es",
        section: "setup",
        slug: "setup-guide",
        docusaurus_path: "/setup-guide",
        docusaurus_id: "setup/setup-guide",
        r2_doc_key: "docs/es/setup/setup-guide.md",
        r2_metadata_key: "metadata/es-replacement.json",
        source_url: "https://notion.so/es-replacement",
        notion_last_edited_time: new Date().toISOString(),
        content_hash: "hash-replacement",
        status: "draft",
        language_source: "automated",
      },
      "en-1",
      "es-human-1", // Exact page ID supplied
      { inputDir: testDir },
    );

    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    const replaced = updated.docs.find((d: { page_id: string }) => d.page_id === "es-replacement");
    expect(replaced).toBeDefined();
    expect(replaced.title).toBe("Guía de Configuración (Reemplazada)");

    const oldHuman = updated.docs.find((d: { page_id: string }) => d.page_id === "es-human-1");
    expect(oldHuman).toBeUndefined();
  });

  it("permits replacing explicit human translation with synthetic ID when exact synthetic ID is supplied as replacedPageId", () => {
    mkdirSync(testDir, { recursive: true });
    const manifestPath = join(testDir, "manifest.json");

    const initialManifest = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      source: { type: "notion", database_id: "db", data_source_id: "ds" },
      docs: [
        {
          page_id: "en-1",
          title: "Setup Guide",
          locale: "en",
          section: "setup",
          slug: "setup-guide",
          docusaurus_path: "/setup-guide",
          status: "published",
        },
        {
          page_id: "en-1-es", // Synthetic page ID
          title: "Guía de Configuración (Sintética)",
          locale: "es",
          section: "setup",
          slug: "setup-guide",
          docusaurus_path: "/setup-guide",
          status: "published",
          language_source: "explicit",
        },
      ],
      sidebars: {},
    };
    writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2), "utf8");

    updateManifestWithDoc(
      manifestPath,
      {
        page_id: "es-new-page",
        title: "Guía de Configuración (Nueva)",
        locale: "es",
        section: "setup",
        slug: "setup-guide",
        docusaurus_path: "/setup-guide",
        docusaurus_id: "setup/setup-guide",
        r2_doc_key: "docs/es/setup/setup-guide.md",
        r2_metadata_key: "metadata/es-new-page.json",
        source_url: "https://notion.so/es-new-page",
        notion_last_edited_time: new Date().toISOString(),
        content_hash: "hash-new",
        status: "draft",
        language_source: "automated",
      },
      "en-1",
      "en-1-es", // Exact synthetic page ID passed via target.replaceablePageId
      { inputDir: testDir },
    );

    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    const replaced = updated.docs.find((d: { page_id: string }) => d.page_id === "es-new-page");
    expect(replaced).toBeDefined();
    expect(replaced.title).toBe("Guía de Configuración (Nueva)");

    const oldSynth = updated.docs.find((d: { page_id: string }) => d.page_id === "en-1-es");
    expect(oldSynth).toBeUndefined();
  });
});

describe("buildManifestDoc", () => {
  it("builds a valid manifest doc with canonical R2 keys and public docusaurus path", () => {
    const meta = {
      title: "Configuração do Projeto",
      page_id: "notion-123",
      source_url: "https://notion.so/notion123",
      notion_last_edited_time: "2026-06-01T12:00:00.000Z",
      content_hash: "hash-pt-123",
      raw_hash: "raw-pt-123",
      locale: "pt",
      section: "managing-projects",
      section_order: 2,
      slug: "project-configuration",
      docusaurus_id: "managing-projects/project-configuration",
      element_type: "Page",
      drafting_status: "automated translations generated",
      status: "active",
      properties: {},
      assets: [],
      keywords: [],
      tags: [],
      language_source: "automated",
    };

    const doc = buildManifestDoc("pt-page-123", meta as any, "pt");

    expect(doc).toEqual({
      page_id: "pt-page-123",
      title: "Configuração do Projeto",
      locale: "pt",
      section: "managing-projects",
      section_order: 2,
      element_type: "Page",
      drafting_status: "automated translations generated",
      slug: "project-configuration",
      docusaurus_id: "managing-projects/project-configuration",
      docusaurus_path: "/project-configuration",
      r2_doc_key: "docs/pt/docs/managing-projects/project-configuration.md",
      r2_metadata_key: "pages/pt-page-123/metadata.json",
      source_url: "https://notion.so/notion123",
      notion_last_edited_time: "2026-06-01T12:00:00.000Z",
      content_hash: "hash-pt-123",
      status: "draft",
      language_source: "automated",
    });
  });
});
