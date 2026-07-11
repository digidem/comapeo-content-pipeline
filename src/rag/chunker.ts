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
 * Preserves paragraph, code-block, and table boundaries. After greedy packing, a
 * repair pass merges or rebalances ANY piece that fell below `minTokens` — not
 * just the trailing remainder — so an under-sized piece cannot sit in the middle
 * of the sequence. Atomic units (code fences, tables) stay whole, so a piece
 * pinned between oversized atoms is left as-is as a best-effort exception.
 */
function splitText(
  text: string,
  minTokens: number,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  const paragraphs = splitByParagraphs(text);

  // Phase 1 — pack paragraphs greedily into pieces (NO overlap yet).
  const pieces: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (currentTokens + paraTokens > maxTokens && current.length > 0) {
      pieces.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(para);
    currentTokens += paraTokens;
  }
  if (current.length > 0) pieces.push(current);

  // Phase 2 — min-size repair (spec §10.1) on the raw pieces. Greedy packing
  // can leave a piece below the minimum anywhere in the sequence, not just as
  // a trailing remainder. A naturally small section never reaches splitText
  // (it emits via the ≤ max path), so this only ever collapses split pieces —
  // never forces cross-section merging.
  repairMinSize(pieces, minTokens, maxTokens);

  // Phase 3 — overlap is applied LAST, between the final (post-repair)
  // adjacent pieces. Applying it during packing and repairing afterwards
  // duplicated content: merging a piece into its predecessor kept the
  // predecessor-tail overlap baked into the piece, so the merged chunk carried
  // those paragraphs twice.
  return pieces.map((piece, idx) => {
    if (idx === 0) return piece.join("\n\n");
    const overlapText = buildOverlap(pieces[idx - 1], overlapTokens);
    return overlapText ? [overlapText, ...piece].join("\n\n") : piece.join("\n\n");
  });
}

/** Token estimate for a piece (its paragraphs joined as they will be emitted). */
function pieceTokens(piece: string[]): number {
  return estimateTokens(piece.join("\n\n"));
}

/**
 * Repair pass over packed pieces: ensure every piece reaches `minTokens` when
 * atomicity allows it. Walks left to right (re-checking after each repair) and
 * is bounded to one full pass plus a single re-pass — no unbounded loops.
 *
 * For each under-minimum piece, in priority order:
 *   1. Merge with an adjacent piece (prefer the previous; else the next) when
 *      the combined size stays ≤ maxTokens * 1.2.
 *   2. Rebalance with the larger neighbor: re-split their combined paragraphs
 *      at the boundary closest to an even split — but only when both resulting
 *      pieces reach `minTokens`. A single-unit (atomic) neighbor is skipped,
 *      since it cannot be re-split.
 *   3. Leave as-is (escape hatch): when neither applies — e.g. a small piece
 *      pinned next to an oversized atomic unit — the minimum is best-effort.
 */
function repairMinSize(pieces: string[][], minTokens: number, maxTokens: number): void {
  const mergeCeiling = Math.ceil(maxTokens * 1.2);

  for (let pass = 0; pass < 2; pass++) {
    let repaired = false;
    for (let i = 0; i < pieces.length; i++) {
      if (pieceTokens(pieces[i]) >= minTokens) continue;

      // 1. Merge with previous neighbor when it fits.
      if (i > 0 && pieceTokens([...pieces[i - 1], ...pieces[i]]) <= mergeCeiling) {
        pieces[i - 1] = [...pieces[i - 1], ...pieces[i]];
        pieces.splice(i, 1);
        repaired = true;
        i--; // re-check the slot that just shifted into index i
        continue;
      }

      // 1b. Else merge with the next neighbor when it fits.
      if (i < pieces.length - 1 && pieceTokens([...pieces[i], ...pieces[i + 1]]) <= mergeCeiling) {
        pieces[i] = [...pieces[i], ...pieces[i + 1]];
        pieces.splice(i + 1, 1);
        repaired = true;
        i--; // re-check this slot (now holds the merged piece)
        continue;
      }

      // 2. Rebalance with the larger neighbor when no merge fits.
      if (rebalancePiece(pieces, i, minTokens)) {
        repaired = true;
        i--; // re-check the rebalanced slot
        continue;
      }

      // 3. Escape hatch: leave as-is.
    }
    if (!repaired) break;
  }
}

/**
 * Rebalance the under-minimum piece at `pieces[i]` against its larger neighbor:
 * recombine their paragraphs and re-split at the boundary closest to even. Only
 * commits when both halves reach `minTokens`; a single-paragraph (atomic)
 * neighbor is skipped because it cannot be subdivided. Returns true when applied.
 */
function rebalancePiece(pieces: string[][], i: number, minTokens: number): boolean {
  const prev = i > 0 ? pieces[i - 1] : null;
  const next = i < pieces.length - 1 ? pieces[i + 1] : null;

  let neighbor: string[] | null = null;
  let neighborIdx = -1;
  if (prev && next) {
    if (pieceTokens(next) >= pieceTokens(prev)) {
      neighbor = next;
      neighborIdx = i + 1;
    } else {
      neighbor = prev;
      neighborIdx = i - 1;
    }
  } else if (prev) {
    neighbor = prev;
    neighborIdx = i - 1;
  } else if (next) {
    neighbor = next;
    neighborIdx = i + 1;
  }
  if (!neighbor) return false;

  // Atomic guard: a single-unit neighbor cannot be re-split.
  if (neighbor.length <= 1) return false;

  const combined =
    neighborIdx < i ? [...neighbor, ...pieces[i]] : [...pieces[i], ...neighbor];
  const combinedTokens = combined.reduce((sum, p) => sum + estimateTokens(p), 0);
  if (combinedTokens < minTokens * 2) return false;

  // Paragraph boundary (number of leading paragraphs) closest to an even split.
  let bestSplit = 1;
  let bestDiff = Infinity;
  let running = 0;
  for (let k = 0; k < combined.length - 1; k++) {
    running += estimateTokens(combined[k]);
    const diff = Math.abs(running - (combinedTokens - running));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = k + 1;
    }
  }

  const firstHalf = combined.slice(0, bestSplit);
  const secondHalf = combined.slice(bestSplit);
  if (pieceTokens(firstHalf) < minTokens || pieceTokens(secondHalf) < minTokens) {
    return false;
  }

  const lo = neighborIdx < i ? neighborIdx : i;
  const hi = neighborIdx < i ? i : neighborIdx;
  pieces[lo] = firstHalf;
  pieces[hi] = secondHalf;
  return true;
}

/**
 * Split text into logical paragraphs, preserving code blocks and tables.
 */
function splitByParagraphs(text: string): string[] {
  const parts: string[] = [];
  let inCodeBlock = false;
  let buffer: string[] = [];

  function flush() {
    if (buffer.length > 0) {
      parts.push(buffer.join("\n"));
      buffer = [];
    }
  }

  for (const line of text.split("\n")) {
    // Fenced code blocks are atomic units (spec §10.1).
    if (line.startsWith("```")) {
      if (!inCodeBlock) flush(); // break any in-progress paragraph
      inCodeBlock = !inCodeBlock;
      buffer.push(line);
      if (!inCodeBlock) flush(); // closing fence → emit whole block
      continue;
    }

    if (inCodeBlock) {
      buffer.push(line);
      continue;
    }

    // Markdown tables are atomic units too: a run of consecutive lines each
    // starting with "|" (header + separator + rows) stays together, mirroring
    // code-fence protection. A table larger than max chunk size is emitted
    // whole as an oversized unit (same as an oversized code block).
    const isTableLine = line.startsWith("|");
    const bufferIsTable =
      buffer.length > 0 && buffer.every((b) => b.startsWith("|"));
    if (buffer.length > 0 && isTableLine !== bufferIsTable) {
      flush(); // boundary between prose and a table run
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    buffer.push(line);
  }

  flush();

  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Build overlap text from the end of the current chunk.
 */
function buildOverlap(paragraphs: string[], targetTokens: number): string {
  let tokens = 0;
  const overlap: string[] = [];

  // Spec targets 80–120 overlap tokens: cap whole-paragraph accumulation at
  // target * 1.2 (= 120 for the default 100) so no oversized paragraph rides
  // along whole.
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const pt = estimateTokens(paragraphs[i]);
    if (tokens + pt > targetTokens * 1.2) break;
    overlap.unshift(paragraphs[i]);
    tokens += pt;
  }

  if (overlap.length === 0) {
    // The tail paragraph alone exceeds the overlap budget (spec targets
    // 80–120 tokens — carrying a whole 400+-token paragraph as "overlap" both
    // bloats the next chunk and violates the target). Slice the trailing
    // characters of prose; NEVER tear an atomic unit (code fence / table) —
    // skip the overlap entirely instead.
    const tail = paragraphs[paragraphs.length - 1];
    if (tail.startsWith("```") || tail.startsWith("|")) return "";
    return tail.slice(-targetTokens * 4);
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
