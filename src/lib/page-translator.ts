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

  // 3. Translate via AI client with glossary
  const glossaryPrompt = formatGlossaryPrompt(glossary, targetLocale);
  const translations = await translator.translate({
    targetLocale,
    blocks: allBlocks,
    glossaryPrompt,
    pageContext: `Documentation page: "${enMetadata.title}" in section "${enMetadata.section}"`,
  });

  // 4. Resolve translated title
  const translatedTitle = translations["__page_title__"]?.trim() || enMetadata.title;

  // 5. Apply translations to cloned Notion block tree
  const translatedBlocks = applyTranslatedBlocks(enRawBlocks, translations);

  // 6. Convert blocks to Docusaurus Markdown & post-process
  let markdownBody = convertBlocks(translatedBlocks);
  markdownBody = postProcessMarkdown(markdownBody, translatedTitle);

  // 7. Verify MDX hazards
  const hazards = findMdxHazards(markdownBody);
  if (hazards.length > 0) {
    console.warn(`[mdx-safety] ${hazards.length} hazards detected in ${targetPageId}:`, hazards);
  }

  // 8. Compute content hash
  const hash = await contentHash(markdownBody);

  // 9. Build localized metadata
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
  };

  // 10. Assemble frontmatter + body
  const frontmatter = buildFrontmatter(translatedMetadata);
  const translatedMd = serializeDoc(frontmatter, markdownBody);

  return {
    targetLocale,
    targetPageId,
    title: translatedTitle,
    translatedMd,
    translatedBlocks,
    translatedMetadata,
    blockCount: extracted.length,
  };
}
