import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  cmdValidateEditorial,
  loadPagesFromOutput,
} from "./editorial-diagnostics.js";

describe("cmdValidateEditorial", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-editorial-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("handles non-existent or empty output directory gracefully", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    const report = await cmdValidateEditorial({ out: emptyDir, "json-only": "true" });
    expect(report.total_issues).toBe(0);
    expect(report.items).toEqual([]);
  });

  it("scans pages and outputs editorial-diagnostics.json", async () => {
    // Setup a dummy page with base64 and anchor issues
    const meta1 = {
      title: "Page Alpha",
      slug: "page-alpha",
      locale: "en",
    };
    const hugeBase64 = "data:image/png;base64," + "X".repeat(15000);
    const md1 = `# Page Alpha\n\n![Image](${hugeBase64})\n\nSee [bad anchor](/docs/page-beta#nowhere).`;

    const meta2 = {
      title: "Page Beta",
      slug: "page-beta",
      locale: "en",
    };
    const md2 = `# Page Beta\n\n## Existing Section\n\nContent.`;

    fs.writeFileSync(path.join(tmpDir, "p1.metadata.json"), JSON.stringify(meta1));
    fs.writeFileSync(path.join(tmpDir, "p1.md"), md1);
    fs.writeFileSync(path.join(tmpDir, "p2.metadata.json"), JSON.stringify(meta2));
    fs.writeFileSync(path.join(tmpDir, "p2.md"), md2);

    const report = await cmdValidateEditorial({ out: tmpDir });
    expect(report.total_issues).toBe(2);
    expect(report.summary.base64_blobs).toBe(1);
    expect(report.summary.broken_anchors).toBe(1);

    const reportFile = path.join(tmpDir, "editorial-diagnostics.json");
    expect(fs.existsSync(reportFile)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(reportFile, "utf-8"));
    expect(parsed.total_issues).toBe(2);
  });

  it("suppresses console tables when json-only is true", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const meta = { title: "Test", slug: "test", locale: "en" };
    fs.writeFileSync(path.join(tmpDir, "p1.metadata.json"), JSON.stringify(meta));
    fs.writeFileSync(path.join(tmpDir, "p1.md"), "# Test\n\nContent.");

    await cmdValidateEditorial({ out: tmpDir, "json-only": "true" });

    // Ensure detailed summary banner was NOT printed
    const loggedText = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(loggedText).not.toContain("NOTION EDITORIAL DIAGNOSTICS & LINTER");
  });

  it("handles malformed raw-blocks.json without crashing", () => {
    const meta = { title: "Test", slug: "test", locale: "en" };
    fs.writeFileSync(path.join(tmpDir, "p1.metadata.json"), JSON.stringify(meta));
    fs.writeFileSync(path.join(tmpDir, "p1.md"), "# Test");
    fs.writeFileSync(path.join(tmpDir, "p1.raw-blocks.json"), "{ invalid-json }");

    const pages = loadPagesFromOutput(tmpDir);
    expect(pages.length).toBe(1);
    expect(pages[0]?.rawBlocks).toBeUndefined();
  });
});
