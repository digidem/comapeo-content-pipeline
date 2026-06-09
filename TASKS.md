# Next Steps

All 13 tasks complete. 145 tests pass, typecheck clean.

---

## 1. Wire the full Markdown converter into the Worker queue consumer ✅

Done: extracted `convertPageData()` as pure function, worker queue consumer calls it, writes canonical Markdown, metadata, upserts D1, records emitted_artifacts, regenerates sidebars.

**Files:** `src/worker/index.ts`, `src/lib/sync.ts`.

---

## 2. Implement `rag:chunks` CLI command ✅

Done: reads manifest, parses frontmatter from .md files via gray-matter, calls `generateChunks()`/`generateChunksManifest()`, writes `rag/chunks/{chunk_id}.json` + `rag/chunks-manifest.json`.

**Files:** `src/cli/index.ts`.

---

## 3. Implement `diff` CLI command ✅

Done: fetches live Notion page via `syncPage()`, compares title/content_hash/status/last_edited against stored metadata.json, prints human-readable diff.

**Files:** `src/cli/index.ts`.

---

## 4. Image asset rehosting ✅

Done: `src/lib/assets.ts` with `extractAssetUrls()`, `rehostAsset()`, `sha256Hex()` (Web Crypto API), `assetR2Key()`. `convertPageData()` scans markdown, downloads Notion images, replaces URLs with stable R2 paths. Content hash computed BEFORE URL replacement. Failures handled gracefully (original URL kept).

**Files:** `src/lib/assets.ts`, `src/lib/assets.test.ts`, `src/lib/sync.ts`, `src/persistence/r2.ts`.

---

## 5. D1 migration automation ✅

Done: `migrations/0001_initial.sql` exists. `db:migrate` CLI command runs `wrangler d1 execute --local` (or `--remote` for production).

**Files:** `migrations/0001_initial.sql`, `src/cli/index.ts`.

---

## 6. `docs:pull` locale-aware output ✅

Done: en → `{outDir}/docs/{section}/{slug}.md`, non-en → `{outDir}/i18n/{locale}/docusaurus-plugin-content-docs/current/{section}/{slug}.md`. No `..` parent traversal.

**Files:** `src/cli/index.ts`.

---

## 7. Sidebar JSON generation and storage ✅

Done: `generateSidebarJson()` produces Docusaurus-format arrays (`{type:"category",label,items}` + plain strings). Worker `regenerateSidebar()` writes proper `SidebarItem[]` to R2. Manifest schema updated.

**Files:** `src/lib/manifest.ts`, `src/schemas/manifest.ts`, `src/worker/index.ts`.

---

## 8. Multilingual page fixture + test ✅

Done: `test/fixtures/notion/multilingual-page.json` with Spanish headings + Portuguese list items. Golden test passes.

**Files:** `test/fixtures/notion/multilingual-page.json`, `test/fixtures/expected/multilingual-page.md`.

---

## 9. Rate-limit retry behavior tests ✅

Done: `src/lib/notion-client.test.ts` with 11 tests covering 429 (Retry-After header, default 1s fallback, multiple retries), 529 (exponential backoff), non-retryable errors (400/401/404), max retries exhaustion, network error recovery.

**Files:** `src/lib/notion-client.test.ts`.

---

## 10. Integration tests for Worker routes ✅

Done: `src/worker/index.test.ts` with 10 tests: health routes, webhook verification challenge, webhook auth rejection, admin auth (403), admin sync/page (enqueue), admin manifest/regenerate. Mock D1/R2/Queue bindings.

**Files:** `src/worker/index.test.ts`.

---

## 11. `sync:full` pagination + watermark ✅

Done: `sync:full` tracks `maxLastEditedTime` across all synced pages, writes `sync_state.json` with watermark. Summary includes watermark value. No state written if zero pages synced.

**Files:** `src/cli/index.ts`.

---

## 12. Content hash skip logic ✅

Done: Worker checks D1 for existing `content_hash` + `status`. If both match → skip writes, mark sync_job 'skipped', update watermark, continue. CLI checks `{pageId}.metadata.json` for matching `content_hash`; `--force` bypasses skip.

**Files:** `src/worker/index.ts`, `src/cli/index.ts`, `src/lib/sync.ts`.

---

## 13. Spec fixture gap: `tables.json` with rich text in cells ✅

Done: Added two table rows with bold, italic, code, and mixed-annotation cells to `tables.json`. Expected output updated in `tables.md`.

**Files:** `test/fixtures/notion/tables.json`, `test/fixtures/expected/tables.md`.

---

## Summary

| # | Task | Priority | Status |
|---|------|----------|--------|
| 1 | Worker queue consumer → full Markdown pipeline | High | ✅ |
| 2 | `rag:chunks` CLI command | High | ✅ |
| 12 | Content hash skip logic | High | ✅ |
| 6 | `docs:pull` locale-aware output | Medium | ✅ |
| 4 | Image asset rehosting | Medium | ✅ |
| 7 | Sidebar JSON generation | Medium | ✅ |
| 5 | D1 migration automation | Medium | ✅ |
| 9 | Rate-limit retry tests | Low | ✅ |
| 10 | Worker integration tests | Low | ✅ |
| 11 | Sync pagination + watermark | Low | ✅ |
| 3 | `diff` CLI command | Low | ✅ |
| 8 | Multilingual fixture | Low | ✅ |
| 13 | Rich text in table cells fixture | Low | ✅ |
