# Pipeline Comparison Report

**Date:** 2026-06-10
**Old codebase:** `comapeo-docs/scripts/` (local Node/Bun scripts)
**New codebase:** `comapeo-content-pipeline/src/` (Cloudflare Worker + CLI)

## Legend

- **SHOULD CONSIDER** — Behavioral difference that may be intentional but should be reviewed
- **MINOR** — Cosmetic or low-impact difference

All SHOULD FIX items have been addressed. This report documents remaining differences.

---

## 1. Notion API Client

### Remaining

| # | Finding | Classification | Notes |
|---|---------|---------------|-------|
| 1.1 | **No circuit breaker** — old code had sliding-window rate-limit tracker with auto-recovery | SHOULD CONSIDER | Simple RPS throttle + retry handles basic cases but lacks the circuit breaker pattern that prevents cascading failures under sustained rate limits |
| 1.2 | **No request scheduler** — old code had a queue-based request scheduler | SHOULD CONSIDER | Multiple concurrent page syncs could still overwhelm the Notion API |
| 1.3 | **Uses `/v1/search` instead of `dataSources.query`** | SHOULD CONSIDER | Client-side filtering by database_id; less efficient for large workspaces |
| 1.4 | **No pagination anomaly detection** — old code detected duplicate IDs and stale cursors | SHOULD CONSIDER | Simpler pagination without these safety checks |

---

## 2. Notion-to-Markdown Conversion

### Remaining

| # | Finding | Classification | Notes |
|---|---------|---------------|-------|
| 2.1 | **No emoji processing** — old code had custom emoji downloading and caching | SHOULD CONSIDER | Custom Notion emojis appear as broken references |
| 2.2 | **Numbered list restart** — new code always starts with `1.` | MINOR | Markdown renderers handle sequential `1.` items correctly |
| 2.3 | **No retry-based image processing** — old code had multi-pass retry for S3 URLs | SHOULD CONSIDER | Single-pass processing with no retry for failed image downloads |
| 2.4 | **No centralized error classification** — old code classified errors into categories | SHOULD CONSIDER | Simpler try/catch with console.warn |
| 2.5 | **No content scoring/analysis** — old code had comprehensive content analysis | MINOR | No equivalent analysis tool |

---

## 3. Asset/Image Handling

### Remaining

| # | Finding | Classification | Notes |
|---|---------|---------------|-------|
| 3.1 | **No image optimization** — old pipeline resized and converted to WebP | SHOULD CONSIDER | Larger file sizes in R2, slower page loads |
| 3.2 | **No image caching** — old pipeline had LRU cache + disk cache | SHOULD CONSIDER | Each sync re-downloads all images |
| 3.3 | **No concurrent image processing** — new pipeline processes sequentially | SHOULD CONSIDER | Slower for pages with many images |
| 3.4 | **No image failure logging** — old pipeline logged to image-failures.json | SHOULD CONSIDER | Makes debugging harder in production |
| 3.5 | **URL replacement uses `replaceAll()`** — could match partial URLs | SHOULD CONSIDER | Position-based replacement would be safer |

---

## 4. Sync/Orchestration Logic

### Remaining

| # | Finding | Classification | Notes |
|---|---------|---------------|-------|
| 4.1 | **No sidebar position fallback with file scanning** — old code scanned existing files | SHOULD CONSIDER | Position collisions possible if pages synced in batches |
| 4.2 | **No translation string management** — old code built translation maps | SHOULD CONSIDER | No automated translation title tracking |
| 4.3 | **No sub-item relation handling in sync** — old code used Sub-item for page hierarchy | SHOULD CONSIDER | docs:pull handles this, but sync layer doesn't |

---

## 5. Persistence

### Remaining

| # | Finding | Classification | Notes |
|---|---------|---------------|-------|
| 5.1 | **No image failure logging** — old pipeline logged to JSON file | SHOULD CONSIDER | Only console.warns failures |
| 5.2 | **No retry metrics** — old pipeline tracked and saved retry metrics | MINOR | Nice-to-have for monitoring |

---

## 6. CLI/Worker

### Remaining

| # | Finding | Classification | Notes |
|---|---------|---------------|-------|
| 6.1 | **No progress spinners** — new CLI uses basic console.log | MINOR | Less user-friendly but functional |
| 6.2 | **No test mode** — old pipeline had test database support | SHOULD CONSIDER | Testing against production data is risky |

---

## 7. Utilities

### Remaining

| # | Finding | Classification | Notes |
|---|---------|---------------|-------|
| 7.1 | **No centralized property name constants** — old code used NOTION_PROPERTIES object | SHOULD CONSIDER | Inline strings scattered across files; multiple files need updating if property names change |

---

## Summary

| Category | SHOULD CONSIDER | MINOR |
|----------|----------------|-------|
| 1. Notion Client | 4 | 0 |
| 2. Converter | 3 | 2 |
| 3. Assets | 5 | 0 |
| 4. Sync | 3 | 0 |
| 5. Persistence | 1 | 1 |
| 6. CLI/Worker | 1 | 1 |
| 7. Utilities | 1 | 0 |
| **TOTAL** | **18** | **4** |

---

## Previously Addressed (removed from this report)

All SHOULD FIX items resolved: image extraction (4.6, 4.7, 1.6), column layouts (2.2b), block recursion (1.4), sidebar_custom_props (3.1), image sanitization (6.1), retry logic (4.3), page grouping (5.1), deleted page detection (5.5, 11.2), sanitizeMarkdownImages (6.1).

Additional improvements: thread-safe children map (2.9), missing block types (2.2), plain text alt (2.7), quote nesting (2.5), parent item filter (1.10), request dedup (1.11), keyword/tag defaults (3.6, 3.7), automated locale mapping (12.3), Toggle/Title filtering (5.3), asset copying, section labels, URL-friendly dirs, translation slug matching.
