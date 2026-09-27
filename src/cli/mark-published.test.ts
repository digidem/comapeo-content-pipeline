import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  markPublished,
  cmdMarkPublished,
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
  element_type?: string | null;
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
      element_type: d.element_type ?? "Page",
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

  it("skips pages whose live Notion title has changed to match excludeTitle regex", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Original Title", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "Valid Page", locale: "en", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi.fn().mockResolvedValue({});
    const getPageMock = vi.fn().mockImplementation(async (pageId: string) => {
      if (pageId === "p1") {
        return {
          id: "p1",
          properties: {
            "Content elements": { title: [{ plain_text: "[PRUEBA] Renamed Scratchpad" }] },
            "Publish Status": { select: { name: "Draft published" } },
          },
        };
      }
      return {
        id: "p2",
        properties: {
          "Content elements": { title: [{ plain_text: "Valid Page" }] },
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
        excludeTitle: "^\\[(PRUEBA|TESTE)\\]",
      },
      { client: mockClient },
    );

    expect(result.targetedDocs).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.updatedCount).toBe(1);
    expect(updatePageStatusMock).toHaveBeenCalledTimes(1);
    expect(updatePageStatusMock).toHaveBeenCalledWith("p2", "Published", expect.any(Object));
  });

  it("skips pages whose live Notion title no longer matches filterTitle regex", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Official Guide", locale: "en", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi.fn().mockResolvedValue({});
    const getPageMock = vi.fn().mockResolvedValue({
      id: "p1",
      properties: {
        "Content elements": { title: [{ plain_text: "Renamed Something Else" }] },
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
        filterTitle: "guide",
      },
      { client: mockClient },
    );

    expect(result.targetedDocs).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.updatedCount).toBe(0);
    expect(updatePageStatusMock).not.toHaveBeenCalled();
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

  it("supports fromStatus: 'UNSET' to backfill pages with missing publish status", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Unset Page", locale: "en", drafting_status: null },
      { page_id: "p2", title: "Empty Page", locale: "en", drafting_status: "" },
      { page_id: "p3", title: "Set Page", locale: "en", drafting_status: "Published" },
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
        fromStatus: "UNSET",
        toStatus: "Draft published",
      },
      { client: mockClient },
    );

    expect(result.targetedDocs).toBe(2);
    expect(result.updatedCount).toBe(2);
    expect(updatePageStatusMock).toHaveBeenCalledWith("p1", "Draft published", expect.any(Object));
    expect(updatePageStatusMock).toHaveBeenCalledWith("p2", "Draft published", expect.any(Object));
    expect(updatePageStatusMock).not.toHaveBeenCalledWith("p3", expect.anything(), expect.anything());

    // Verify rollback log stores null as original_status and from_status, not literal "UNSET"
    expect(result.rollbackPath).toBeDefined();
    const rollbackContent = JSON.parse(readFileSync(result.rollbackPath!, "utf-8"));
    expect(rollbackContent.from_status).toBeNull();
    expect(rollbackContent.entries[0].original_status).toBeNull();
    expect(rollbackContent.entries[1].original_status).toBeNull();
  });

  it("skips pages when fromStatus is UNSET but live Notion status is already set", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Unset In Manifest", locale: "en", drafting_status: null },
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
        fromStatus: "UNSET",
        toStatus: "Draft published",
      },
      { client: mockClient },
    );

    expect(result.targetedDocs).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.updatedCount).toBe(0);
    expect(updatePageStatusMock).not.toHaveBeenCalled();
  });

  it("filters out non-content pages (Title, Toggle) from manifest", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Content Page", locale: "en", drafting_status: "Draft published", element_type: "Page" },
      { page_id: "p2", title: "Empty Type Page", locale: "en", drafting_status: "Draft published", element_type: "" },
      { page_id: "p3", title: "Section Header", locale: "en", drafting_status: "Draft published", element_type: "Title" },
      { page_id: "p4", title: "Collapsible Section", locale: "en", drafting_status: "Draft published", element_type: "Toggle" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const result = await markPublished({
      manifestPath,
      outDir: tempDir,
    });

    expect(result.targetedDocs).toBe(2);
    expect(result.targets.map((t) => t.pageId)).toEqual(["p1", "p2"]);
  });

  it("filters candidate docs by filterTitle regex", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Getting Started with Sync", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "Installation Guide", locale: "en", drafting_status: "Draft published" },
      { page_id: "p3", title: "Troubleshooting", locale: "en", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const result = await markPublished({
      manifestPath,
      outDir: tempDir,
      filterTitle: "guide",
    });

    expect(result.targetedDocs).toBe(1);
    expect(result.targets[0].title).toBe("Installation Guide");
  });

  it("excludes candidate docs by excludeTitle regex", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Official Documentation", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "[PRUEBA] Spanish Test", locale: "es", drafting_status: "Draft published" },
      { page_id: "p3", title: "[TESTE] Portuguese Scratch", locale: "pt", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const result = await markPublished({
      manifestPath,
      outDir: tempDir,
      excludeTitle: "^\\[(PRUEBA|TESTE)\\]",
    });

    expect(result.targetedDocs).toBe(1);
    expect(result.targets[0].title).toBe("Official Documentation");
  });

  it("combines filterTitle and excludeTitle correctly", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Setup Guide", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "Setup Guide [DRAFT]", locale: "en", drafting_status: "Draft published" },
      { page_id: "p3", title: "Reference Manual", locale: "en", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    const result = await markPublished({
      manifestPath,
      outDir: tempDir,
      filterTitle: "guide",
      excludeTitle: "\\[DRAFT\\]",
    });

    expect(result.targetedDocs).toBe(1);
    expect(result.targets[0].pageId).toBe("p1");
  });

  it("throws MarkPublishedError when invalid regex pattern is provided for title filters", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Sample", locale: "en", drafting_status: "Draft published" },
    ]);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    await expect(
      markPublished({
        manifestPath,
        outDir: tempDir,
        filterTitle: "[unclosed",
      }),
    ).rejects.toThrow(MarkPublishedError);

    await expect(
      markPublished({
        manifestPath,
        outDir: tempDir,
        excludeTitle: "(unclosed-group",
      }),
    ).rejects.toThrow(MarkPublishedError);

    await expect(
      markPublished({
        manifestPath,
        outDir: tempDir,
        filterTitle: "true",
      }),
    ).rejects.toThrow("requires a non-empty regular expression");

    await expect(
      markPublished({
        manifestPath,
        outDir: tempDir,
        excludeTitle: "true",
      }),
    ).rejects.toThrow("requires a non-empty regular expression");
  });
});

describe("cmdMarkPublished", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cmd-mark-pub-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prints help and returns early when --help is passed", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await cmdMarkPublished({ help: "true" });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Special value "UNSET" matches pages where Publish Status'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("--filter-title <regex>"),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("--exclude-title <regex>"),
    );
    consoleSpy.mockRestore();
  });

  it("prints help and returns early when -h is passed", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await cmdMarkPublished({ h: "true" });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Special value "UNSET" matches pages where Publish Status'),
    );
    consoleSpy.mockRestore();
  });

  it("prints help and returns early when -h is passed via positional argument", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await cmdMarkPublished({ _: JSON.stringify(["-h"]) });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Special value "UNSET" matches pages where Publish Status'),
    );
    consoleSpy.mockRestore();
  });

  it("respects --no-set-published-date to prevent updating publication date", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Date Page", locale: "en", drafting_status: "Draft published" },
    ]);
    const localManifestPath = join(tempDir, "manifest-date-test.json");
    writeFileSync(localManifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi.fn().mockResolvedValue({});
    const mockClient: StatusUpdateClient = {
      updatePageStatus: updatePageStatusMock,
    };

    await cmdMarkPublished(
      {
        "manifest-path": localManifestPath,
        out: tempDir,
        live: "true",
        "no-set-published-date": "true",
      },
      { client: mockClient },
    );

    expect(updatePageStatusMock).toHaveBeenCalledWith("p1", "Published", {
      setPublishedDate: false,
      publishedDate: undefined,
    });
  });

  describe("queryDatabase fallback when manifest is absent", () => {
    it("queries Notion database directly when default manifest does not exist", async () => {
      const updatePageStatusMock = vi.fn().mockResolvedValue({});
      const queryDatabaseMock = vi.fn().mockResolvedValue({
        results: [
          {
            id: "db-p1",
            properties: {
              "Content elements": { title: [{ plain_text: "Live Page 1" }] },
              Language: { select: { name: "English" } },
              "Publish Status": { select: { name: "Draft published" } },
            },
          },
          {
            id: "db-p2",
            properties: {
              "Content elements": { title: [{ plain_text: "Live Page 2" }] },
              Language: { select: { name: "Spanish" } },
              "Publish Status": { select: { name: "Draft published" } },
            },
          },
        ],
      });

      const mockClient: StatusUpdateClient = {
        updatePageStatus: updatePageStatusMock,
        queryDatabase: queryDatabaseMock,
      };

      const result = await markPublished(
        {
          outDir: tempDir, // manifest.json does not exist in tempDir
          fromStatus: "Draft published",
          toStatus: "Published",
          live: true,
        },
        { client: mockClient },
      );

      expect(queryDatabaseMock).toHaveBeenCalledWith({
        filter: {
          property: "Publish Status",
          select: { equals: "Draft published" },
        },
      });
      expect(result.updatedCount).toBe(2);
      expect(result.targetedDocs).toBe(2);
      expect(updatePageStatusMock).toHaveBeenCalledTimes(2);
      expect(updatePageStatusMock).toHaveBeenCalledWith("db-p1", "Published", {
        setPublishedDate: true,
        publishedDate: undefined,
      });
      expect(updatePageStatusMock).toHaveBeenCalledWith("db-p2", "Published", {
        setPublishedDate: true,
        publishedDate: undefined,
      });
    });

    it("queries for is_empty when fromStatus is UNSET and manifest does not exist", async () => {
      const updatePageStatusMock = vi.fn().mockResolvedValue({});
      const queryDatabaseMock = vi.fn().mockResolvedValue({
        results: [
          {
            id: "db-unset-1",
            properties: {
              "Content elements": { title: [{ plain_text: "Unset Page" }] },
              Language: { select: { name: "Portuguese" } },
              "Publish Status": { select: null },
            },
          },
        ],
      });

      const mockClient: StatusUpdateClient = {
        updatePageStatus: updatePageStatusMock,
        queryDatabase: queryDatabaseMock,
      };

      const result = await markPublished(
        {
          outDir: tempDir,
          fromStatus: "UNSET",
          toStatus: "Draft published",
          live: true,
        },
        { client: mockClient },
      );

      expect(queryDatabaseMock).toHaveBeenCalledWith({
        filter: {
          property: "Publish Status",
          select: { is_empty: true },
        },
      });
      expect(result.updatedCount).toBe(1);
      expect(updatePageStatusMock).toHaveBeenCalledWith("db-unset-1", "Draft published", {
        setPublishedDate: false,
        publishedDate: undefined,
      });
    });

    it("applies filterTitle and excludeTitle to database query results", async () => {
      const queryDatabaseMock = vi.fn().mockResolvedValue({
        results: [
          {
            id: "db-1",
            properties: {
              "Content elements": { title: [{ plain_text: "User Guide" }] },
              Language: { select: { name: "English" } },
              "Publish Status": { select: { name: "Draft published" } },
              "Element Type": { select: { name: "Page" } },
            },
          },
          {
            id: "db-2",
            properties: {
              "Content elements": { title: [{ plain_text: "User Guide [PRUEBA]" }] },
              Language: { select: { name: "English" } },
              "Publish Status": { select: { name: "Draft published" } },
              "Element Type": { select: { name: "Page" } },
            },
          },
          {
            id: "db-3",
            properties: {
              "Content elements": { title: [{ plain_text: "Overview" }] },
              Language: { select: { name: "English" } },
              "Publish Status": { select: { name: "Draft published" } },
              "Element Type": { select: { name: "Page" } },
            },
          },
        ],
      });

      const mockClient: StatusUpdateClient = {
        updatePageStatus: vi.fn(),
        queryDatabase: queryDatabaseMock,
      };

      const result = await markPublished(
        {
          outDir: tempDir,
          fromStatus: "Draft published",
          filterTitle: "guide",
          excludeTitle: "\\[PRUEBA\\]",
          dryRun: true,
        },
        { client: mockClient },
      );

      expect(result.targetedDocs).toBe(1);
      expect(result.targets[0].pageId).toBe("db-1");
    });

    it("throws MarkPublishedError when client does not support queryDatabase and manifest is absent", async () => {
      const mockClient: StatusUpdateClient = {
        updatePageStatus: vi.fn(),
      };

      await expect(
        markPublished(
          {
            outDir: tempDir,
            fromStatus: "Draft published",
            toStatus: "Published",
          },
          { client: mockClient },
        ),
      ).rejects.toThrow(MarkPublishedError);
    });
  });

  it("passes --filter-title and --exclude-title flags to markPublished", async () => {
    const manifest = createMockManifest([
      { page_id: "p1", title: "Included Guide", locale: "en", drafting_status: "Draft published" },
      { page_id: "p2", title: "Excluded Guide [TEST]", locale: "en", drafting_status: "Draft published" },
    ]);
    const localManifestPath = join(tempDir, "manifest-filter-test.json");
    writeFileSync(localManifestPath, JSON.stringify(manifest), "utf-8");

    const updatePageStatusMock = vi.fn().mockResolvedValue({});
    const mockClient: StatusUpdateClient = {
      updatePageStatus: updatePageStatusMock,
    };

    await cmdMarkPublished(
      {
        "manifest-path": localManifestPath,
        out: tempDir,
        live: "true",
        "filter-title": "guide",
        "exclude-title": "\\[TEST\\]",
      },
      { client: mockClient },
    );

    expect(updatePageStatusMock).toHaveBeenCalledTimes(1);
    expect(updatePageStatusMock).toHaveBeenCalledWith("p1", "Published", expect.any(Object));
  });

  it("rejects --exclude-title without value in cmdMarkPublished", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await cmdMarkPublished({
      out: tempDir,
      "exclude-title": "true",
      live: "true",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Option --exclude-title requires a non-empty regular expression"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

