/**
 * Markdown post-processing pipeline.
 *
 * Transforms applied to the raw Notion→Markdown output before
 * frontmatter serialization. Runtime-agnostic (no Node APIs).
 *
 * Reference: ../comapeo-docs/scripts/notion-fetch/
 *   - contentWriter.ts    → removeDuplicateTitle
 *   - markdownTransform.ts → ensureBlankLineAfterStandaloneBold
 *   - contentSanitizer.ts  → sanitizeMarkdownContent
 */

const EMOJI_STYLE_MARKERS = ["display:", "height:", "margin:"];

const isEmojiStyleObject = (snippet: string): boolean =>
  EMOJI_STYLE_MARKERS.every((marker) => snippet.includes(marker));

const isEmojiImgTag = (snippet: string): boolean =>
  snippet.includes('className="emoji"');

/**
 * Remove a leading H1 heading that duplicates the page title.
 *
 * Notion exports often include an H1 that matches the page title.
 * This prevents duplicate titles in Docusaurus (which uses frontmatter title).
 */
export function removeDuplicateTitle(
  content: string,
  pageTitle: string,
): string {
  if (!content || !pageTitle) return content;

  const firstH1Regex = /^\s*# (.+?)(?:\n|$)/;
  const match = content.match(firstH1Regex);
  if (!match) return content;

  const firstH1Text = match[1].trim();
  if (
    firstH1Text === pageTitle ||
    pageTitle.includes(firstH1Text) ||
    firstH1Text.includes(pageTitle)
  ) {
    let processed = content.replace(match[0], "");
    processed = processed.replace(/^\s+/, "");
    return processed;
  }

  return content;
}

/**
 * Ensure a blank line after standalone bold lines like `**Heading**`.
 *
 * These represent section titles in Notion where bold text precedes
 * descriptive content. Without blank lines, adjacent content merges
 * into the same paragraph.
 */
export function ensureBlankLineAfterStandaloneBold(
  content: string,
): string {
  if (!content) return content;

  const lines = content.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result.push(line);

    const nextLine = lines[i + 1];
    const isStandaloneBold = /^\s*\*\*[^*].*\*\*\s*$/.test(line.trim());
    const nextLineHasContent =
      nextLine !== undefined && nextLine.trim().length > 0;

    if (isStandaloneBold && nextLineHasContent) {
      result.push("");
    }
  }

  return result.join("\n");
}

/**
 * Fix heading hierarchy for proper Docusaurus TOC generation.
 * - Keeps only the first H1 (page title)
 * - Converts subsequent H1s to H2s
 * - Removes empty headings
 */
function fixHeadingHierarchy(
  content: string,
  codeBlockPlaceholders: string[],
): string {
  const lines = content.split("\n");
  let firstH1Found = false;

  const fixedLines = lines.map((line) => {
    // Skip code block placeholders
    if (
      codeBlockPlaceholders.some((p) => line.includes(p))
    ) {
      return line;
    }

    const headingMatch = line.match(/^(\s{0,3})(#{1,6})\s*(.*)$/);
    if (!headingMatch) return line;

    const [, leading, hashes, text] = headingMatch;
    const level = hashes.length;
    const trimmedText = text.trim();

    // Remove empty headings
    if (trimmedText === "") return "";

    if (level === 1) {
      if (!firstH1Found) {
        firstH1Found = true;
        return line;
      }
      // Demote subsequent H1s to H2s
      return `${leading}## ${trimmedText}`;
    }

    return line;
  });

  return fixedLines.join("\n");
}

/**
 * Sanitize markdown content for Docusaurus MDX compatibility.
 *
 * - Fixes heading hierarchy
 * - Strips Notion curly-brace formula artifacts
 * - Fixes malformed HTML/JSX tags
 * - Preserves code blocks during processing
 */
export function sanitizeMarkdownContent(content: string): string {
  if (!content) return content;

  // 0. Mask code fences and inline code to avoid altering them
  const codeBlocks: string[] = [];
  const codeSpans: string[] = [];
  const codeBlockPlaceholders: string[] = [];

  let sanitized = content;
  sanitized = sanitized.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    const placeholder = `__CODEBLOCK_${codeBlocks.length - 1}__`;
    codeBlockPlaceholders.push(placeholder);
    return placeholder;
  });
  sanitized = sanitized.replace(/`[^`\n]*`/g, (m) => {
    codeSpans.push(m);
    return `__CODESPAN_${codeSpans.length - 1}__`;
  });

  // 1. Fix heading hierarchy
  sanitized = fixHeadingHierarchy(sanitized, codeBlockPlaceholders);

  // 2. Strip curly-brace expressions (Notion formula artifacts) — preserve emoji JSX
  for (let i = 0; i < 5 && /\{[^{}]*\}/.test(sanitized); i++) {
    sanitized = sanitized.replace(/\{([^{}]*)\}/g, (_match, inner) =>
      isEmojiStyleObject(_match) ? _match : String(inner).trim(),
    );
  }

  // 3. Fix malformed <link to section.> patterns
  sanitized = sanitized.replace(
    /<link\s+to\s+section\.?>/gi,
    "[link to section](#section)",
  );

  // 4. Fix other malformed <link> tags with invalid attributes
  sanitized = sanitized.replace(
    /<link\s+[^>]*[^\w\s"=-][^>]*>/g,
    "[link](#)",
  );

  // 5. Fix malformed <Link> tags
  sanitized = sanitized.replace(
    /<Link\s+[^>]*[^\w\s"=-][^>]*>/g,
    "[Link](#)",
  );

  // 6. Fix tags with dots or spaces in attribute names (exclude emoji img tags)
  sanitized = sanitized.replace(
    /<([a-zA-Z][a-zA-Z0-9]*)\s+([^>]*?)([.\s]+)([^>]*?)>/g,
    (match, tagName, before, _separator, after) => {
      if (tagName.toLowerCase() === "img" && isEmojiImgTag(before + after)) {
        return match;
      }
      if (_separator.includes(".") ||
          (_separator.includes(" ") && !before.includes("="))) {
        return `[${tagName}](#${tagName.toLowerCase()})`;
      }
      return match;
    },
  );

  // 7. Final cleanup: any remaining curly braces
  for (let i = 0; i < 3 && /\{[^{}]*\}/.test(sanitized); i++) {
    sanitized = sanitized.replace(/\{([^{}]*)\}/g, (match, inner) =>
      isEmojiStyleObject(match) ? match : inner,
    );
  }

  // 8. Restore masked code blocks and inline code
  sanitized = sanitized.replace(
    /__CODEBLOCK_(\d+)__/g,
    (_m, i) => codeBlocks[Number(i)],
  );
  sanitized = sanitized.replace(
    /__CODESPAN_(\d+)__/g,
    (_m, i) => codeSpans[Number(i)],
  );

  return sanitized;
}

/**
 * Apply all post-processing transforms to markdown content.
 *
 * Called by sync.ts after convertBlocks() and before contentHash().
 */
export function postProcessMarkdown(
  content: string,
  pageTitle: string,
): string {
  if (!content) return "";

  let processed = content;

  // Phase 1: Ensure blank lines after standalone bold headings
  processed = ensureBlankLineAfterStandaloneBold(processed);

  // Phase 2: Sanitize for MDX compatibility (heading hierarchy, curly braces, malformed HTML)
  processed = sanitizeMarkdownContent(processed);

  // Phase 3: Remove duplicate H1 matching the page title (after sanitize so heading hierarchy is already fixed)
  processed = removeDuplicateTitle(processed, pageTitle);

  return processed;
}
