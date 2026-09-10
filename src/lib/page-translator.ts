/**
 * Page-level translation orchestrator.
 *
 * Combines block-level translation, Docusaurus markdown generation,
 * metadata localization, and MDX hazard safety validation.
 */

import type { NotionBlockList } from "./notion-converter.js";
import { convertBlocks } from "./notion-converter.js";
import type { PageMetadata } from "../schemas/metadata.js";
import { AITranslator, type TranslationBlock } from "./ai-translator.js";
import { extractTranslatableBlocks, applyTranslatedBlocks } from "./block-translator.js";
import { formatGlossaryPrompt, type Glossary } from "./glossary.js";
import { postProcessMarkdown } from "./post-process.js";
import { buildFrontmatter, serializeDoc } from "./frontmatter.js";
import { contentHash } from "./hash.js";
import { findMdxHazards } from "./mdx-safety.js";
import { rehostMarkdownAssets } from "./assets.js";

/**
 * Replaces inline HTML tags (like `<img ... />` or `<br />`) with stable tokens
 * to protect them from LLM formatting corruption or URL modification.
 */
export function maskHtmlTags(text: string): {
  masked: string;
  tagMap: Map<string, string>;
} {
  const tagMap = new Map<string, string>();
  let counter = 0;

  // Match inline <img ... /> or <br /> tags
  const TAG_REGEX = /<img\b[^>]*\/?>|<br\s*\/?>/gi;

  const masked = text.replace(TAG_REGEX, (match) => {
    const placeholder = `⟦TAG_${counter++}⟧`;
    tagMap.set(placeholder, match);
    return placeholder;
  });

  return { masked, tagMap };
}

/**
 * Restores original HTML tags from placeholder tokens, handling potential LLM formatting variations.
 */
export function unmaskHtmlTags(text: string, tagMap: Map<string, string>): string {
  let result = text;
  for (const [placeholder, originalTag] of tagMap.entries()) {
    if (result.includes(placeholder)) {
      result = result.replaceAll(placeholder, originalTag);
      continue;
    }

    const match = placeholder.match(/\d+/);
    if (match) {
      const id = match[0];
      const loosePattern = new RegExp(`(?:⟦|\\[|\\[\\[|«)\\s*TAG_${id}\\s*(?:⟧|\\]|\\]\\]|»)`, "gi");
      result = result.replace(loosePattern, originalTag);
    }
  }
  return result;
}

export interface TranslatePageOptions {
  enRawBlocks: NotionBlockList;
  enMetadata: PageMetadata;
  targetLocale: "pt" | "es";
  translator: AITranslator;
  glossary: Glossary;
  targetPageId?: string;
  dryRun?: boolean;
}

export interface TranslatePageResult {
  targetLocale: string;
  targetPageId: string;
  title: string;
  markdownBody: string;
  translatedMd: string;
  translatedBlocks: NotionBlockList;
  translatedMetadata: PageMetadata;
  blockCount: number;
}

/**
 * Translate a complete documentation page into the target locale.
 *
 * Uses the inverted architecture: preserves English block layout and image
 * references, translates only human-readable text via the AI client with
 * domain glossary guidance, and serializes to clean Docusaurus markdown.
 */
export async function translatePageContent(
  opts: TranslatePageOptions,
): Promise<TranslatePageResult> {
  const { enRawBlocks, enMetadata, targetLocale, translator, glossary } = opts;
  const targetPageId = opts.targetPageId ?? `${enMetadata.page_id}-${targetLocale}`;

  // 1. Extract translatable block segments
  const extracted = extractTranslatableBlocks(enRawBlocks);

  // 2. Add title as a translatable element
  const titleBlock: TranslationBlock = {
    id: "__page_title__",
    text: enMetadata.title,
  };
  const allBlocks: TranslationBlock[] = [titleBlock, ...extracted];

  // 3. Mask inline HTML tags to protect URLs and attributes from LLM formatting
  const blockTagMaps = new Map<string, Map<string, string>>();
  const maskedBlocks: TranslationBlock[] = allBlocks.map((b) => {
    const { masked, tagMap } = maskHtmlTags(b.text);
    if (tagMap.size > 0) {
      blockTagMaps.set(b.id, tagMap);
    }
    return { id: b.id, text: masked };
  });

  // 4. Translate via AI client with glossary
  const glossaryPrompt = formatGlossaryPrompt(glossary, targetLocale);
  const rawTranslations = await translator.translate({
    targetLocale,
    blocks: maskedBlocks,
    glossaryPrompt,
    pageContext: `Documentation page: "${enMetadata.title}" in section "${enMetadata.section}"`,
  });

  // 5. Unmask HTML tags in translated output
  const translations: Record<string, string> = {};
  for (const [id, transText] of Object.entries(rawTranslations)) {
    const tagMap = blockTagMaps.get(id);
    translations[id] = tagMap ? unmaskHtmlTags(transText, tagMap) : transText;
  }

  // 6. Resolve translated title
  const translatedTitle = translations["__page_title__"]?.trim() || enMetadata.title;

  // 7. Apply translations to cloned Notion block tree
  const translatedBlocks = applyTranslatedBlocks(enRawBlocks, translations);

  // 8. Convert blocks to Docusaurus Markdown & post-process
  let markdownBody = convertBlocks(translatedBlocks);
  markdownBody = postProcessMarkdown(markdownBody, translatedTitle);

  // 9. Rehost asset URLs using English metadata (temporary Notion S3 -> stable local assets/<sha256>.<ext>)
  if (enMetadata.assets && enMetadata.assets.length > 0) {
    markdownBody = rehostMarkdownAssets(markdownBody, enMetadata.assets);
  }

  // 10. Verify MDX hazards
  const hazards = findMdxHazards(markdownBody);
  if (hazards.length > 0) {
    console.warn(`[mdx-safety] ${hazards.length} hazards detected in ${targetPageId}:`, hazards);
  }

  // 11. Compute content hash on canonical rehosted markdown
  const hash = await contentHash(markdownBody);

  // 12. Build localized metadata
  const translatedMetadata: PageMetadata = {
    ...enMetadata,
    page_id: targetPageId,
    title: translatedTitle,
    locale: targetLocale,
    content_hash: hash,
    language_source: "automated",
    drafting_status: "automated translations generated",
    // Preserve canonical Docusaurus routing
    slug: enMetadata.slug,
    docusaurus_id: enMetadata.docusaurus_id,
    section: enMetadata.section,
    section_order: enMetadata.section_order,
    assets: enMetadata.assets ? [...enMetadata.assets] : [],
  };

  // 13. Assemble frontmatter + body
  const frontmatter = buildFrontmatter(translatedMetadata);
  const translatedMd = serializeDoc(frontmatter, markdownBody);

  return {
    targetLocale,
    targetPageId,
    title: translatedTitle,
    markdownBody,
    translatedMd,
    translatedBlocks,
    translatedMetadata,
    blockCount: extracted.length,
  };
}
