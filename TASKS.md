# Phase 2: Match reference output from comapeo-docs

Goal: our pipeline's markdown output matches `../comapeo-docs/docs/` quality.
Reference converter: `../comapeo-docs/scripts/notion-fetch/generateBlocks.ts`.
Reference uses `notion-to-md` (n2m) library + custom transformers + post-processing.
Our pipeline uses hand-rolled `notion-converter.ts`. Gap analysis done — fix in priority order.

---

## 1. Callout → Docusaurus admonition conversion

**Symptom:** Our pipeline outputs `> [!NOTE]` (Obsidian blockquote style).
Reference outputs `:::note\n...\n:::` (Docusaurus admonition syntax).

**Reference:** `../comapeo-docs/scripts/notion-fetch/calloutProcessor.ts`
Maps Notion callout colors → admonition types:
- `blue_background` → `info`, `yellow_background` → `warning`
- `red_background` → `danger`, `green_background` → `tip`
- `gray_background`/`default` → `note`, `orange_background` → `caution`

Also: extracts **bold title** from callout content, strips emoji icons as title prefix,
handles nested children blocks.

**Fix:**
- Rewrite `convertCallout()` in `src/lib/notion-converter.ts` to emit `:::` syntax
- Map Notion callout colors to admonition types (not just `[!NOTE]`)
- Extract bold title from first line of callout content
- Strip emoji prefix from title (use as icon)
- Handle nested children inside callouts
- Write golden fixture test with all color variants

**Files:** `src/lib/notion-converter.ts`, `test/fixtures/notion/`, `test/fixtures/expected/`

---

## 2. Unsupported block type handling

**Symptom:** Output contains `> [!NOTE]\n> Unsupported Notion block: \`unsupported\``.
The Notion API returns blocks with `type: "unsupported"` when the integration lacks
access to that block's content type. These should be silently skipped or minimally rendered.

**Fix:**
- Add `"unsupported"` to `SUPPORTED_BLOCKS` set
- In `convertSingleBlock()`, handle `unsupported` by returning empty string (skip)
- Alternatively: emit an HTML comment `<!-- unsupported block: {type} -->` for debugging
- Update golden fixture: add unsupported block → expect empty/minimal output

**Files:** `src/lib/notion-converter.ts`, `test/fixtures/`

---

## 3. Content post-processing pipeline

**Symptom:** Reference applies several post-processing passes that our pipeline lacks.

**Reference files:**
- `contentSanitizer.ts` — heading hierarchy fix, curly-brace stripping, malformed HTML fix
- `contentWriter.ts` — `removeDuplicateTitle()` strips H1 matching page title
- `markdownTransform.ts` — `ensureBlankLineAfterStandaloneBold()`

**Fix:**
- Build a `postProcessMarkdown(content, pageTitle)` function in `src/lib/notion-converter.ts`
  (or a new `src/lib/post-process.ts`)
- Phase 1: `removeDuplicateTitle(content, pageTitle)` — strip leading H1 if it matches title
- Phase 2: `ensureBlankLineAfterStandaloneBold(content)` — add blank line after `**Heading**` lines
- Phase 3: `sanitizeMarkdownContent(content)` — strip curly-brace expressions (Notion formula artifacts),
  fix heading hierarchy (only one H1, demote subsequent H1s to H2s), fix malformed HTML/JSX tags
- Wire into `convertPageData()` after `convertBlocks()` before `contentHash()`
- Write tests for each transform

**Files:** `src/lib/notion-converter.ts` (or new `src/lib/post-process.ts`), `src/lib/sync.ts`

---

## 4. Frontmatter enrichment for Docusaurus

**Symptom:** Our frontmatter missing fields that reference expects:
`sidebar_label`, `pagination_label`, `custom_edit_url`, `keywords` (separate from tags),
`last_update` block with date + author.

**Reference:** `../comapeo-docs/scripts/notion-fetch/frontmatterBuilder.ts`

**Fix:**
- Update `buildFrontmatter()` in `src/lib/frontmatter.ts` to include:
  - `sidebar_label: {title}` and `pagination_label: {title}`
  - `custom_edit_url: https://github.com/digidem/comapeo-docs/edit/main/docs/{path}`
  - `keywords:` from Notion `Keywords` multi_select property (extract in `sync.ts`)
  - `last_update: date: ... author: ...` — from `Date Published` property or `last_edited_time`
- Extract `Tags` multi_select property in `sync.ts` for `tags:` frontmatter
- Extract `Icon` rich_text property for `sidebar_custom_props`
- Update schema if needed

**Files:** `src/lib/frontmatter.ts`, `src/lib/sync.ts`, `src/schemas/metadata.ts`

---

## 5. Hyperlinked image support

**Symptom:** Our pipeline outputs `![alt](url)` for images.
Reference detects when images have hyperlinks in Notion and wraps them:
`[![alt](img-url)](link-url)`.

**Reference:** `../comapeo-docs/scripts/notionClient.ts` — custom image transformer (lines 346-441)
Checks caption rich_text for link annotations, plain text URLs, and dedicated link properties.

**Fix:**
- Update `convertImage()` in `src/lib/notion-converter.ts`
- Check image caption for link URLs (in `annotations` or plain text URL patterns)
- If link found in caption, wrap output: `[![alt](img-url)](link-url)`
- Write golden fixture test with linked and unlinked images

**Files:** `src/lib/notion-converter.ts`, `test/fixtures/`

---

## 6. Empty paragraph handling

**Symptom:** Reference outputs `<div class="notion-spacer">` for empty paragraphs (visual layout).
Our pipeline outputs empty text (no visible difference but less structured).

**Fix:**
- In `convertParagraph()`, detect completely empty rich_text (no content)
- Output `<div class="notion-spacer" aria-hidden="true" role="presentation"></div>`
  for empty paragraphs (matching reference behavior)
- Write test

**Files:** `src/lib/notion-converter.ts`

---

## 7. Sidebar position assignment

**Symptom:** Our pipeline sets `sidebar_position` to `undefined` when Notion `Order` property
is null. Reference has fallback logic: preserve existing position from cache, generate
sequential positions for pages without explicit order.

**Reference:** `../comapeo-docs/scripts/notion-fetch/generateBlocks.ts` lines 1019-1043

**Fix:**
- In `convertPageData()` / `syncPage()`, implement position assignment logic:
  1. Use `Order` property if set
  2. Fall back to stored position (from D1 / metadata cache)
  3. Generate sequential position after max known position
- CLI should read existing metadata files to preserve positions

**Files:** `src/lib/sync.ts`, `src/cli/index.ts`, `src/worker/index.ts`

---

## 8. Table block output verification

**Symptom:** Reference uses `n2m` library for table rendering. Our hand-rolled table converter
may produce different formatting. Need to compare output on real table-heavy pages.

**Fix:**
- Find a Notion page with a table, compare our output vs reference
- Verify table alignment, empty cells, multi-line cell content
- Fix discrepancies in `convertTable()` / `convertTableRow()`
- Add/adjust golden fixture tests

**Files:** `src/lib/notion-converter.ts`, `test/fixtures/`

---

## Summary

| # | Issue | Impact | Complexity |
|---|-------|--------|------------|
| 1 | Callout → `:::` admonition | High — wrong syntax for Docusaurus | Medium |
| 2 | Unsupported block spam | Medium — noise in output | Low |
| 3 | Content post-processing | High — MDX errors, TOC quality | Medium |
| 4 | Frontmatter enrichment | High — Docusaurus metadata missing | Medium |
| 5 | Hyperlinked image support | Low — rare but useful | Low |
| 6 | Empty paragraph spacing | Low — visual only | Low |
| 7 | Sidebar position assignment | Medium — ToC ordering | Medium |
| 8 | Table output verification | Low — verify existing code | Low |

**Definition of done:** Pick any 3 pages from `sync:full --limit 5`, compare output
side-by-side with `../comapeo-docs/docs/` equivalents. No `Unsupported Notion block`
messages. Callouts render as `:::` admonitions. Frontmatter has all required fields.
Content passes Docusaurus MDX compilation.
