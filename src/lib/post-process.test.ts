import { describe, it, expect } from "vitest";
import {
  removeDuplicateTitle,
  ensureBlankLineAfterStandaloneBold,
  sanitizeMarkdownContent,
  postProcessMarkdown,
} from "./post-process.js";

describe("removeDuplicateTitle", () => {
  it("removes H1 that matches page title", () => {
    const content = "# Welcome\n\nSome content.";
    const result = removeDuplicateTitle(content, "Welcome");
    expect(result).toBe("Some content.");
  });

  it("removes H1 that contains page title", () => {
    const content = "# Welcome to CoMapeo\n\nMore text.";
    const result = removeDuplicateTitle(content, "Welcome to CoMapeo");
    expect(result).toBe("More text.");
  });

  it("keeps H1 if it does not match page title", () => {
    const content = "# Getting Started\n\nSome content.";
    const result = removeDuplicateTitle(content, "Welcome");
    expect(result).toBe("# Getting Started\n\nSome content.");
  });

  it("handles content without H1", () => {
    const content = "Just some text.\n\nMore text.";
    const result = removeDuplicateTitle(content, "Something");
    expect(result).toBe(content);
  });

  it("handles title that is contained within H1", () => {
    const content = "# Welcome\n\nText.";
    const result = removeDuplicateTitle(content, "Welcome to CoMapeo");
    // pageTitle includes the H1 text → match by includes
    expect(result).toBe("Text.");
  });

  it("handles nil input", () => {
    expect(removeDuplicateTitle("", "Title")).toBe("");
    expect(removeDuplicateTitle("# Hi", "")).toBe("# Hi");
  });
});

describe("ensureBlankLineAfterStandaloneBold", () => {
  it("adds blank line after standalone bold heading", () => {
    const content = "**Important**\nThis is the description.";
    const result = ensureBlankLineAfterStandaloneBold(content);
    expect(result).toBe("**Important**\n\nThis is the description.");
  });

  it("does not add blank line if already present", () => {
    const content = "**Note**\n\nAlready spaced.";
    const result = ensureBlankLineAfterStandaloneBold(content);
    expect(result).toBe("**Note**\n\nAlready spaced.");
  });

  it("does not add blank line when next line is empty", () => {
    const content = "**Note**\n";
    const result = ensureBlankLineAfterStandaloneBold(content);
    expect(result).toBe("**Note**\n");
  });

  it("does not affect inline bold", () => {
    const content = "Some **bold** text here.\nMore text.";
    const result = ensureBlankLineAfterStandaloneBold(content);
    expect(result).toBe(content);
  });

  it("handles multiple standalone bold lines", () => {
    const content = "**First**\nContent one.\n**Second**\nContent two.";
    const result = ensureBlankLineAfterStandaloneBold(content);
    expect(result).toBe(
      "**First**\n\nContent one.\n**Second**\n\nContent two.",
    );
  });
});

describe("sanitizeMarkdownContent", () => {
  it("demotes duplicate H1s to H2s", () => {
    const content = "# Title\n\ntext\n\n# Another H1\n";
    const result = sanitizeMarkdownContent(content);
    expect(result).toContain("## Another H1");
  });

  it("keeps first H1", () => {
    const content = "# Only Title\n\nContent.";
    const result = sanitizeMarkdownContent(content);
    expect(result).toContain("# Only Title");
  });

  it("strips curly-brace expressions", () => {
    const content = "Some {{formula}} text.";
    const result = sanitizeMarkdownContent(content);
    expect(result).not.toContain("{{");
    expect(result).not.toContain("}}");
  });

  it("preserves code blocks", () => {
    const content = "```\nconst x = {a: 1};\n```\n\nText.";
    const result = sanitizeMarkdownContent(content);
    expect(result).toContain("const x = {a: 1}");
  });

  it("preserves inline code", () => {
    const content = "Run `{a: 1}` now.";
    const result = sanitizeMarkdownContent(content);
    expect(result).toContain("`{a: 1}`");
  });

  it("fixes malformed link tags", () => {
    const content = "See <link to section.> for more.";
    const result = sanitizeMarkdownContent(content);
    expect(result).toContain("[link to section](#section)");
  });

  it("removes empty headings", () => {
    const content = "# \n\nText.";
    const result = sanitizeMarkdownContent(content);
    expect(result).not.toContain("# ");
  });

  it("handles empty input", () => {
    expect(sanitizeMarkdownContent("")).toBe("");
  });
});

describe("postProcessMarkdown", () => {
  it("applies all transforms: duplicate title removal", () => {
    const content = "# Welcome\n\nSome content.";
    const result = postProcessMarkdown(content, "Welcome");
    expect(result).toBe("Some content.");
  });

  it("applies blank-line-after-bold transform", () => {
    const content = "**Note**\nDescription here.";
    const result = postProcessMarkdown(content, "Welcome");
    expect(result).toContain("**Note**\n\nDescription here.");
  });

  it("demotes duplicate H1s", () => {
    const content = "# Title\n\nText\n\n# Another\n";
    const result = postProcessMarkdown(content, "Title");
    // First H1 removed (matches title), second H1 demoted to H2
    expect(result).toContain("## Another");
    expect(result).not.toContain("# Title");
  });

  it("handles empty content", () => {
    expect(postProcessMarkdown("", "Title")).toBe("");
  });
});
