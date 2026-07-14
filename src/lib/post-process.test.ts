import { describe, it, expect } from "vitest";
import {
  removeDuplicateTitle,
  ensureBlankLineAfterStandaloneBold,
  sanitizeMarkdownContent,
  sanitizeMarkdownImages,
  stripImageAuthorNotes,
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

  it("preserves JSX color-span style objects through brace stripping", () => {
    const content =
      'precision<span style={{color:"red"}}> </span>is worse than ±10m {{formula}}.';
    const result = sanitizeMarkdownContent(content);
    // The style object survives intact (a stripped/string style throws in MDX).
    expect(result).toContain('<span style={{color:"red"}}>');
    expect(result).not.toContain('style=color');
    // Genuine Notion formula braces are still stripped.
    expect(result).not.toContain("{{formula}}");
  });

  it("preserves custom-emoji img style objects", () => {
    const content =
      '<img src="https://x/abc.png" alt="wave" className="emoji" style={{display:"inline",height:"1.2em",width:"auto",verticalAlign:"text-bottom",margin:"0 0.1em"}} />';
    const result = sanitizeMarkdownContent(content);
    expect(result).toContain('style={{display:"inline"');
    expect(result).toContain('className="emoji"');
  });

  it("handles empty input", () => {
    expect(sanitizeMarkdownContent("")).toBe("");
  });
});

describe("sanitizeMarkdownImages", () => {
  it("removes images with empty URLs", () => {
    const content = "Before\n![alt]()\nAfter";
    const result = sanitizeMarkdownImages(content);
    expect(result).toBe("Before\n\nAfter");
  });

  it("removes images with undefined placeholder", () => {
    const content = "![photo](undefined)";
    const result = sanitizeMarkdownImages(content);
    expect(result).toBe("");
  });

  it("removes images with null placeholder", () => {
    const content = "![photo](null)";
    const result = sanitizeMarkdownImages(content);
    expect(result).toBe("");
  });

  it("removes images with NULL placeholder (case-insensitive)", () => {
    const content = "![photo](NULL)";
    const result = sanitizeMarkdownImages(content);
    expect(result).toBe("");
  });

  it("strips whitespace from image URLs", () => {
    const content = "![alt]( https://example.com/img.png )";
    const result = sanitizeMarkdownImages(content);
    expect(result).toBe("![alt](https://example.com/img.png)");
  });

  it("strips internal whitespace from image URLs", () => {
    const content = "![alt]( https://example.com/img .png )";
    const result = sanitizeMarkdownImages(content);
    expect(result).toBe("![alt](https://example.com/img.png)");
  });

  it("leaves valid images untouched", () => {
    const content = "![alt](https://example.com/img.png)";
    const result = sanitizeMarkdownImages(content);
    expect(result).toBe(content);
  });

  it("handles empty input", () => {
    expect(sanitizeMarkdownImages("")).toBe("");
  });

  it("handles multiple image issues in one pass", () => {
    const content = "![bad]()\n![undef](undefined)\n![good](https://example.com/a.png)\n![space]( https://b.com/img.png )";
    const result = sanitizeMarkdownImages(content);
    expect(result).toBe("\n\n![good](https://example.com/a.png)\n![space](https://b.com/img.png)");
  });
});

describe("stripImageAuthorNotes", () => {
  it("strips a standalone [Image: url] line", () => {
    const content = "Some text.\n[Image: https://prod-files-secure.s3.amazonaws.com/abc123]\nMore text.";
    const result = stripImageAuthorNotes(content);
    expect(result).not.toContain("[Image:");
    expect(result).toContain("Some text.");
    expect(result).toContain("More text.");
  });

  it("strips a bold-wrapped [Image: url] line", () => {
    const content = "Before.\n**[Image: https://example.com/pic.jpg]**\nAfter.";
    const result = stripImageAuthorNotes(content);
    expect(result).not.toContain("[Image:");
    expect(result).toContain("Before.");
    expect(result).toContain("After.");
  });

  it("does NOT strip [Image: ...] when it appears mid-sentence with other content", () => {
    const content = "See the [Image: https://example.com/pic.jpg] for reference.";
    const result = stripImageAuthorNotes(content);
    // Line has other content — must be preserved
    expect(result).toContain("[Image:");
  });

  it("does NOT touch standard Markdown images ![alt](url)", () => {
    const content = "![A screenshot](https://example.com/screenshot.png)";
    const result = stripImageAuthorNotes(content);
    expect(result).toBe(content);
  });

  it("collapses double blank lines left after stripping", () => {
    const content = "Para one.\n\n[Image: https://example.com/img.png]\n\nPara two.";
    const result = stripImageAuthorNotes(content);
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain("Para one.");
    expect(result).toContain("Para two.");
  });

  it("handles empty input", () => {
    expect(stripImageAuthorNotes("")).toBe("");
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

  it("applies image sanitization in pipeline", () => {
    const content = "# Title\n\n![bad]()\n![good](https://example.com/img.png)";
    const result = postProcessMarkdown(content, "Title");
    expect(result).not.toContain("![bad]()");
    expect(result).toContain("![good](https://example.com/img.png)");
  });

  it("handles empty content", () => {
    expect(postProcessMarkdown("", "Title")).toBe("");
  });
});
