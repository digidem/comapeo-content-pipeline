import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FilesystemStorage,
  writePageArtifacts,
  writeManifest,
  readManifest,
  R2_PATHS,
} from "./r2.js";
import { SCHEMA_SQL } from "./d1.js";

describe("FilesystemStorage", () => {
  let storage: FilesystemStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pipeline-test-"));
    storage = new FilesystemStorage(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads a key", async () => {
    await storage.put("test.json", '{"hello":"world"}', "application/json");
    const result = await storage.get("test.json");
    expect(result).toBe('{"hello":"world"}');
  });

  it("returns null for missing key", async () => {
    const result = await storage.get("nonexistent.json");
    expect(result).toBeNull();
  });

  it("deletes a key", async () => {
    await storage.put("delete-me.txt", "content");
    await storage.delete("delete-me.txt");
    const result = await storage.get("delete-me.txt");
    expect(result).toBeNull();
  });

  it("lists keys by prefix", async () => {
    await storage.put("docs/en/a.md", "a");
    await storage.put("docs/en/b.md", "b");
    await storage.put("docs/pt/a.md", "pt");

    const enDocs = await storage.list("docs/en/");
    expect(enDocs).toHaveLength(2);
    expect(enDocs.map((e) => e.key).sort()).toEqual([
      "docs/en/a.md",
      "docs/en/b.md",
    ]);
  });
});

describe("writePageArtifacts", () => {
  let storage: FilesystemStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pipeline-test-"));
    storage = new FilesystemStorage(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes all artifact files", async () => {
    const metadata = {
      page_id: "test123",
      title: "Test Page",
      slug: "test-page",
      locale: "en",
      section: null,
    };

    await writePageArtifacts(
      storage,
      "test123",
      metadata,
      "---\ntitle: Test\n---\n\n# Hello",
      { raw: "page-data" },
      { blocks: [] },
    );

    // Verify all 4 files exist
    const md = await storage.get("pages/test123/metadata.json");
    const doc = await storage.get("docs/en/docs/test-page.md");
    const rawPage = await storage.get("pages/test123/raw-page.json");
    const rawBlocks = await storage.get("pages/test123/raw-blocks.json");

    expect(md).toBeTruthy();
    expect(doc).toBeTruthy();
    expect(rawPage).toBeTruthy();
    expect(rawBlocks).toBeTruthy();
  });
});

describe("writeManifest / readManifest", () => {
  let storage: FilesystemStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pipeline-test-"));
    storage = new FilesystemStorage(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a manifest", async () => {
    const manifest = { schema_version: "1.0", docs: [{ title: "Test" }] };
    await writeManifest(storage, manifest);

    const read = await readManifest(storage);
    expect(read).toBeTruthy();
    expect(read?.docs).toHaveLength(1);
  });
});

describe("SCHEMA_SQL", () => {
  it("contains all 4 tables", () => {
    expect(SCHEMA_SQL).toContain("source_pages");
    expect(SCHEMA_SQL).toContain("sync_jobs");
    expect(SCHEMA_SQL).toContain("sync_state");
    expect(SCHEMA_SQL).toContain("emitted_artifacts");
  });

  it("contains required indexes", () => {
    expect(SCHEMA_SQL).toContain("idx_source_pages_status");
    expect(SCHEMA_SQL).toContain("idx_source_pages_locale");
    expect(SCHEMA_SQL).toContain("idx_source_pages_last_edited");
    expect(SCHEMA_SQL).toContain("idx_sync_jobs_status");
  });
});

describe("R2_PATHS", () => {
  it("generates correct manifest path", () => {
    expect(R2_PATHS.manifest).toBe("manifests/latest.json");
  });

  it("generates correct doc path", () => {
    const path = R2_PATHS.doc("en", "basics", "intro");
    expect(path).toBe("docs/en/docs/basics/intro.md");
  });

  it("generates correct metadata path", () => {
    expect(R2_PATHS.metadata("abc")).toBe("pages/abc/metadata.json");
  });
});
