import { describe, it, expect } from "vitest";
import { inlineMarkdownToRichText } from "./inline-parser.js";
import { richTextToMarkdown } from "./notion-converter.js";

describe("inlineMarkdownToRichText", () => {
  it("converts plain text without formatting", () => {
    const res = inlineMarkdownToRichText("Simple plain text");
    expect(res).toHaveLength(1);
    expect(res[0].text.content).toBe("Simple plain text");
    expect(res[0].annotations.bold).toBe(false);
    expect(res[0].annotations.italic).toBe(false);
    expect(res[0].annotations.code).toBe(false);
    expect(res[0].text.link).toBeNull();
  });

  it("converts bold text", () => {
    const res = inlineMarkdownToRichText("Hello **world**!");
    expect(res).toHaveLength(3);
    expect(res[0].text.content).toBe("Hello ");
    expect(res[0].annotations.bold).toBe(false);
    expect(res[1].text.content).toBe("world");
    expect(res[1].annotations.bold).toBe(true);
    expect(res[2].text.content).toBe("!");
    expect(res[2].annotations.bold).toBe(false);
  });

  it("converts italic text", () => {
    const res = inlineMarkdownToRichText("Hello *italic* text");
    expect(res).toHaveLength(3);
    expect(res[1].text.content).toBe("italic");
    expect(res[1].annotations.italic).toBe(true);
  });

  it("converts inline code", () => {
    const res = inlineMarkdownToRichText("Run `bun test` now");
    expect(res).toHaveLength(3);
    expect(res[1].text.content).toBe("bun test");
    expect(res[1].annotations.code).toBe(true);
  });

  it("converts strikethrough", () => {
    const res = inlineMarkdownToRichText("Old ~~deprecated~~ text");
    expect(res).toHaveLength(3);
    expect(res[1].text.content).toBe("deprecated");
    expect(res[1].annotations.strikethrough).toBe(true);
  });

  it("converts markdown links", () => {
    const res = inlineMarkdownToRichText("Click [here](https://example.com) for details");
    expect(res).toHaveLength(3);
    expect(res[1].text.content).toBe("here");
    expect(res[1].text.link).toEqual({ url: "https://example.com" });
    expect(res[1].href).toBe("https://example.com");
  });

  it("converts links with bold text", () => {
    const res = inlineMarkdownToRichText("[**Bold Link**](https://example.com)");
    expect(res).toHaveLength(1);
    expect(res[0].text.content).toBe("Bold Link");
    expect(res[0].annotations.bold).toBe(true);
    expect(res[0].text.link).toEqual({ url: "https://example.com" });
  });

  it("splits text exceeding 2000 characters", () => {
    const longText = "a".repeat(2500);
    const res = inlineMarkdownToRichText(longText);
    expect(res.length).toBeGreaterThan(1);
    expect(res.every((span) => span.text.content.length <= 2000)).toBe(true);
    const total = res.map((s) => s.text.content).join("");
    expect(total).toBe(longText);
  });

  it("roundtrips with richTextToMarkdown", () => {
    const input = "Tap **Observations** to see [all records](https://example.com) and `export` them.";
    const richText = inlineMarkdownToRichText(input);
    const backToMd = richTextToMarkdown(richText);
    expect(backToMd).toBe(input);
  });

  it("preserves HTML img tags without parsing underscores in URL as italics", () => {
    const input = 'Step 2: <img src="https://example.com/public/photo_2026-04-18_09-03-07.jpg" alt="switch" className="emoji" /> **Done**';
    const richText = inlineMarkdownToRichText(input);
    const backToMd = richTextToMarkdown(richText);
    expect(backToMd).toBe(input);
    expect(backToMd).not.toContain("*2026-04-18*");
  });
});
