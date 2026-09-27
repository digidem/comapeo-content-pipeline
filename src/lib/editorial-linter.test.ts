import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  extractHeadingsFromMarkdown,
  runEditorialLinter,
} from "./editorial-linter.js";
import {
  loadPagesFromOutput,
  cmdValidateEditorial,
} from "../cli/editorial-diagnostics.js";
import { EditorialDiagnosticsReportSchema } from "../schemas/index.js";

describe("editorial-linter", () => {
  describe("extractHeadingsFromMarkdown", () => {
    it("extracts markdown headings across levels and ignores code fences", () => {
      const markdown = [
        "# Main Title",
        "",
        "Intro text",
        "",
        "## Section One",
        "",
        "```markdown",
        "# Ignored Code Heading",
        "```",
        "",
        "### Sub Section with **Bold** and [Link](#target)",
        "",
        "#### Another Heading",
      ].join("\n");

      const headings = extractHeadingsFromMarkdown(markdown);
      expect(headings.has("main-title")).toBe(true);
      expect(headings.has("section-one")).toBe(true);
      expect(headings.has("sub-section-with-bold-and-link")).toBe(true);
      expect(headings.has("another-heading")).toBe(true);
      expect(headings.has("ignored-code-heading")).toBe(false);
    });
  });

  describe("runEditorialLinter", () => {
    it("detects broken anchors targeting non-existent sections", () => {
      const pages = [
        {
          pageId: "page-1",
          title: "Source Page",
          slug: "source-page",
          locale: "en",
          markdown: "See [missing](#non-existent-anchor) and [target missing](/docs/target-page#missing-section).",
        },
        {
          pageId: "page-2",
          title: "Target Page",
          slug: "target-page",
          locale: "en",
          markdown: "# Target Title\n\n## Valid Section\n\nSome text.",
        },
      ];

      const report = runEditorialLinter(pages);
      expect(report.summary.broken_anchors).toBe(2);
      const broken = report.items.filter((i) => i.category === "broken_anchor");
      expect(broken.length).toBe(2);
      expect(broken[0]?.guidance).toContain("non-existent-anchor");
      expect(broken[1]?.guidance).toContain("missing-section");
    });

    it("does not flag valid anchors that exist in the target page", () => {
      const pages = [
        {
          pageId: "page-1",
          title: "Source Page",
          slug: "source-page",
          locale: "en",
          markdown: "# Source Title\n\n## Intro\n\nSee [valid section](/docs/target-page#valid-section) and [self](#intro).",
        },
        {
          pageId: "page-2",
          title: "Target Page",
          slug: "target-page",
          locale: "en",
          markdown: "# Target Title\n\n## Valid Section\n\nSome content.\n\n## Intro\n\nIntro text.",
        },
      ];

      const report = runEditorialLinter(pages);
      expect(report.summary.broken_anchors).toBe(0);
    });

    it("detects oversized base64 data URIs in raw blocks and markdown", () => {
      const hugeBase64 = "data:image/png;base64," + "A".repeat(15000);
      const pages = [
        {
          pageId: "page-with-block-image",
          title: "Image Page",
          slug: "image-page",
          locale: "en",
          markdown: "# Image Page\n\nNormal text.",
          rawBlocks: [
            {
              id: "block-base64-123",
              type: "image",
              image: {
                file: {
                  url: hugeBase64,
                },
              },
            },
          ],
        },
        {
          pageId: "page-with-md-image",
          title: "MD Image Page",
          slug: "md-image-page",
          locale: "en",
          markdown: `# MD Image Page\n\n![Image](${hugeBase64})`,
        },
      ];

      const report = runEditorialLinter(pages);
      expect(report.summary.base64_blobs).toBe(2);
      const blobs = report.items.filter((i) => i.category === "base64_blob");
      expect(blobs[0]?.block_id).toBe("block-base64-123");
      expect(blobs[0]?.details.size_kb).toBeGreaterThan(14);
    });

    it("ignores base64 data under threshold", () => {
      const smallBase64 = "data:image/png;base64," + "A".repeat(500);
      const pages = [
        {
          pageId: "small-img",
          title: "Small",
          slug: "small",
          locale: "en",
          markdown: `# Small\n\n![Icon](${smallBase64})`,
        },
      ];

      const report = runEditorialLinter(pages, { base64ThresholdBytes: 10000 });
      expect(report.summary.base64_blobs).toBe(0);
    });

    it("detects localized slug drift mapped in KNOWN_SLUG_ALIASES", () => {
      const pages = [
        {
          pageId: "page-1",
          title: "Spanish Page",
          slug: "spanish-page",
          locale: "es",
          markdown: "Consulta [la guía](/docs/entiende-como-funciona-el-intercambio) para más detalles.",
        },
        {
          pageId: "page-2",
          title: "Understanding How Exchange Works",
          slug: "understanding-how-exchange-works",
          locale: "en",
          markdown: "# Understanding How Exchange Works\n\nContent.",
        },
      ];

      const report = runEditorialLinter(pages);
      expect(report.summary.slug_drift).toBe(1);
      const drift = report.items.find((i) => i.category === "slug_drift");
      expect(drift?.details.used_slug).toBe("entiende-como-funciona-el-intercambio");
      expect(drift?.details.canonical_slug).toBe("understanding-how-exchange-works");
    });

    it("detects unmapped internal Notion references", () => {
      const pages = [
        {
          pageId: "page-1",
          title: "Page One",
          slug: "page-one",
          locale: "en",
          markdown: "See [orphaned notion page](https://www.notion.so/digidem/99999999999999999999999999999999).",
        },
      ];

      const report = runEditorialLinter(pages);
      expect(report.summary.unmapped_references).toBe(1);
      const unmapped = report.items.find((i) => i.category === "unmapped_reference");
      expect(unmapped?.details.unresolved_id).toBe("99999999999999999999999999999999");
    });
  });

  describe("CLI and Output integration", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "editorial-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("loads pages and executes diagnostics report emitting valid JSON", async () => {
      const meta = {
        title: "Test Page",
        slug: "test-page",
        locale: "en",
      };
      fs.writeFileSync(path.join(tmpDir, "p1.metadata.json"), JSON.stringify(meta), "utf-8");
      fs.writeFileSync(
        path.join(tmpDir, "p1.md"),
        "# Test Page\n\nLink to [stale](/docs/entiende-como-funciona-el-intercambio).",
        "utf-8"
      );

      const pages = loadPagesFromOutput(tmpDir);
      expect(pages.length).toBe(1);
      expect(pages[0]?.title).toBe("Test Page");

      const report = await cmdValidateEditorial({ out: tmpDir, "json-only": "true" });
      expect(report.total_issues).toBeGreaterThan(0);
      expect(report.summary.slug_drift).toBe(1);

      const savedJson = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "editorial-diagnostics.json"), "utf-8")
      );
      expect(() => EditorialDiagnosticsReportSchema.parse(savedJson)).not.toThrow();
    });
  });
});
