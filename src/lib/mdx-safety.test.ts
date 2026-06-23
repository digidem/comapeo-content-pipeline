import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findMdxHazards } from "./mdx-safety.js";
import { convertBlocks, type NotionBlockList } from "./notion-converter.js";
import { postProcessMarkdown } from "./post-process.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../test/fixtures");

describe("findMdxHazards", () => {
  it("flags a string style attribute", () => {
    const h = findMdxHazards('<span style="color:red">x</span>');
    expect(h.some((x) => x.kind === "string-or-bare-style")).toBe(true);
  });

  it("flags a bare (brace-stripped) style attribute", () => {
    const h = findMdxHazards('<span style=color:"red">x</span>');
    expect(h.some((x) => x.kind === "string-or-bare-style")).toBe(true);
  });

  it("accepts a JSX object style attribute", () => {
    expect(findMdxHazards('<span style={{color:"red"}}>x</span>')).toEqual([]);
  });

  it("does not flag dangling bold (rendering concern, not a build break)", () => {
    expect(findMdxHazards("**Data Privacy & Security")).toEqual([]);
    expect(findMdxHazards("***Step 1****:* tap **Next**")).toEqual([]);
  });

  it("ignores hazards inside code fences and inline code", () => {
    expect(findMdxHazards('```\n<span style="x">\n```')).toEqual([]);
    expect(findMdxHazards('use `style="x"` literally')).toEqual([]);
  });
});

// Regression gate: the full convert → post-process pipeline must never emit a
// build-breaking construct for any golden fixture.
describe("golden fixtures are MDX-safe end to end", () => {
  const names = readdirSync(join(fixturesDir, "notion"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));

  it.each(names)("%s", (name) => {
    const input: NotionBlockList = JSON.parse(
      readFileSync(join(fixturesDir, "notion", `${name}.json`), "utf8"),
    );
    const rendered = postProcessMarkdown(convertBlocks(input), "");
    expect(findMdxHazards(rendered)).toEqual([]);
  });
});
