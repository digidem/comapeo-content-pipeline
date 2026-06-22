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
 *
 * Strips an optional chain of "insubstantial" prefixes before the H1:
 *   whitespace → (divider → whitespace)* → (spacer → whitespace)* → H1
 * If the H1 matches the page title, the entire chain + H1 is removed.
 */
export function removeDuplicateTitle(
  content: string,
  pageTitle: string,
): string {
  if (!content || !pageTitle) return content;

  // Normalize: track how much leading content to eat
  let pos = 0;
  const len = content.length;

  // Eat whitespace
  while (pos < len && (content[pos] === " " || content[pos] === "\t" || content[pos] === "\n" || content[pos] === "\r")) {
    pos++;
  }

  // Eat optional --- divider (repeated)
  while (pos < len && content.slice(pos).startsWith("---")) {
    const nl = content.indexOf("\n", pos);
    pos = nl === -1 ? len : nl + 1;
    // Eat whitespace after divider
    while (pos < len && (content[pos] === " " || content[pos] === "\t" || content[pos] === "\n" || content[pos] === "\r")) {
      pos++;
    }
  }

  // Eat optional notion-spacer div (repeated)
  const spacerTag = '<div class="notion-spacer" aria-hidden="true" role="presentation"></div>';
  while (pos < len && content.slice(pos).startsWith(spacerTag)) {
    pos += spacerTag.length;
    // Eat whitespace after spacer
    while (pos < len && (content[pos] === " " || content[pos] === "\t" || content[pos] === "\n" || content[pos] === "\r")) {
      pos++;
    }
    // Eat optional --- divider after spacer
    while (pos < len && content.slice(pos).startsWith("---")) {
      const nl = content.indexOf("\n", pos);
      pos = nl === -1 ? len : nl + 1;
      while (pos < len && (content[pos] === " " || content[pos] === "\t" || content[pos] === "\n" || content[pos] === "\r")) {
        pos++;
      }
    }
  }

  // Eat optional leading images (hero/banner images — decorative, not content)
  // These are images with no accompanying text before the H1 title.
  while (pos < len && content.slice(pos).startsWith("![")) {
    const nl = content.indexOf("\n", pos);
    pos = nl === -1 ? len : nl + 1;
    // Eat whitespace after image
    while (pos < len && (content[pos] === " " || content[pos] === "\t" || content[pos] === "\n" || content[pos] === "\r")) {
      pos++;
    }
    // Eat optional spacers/dividers between multiple images
    while (pos < len && content.slice(pos).startsWith(spacerTag)) {
      pos += spacerTag.length;
      while (pos < len && (content[pos] === " " || content[pos] === "\t" || content[pos] === "\n" || content[pos] === "\r")) {
        pos++;
      }
    }
  }

  // Check if now at an H1
  if (pos >= len || content[pos] !== "#" || content[pos + 1] !== " ") {
    return content; // Not an H1 — content is substantial, preserve everything
  }

  const nlAfter = content.indexOf("\n", pos);
  const h1Line = nlAfter === -1 ? content.slice(pos) : content.slice(pos, nlAfter);
  const h1Text = h1Line.slice(2).trim();

  if (
    h1Text === pageTitle ||
    pageTitle.includes(h1Text) ||
    h1Text.includes(pageTitle)
  ) {
    // Keep everything before the H1 (whitespace, spacers, images) but remove the H1 itself
    const before = content.slice(0, pos);
    let after = nlAfter === -1 ? "" : content.slice(nlAfter);
    after = after.replace(/^\n+/, "");
    return before + after;
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

  // 0b. Mask JSX style objects (`style={{…}}`) so the curly-brace stripper and
  // malformed-tag fixers below can't corrupt them. The converter emits color
  // runs as `<span style={{color:"red"}}>` and custom emoji as inline
  // `<img … style={{…}} />`; both must survive sanitization intact (a string
  // style or stripped braces throws at MDX static-site-generation time).
  const styleObjects: string[] = [];
  sanitized = sanitized.replace(/style=\{\{[^{}]*\}\}/g, (m) => {
    styleObjects.push(m);
    return `__STYLEOBJ_${styleObjects.length - 1}__`;
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

  // Restore masked JSX style objects.
  sanitized = sanitized.replace(
    /__STYLEOBJ_(\d+)__/g,
    (_m, i) => styleObjects[Number(i)],
  );

  return sanitized;
}

/**
 * Sanitize markdown image syntax.
 *
 * Fixes common image issues from Notion exports:
 * - Removes images with empty URLs: `![alt]()`
 * - Removes images with invalid placeholders: `![alt](undefined)`, `![alt](null)`
 * - Strips whitespace from image URLs: `![alt]( url with spaces )`
 */
export function sanitizeMarkdownImages(content: string): string {
	if (!content) return content;

	// Remove images with empty or invalid URLs, then strip whitespace from remaining URLs
	let result = content
		.replace(/!\[([^\]]*)\]\((undefined|null)\)/gi, "")
		.replace(/!\[([^\]]*)\]\(\s*\)/g, "")
		.replace(
			/!\[([^\]]*)\]\(([^)]+)\)/g,
			(_match, alt, url) => `![${alt}](${url.replace(/\s+/g, "")})`,
		);

	// Clean up blank lines left by removed images
	result = result.replace(/\n{3,}/g, "\n\n");

	return result;
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

	// Phase 3: Sanitize markdown images (remove empty/invalid URLs, strip whitespace)
	processed = sanitizeMarkdownImages(processed);

	// Phase 4: Remove duplicate H1 matching the page title (after sanitize so heading hierarchy is already fixed)
	processed = removeDuplicateTitle(processed, pageTitle);

	return processed;
}
