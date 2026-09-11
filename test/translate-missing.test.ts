import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyReferencedAssets, updateManifestWithDoc } from "../scripts/translate-missing.js";
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
});
