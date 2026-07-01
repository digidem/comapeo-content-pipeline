# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for all pending and resolved tasks in the CoMapeo Notion-to-Markdown content pipeline.

---

## Pending Tasks

### Follow-ups (discovered July 2026, deliberately deferred)
- [ ] **`manifest:generate` is broken for the CLI layout**: it expects `*.metadata.json` files that `sync:full` never writes, so it silently produces an empty manifest (and overwrites the good one `sync:full` wrote). Either make `sync:full` emit per-page metadata blobs or point `manifest:generate` at the in-manifest data. Until fixed, do not run `manifest:generate` after a CLI sync.
- [ ] **`mapStatus` active/draft realignment** (plan v4 "status vocabulary drift", explicitly out of scope there): today `active` = Published / Draft published / Ready to publish; the other 8 live options map to `draft`. Decide with editorial whether e.g. "Adding to staging site" should publish.
- [ ] **Automated-locale casing**: live Notion `Language` values for automated translations don't exactly match the `NOTION_LOCALES` keys (sync stores the lowercase passthrough, e.g. `"es - automated"`), so locale canonicalization still happens in `docs:pull`, not at sync time. Same behavior as before the refactor; align the map keys with the live values when convenient.

---

## Completed Tasks

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
