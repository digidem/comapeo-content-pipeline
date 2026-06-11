/**
 * RAG chunk generation from canonical Markdown.
 *
 * Per spec §10:
 *   - Input: canonical Markdown
 *   - Target size: 400–800 tokens
 *   - Overlap: 80–120 tokens
 *   - Preserve page title and heading path
 *   - Do not split tables or code blocks unless unavoidable
 *   - Skip draft/deprecated pages by default
 */

import { contentHash as computeHash } from "../lib/hash.js";
import type { RagChunk } from "../schemas/rag.js";

export interface ChunkInput {
  pageId: string;
  title: string;
  locale: string;
  slug: string;
  sourceUrl: string;
  docusaurusPath: string;
  contentHash: string;
  markdownBody: string;
}

/**
 * Estimate token count from text (rough: ~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate chunks from a single page's Markdown body.
 */
export async function generateChunks(input: ChunkInput): Promise<RagChunk[]> {
  const { pageId, title, locale, slug, sourceUrl, docusaurusPath, contentHash, markdownBody } = input;

  const sections = splitIntoSections(markdownBody);
  const chunks: RagChunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const sectionTokens = estimateTokens(section.text);

    // If section fits in one chunk, emit it directly
    if (sectionTokens <= 800) {
      chunks.push(await buildChunk({
        pageId, title, locale, slug, sourceUrl, docusaurusPath,
        contentHash, headingPath: section.headingPath,
        text: section.text.trim(),
        chunkIndex: chunkIndex++,
      }));
      continue;
    }

    // Split large section into overlapping chunks
    const subChunks = splitText(section.text, 400, 800, 100);
    for (const sub of subChunks) {
      chunks.push(await buildChunk({
        pageId, title, locale, slug, sourceUrl, docusaurusPath,
        contentHash, headingPath: section.headingPath,
        text: sub.trim(),
        chunkIndex: chunkIndex++,
      }));
    }
  }

  return chunks;
}

interface Section {
  headingPath: string[];
  text: string;
}

/**
 * Split markdown into sections by headings.
 */
function splitIntoSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  let currentLines: string[] = [];

  function flushSection() {
    const text = currentLines.join("\n").trim();
    if (text.length > 0 || headingStack.length > 0) {
      sections.push({
        headingPath: headingStack.map((h) => h.title),
        text,
      });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flushSection();

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Update heading stack
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });

      // Add the heading line itself to the new section
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }

  flushSection();
  return sections;
}

/**
 * Split text into overlapping chunks aiming for [minTokens, maxTokens] token range.
 * Preserves paragraph and code-block boundaries.
 */
function splitText(
  text: string,
  _minTokens: number,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  const paragraphs = splitByParagraphs(text);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (currentTokens + paraTokens > maxTokens && current.length > 0) {
      // Emit current chunk
      chunks.push(current.join("\n\n"));

      // Overlap: keep last ~overlapTokens tokens
      const overlapText = buildOverlap(current, overlapTokens);
      current = overlapText ? [overlapText] : [];
      currentTokens = estimateTokens(overlapText);
    }

    current.push(para);
    currentTokens += paraTokens;
  }

  // Emit final chunk
  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }

  return chunks;
}

/**
 * Split text into logical paragraphs, preserving code blocks.
 */
function splitByParagraphs(text: string): string[] {
  const parts: string[] = [];
  let inCodeBlock = false;
  let buffer: string[] = [];

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("```")) {
      // Flush current paragraph
      if (buffer.length > 0 && !inCodeBlock) {
        parts.push(buffer.join("\n"));
        buffer = [];
      }
      inCodeBlock = !inCodeBlock;
      buffer.push(line);
      if (!inCodeBlock) {
        // End of code block — emit as single unit
        parts.push(buffer.join("\n"));
        buffer = [];
      }
      continue;
    }

    if (!inCodeBlock && line.trim() === "") {
      if (buffer.length > 0) {
        parts.push(buffer.join("\n"));
        buffer = [];
      }
      continue;
    }

    // Inside code block or regular text
    buffer.push(line);
  }

  if (buffer.length > 0) {
    parts.push(buffer.join("\n"));
  }

  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Build overlap text from the end of the current chunk.
 */
function buildOverlap(paragraphs: string[], targetTokens: number): string {
  let tokens = 0;
  const overlap: string[] = [];

  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const pt = estimateTokens(paragraphs[i]);
    if (tokens + pt > targetTokens * 1.5 && overlap.length > 0) break;
    overlap.unshift(paragraphs[i]);
    tokens += pt;
  }

  return overlap.join("\n\n");
}

// ── Chunk builder ──

async function buildChunk(params: {
  pageId: string;
  title: string;
  locale: string;
  slug: string;
  sourceUrl: string;
  docusaurusPath: string;
  contentHash: string;
  headingPath: string[];
  text: string;
  chunkIndex: number;
}): Promise<RagChunk> {
  const { pageId, title, locale, slug, sourceUrl, docusaurusPath, contentHash, headingPath, text, chunkIndex } = params;

  const chunkId = await computeHash(
    `${pageId}:${contentHash}:${headingPath.join("/")}:${chunkIndex}`,
  );

  return {
    chunk_id: chunkId,
    page_id: pageId,
    title,
    locale,
    slug,
    heading_path: headingPath,
    text,
    source_url: sourceUrl,
    docusaurus_path: docusaurusPath,
    content_hash: contentHash,
    status: "active",
  };
}

/**
 * Generate chunks manifest.
 */
export function generateChunksManifest(
  chunks: RagChunk[],
): { schema_version: string; generated_at: string; chunks: RagChunk[] } {
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    chunks,
  };
}
