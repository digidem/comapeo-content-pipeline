# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for all pending and resolved tasks in the CoMapeo Notion-to-Markdown content pipeline.

---

## Pending Tasks

### Residual broken refs (content-state, needs Notion editorial — NOT pipeline bugs)
Full-output production build (2026-07-02): **46 broken links + 182 broken anchor refs across 35 pages** (warnings; build succeeds). Every sampled case traces to Notion content state, all in the categories recorded 2026-06-22:
- [ ] ES pages link to localized slugs that don't exist as routes (`/es/docs/entiende-como-funciona-el-intercambio` ×8, `…seleccion-de-roles…` ×7, etc.) — pages renamed in Notion or never published; translations publish under the English slug.
- [ ] Anchor targets on placeholder pages: e.g. `troubleshooting-mapping-with-collaborators` is "Content coming soon" in Notion (and its EN row carries a Spanish title — mislabeled), yet 9 pages link to `#exchange-problems` on it.
- [ ] Cross-language fragments: PT/ES pages linking EN heading anchors (e.g. `/pt/docs/creating-a-new-observation#deleting-audio` — the PT heading is "Excluindo áudio").
- [ ] Authoring errors: nested markdown link (`[Deleting…](…) /docs/deleting…`), `/doc/` typo, same-page `#adding-photos` anchors that belong to another page.
- [ ] `Video: @document_….mp4` Drive link-mention with an ugly label on creating-a-new-observation (EN+ES) — works, but worth a nicer label in Notion.

---

## Completed Tasks

### Markdown Quality Audit & Renderer Verification (July 2026)
Full corpus (99 emitted files) audited with markdownlint + `findMdxHazards` + production Docusaurus build + visual inspection in Chrome. Converter defects found & fixed (all locked with unit tests, goldens updated):
- [x] **Emphasis whitespace** (814 lint hits → 0): space-padded Notion spans rendered literal asterisks (`***Step 2: ***Choose`); whitespace now hoisted outside markers, whitespace-only spans unwrapped.
- [x] **Punctuation-only emphasis** (42 → 0): bolded/italicized bare `:` after a word is invalid intraword emphasis — markers dropped. Bonus: heading text cleanup took build broken-anchor warnings on the ES residuals from 9 to their true content-state baseline.
- [x] **Table cells with newlines** (35 table lint hits → 0): split rows (missing columns + spurious rows) — interior newlines → `<br />`, edges trimmed.
- [x] **Nested admonitions**: equal-colon fences closed the outer container early → orphan `:::` rendered as text; outer fences now use deepest-inner+1 colons, closing fences always blank-line separated.
- [x] **Divider-as-setext** and **padded heading text** (MD003/MD019) fixed.
- [x] **Callout titles from bold+italic spans**: `***Tip:***` no longer leaks asterisks into title/content (regex fence fix, verified against raw Notion blocks).
- [x] **Inline emoji/icon 404s**: raw `<img src="assets/…">` is invisible to the MDX bundler and `@docusaurus/plugin-ideal-image` breaks webpack-import alternatives — docs:pull now rewrites to site-root `/images/notion/…` and publishes the 61 referenced assets to `static/images/notion/` (sync script rsyncs it, scoped `--delete`). Icons verified rendering inline in Chrome.
- [x] Remaining lint findings are Notion authoring structure (13 heading-level jumps, 5 list indents) — cosmetic, left alone.
- [x] Visual verification in Chrome across EN/ES/PT: sidebar/i18n labels, admonitions, tables, images, hero assets, `[Image:` strip, staging-page 404 — all good.

### Follow-up Fixes (July 2026)
- [x] **`manifest:generate` made safe and usable**: `sync:full`/`sync:page` now emit per-page `<page_id>.metadata.json` blobs (after final sidebar positions are assigned); `manifest:generate` exits with an actionable error when no blobs exist and refuses to clobber a non-empty manifest with a 0-doc result. Verified against all three footgun scenarios.
- [x] **`mapStatus` realigned to the live vocabulary**: exact case-insensitive map for all 13 live "Publish Status" options, backed by an investigation of the old system's production semantics (only "Ready to publish" is pulled there; write-backs move pages to "Draft published" on staging deploy and "Published" on production deploy — this pipeline is stateless, so all post-gate states map `active`). active = Ready to publish / Adding to staging site / Draft published / Published; Remove → deprecated; Unplublished → archived. Regex fallback retained for legacy values. No immediate content change (all 36 currently-active pages are "Draft published").
- [x] **Automated-locale casing**: `normalizeLocale` is case-insensitive; live values `"ES - automated"`/`"PT - automated"` now canonicalize to `es`/`pt` at sync time instead of falling through to docs:pull.

### Notion API-Level Status Filtering (July 2026) — plan [plans/2026-06-27-notion-api-status-filtering-4.0.md](file:///home/luandro/Dev/digidem/comapeo-content-pipeline/plans/2026-06-27-notion-api-status-filtering-4.0.md)
- [x] **Phase 1 — Constants consolidated**: `DRAFTING_STATUS` → `PUBLISH_STATUS` (fixes the property read — previously every page classified `draft` because "Drafting Status" doesn't exist); added `KEYWORDS`/`TAGS`/`DATE_PUBLISHED`/`PARENT_ITEM`, `DEAD_STATUSES = ["Remove", "Unplublished"]`, `NOTION_API`, element-type helpers, `normalizeLocale`, `SECTION_NAMES`. `/remove/i` + `/unpl?ublished/i` added to `DEPRECATED_PATTERNS`.
- [x] **Phase 2 — Live gate passed**: SDK v5 `dataSources.query` with `Notion-Version: 2025-09-03` accepts the compound exclusion filter. Live counts: 284 rows total → filter keeps 280, excludes exactly the 4 Remove/Unplublished rows, keeps all 210 empty-status rows.
- [x] **Phase 3A — SDK query integration**: paginated `NotionClient.queryDatabase()`; `buildQueryFilter()` in `notion-filters.ts` (exclusion-based, never touches Parent item/Sub-item); wired into `sync:full` (`--all`/`--filter` respected) and Worker cron `queryChangedPages` (replaces the broken `/v1/search` workaround). `queryDataSource()` deprecated.
- [x] **Phase 4 — Cleanup**: cron pagination loop (fixes >50-page truncation), `MAX_PAGES = 10000` safety counter, dead `dataSourceId` param removed, `wrangler.toml`/CLAUDE.md queue-consumer docs reconciled.
- [x] **Phase 5 — Tests**: 250 → 328 tests (filter construction, queryDatabase pagination + stale cursor, cron, locale/element-type helpers, status fixtures, DEAD_STATUSES↔mapStatus invariant, model-safety guard, no-stale-constant grep guard).
- [x] **Phase 6 — Deployed & verified**: worker deployed (`/health/deep` ok), queue consumer processed a live page end-to-end (canonical MD in R2 with `status: active`), `sync:full` re-synced 280 pages (= 284 − 4 dead), manifest now classifies 36 active / 244 draft, cron watermark advancing with no job errors.

### Content Hygiene (July 2026)
- [x] **Task 6 — Inline `[Image: <url>]` author-notes**: decision taken — defensively strip whole lines consisting solely of `[Image: …]` in post-processing (expiring AWS URLs, editorial self-notes). Inline mentions and real `![…](…)` images untouched. The 4 leaked occurrences in the PT build are gone on regeneration.
- [x] **Task 7 — Staging container leak**: decision taken — title-annotation exclusion in `docs:pull` (`(translating…)`, `(staging)`, `(do not publish)`, `(internal)`), extended to the whole sub-item group since children inherit the container slug but not its annotated title. Verified: `docs:pull --all` output differs from before by exactly the one leaked file. Consider also cleaning the page up in Notion.

### Worker & RAG Validation (July 2026)
- [x] **Worker conversion path**: validated live post-deploy — admin enqueue → queue consumer → `convertPageData` → canonical Markdown + metadata + raw JSON in R2, D1 `sync_jobs` completed without error.
- [x] **RAG chunks**: all generated chunks and the chunks manifest validate against the zod schemas (1178/1178 with `--all`; 55/55 active-only after re-sync); 0 of 62 structural (Toggle/Title) pages leak into chunks.

### Completed Tasks (earlier)

### Phase 2: Match Reference Output (Gap Mitigation)
- [x] **Admonitions**: Converted Callout blocks to Docusaurus `:::` warnings/notes syntax.
- [x] **Unsupported Blocks**: Silently skip `unsupported` block types.
- [x] **Post-Processing**: Built sanitizer to strip redundant H1s, add blank lines after headers, and clean curly-brace formula artifacts.
- [x] **Frontmatter Enrichment**: Populated sidebar/pagination labels, tags, and edit URLs.
- [x] **Hyperlinked Images**: Wrap hyperlinked images in markdown link references.
- [x] **Empty Paragraph Spacing**: Output `<div class="notion-spacer">` for correct paragraph rendering.
- [x] **Sidebar Position fallback**: Sequential position assignment for pages without explicit order.
- [x] **Table Verification**: Clean formatting of tables and multi-line cells.

### Bug Fixes & Refactoring (June 2026)
- [x] **Dangling Asterisks**: Wrapped bold/italic/code tags per line segment in `richTextToMarkdown` to prevent unclosed formatting when spanning newlines.
- [x] **Internal Links & Anchors**: Created [links.ts](file:///home/luandro/Dev/digidem/comapeo-content-pipeline/src/lib/links.ts) to slugify heading anchors to match Docusaurus lowercase-hyphenated layout.
- [x] **Clean Re-Sync**: Synchronized metadata successfully across all 3 locales (EN, ES, PT).
- [x] **CI regression gate**: Added GitHub Actions workflow to run typecheck and `docusaurus build` as compiler safeguards.
- [x] **JSX Style preservation**: Preserved inline styles (like colors and custom emojis) through brace stripping.
