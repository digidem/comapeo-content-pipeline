import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  validateMdxContent,
  validateMdxFile,
  validateMdxFiles,
  findMarkdownFiles,
} from "../scripts/validate-mdx.js";

describe("MDX Canary Build Gate", () => {
  describe("Golden Fixtures", () => {
    const fixturesDir = path.resolve(process.cwd(), "test/fixtures/expected");
    const fixtureFiles = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(fixturesDir, f));

    it("passes all golden markdown fixtures without false positives", async () => {
      expect(fixtureFiles.length).toBeGreaterThan(0);
      const summary = await validateMdxFiles(fixtureFiles);
      expect(summary.failed).toBe(0);
      expect(summary.passed).toBe(fixtureFiles.length);
    });

    for (const file of fixtureFiles) {
      const baseName = path.basename(file);
      it(`validates fixture: ${baseName}`, async () => {
        const result = await validateMdxFile(file);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });
    }
  });

  describe("Syntax and Hazard Detection", () => {
    it("fails when unescaped JSX brackets are present in text", async () => {
      const content = [
        "# Documentation Title",
        "",
        "Please provide the <username> parameter here.",
        "",
        "Next paragraph.",
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.line).toBe(3);
      expect(result.errors[0]?.message).toMatch(/closing tag for `<username>`/i);
      expect(result.errors[0]?.snippet).toContain("<username>");
    });

    it("fails when string style attribute is used (breaking Docusaurus SSR)", async () => {
      const content = [
        "# Title",
        "",
        '<span style="color: red;">Highlighted text</span>',
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.line).toBe(3);
      expect(result.errors[0]?.message).toMatch(/style.*prop expects a mapping/i);
    });

    it("fails when bare unquoted style attribute is used", async () => {
      const content = [
        "# Title",
        "",
        "<span style=color:red>Highlighted text</span>",
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.line).toBe(3);
    });

    it("fails on unclosed or mismatched JSX tags", async () => {
      const content = [
        "# Title",
        "",
        "<div><p>Paragraph inside unclosed tags</div>",
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.line).toBe(3);
      expect(result.errors[0]?.message).toMatch(/closing tag/i);
    });
  });

  describe("Legitimate Markdown Constructs (Zero False Positives)", () => {
    it("permits valid JSX style prop objects", async () => {
      const content = '<span style={{color:"red"}}>Red text</span>';
      const result = await validateMdxContent(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("permits code fences containing angle brackets and bare style attributes", async () => {
      const content = [
        "# Code Example",
        "",
        "```html",
        '<span style="color: red;">This is safe code</span>',
        "<custom-element attr=val>",
        "```",
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("permits inline code containing angle brackets", async () => {
      const content = "Use `<filename>` or `<User ID>` in the configuration.";
      const result = await validateMdxContent(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("permits Docusaurus admonitions", async () => {
      const content = [
        ":::note",
        "This is an admonition note.",
        ":::",
        "",
        ":::warning Important",
        "Pay attention to this.",
        ":::",
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("permits HTML details and summary blocks", async () => {
      const content = [
        "<details>",
        "<summary>Click to see details</summary>",
        "",
        "Hidden content revealed here.",
        "",
        "</details>",
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("permits Markdown tables with formatting", async () => {
      const content = [
        "| Header 1 | Header 2 |",
        "| --- | --- |",
        "| **Bold text** | *Italic* and `code` |",
        "| Value A | Value B |",
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("permits YAML frontmatter at document start", async () => {
      const content = [
        "---",
        "title: My Page",
        "sidebar_position: 2",
        "---",
        "",
        "# Heading",
        "Body content",
      ].join("\n");

      const result = await validateMdxContent(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe("File Search and Batch Processing", () => {
    it("finds markdown files recursively", () => {
      const fixturesDir = path.resolve(process.cwd(), "test/fixtures/expected");
      const files = findMarkdownFiles(fixturesDir);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.endsWith(".md"))).toBe(true);
    });

    it("returns empty array for non-existent path", () => {
      const files = findMarkdownFiles("non/existent/path");
      expect(files).toEqual([]);
    });

    it("batches results correctly with summary statistics", async () => {
      const fixturesDir = path.resolve(process.cwd(), "test/fixtures/expected");
      const files = findMarkdownFiles(fixturesDir).slice(0, 3);
      const summary = await validateMdxFiles(files);
      expect(summary.total).toBe(3);
      expect(summary.passed).toBe(3);
      expect(summary.failed).toBe(0);
      expect(summary.results.length).toBe(3);
    });
  });
});
