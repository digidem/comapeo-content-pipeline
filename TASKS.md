# Known Issues

Issues discovered during end-to-end testing. Fix in priority order.

---

## 1. `sync:full` broken — Notion query endpoint returns 400

**Symptom:** `pnpm pipeline sync:full` fails with `Notion API error 400: Invalid request URL`.

**Root cause:** `NotionClient.queryDataSource()` calls `/search/data-sources/query` which returns 400 with API version `2026-03-11`. The CLAUDE.md gotcha states `/v1/search` is the working query endpoint.

**Fix:**
- Update `src/lib/notion-client.ts` `queryDataSource()` to use `POST /v1/search` instead of `/search/data-sources/query`
- Change request body from `{ data_source_id, page_size, sorts, filter }` to the `/v1/search` format: `{ query: "", filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size }`
- Also update `src/worker/index.ts` `queryChangedPages()` which calls the same broken endpoint with direct `fetch()`
- Verify `sync:full --limit 5` works after fix

**Files:** `src/lib/notion-client.ts`, `src/worker/index.ts`

---

## 2. Content hash non-deterministic on repeated syncs

**Symptom:** Running `sync:page` twice on the same page produces different `content_hash` values, breaking the skip-unchanged logic.

**Root cause:** Investigation needed — possible causes:
- Notion API returns slightly different data each time (timestamps, cursor positions)
- `rawPage` or `rawBlocks` serialization includes unstable fields
- The `convertPageData` function became async (asset rehosting) and content_hash should be computed BEFORE asset URLs are replaced (code does this, but verify)
- `JSON.stringify` with `sortedKeys` may not handle all Notion API response shapes correctly

**Fix:**
- Write a test: sync same page twice, assert hashes equal
- Check if `notion_last_edited_time` or other API-level fields change between calls
- Consider computing `content_hash` from the Markdown body only (already done — verify it's consistent)
- Add debug logging to trace hash differences

**Files:** `src/lib/sync.ts`, `src/lib/hash.ts`, new test in `src/lib/lib.test.ts`

---

## 3. Worker doesn't re-upload downloaded assets to R2

**Symptom:** `convertPageData()` downloads Notion images and replaces URLs in Markdown with `assets/{sha256}.{ext}` paths, but the actual binary data is never stored in R2.

**Root cause:** `convertPageData` runs the download + URL replacement, but the Queue consumer doesn't call `env.CONTENT_BUCKET.put()` for each downloaded asset. The asset data is held in memory and discarded.

**Fix:**
- `convertPageData` should return the downloaded asset data alongside the metadata
- Queue consumer should iterate `metadata.assets` and upload each to R2 at `assets/{sha256}.{ext}`
- Asset upload failures should be non-fatal (log warning, keep original URL)

**Files:** `src/lib/sync.ts`, `src/worker/index.ts`

---

## 4. Worker blocks fetch is not recursive

**Symptom:** Queue consumer fetches top-level blocks only (`/blocks/{pageId}/children`). Nested blocks (toggle content, bullet children, etc.) are not fetched.

**Root cause:** The Worker uses direct `fetch()` calls and doesn't recurse into `has_children` blocks. The CLI uses `NotionClient.getPageBlocks()` which does recursive fetching.

**Fix:**
- Either import and use `NotionClient` in the Worker (it's runtime-agnostic — uses `fetch`), or implement recursive block fetching in the queue consumer
- Call `client.getPageBlocks(pageId)` instead of the direct `fetch()` call
- Update the blocks response handling to use the already-recursive result

**Files:** `src/worker/index.ts`

---

## 5. No integration test for full queue consumer flow

**Symptom:** `src/worker/index.test.ts` tests HTTP routes but not the queue consumer processing logic (`queueHandler`).

**Root cause:** The queue consumer wasn't extracted as an importable function (it was a named export, now it's part of the default export). It can still be tested by importing the handler function.

**Fix:**
- Export `queueHandler` as a named export for testing (keep it in the default export too)
- Write tests: mock Notion API responses, verify R2 writes, D1 upserts, hash skip, error recording
- Use the existing mock builders from the test file

**Files:** `src/worker/index.ts`, `src/worker/index.test.ts`

---

## 6. Rich text annotations: strikethrough, underline, color not supported

**Symptom:** The Notion converter handles bold, italic, code but doesn't convert strikethrough, underline, or colored text.

**Fix:**
- Add `~~strikethrough~~` support in `richTextToMarkdown()` (`src/lib/notion-converter.ts`)
- Add `<u>underline</u>` support (or ignore — Markdown doesn't have native underline)
- Add golden fixture test cases in `test/fixtures/notion/rich-text.json`

**Files:** `src/lib/notion-converter.ts`, `test/fixtures/`

---

## Summary

| # | Issue | Impact |
|---|-------|--------|
| 1 | `sync:full` query endpoint 400 | **Blocks full sync** |
| 2 | Non-deterministic content hash | Breaks skip-unchanged |
| 3 | Assets not uploaded to R2 | Expiring image URLs |
| 4 | No recursive block fetch in Worker | Missing nested content |
| 5 | No queue consumer integration test | Test gap |
| 6 | Missing rich text annotations | Minor MD incompleteness |
