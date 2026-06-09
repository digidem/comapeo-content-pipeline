# Next Steps

Remaining work to close all gaps between the current implementation and the spec's Definition of Done (§19).

---

## 1. Wire the full Markdown converter into the Worker queue consumer

**Current state:** `src/worker/index.ts` queue consumer fetches raw page + blocks from Notion and stores them in R2, but never calls `convertBlocks()` or `buildFrontmatter()`. It writes raw JSON but not canonical Markdown.

**What to do:**
- Import `convertBlocks` and `syncPage` logic into the queue consumer (or share the code).
- After fetching page + blocks, run the full conversion pipeline.
- Write `canonical.{locale}.md` to R2 (per spec §5.1).
- Write `metadata.json` with `content_hash`, `raw_hash`, `status`, etc.
- Update D1 `source_pages` row with hash + path columns.

**Files:** `src/worker/index.ts`, `src/lib/sync.ts` (make reusable in non-Node env).

---

## 2. Implement `rag:chunks` CLI command

**Current state:** CLI prints "not yet implemented".

**What to do:**
- Import `generateChunks` + `generateChunksManifest` from `src/rag/chunker.ts`.
- Accept `--input` (manifest path or output dir) and `--out` (chunks output dir).
- Iterate over all docs in manifest, read each page's Markdown, generate chunks.
- Write `rag/chunks/{chunk_id}.json` + `rag/chunks-manifest.json`.
- Use `FilesystemStorage` for local mode; doc `StorageBackend` for R2 mode.

**Files:** `src/cli/index.ts`, `src/rag/chunker.ts`.

---

## 3. Implement `diff` CLI command

**Current state:** Stub.

**What to do:**
- Accept `--page <page_id>`.
- Fetch current page from Notion, compute current hash.
- Compare against stored hash in D1 or local metadata.
- Print human-readable diff (title, block count, hash change, status change).

**Files:** `src/cli/index.ts`.

---

## 4. Image asset rehosting

**Current state:** `sync.ts` sets `assets: []` on metadata. Image URLs in markdown point to Notion (expiring URLs).

**Spec says (§8.4):** "Download and rehost supported assets into R2 where possible."

**What to do:**
- Scan converted Markdown for `![...](https://...)` image references.
- For each Notion-hosted image, download via `fetch()`.
- Compute SHA-256, store in R2 as `assets/{sha256}.{ext}`.
- Replace URL in Markdown with R2 path or local Docusaurus path.
- Record in `PageMetadata.assets[]`.
- Handle download failures gracefully (keep original URL as fallback, log warning).

**Files:** New `src/lib/assets.ts`, changes to `src/lib/sync.ts`, `src/persistence/r2.ts`.

---

## 5. D1 migration automation

**Current state:** SQL strings exist in `src/persistence/d1.ts` but no automated migration runner.

**What to do:**
- Create `migrations/0001_initial.sql` with the full schema.
- Add `wrangler d1 migrations apply` to deploy flow.
- Add a `pnpm pipeline db:migrate` command that applies migrations locally via `wrangler d1 execute --local`.

**Files:** New `migrations/`, `src/cli/index.ts`.

---

## 6. `docs:pull` locale-aware output

**Current state:** Writes to a flat directory. Doesn't fully replicate the Docusaurus i18n structure.

**Spec says (§5.1):** Output should be `i18n/{locale}/docusaurus-plugin-content-docs/current/` for non-en locales.

**What to do:**
- For `locale === "en"`: write to `docs/{section}/{slug}.md`.
- For other locales: write to `i18n/{locale}/docusaurus-plugin-content-docs/current/{section}/{slug}.md`.
- Read the manifest to determine section structure.
- Verify the output matches current `comapeo-docs` structure exactly.

**Files:** `src/cli/index.ts` (`cmdDocsPull`).

---

## 7. Sidebar JSON generation and storage

**Current state:** Simple sidebar strings embedded in manifest. Not written as standalone R2 files.

**Spec says (§5.1):** R2 should have `sidebars/{locale}.json`.

**What to do:**
- Generate proper Docusaurus sidebar JSON (array of `{type, label, id}` objects, not raw strings).
- Write to R2 path `sidebars/{locale}.json` during sync.
- Reference sidebar keys in manifest.

**Files:** `src/lib/manifest.ts`, `src/persistence/r2.ts`.

---

## 8. Multilingual page fixture + test

**Current state:** `multilingual-page.json` listed in spec §15.2 but not created.

**What to do:**
- Create `test/fixtures/notion/multilingual-page.json` with pages in en/pt/es.
- Create expected output in `test/fixtures/expected/`.
- Add golden test.

**Files:** `test/fixtures/`.

---

## 9. Rate-limit retry behavior tests

**Current state:** `NotionClient` has retry logic but no unit tests for it.

**Spec says (§15.1):** Required unit test: "Notion rate-limit retry behavior."

**What to do:**
- Use `setRetryAfterCallback` to capture retry events.
- Mock `fetch` to return 429 and 529 responses.
- Verify exponential backoff, max retries, and `Retry-After` header parsing.

**Files:** New `src/lib/notion-client.test.ts`.

---

## 10. Integration tests for Worker routes

**Current state:** No integration tests for the Hono worker routes.

**Spec says (§15.3):**
- Webhook receives event and enqueues job.
- Queue consumer processes one page.
- Unchanged page skips R2 writes.
- Changed page rewrites artifacts.
- Failed Notion call retries and records failure.
- Manifest regenerates after changed content.

**What to do:**
- Use `vitest` + `miniflare` (or mock bindings) to test Hono routes.
- Test queue consumer with mock Notion API responses.
- Test hash-based skip logic.
- Test failure recording in D1.

**Files:** New `src/worker/index.test.ts`.

---

## 11. `sync:full` pagination + watermark test

**Current state:** `sync:full` queries data source but doesn't persist watermark to D1.

**What to do:**
- After `sync:full`, store `last_sync_watermark` in D1 `sync_state`.
- Next incremental sync only fetches pages newer than watermark.
- Test pagination across >100 pages.

**Files:** `src/cli/index.ts`, `src/lib/sync.ts`.

---

## 12. Content hash skip logic

**Current state:** Hashes are computed but the "skip unchanged" path is not wired end-to-end.

**Spec says (§8.2):** "content_hash decides what to rewrite/reindex."

**What to do:**
- Before writing R2 artifacts, check D1 for existing `content_hash`.
- If hash matches and status hasn't changed, skip writes and mark job as `skipped`.
- Log skipped pages for observability.

**Files:** `src/lib/sync.ts`, `src/worker/index.ts`.

---

## 13. Spec fixture gap: `tables.json` with rich text in cells

**Current state:** Tables fixture uses plain text cells.

**What to do:**
- Add a table fixture row with bold/italic/code inside cells.
- Verify rich text conversion works inside table cells.

**Files:** `test/fixtures/notion/tables.json`, `test/fixtures/expected/tables.md`.

---

## Summary

| # | Task | Priority |
|---|------|----------|
| 1 | Worker queue consumer → full Markdown pipeline | High |
| 2 | `rag:chunks` CLI command | High |
| 12 | Content hash skip logic | High |
| 6 | `docs:pull` locale-aware output | Medium |
| 4 | Image asset rehosting | Medium |
| 7 | Sidebar JSON generation | Medium |
| 5 | D1 migration automation | Medium |
| 9 | Rate-limit retry tests | Low |
| 10 | Worker integration tests | Low |
| 11 | Sync pagination + watermark | Low |
| 3 | `diff` CLI command | Low |
| 8 | Multilingual fixture | Low |
| 13 | Rich text in table cells fixture | Low |
