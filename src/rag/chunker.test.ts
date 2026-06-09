import { describe, it, expect } from "vitest";
import { generateChunks, generateChunksManifest } from "./chunker.js";

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
  it("generates a single chunk for short content", () => {
    const markdown = "## Introduction\n\nThis is a short introduction paragraph.";
    const chunks = generateChunks({ ...baseInput, markdownBody: markdown });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe("Getting Started");
    expect(chunks[0].heading_path).toEqual(["Introduction"]);
    expect(chunks[0].status).toBe("active");
    expect(chunks[0].page_id).toBe("abc123");
  });

  it("generates deterministic chunk IDs", () => {
    const markdown = "## Hello\n\nWorld.";
    const chunks1 = generateChunks({ ...baseInput, markdownBody: markdown });
    const chunks2 = generateChunks({ ...baseInput, markdownBody: markdown });

    expect(chunks1[0].chunk_id).toBe(chunks2[0].chunk_id);
  });

  it("handles multiple headings", () => {
    const markdown = `
## First Section

Content one here.

### Sub Section

Deeper content.

## Second Section

More content.
`.trim();

    const chunks = generateChunks({ ...baseInput, markdownBody: markdown });
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Check heading paths
    const paths = chunks.map((c) => c.heading_path.join(" > "));
    expect(paths.some((p) => p.includes("First Section"))).toBe(true);
  });

  it("preserves code blocks without splitting", () => {
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

    const chunks = generateChunks({ ...baseInput, markdownBody: markdown });
    const allText = chunks.map((c) => c.text).join("\n\n");
    expect(allText).toContain("```typescript");
    expect(allText).toContain("const x = 1;");
  });

  it("handles empty markdown", () => {
    const chunks = generateChunks({ ...baseInput, markdownBody: "" });
    expect(chunks).toHaveLength(0);
  });

  it("generates large content as multiple chunks", () => {
    // Create enough text to force chunking
    const longText = Array(200)
      .fill("This is a paragraph with enough text to trigger chunking behavior. ".repeat(5))
      .join("\n\n");

    const markdown = `## Long Section\n\n${longText}`;
    const chunks = generateChunks({ ...baseInput, markdownBody: markdown });

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should have the same heading path
    for (const c of chunks) {
      expect(c.heading_path).toEqual(["Long Section"]);
    }
  });
});

describe("generateChunksManifest", () => {
  it("generates a valid manifest", () => {
    const chunks = generateChunks({
      ...baseInput,
      markdownBody: "## Hello\n\nWorld.",
    });

    const manifest = generateChunksManifest(chunks);
    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.generated_at).toBeDefined();
  });
});
