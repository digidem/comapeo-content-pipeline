# OLD comapeo-docs Notion → Markdown render inventory

Read-only inventory of how `/home/luandro/Dev/digidem/comapeo-docs` (the pipeline being replaced) converts Notion → Markdown and renders it in Docusaurus. Focus: **rendering fidelity**. All `file:line` refer to that repo.

Pipeline entry: `scripts/notion-fetch/*` orchestrated by `generateBlocks.ts`; per-page work funnels through `markdownRetryProcessor.ts → processMarkdown`.

## 1. Conversion engine

- Library: `notion-to-md` `^3.1.9` (`package.json`). `@notionhq/client` `^5.12.0`, Notion API version `2025-09-03` (v5).
- Instance: `new NotionToMarkdown({ notionClient: notion })` — `scripts/notionClient.ts:267`. No special options beyond the client.
- Only **two** `setCustomTransformer` registrations exist (grep across `scripts/`, excluding tests):
  - `"paragraph"` — `scripts/notionClient.ts:339`
  - `"image"` — `scripts/notionClient.ts:443`
- Everything else (callout, table, columns, toggle, equation, bookmark, embed, video, file, child_page, mention, divider, etc.) uses **notion-to-md defaults** — see §6.
- `paragraph` transformer (`notionClient.ts:300-311`): an empty paragraph (no visible rich_text and no children) is replaced with a literal HTML spacer string, **not** an empty line:
  ```ts
  const NOTION_SPACER_HTML =
    '<div class="notion-spacer" aria-hidden="true" role="presentation"></div>';
  ```
  This survives into rendered docs (e.g. `docs/managing-data-and-privacy/encryption-and-security.md:28`).
- `image` transformer (`notionClient.ts:346-441`): preserves hyperlinks Notion hides from the API. Detects link via (a) caption rich_text `.text.link.url`, (b) plain-text URL regex in caption, (c) `image.link`, (d) block-level `.link`. Caption text without a URL becomes **alt text**. Output `![alt](url)` or `[![alt](img)](link)`.

## 2. Image pipeline

Notion image URLs are AWS S3 presigned, **expiring after 1 hour** (`imageProcessing.ts:41-89`, `isExpiredUrlError`).

- **Downloaded locally: yes.** Orchestrator `processAndReplaceImages` (`imageReplacer.ts:402`) — regex-extracts markdown `![..](..)` and `<img src=..>` matches (incl. hyperlink-wrapped images), validates URL protocol `http|https|data` (`imageValidation.ts:37`), downloads via `downloadAndProcessImage` (`imageProcessing.ts:719`): axios 30s timeout, retries ×3, sharp resize `maxWidth=1280` (`imageProcessor.ts:8`, `constants.ts:98`), compress (jpeg q80 / png lvl9 / webp q80; SVG passthrough).
- **Storage + naming:** `static/images/` (`IMAGES_PATH`, `imageProcessing.ts:175`). Filename = `${sanitizedBlockName}_${index}${ext}` where blockName is lowercased alnum, truncated 20 chars (`imageProcessing.ts:844-848`). e.g. `encryptionandsec_0.jpg`. **Keyed by block name + index, NOT content hash** — a re-fetch can rename a file even if bytes are identical.
- **Path written into markdown:** `/images/${filename}` (canonical, site-root-relative).
- **Cache:** live format is **per-entry lazy files** `.cache/images/${md5(url)}.json` (`ImageCache`, `imageProcessing.ts:461-465`), freshness via `notionLastEdited` + 30-day TTL fallback. The repo-root `image-cache.json` is the **legacy monolithic** format; `scripts/migrate-image-cache.ts` converts it to per-entry (non-destructive). Failures logged to `image-failures.json` (`imageProcessing.ts:364`).
- **Build-time rewrite:** `remark-fix-image-paths.ts` is the **only** remark plugin (`docusaurus.config.ts:7,291`). It calls `rewriteLocaleImagePlaceholderPath` (`scripts/shared/localeImagePlaceholders.ts:98`) to decode two placeholder families that translation injects so URLs survive LLM translation untouched:
  - `/images/__locale_ref__/<base64url(/images/...)>` → original canonical `/images/...`
  - `/images/__remote_ref__/<base64url(https://...)>` → original remote URL
  - also fixes `images/` → `/images/` and rewrites `src=` inside raw HTML `<img>` nodes.
- **Safety net:** `validateAndFixRemainingImages` re-runs the whole replace pass if any S3/`data:` URLs remain post-processing (`imageReplacer.ts:912`). Fallback for a truly failed image = `**[Image N: alt]** *(Image failed to download)*` + HTML comment with original URL (`imageValidation.ts:58-72`).

## 3. Custom emoji & icons

- **`custom_emoji`** (a `mention` of type `custom_emoji`, hosted image): extracted from raw blocks **before** markdown conversion (`emojiExtraction.ts:19` `extractCustomEmojiUrls`, walks paragraph/heading/callout/quote/list/to_do/toggle/child_page rich_text + properties). Downloaded to `static/images/emojis/` (`emojiProcessor.ts:30`), **content-hash dedup** (`emojiDownload.ts:233-276`, `generateFilename`/`generateHash`), cached in `static/images/emojis/.emoji-cache.json` (`emojiProcessor.ts:33`). Host allowlist `amazonaws.com`, `notion.site` (`emojiProcessor.ts:41`).
- Rendered as **inline `<img>`** with fixed styling, replacing both the plain-text token and `[img](#img)[name]` patterns (`emojiMapping.ts:9-89`):
  ```ts
  '<img src=".." alt="name" className="emoji" style={{display:"inline",height:"1.2em",width:"auto",verticalAlign:"text-bottom",margin:"0 0.1em"}} />'
  ```
  Depends on Docusaurus MDX treating this as JSX/HTML passthrough inside `.md`.
- **Standard Unicode emoji:** no handling — pass through as literal text.
- **Page `icon`** (Notion page property `Icon` rich_text): emitted into frontmatter `sidebar_custom_props.icon` (`generateBlocks.ts:1046-1051`). Not rendered in body.
- **Callout icon:** only `emoji` type preserved (§4). External/file/custom-emoji callout icons are **dropped** (`calloutProcessor.ts:71-81`).
- Fallback on download failure = keep original remote URL (`emojiDownload.ts:363-367`).

## 4. Callouts

No custom transformer. notion-to-md renders a callout as a **blockquote** (`>`); conversion to a Docusaurus admonition is a **post-processing text match**, not a block transform.

- `processCalloutsInMarkdown` (`markdownTransform.ts:320`): walks raw blocks for callouts, normalizes callout text, finds the matching blockquote region in the markdown by substring (`findMatchingBlockquote`, `markdownTransform.ts:271`), splices in the admonition. Skips matches inside code fences or existing `:::` admonitions (`markdownTransform.ts:379-403`).
- **Color → admonition type** (`CALLOUT_COLOR_MAPPING`, `calloutProcessor.ts:11-22`):
  blue→`info`, yellow→`warning`, red→`danger`, green→`tip`, gray→`note`, orange→`caution`, purple/pink/brown/default→`note`.
- **Icon preserved as title prefix:** emoji + extracted title → `:::note 🚧 Work in progress` (`calloutProcessor.ts:295-302`, `325-341`). Title extracted from leading `**Bold**` or `Title:` (`calloutProcessor.ts:195-263`).
- Real output (`encryption-and-security.md`): `:::note ⚠️ Warning`, `:::note 💡 Tip`.
- Fragility: matching is by normalized text content. Duplicate callout wording, callouts inside lists, or content altered between fetch and match can cause a callout to be skipped and remain a plain blockquote.

## 5. Captions

- **Image captions** → alt text only (`notionClient.ts:382-409`). If a caption contains a URL/link, that URL becomes the wrapping hyperlink and is removed from the alt. No caption text renders beneath the image.
- **Video captions / other media captions:** no special handling — notion-to-md default.

## 6. Other block types

**No custom transformers** for any of these; output is whatever `notion-to-md@3.1.9` emits by default. Specifically unhandled (confirmed by grep of `setCustomTransformer` + processor files): `column_list`/`column`, `synced_block`, `table`, `table_of_contents`, `breadcrumb`, block-level `toggle`, `equation` (block + inline `$…$`), `bookmark`, `embed`, `video`, `file`/`pdf`, `child_page`, `link_to_page`, `divider`, `mention` (except custom_emoji, §3).

- Note on **Toggle**: appears only as a Notion **page "Element Type"** that creates a section folder (`generateBlocks.ts:954`, `sectionProcessors.ts`) — not inline block handling.
- **Equations** rely on n2m's `$…$`/`$$…$$`; Docusaurus has **no math/katex plugin** configured (see §9) — block/inline math may not render.
- **Columns** are flattened by n2m default (no column layout preserved).

## 7. Frontmatter

- **Producer in code:** `buildFrontmatter` (`frontmatterBuilder.ts:98-149`). Fields written at fetch time:
  `id` (`doc-{slug}`), `title`, `sidebar_label`, `sidebar_position`, `pagination_label`, `custom_edit_url` (GitHub edit link to `docs/${relativePath}`), `keywords[]`, `tags[]`, `slug` (`/{slug}`), `last_update.date` + `author: Awana Digital`, optional `sidebar_custom_props` (`icon`, `title`).
  - `last_update.date` from Notion property **`Date Published`** → `last_edited_time` → `now` (`getPublishedDate`, `frontmatterBuilder.ts:34-83`). Property names from `NOTION_PROPERTIES` (`constants.ts:14-24`): Title=`Content elements`, Status=`Publish Status`, Order=`Order`, ElementType=`Element Type`, etc.
- **Post-step** `fix-frontmatter.ts` (separate CLI): walks `docs/` + `i18n/*/…/current`, quotes any YAML scalar containing special chars; **always** quotes `title`, `sidebar_label`, `pagination_label` (`fix-frontmatter.ts:8-12`, `50-83`).
- **Discrepancy worth flagging:** committed docs carry extra provenance fields **not emitted by any reviewed script** (grep of `scripts/` finds no producer): `source: notion`, `notion_page_id`, `notion_last_edited_time`, `content_hash`, `status`, `locale`, `section` — see `encryption-and-security.md:8-14`. These come from a CI / `content`-branch stage outside this repo's fetch code.

## 8. Empty / placeholder content

- `scripts/notion-placeholders/index.ts` is a **Notion-side backfill tool**: it *writes generated content into Notion* (`ContentGenerator` → `NotionUpdater`), not into markdown. English, non-Section pages below a content score.
- At **fetch time**, a page whose markdown has no `.parent` (no Website Block / no blocks) gets `writePlaceholderFile` (`contentWriter.ts:123`), emitting a real placeholder into the markdown:
  ```
  <!-- Placeholder content generated automatically because the Notion page is missing a Website Block. -->

  :::note
  Content placeholder – add blocks in Notion to replace this file.
  :::
  ```

## 9. Build-time render dependencies

Without these, raw generated markdown would **not** render correctly:

- **`remark-fix-image-paths`** (§2): the sole remark plugin (`docusaurus.config.ts:291`). Required to decode `__locale_ref__`/`__remote_ref__` placeholders and fix relative `images/` paths. **Raw committed `.md` still contains the base64 placeholders** until Docusaurus build decodes them.
- **MDX/HTML passthrough**: inline emoji `<img className="emoji" …>` (§3) and `notion-spacer` `<div>` (§1) rely on Docusaurus parsing raw HTML inside `.md` as MDX.
- **Built-in admonitions**: `:::note|tip|warning|danger|info|caution` are native Docusaurus (no extra plugin).
- **No math plugin (katex/rehype-katex)** configured — equation rendering is unsupported/unverified.
- `markdown.hooks`: `onBrokenMarkdownLinks: "warn"`, `onBrokenMarkdownImages: "warn"` (`docusaurus.config.ts:225-230`).
- Other plugins (`plugin-client-redirects`, `plugin-pwa`) are unrelated to render fidelity.

## Things the old system does that are easy to overlook

- Empty Notion paragraphs become `<div class="notion-spacer" aria-hidden role=presentation></div>` — not blank lines. New pipeline must replicate or explicitly drop them (`notionClient.ts:274,310`).
- Callouts are converted by **text-matching blockquotes**, not block structure (`markdownTransform.ts:357`). Duplicate wording or callouts-in-lists silently fall back to plain blockquotes.
- Callout icons: only `emoji` kept; external/file/custom-emoji callout icons are dropped (`calloutProcessor.ts:71-81`).
- Image filenames are `blockName_index.ext` (not content-hashed); only the URL-keyed cache prevents re-download. Renames on re-fetch are possible (`imageProcessing.ts:848`).
- `image-cache.json` at repo root is **legacy**; live cache is `.cache/images/${md5}.json` per entry (`imageProcessing.ts:461`).
- Committed markdown still holds **base64 `__locale_ref__`/`__remote_ref__` placeholders**; images only resolve because `remark-fix-image-paths` decodes them at Docusaurus build time.
- Committed docs have provenance frontmatter (`source`, `notion_page_id`, `content_hash`, `status`, `locale`, `section`) produced by a stage **not present** in the reviewed fetch scripts.
- Duplicate H1 matching the title is stripped (`contentWriter.ts:24`); a blank line is auto-inserted after standalone `**bold**` lines (`markdownTransform.ts:166`).
- Image captions become alt text only; a URL in a caption turns the image into a hyperlink wrapper (`notionClient.ts:430-440`).
- Equations, tables, columns, bookmarks, embeds, video, file/PDF, child_page, mentions have **no custom handling** — output is `notion-to-md@3.1.9` default, and no katex plugin is configured.
- Custom emoji render as `<img className="emoji">` inline JSX — depends on MDX HTML passthrough in `.md`.
- Empty pages get a real `:::note` placeholder in markdown; the separate `notion-placeholders` tool backfills content into Notion itself.

---

> **Note on placement:** originally targeted `../comapeo-content-pipeline/OLD-RENDER-INVENTORY.md`, but that dir is outside this session's sandbox. Written here as fallback — move it over with `mv OLD-RENDER-INVENTORY.md ../comapeo-content-pipeline/`.
