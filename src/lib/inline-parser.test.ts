import { describe, it, expect } from "vitest";
import { inlineMarkdownToRichText } from "./inline-parser.js";
import { richTextToMarkdown } from "./notion-converter.js";

describe("inlineMarkdownToRichText", () => {
  it("converts plain text without formatting", () => {
    const res = inlineMarkdownToRichText("Simple plain text");
    expect(res).toHaveLength(1);
    expect(res[0].text!.content).toBe("Simple plain text");
    expect(res[0].annotations.bold).toBe(false);
    expect(res[0].annotations.italic).toBe(false);
    expect(res[0].annotations.code).toBe(false);
    expect(res[0].text!.link).toBeNull();
  });

  it("converts bold text", () => {
    const res = inlineMarkdownToRichText("Hello **world**!");
    expect(res).toHaveLength(3);
    expect(res[0].text!.content).toBe("Hello ");
    expect(res[0].annotations.bold).toBe(false);
    expect(res[1].text!.content).toBe("world");
    expect(res[1].annotations.bold).toBe(true);
    expect(res[2].text!.content).toBe("!");
    expect(res[2].annotations.bold).toBe(false);
  });

  it("converts italic text", () => {
    const res = inlineMarkdownToRichText("Hello *italic* text");
    expect(res).toHaveLength(3);
    expect(res[1].text!.content).toBe("italic");
    expect(res[1].annotations.italic).toBe(true);
  });

  it("converts inline code", () => {
    const res = inlineMarkdownToRichText("Run `bun test` now");
    expect(res).toHaveLength(3);
    expect(res[1].text!.content).toBe("bun test");
    expect(res[1].annotations.code).toBe(true);
  });

  it("converts strikethrough", () => {
    const res = inlineMarkdownToRichText("Old ~~deprecated~~ text");
    expect(res).toHaveLength(3);
    expect(res[1].text!.content).toBe("deprecated");
    expect(res[1].annotations.strikethrough).toBe(true);
  });

  it("converts markdown links", () => {
    const res = inlineMarkdownToRichText("Click [here](https://example.com) for details");
    expect(res).toHaveLength(3);
    expect(res[1].text!.content).toBe("here");
    expect(res[1].text!.link).toEqual({ url: "https://example.com" });
    expect(res[1].href).toBe("https://example.com");
  });

  it("converts links with bold text", () => {
    const res = inlineMarkdownToRichText("[**Bold Link**](https://example.com)");
    expect(res).toHaveLength(1);
    expect(res[0].text!.content).toBe("Bold Link");
    expect(res[0].annotations.bold).toBe(true);
    expect(res[0].text!.link).toEqual({ url: "https://example.com" });
  });

  it("splits text exceeding 2000 characters", () => {
    const longText = "a".repeat(2500);
    const res = inlineMarkdownToRichText(longText);
    expect(res.length).toBeGreaterThan(1);
    expect(res.every((span) => span.text!.content.length <= 2000)).toBe(true);
    const total = res.map((s) => s.text!.content).join("");
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

  it("converts emoji img tags with data-emoji-id into Notion custom_emoji mentions", () => {
    const input = 'Open <img src="https://example.com/icon.png" alt="menu" data-emoji-id="emoji-123" className="emoji" /> now';
    const res = inlineMarkdownToRichText(input);
    expect(res).toHaveLength(3);
    expect(res[0].type).toBe("text");
    expect(res[0].text?.content).toBe("Open ");
    expect(res[1].type).toBe("mention");
    expect((res[1].mention as { type: string; custom_emoji: { id: string } }).type).toBe("custom_emoji");
    expect((res[1].mention as { type: string; custom_emoji: { id: string } }).custom_emoji.id).toBe("emoji-123");
    expect(res[2].type).toBe("text");
    expect(res[2].text?.content).toBe(" now");
  });

  it("resolves custom_emoji id from emojiMap when data-emoji-id is absent", () => {
    const input = 'Open <img src="https://example.com/icon.png" alt="menu" className="emoji" /> now';
    const emojiMap = new Map([["menu", "emoji-from-map"]]);
    const res = inlineMarkdownToRichText(input, emojiMap);
    expect(res).toHaveLength(3);
    expect(res[1].type).toBe("mention");
    expect((res[1].mention as { type: string; custom_emoji: { id: string } }).custom_emoji.id).toBe("emoji-from-map");
  });

  it("handles links with balanced parentheses in the URL", () => {
    const input = "See [Function article](https://en.wikipedia.org/wiki/Function_(mathematics)) for info.";
    const res = inlineMarkdownToRichText(input);
    expect(res).toHaveLength(3);
    expect(res[1].text?.content).toBe("Function article");
    expect(res[1].text?.link?.url).toBe("https://en.wikipedia.org/wiki/Function_(mathematics)");
  });

  it("converts underline HTML tags to Notion underline annotations", () => {
    const input = "Please <u>underline this</u> text.";
    const res = inlineMarkdownToRichText(input);
    expect(res).toHaveLength(3);
    expect(res[1].text?.content).toBe("underline this");
    expect(res[1].annotations.underline).toBe(true);
    expect(richTextToMarkdown(res)).toBe(input);
  });

  it("converts JSX and HTML color spans to Notion color annotations", () => {
    const input = 'Check <span style={{color:"red"}}>alert</span> and <span style="color: blue">info</span>.';
    const res = inlineMarkdownToRichText(input);
    expect(res).toHaveLength(5);
    expect(res[1].text?.content).toBe("alert");
    expect(res[1].annotations.color).toBe("red");
    expect(res[3].text?.content).toBe("info");
    expect(res[3].annotations.color).toBe("blue");
  });

  it("preserves technical identifiers with multiple underscores without corrupting them as italics", () => {
    const input = "Set my_var_name, SOME_ENV_VAR, and config_file.txt in settings.";
    const res = inlineMarkdownToRichText(input);
    expect(res).toHaveLength(1);
    expect(res[0].text?.content).toBe(input);
    expect(res[0].annotations.italic).toBe(false);

    const backToMd = richTextToMarkdown(res);
    expect(backToMd).toBe(input);
    expect(backToMd).not.toContain("*var*");
    expect(backToMd).not.toContain("*ENV*");
  });

  it("converts genuine underscore italics with word boundaries", () => {
    const input = "This is _italic text_ and (_parenthesized_) here.";
    const res = inlineMarkdownToRichText(input);
    expect(res).toHaveLength(5);
    expect(res[1].text?.content).toBe("italic text");
    expect(res[1].annotations.italic).toBe(true);
    expect(res[3].text?.content).toBe("parenthesized");
    expect(res[3].annotations.italic).toBe(true);
  });

  it("preserves technical expressions with literal asterisks without corrupting them as italics", () => {
    const input = "expression a*b*c and x**2**y should not be italic or bold";
    const res = inlineMarkdownToRichText(input);
    expect(res).toHaveLength(1);
    expect(res[0].text?.content).toBe(input);
    expect(res[0].annotations.italic).toBe(false);
    expect(res[0].annotations.bold).toBe(false);
  });

  it("converts genuine asterisk italics with word boundaries", () => {
    const input = "This is *italic text* and (*parenthesized*) here.";
    const res = inlineMarkdownToRichText(input);
    expect(res).toHaveLength(5);
    expect(res[1].text?.content).toBe("italic text");
    expect(res[1].annotations.italic).toBe(true);
    expect(res[3].text?.content).toBe("parenthesized");
    expect(res[3].annotations.italic).toBe(true);
  });
});

