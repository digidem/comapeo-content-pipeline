import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  markPublished,
  resolveManifestPath,
  MarkPublishedError,
  type StatusUpdateClient,
} from "./mark-published.js";
import type { ContentManifest } from "../schemas/manifest.js";

function createMockManifest(docs: Array<{
  page_id: string;
  title: string;
  locale: string;
  drafting_status?: string | null;
}>): ContentManifest {
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    source: {
      type: "notion",
      database_id: "test-db",
      data_source_id: "test-ds",
    },
    docs: docs.map((d, index) => ({
      page_id: d.page_id,
      title: d.title,
      locale: d.locale,
      section: "test-section",
      section_order: index,
      element_type: "Page",
      drafting_status: d.drafting_status ?? null,
      slug: `slug-${d.page_id}`,
      docusaurus_id: `test-section/slug-${d.page_id}`,
      docusaurus_path: `/slug-${d.page_id}`,
      r2_doc_key: `docs/${d.locale}/test-section/slug-${d.page_id}.md`,
      r2_metadata_key: `pages/${d.page_id}/metadata.json`,
      source_url: `https://notion.so/${d.page_id}`,
      notion_last_edited_time: "2026-09-17T00:00:00.000Z",
      content_hash: "sha256:test",
      status: "draft",
    })),
    sidebars: {
      en: [],
      es: [],
      pt: [],
    },
  };
}

describe("resolveManifestPath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mark-pub-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns explicit manifestPath if provided", () => {
    const custom = join(tempDir, "custom.json");
    expect(resolveManifestPath({ manifestPath: custom })).toBe(custom);
  });

  it("resolves default manifest.json under outDir", () => {
    expect(resolveManifestPath({ outDir: tempDir })).toBe(join(tempDir, "manifest.json"));
  });

  it("resolves versioned manifest if it exists", () => {
    const versioned = join(tempDir, "manifest-20260918.json");
    writeFileSync(versioned, "{}");
    expect(resolveManifestPath({ manifestVersion: "20260918", outDir: tempDir })).toBe(versioned);
  });

  it("throws MarkPublishedError when manifestVersion is supplied but does not exist", () => {
    expect(() =>
      resolveManifestPath({ manifestVersion: "missing-version-999", outDir: tempDir }),
    ).toThrow(MarkPublishedError);
  });
});

describe("markPublished", () => {
  let tempDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mark-pub-test-"));
    manifestPath = join(tempDir, "manifest.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws MarkPublishedError when manifest does not exist", async () => {
    await expect(
      markPublished({ manifestPath: join(tempDir, "nonexistent.json") }),
    ).rejects.toThrow(MarkPublishedError);
  });

  it("throws MarkPublishedError when manifest fails schema validation", async () => {
    writeFileSync(manifestPath, JSON.stringify({ docs: [{ badField: true }] }), "utf-8");
    await expect(
      markPublished({ manifestPath, outDir: tempDir }),
    ).rejects.toThrow(MarkPublishedError);
  });

  it("defaults to dry-run mode and makes 0 write calls", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Page 1", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "Page 2", locale: "en", drafting_status: "Draft published" },
      { page_id: "p3", title: "Page 3", locale: "en", drafting_status: "Published" },
      { page_id: "p4", title: "Page 4", locale: "en", drafting_status: "In review" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const mockClient: StatusUpdateClient = {
      updatePageStatus: vi.fn(),
    };

    const result = await markPublished(
      { manifestPath, outDir: tempDir },
      { client: mockClient },
    );

    expect(result.dryRun).toBe(true);
    expect(result.totalManifestDocs).toBe(4);
    expect(result.targetedDocs).toBe(2);
    expect(result.updatedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.targets).toHaveLength(2);
    expect(result.targets.map((t) => t.pageId)).toEqual(["p1", "p2"]);
    expect(mockClient.updatePageStatus).not.toHaveBeenCalled();
  });

  it("filters by locale and limit in dry-run mode", async () => {
    const manifest = createMockManifest([
      { page_id: "en1", title: "EN 1", locale: "en", drafting_status: "Draft published" },
      { page_id: "es1", title: "ES 1", locale: "es", drafting_status: "Draft published" },
      { page_id: "es2", title: "ES 2", locale: "es", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const result = await markPublished({
      manifestPath,
      outDir: tempDir,
      locale: "es",
      limit: 1,
    });

    expect(result.targetedDocs).toBe(1);
    expect(result.targets[0].pageId).toBe("es1");
  });

  it("executes live writes when live: true and saves rollback log incrementally", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Intro", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "Guide", locale: "es", drafting_status: "Draft published" },
      { page_id: "p3", title: "Already live", locale: "pt", drafting_status: "Published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi.fn().mockResolvedValue({});
    const getPageMock = vi.fn().mockResolvedValue({
      id: "p1",
      properties: {
        "Publish Status": { select: { name: "Draft published" } },
      },
    });

    const mockClient: StatusUpdateClient = {
      updatePageStatus: updatePageStatusMock,
      getPage: getPageMock,
    };

    const result = await markPublished(
      {
        manifestPath,
        outDir: tempDir,
        live: true,
        publishedDate: "2026-09-18",
      },
      { client: mockClient },
    );

    expect(result.dryRun).toBe(false);
    expect(result.targetedDocs).toBe(2);
    expect(result.updatedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(updatePageStatusMock).toHaveBeenCalledTimes(2);

    expect(updatePageStatusMock).toHaveBeenCalledWith("p1", "Published", {
      setPublishedDate: true,
      publishedDate: "2026-09-18",
    });
    expect(updatePageStatusMock).toHaveBeenCalledWith("p2", "Published", {
      setPublishedDate: true,
      publishedDate: "2026-09-18",
    });

    // Check rollback log file
    expect(result.rollbackPath).toBeDefined();
    expect(existsSync(result.rollbackPath!)).toBe(true);

    const rollbackContent = JSON.parse(readFileSync(result.rollbackPath!, "utf-8"));
    expect(rollbackContent.operation).toBe("Draft published-to-Published");
    expect(rollbackContent.total_updated).toBe(2);
    expect(rollbackContent.entries).toHaveLength(2);
    expect(rollbackContent.entries[0]).toEqual(
      expect.objectContaining({
        page_id: "p1",
        title: "Intro",
        original_status: "Draft published",
        new_status: "Published",
      }),
    );
  });

  it("skips pages whose live Notion status has changed from fromStatus", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Stale Page", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "Valid Page", locale: "en", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi.fn().mockResolvedValue({});
    const getPageMock = vi.fn().mockImplementation(async (pageId: string) => {
      if (pageId === "p1") {
        return {
          id: "p1",
          properties: {
            "Publish Status": { select: { name: "Remove" } }, // Changed by editor!
          },
        };
      }
      return {
        id: "p2",
        properties: {
          "Publish Status": { select: { name: "Draft published" } },
        },
      };
    });

    const mockClient: StatusUpdateClient = {
      updatePageStatus: updatePageStatusMock,
      getPage: getPageMock,
    };

    const result = await markPublished(
      {
        manifestPath,
        outDir: tempDir,
        live: true,
      },
      { client: mockClient },
    );

    expect(result.targetedDocs).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.updatedCount).toBe(1);
    expect(updatePageStatusMock).toHaveBeenCalledTimes(1);
    expect(updatePageStatusMock).toHaveBeenCalledWith("p2", "Published", expect.any(Object));
  });

  it("bypasses live status check when force: true is specified", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Forced Page", locale: "en", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi.fn().mockResolvedValue({});
    const getPageMock = vi.fn().mockResolvedValue({
      id: "p1",
      properties: {
        "Publish Status": { select: { name: "Remove" } },
      },
    });

    const mockClient: StatusUpdateClient = {
      updatePageStatus: updatePageStatusMock,
      getPage: getPageMock,
    };

    const result = await markPublished(
      {
        manifestPath,
        outDir: tempDir,
        live: true,
        force: true,
      },
      { client: mockClient },
    );

    expect(getPageMock).not.toHaveBeenCalled();
    expect(result.updatedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(updatePageStatusMock).toHaveBeenCalledWith("p1", "Published", expect.any(Object));
  });

  it("handles non-blocking errors and persists rollback incrementally for successful updates", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Succeeding Page", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "Failing Page", locale: "en", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Notion 500 error"));

    const mockClient: StatusUpdateClient = {
      updatePageStatus: updatePageStatusMock,
    };

    const result = await markPublished(
      {
        manifestPath,
        outDir: tempDir,
        live: true,
      },
      { client: mockClient },
    );

    expect(result.targetedDocs).toBe(2);
    expect(result.updatedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      pageId: "p2",
      title: "Failing Page",
      error: "Notion 500 error",
    });

    // Rollback log should be flushed on disk with the 1 successful update
    expect(result.rollbackPath).toBeDefined();
    const rollbackContent = JSON.parse(readFileSync(result.rollbackPath!, "utf-8"));
    expect(rollbackContent.total_updated).toBe(1);
    expect(rollbackContent.entries[0].page_id).toBe("p1");
  });

  it("respects custom fromStatus and toStatus and setPublishedDate: false", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Custom Page", locale: "en", drafting_status: "Ready to publish" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi.fn().mockResolvedValue({});
    const mockClient: StatusUpdateClient = {
      updatePageStatus: updatePageStatusMock,
    };

    const result = await markPublished(
      {
        manifestPath,
        outDir: tempDir,
        live: true,
        fromStatus: "Ready to publish",
        toStatus: "Draft published",
        setPublishedDate: false,
      },
      { client: mockClient },
    );

    expect(result.updatedCount).toBe(1);
    expect(updatePageStatusMock).toHaveBeenCalledWith("p1", "Draft published", {
      setPublishedDate: false,
      publishedDate: undefined,
    });
  });
});
