# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for all pending and resolved tasks in the CoMapeo Notion-to-Markdown content pipeline.

---

## Pending Tasks

### 1. Reduce Notion Fetching Time & API-Level Status Filtering (High Priority)
*See full implementation spec: [plans/2026-06-27-notion-api-status-filtering-4.0.md](file:///home/luandro/Dev/digidem/comapeo-content-pipeline/plans/2026-06-27-notion-api-status-filtering-4.0.md)*

- [ ] **Phase 1: Consolidate Constants**:
  - Rename `DRAFTING_STATUS` to `PUBLISH_STATUS` (value `"Publish Status"`). Add `KEYWORDS`, `TAGS`, `DATE_PUBLISHED`, and `PARENT_ITEM: "Parent item"` constants.
  - Centralize `DEAD_STATUSES = ["Remove", "Unplublished"]`. Add pattern mapping `/remove/i` and `/unpl?ublished/i` in [status.ts](file:///home/luandro/Dev/digidem/comapeo-content-pipeline/src/lib/status.ts).
  - Centralize API constants (`BASE_URL`, `SEARCH_VERSION`, `DATABASE_VERSION`, `DEFAULT_PAGE_SIZE`), element types, locales, and section names.
- [ ] **Phase 2: Live Verification & SDK compatibility gate**:
  - Construct Notion client with version `"2025-09-03"` and test `dataSources.query` filter acceptance using `DEAD_STATUSES` under `wrangler dev`.
- [ ] **Phase 3: SDK/Raw-Fetch Query Integration**:
  - Implement paginated `queryDatabase()` in `NotionClient` to replace `queryDataSource()`.
  - Implement `buildQueryFilter()` in `src/lib/notion-filters.ts` supporting exclusions for `DEAD_STATUSES`.
  - Wire the new query filter into `cmdSyncFull()` and `queryChangedPages()`.
- [ ] **Phase 4: Cron Watermark Pagination & Cleanup**:
  - Implement a pagination loop in `queryChangedPages` (fixes the >50-page cron sync truncation bug).
  - Add a cron safety counter (`MAX_PAGES = 10000`) to prevent runaway loops.
  - Reconcile `wrangler.toml` and [CLAUDE.md](file:///home/luandro/Dev/digidem/comapeo-content-pipeline/CLAUDE.md) queue consumer discrepancy.
- [ ] **Phase 5: Test Suite Expansion**:
  - Add unit and integration tests for filtering logic, cron watermark pagination, and status mappings.
- [ ] **Phase 6: Deploy & Verify**:
  - Deploy worker, trigger `sync:full --force`, and verify page counts.

### 2. Content Hygiene
- [ ] **Task 6: Inline Image Notes (`[Image: <url>]` author-notes)**:
  - Address plain-text `[Image: <expiring-url>]` written in blocks.
  - *Decision Needed*: Defensively strip standalone `[Image: <url>]` lines in `docs:pull` or leave and flag for Notion cleanup.
- [ ] **Task 7: Staging Container Leak**:
  - Prevent internal container pages like `"CoMapeo Data & Privacy (translating for public page)"` from publishing under the Uncategorized section.
  - *Decision Needed*: Recategorize/delete in Notion, or add title exclusion filters to `docs:pull`.

### 3. Worker & RAG Validation
- [ ] **Worker Conversion Path**:
  - Validate that the Cloudflare Worker successfully runs `convertPageData` and writes canonical Markdown to R2 without runtime errors.
- [ ] **RAG Chunks Validation**:
  - Confirm the generated chunks from `rag:chunks` subcommand in [chunker.ts](file:///home/luandro/Dev/digidem/comapeo-content-pipeline/src/rag/chunker.ts) match WhatsApp RAG support bot requirements and that structural (Toggle/Title) pages are successfully skipped.

---

## Completed Tasks

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
