import { describe, it, expect } from "vitest";
import { rewriteRawImgSrcToStatic, STATIC_IMG_PREFIX } from "./img-rewrite.js";

describe("rewriteRawImgSrcToStatic", () => {
  it("rewrites a relative assets/ src attribute to a site-root static path", () => {
    const input = '<img src="assets/abc123.png" alt="icon" className="emoji" />';
    const { content, assets } = rewriteRawImgSrcToStatic(input);
    expect(content).toBe(
      `<img src="${STATIC_IMG_PREFIX}abc123.png" alt="icon" className="emoji" />`,
    );
    expect(assets).toEqual(["abc123.png"]);
  });

  it("handles a realistic full emoji img tag with JSX style object", () => {
    const input =
      '<img src="assets/182d654c7a9e6c2b35788275066f1447fff4ca24cd0f70a34f4b06e0c4326154.png" alt="android" className="emoji" style={{display:"inline",height:"1.2em",width:"auto",verticalAlign:"text-bottom",margin:"0 0.1em"}} />';
    const { content, assets } = rewriteRawImgSrcToStatic(input);
    expect(content).toContain(
      `src="${STATIC_IMG_PREFIX}182d654c7a9e6c2b35788275066f1447fff4ca24cd0f70a34f4b06e0c4326154.png"`,
    );
    expect(content).toContain('className="emoji"');
    expect(assets).toHaveLength(1);
  });

  it("rewrites multiple img tags and dedupes repeated assets", () => {
    const input =
      'Text <img src="assets/a.png" alt="a" /> and <img src="assets/b.png" alt="b" /> again <img src="assets/a.png" alt="a2" /> end.';
    const { content, assets } = rewriteRawImgSrcToStatic(input);
    expect(content).toContain(`src="${STATIC_IMG_PREFIX}a.png" alt="a"`);
    expect(content).toContain(`src="${STATIC_IMG_PREFIX}b.png" alt="b"`);
    expect(content).toContain(`src="${STATIC_IMG_PREFIX}a.png" alt="a2"`);
    expect(assets).toEqual(["a.png", "b.png"]);
  });

  it("leaves markdown images untouched (they are bundler-processed)", () => {
    const input = "![image](assets/abc123.png)";
    const { content, assets } = rewriteRawImgSrcToStatic(input);
    expect(content).toBe(input);
    expect(assets).toEqual([]);
  });

  it("leaves absolute URLs untouched", () => {
    const input = '<img src="https://example.com/image.png" alt="ext" />';
    const { content } = rewriteRawImgSrcToStatic(input);
    expect(content).toBe(input);
  });

  it("leaves site-root /images/ paths untouched (idempotent)", () => {
    const input = `<img src="${STATIC_IMG_PREFIX}abc123.png" alt="icon" />`;
    const once = rewriteRawImgSrcToStatic(input);
    expect(once.content).toBe(input);
    expect(once.assets).toEqual([]);
  });

  it("does not rewrite non-assets/ relative paths", () => {
    const input = '<img src="images/photo.jpg" alt="photo" />';
    const { content } = rewriteRawImgSrcToStatic(input);
    expect(content).toBe(input);
  });

  it("returns an unchanged string when there are no img tags", () => {
    const input = "No images here, just [a link](/docs/page) and **bold**.";
    const { content, assets } = rewriteRawImgSrcToStatic(input);
    expect(content).toBe(input);
    expect(assets).toEqual([]);
  });

  it("leaves a traversal src (../) untouched and reports no asset", () => {
    // Pre-fix this captured `../../.env` and fed it to the asset-copy loop,
    // which joined it into a path on both read and write sides.
    const input = '<img src="assets/../../.env" alt="evil" />';
    const { content, assets } = rewriteRawImgSrcToStatic(input);
    expect(content).toBe(input); // src left as-is → harmless 404, never copied
    expect(assets).toEqual([]);
  });

  it("leaves a multi-segment (subdir) src untouched and reports no asset", () => {
    const input = '<img src="assets/sub/dir.png" alt="nested" />';
    const { content, assets } = rewriteRawImgSrcToStatic(input);
    expect(content).toBe(input);
    expect(assets).toEqual([]);
  });
});
