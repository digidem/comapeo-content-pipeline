import { describe, it, expect } from "vitest";
import { generateChunks, generateChunksManifest } from "./chunker.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../test/fixtures");

const baseInput = {
  pageId: "abc123",
  title: "Getting Started",
  locale: "en",
  slug: "getting-started",
  sourceUrl: "https://notion.so/abc123",
  docusaurusPath: "/docs/getting-started",
  contentHash: "sha256:abc",
};

describe("generateChunks", () => {
  it("generates a single chunk for short content", async () => {
    const markdown = "## Introduction\n\nThis is a short introduction paragraph.";
    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe("Getting Started");
    expect(chunks[0].heading_path).toEqual(["Introduction"]);
    expect(chunks[0].status).toBe("active");
    expect(chunks[0].page_id).toBe("abc123");
  });

  it("generates deterministic chunk IDs", async () => {
    const markdown = "## Hello\n\nWorld.";
    const chunks1 = await generateChunks({ ...baseInput, markdownBody: markdown });
    const chunks2 = await generateChunks({ ...baseInput, markdownBody: markdown });

    expect(chunks1[0].chunk_id).toBe(chunks2[0].chunk_id);
  });

  it("handles multiple headings", async () => {
    const markdown = `
## First Section

Content one here.

### Sub Section

Deeper content.

## Second Section

More content.
`.trim();

    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Check heading paths
    const paths = chunks.map((c) => c.heading_path.join(" > "));
    expect(paths.some((p) => p.includes("First Section"))).toBe(true);
  });

  it("preserves code blocks without splitting", async () => {
    const markdown = `
## Code Example

Before the code block.

\`\`\`typescript
const x = 1;
const y = 2;
console.log(x + y);
\`\`\`

After the code block.
`.trim();

    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });
    const allText = chunks.map((c) => c.text).join("\n\n");
    expect(allText).toContain("```typescript");
    expect(allText).toContain("const x = 1;");
  });

  it("handles empty markdown", async () => {
    const chunks = await generateChunks({ ...baseInput, markdownBody: "" });
    expect(chunks).toHaveLength(0);
  });

  it("generates large content as multiple chunks", async () => {
    // Create enough text to force chunking
    const longText = Array(200)
      .fill("This is a paragraph with enough text to trigger chunking behavior. ".repeat(5))
      .join("\n\n");

    const markdown = `## Long Section\n\n${longText}`;
    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should have the same heading path
    for (const c of chunks) {
      expect(c.heading_path).toEqual(["Long Section"]);
    }
  });
});

// ── Spec §10.1: minimum chunk size + atomic tables ──

describe("generateChunks — spec §10.1 (min size + atomic tables)", () => {
  // estimateTokens is ceil(len/4), so a run of N chars is exactly N/4 tokens.
  const para = (tokenCount: number): string => "w".repeat(tokenCount * 4);
  const tokens = (text: string): number => Math.ceil(text.length / 4);

  it("keeps a table atomic across a chunk boundary", async () => {
    // A section large enough to split, with a table sitting between two big
    // prose blocks so it lands at a chunk seam.
    const markdown = [
      "## Table Boundary",
      "",
      para(550),
      "",
      "| Name | Role |",
      "| --- | --- |",
      "| Ada | Engineer |",
      "| Bo | Designer |",
      "| Cy | PM |",
      "| Dee | QA |",
      "| Eli | Writer |",
      "| Fen | Support |",
      "| Gia | DevRel |",
      "| Hugo | SRE |",
      "",
      para(550),
    ].join("\n");

    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });
    expect(chunks.length).toBeGreaterThan(1);

    const tableLines = markdown.split("\n").filter((l) => l.startsWith("|"));

    // No chunk may hold a partial table: any chunk that touches the table
    // (overlap can repeat the whole table into a neighbor) must contain every
    // table line — header, separator, and all rows — never a torn subset.
    const chunksWithTables = chunks.filter((c) =>
      c.text.split("\n").some((l) => l.startsWith("|")),
    );
    expect(chunksWithTables.length).toBeGreaterThan(0);
    for (const c of chunksWithTables) {
      for (const line of tableLines) {
        expect(c.text).toContain(line);
      }
    }
  });

  it("merges a sub-minimum split remainder into the previous chunk", async () => {
    // Sized so the trailing piece is < 400 tokens but merges to ≤ 960.
    // Paragraphs (tokens): 460, 460, 100, 241 → final remainder ~342 tokens,
    // which folds into the previous ~560-token chunk (~903 merged).
    const markdown = [
      "## Merge Remainder",
      "",
      para(460),
      "",
      para(460),
      "",
      para(100),
      "",
      para(241),
    ].join("\n");

    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // The merge-up rule guarantees no chunk falls below the 400-token minimum.
    for (const c of chunks) {
      expect(tokens(c.text)).toBeGreaterThanOrEqual(400);
    }
    const finalTokens = tokens(chunks[chunks.length - 1].text);
    expect(finalTokens).toBeGreaterThanOrEqual(400);
    expect(finalTokens).toBeLessThanOrEqual(960);
  });

  it("merge repair never duplicates overlap content (overlap applied after repair)", async () => {
    // Distinct-letter paragraphs so duplication is detectable. Packing leaves a
    // sub-400 trailing piece that merges into its predecessor. With overlap
    // baked in before repair (the old order), the merged chunk carried the
    // predecessor's tail twice.
    const pA = "a".repeat(460 * 4);
    const pB = "b".repeat(460 * 4);
    const pC = "c".repeat(100 * 4);
    const pD = "d".repeat(241 * 4);
    const markdown = ["## Overlap Dup", "", pA, "", pB, "", pC, "", pD].join("\n");

    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // No chunk may contain the same source paragraph twice.
    for (const c of chunks) {
      for (const para of [pA, pB, pC, pD]) {
        const occurrences = c.text.split(para).length - 1;
        expect(occurrences, "paragraph duplicated inside a single chunk").toBeLessThanOrEqual(1);
      }
    }

    // Overlap still present BETWEEN adjacent chunks: each later chunk starts
    // with tail content of its predecessor.
    for (let i = 1; i < chunks.length; i++) {
      const prevTailChar = chunks[i - 1].text.trimEnd().slice(-1);
      expect(chunks[i].text.startsWith(prevTailChar.repeat(10))).toBe(true);
    }
  });

  it("leaves a naturally tiny section as a single small chunk", async () => {
    const markdown = "## Tiny\n\nShort paragraph here, well under the minimum.";
    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });

    // Small sections emit directly via the ≤ max path — never force-merged,
    // never padded, never dropped.
    expect(chunks).toHaveLength(1);
    expect(tokens(chunks[0].text)).toBeLessThan(400);
    expect(chunks[0].heading_path).toEqual(["Tiny"]);
  });
});

// ── Repair pass (round 3): min-size must cover ALL split pieces ──

describe("generateChunks — repair pass (non-tail under-min pieces)", () => {
  // estimateTokens is ceil(len/4); para(n) is exactly n tokens.
  const para = (tokenCount: number): string => "w".repeat(tokenCount * 4);
  const tokens = (text: string): number => Math.ceil(text.length / 4);

  it("merges a leading under-min piece with the next when it fits (reviewer case)", async () => {
    // Heading + small para + big para. Greedy packing emits the heading and the
    // small para as the FIRST piece (~152 tokens), then the big para forces a
    // flush — so the under-min piece is at the START, which the old trailing-
    // only merge never inspected. Repair folds it into the next (≤ 960).
    const markdown = ["## A", "", para(150), "", para(650)].join("\n");
    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });

    // The two pieces merge into one; nothing falls below the 400 minimum.
    expect(chunks).toHaveLength(1);
    const t = tokens(chunks[0].text);
    expect(t).toBeGreaterThanOrEqual(400);
    expect(t).toBeLessThanOrEqual(960);
  });

  it("rebalances when merge would exceed the ceiling, yielding two ≥ min pieces", async () => {
    // Packs to [heading+500+290 ≈ 792, 350]. Merge would be ~1142 > 960, so
    // repair rebalances: recombine with the multi-paragraph neighbor and
    // re-split near even → [~502, ~640], both ≥ 400.
    const markdown = ["## A", "", para(500), "", para(290), "", para(350)].join("\n");
    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });

    // Rebalance keeps two pieces (a merge would have collapsed to one); both
    // must clear the minimum and stay under the ceiling.
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      const t = tokens(c.text);
      expect(t).toBeGreaterThanOrEqual(400);
      expect(t).toBeLessThanOrEqual(960);
    }
  });

  it("leaves an under-min piece as-is when atomicity blocks both merge and rebalance (escape hatch)", async () => {
    // Heading + tiny para + a single oversized fenced code block. Greedy packing
    // emits [~50, ~950]. Merge would exceed 960, and rebalance cannot produce
    // two ≥ 400 halves because the atomic code block cannot be subdivided — any
    // split leaves one side below the minimum. The documented escape hatch
    // fires: the small piece is emitted unchanged.
    const codeBody = "x".repeat(950 * 4); // 950 tokens: merge (~1001) exceeds the 960 ceiling
    const codeBlock = "```ts\n" + codeBody + "\n```";
    const markdown = ["## A", "", para(49), "", codeBlock].join("\n");
    const chunks = await generateChunks({ ...baseInput, markdownBody: markdown });

    expect(chunks).toHaveLength(2);
    // The exception: a sub-minimum chunk survives where atomicity makes the
    // minimum impossible.
    expect(tokens(chunks[0].text)).toBeLessThan(400);
    // The atomic code block stays whole in the neighbor.
    expect(chunks[1].text).toContain("```ts");
    expect(chunks[1].text).toContain("```");
  });
});

describe("generateChunksManifest", () => {
  it("generates a valid manifest", async () => {
    const chunks = await generateChunks({
      ...baseInput,
      markdownBody: "## Hello\n\nWorld.",
    });

    const manifest = generateChunksManifest(chunks);
    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.generated_at).toBeDefined();
  });
});

// ── Golden fixture (spec §15.2) ──

describe("generateChunks — golden fixture", () => {
  it("deep-equals test/fixtures/expected/chunks.json", async () => {
    // Fixed markdown doc (~1200 words, h2/h3 headings, a table, a fenced code
    // block). Input params are identical to the throwaway generator so the
    // output is byte-stable.
    const markdown = readFileSync(
      join(fixturesDir, "golden", "golden-doc.md"),
      "utf8",
    );

    const chunks = await generateChunks({
      pageId: "abc123",
      title: "CoMapeo Synchronization",
      locale: "en",
      slug: "sync",
      sourceUrl: "https://notion.so/abc123",
      docusaurusPath: "/sync",
      contentHash: "sha256:abc",
      markdownBody: markdown,
    });

    // No volatile fields to normalize: chunk_id is a content-hash of
    // deterministic inputs (pageId:contentHash:headingPath.join("/"):chunkIndex)
    // and a RagChunk carries no timestamps. The full array compares as-is.
    const expected = JSON.parse(
      readFileSync(join(fixturesDir, "expected", "chunks.json"), "utf8"),
    );

    expect(JSON.parse(JSON.stringify(chunks))).toEqual(expected);
  });
});
