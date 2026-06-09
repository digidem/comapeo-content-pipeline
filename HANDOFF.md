# Handoff Prompt

Copy this into `/goal` or use as the prompt for the next session:

```
You are working in `digidem/comapeo-content-pipeline`. The companion
`comapeo-docs` repo is at `../comapeo-docs`.

Your goal: fix every issue in TASKS.md until `pnpm pipeline sync:full --limit 5`
runs end-to-end without errors.

## Start here

Read CLAUDE.md for architecture, conventions, and commands. Then read TASKS.md
for the 6 known issues in priority order. The authoritative spec is
`comapeo_content_pipeline_spec.md`.

Use the `senior-engineer-delegation` skill before starting.

## Current state

- 145 tests pass, typecheck clean, worker deployed
- All 13 original TASKS items complete
- Worker: webhook → queue → consumer → convertPageData → R2 + D1 → manifest
- Queue consumer deployed and processing (default export `{fetch, queue, scheduled}`)
- CLI commands work: sync:page, diff, manifest:generate, validate, docs:pull, rag:chunks, db:migrate
- `sync:full` is the main broken path — returns 400 from Notion API

```
Admin token: `2ff93c318d02f4c15b0ef824a54b01c21482d4e8b95190a3615eaf650275c134`
Secrets set: NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_DATA_SOURCE_ID, ADMIN_TOKEN,
NOTION_WEBHOOK_VERIFICATION_TOKEN
```

## Priority order

1. **sync:full 400 error** — migrate Notion query from `/search/data-sources/query` to `/v1/search`
2. **Content hash non-determinism** — same page produces different hashes on repeated syncs
3. **Asset upload to R2** — assets downloaded but binary data never stored in Worker
4. **Recursive block fetch in Worker** — use NotionClient.getPageBlocks() instead of direct fetch
5. **Queue consumer integration test** — export + test queueHandler with mock Notion responses
6. **Missing rich text annotations** — strikethrough, underline, color support

## Rules

1. Work TASKS.md in priority order (1 → 6).
2. For each task: plan → failing test → implement → `npx vitest run` + `npx tsc --noEmit` → review diff → commit.
3. `npx wrangler deploy` after any worker-affecting change.
4. 145 tests currently pass — never regress. No test skipping.
5. Check off completed items in TASKS.md, commit the markdown change.
6. Shared lib code (`src/lib/`) stays runtime-agnostic (no Node-only APIs).
7. ESM imports use `.js` extensions. Zod schemas are source of truth.

## Key gotchas

- Notion `/v1/search` is the working query endpoint. `/v1/databases/{id}/query` and
  `/v1/search/data-sources/query` return 400 with API version 2026-03-11.
- Worker uses `node:crypto` (HMAC) — needs `nodejs_compat` flag. Don't remove it.
- Queue consumer needs default export `{ fetch, queue, scheduled }` — NOT named exports.
- `gray-matter.stringify` chokes on `undefined` values — strip them first.
- Notion webhook: one-time challenge echoes `verification_token` from body before
  HMAC check. Runtime events require valid signature.
- D1 binding is `DB`, R2 is `CONTENT_BUCKET`, Queue is `SYNC_QUEUE`.
- Worker startup test: `curl https://comapeo-content-pipeline.luandro.workers.dev/health`

## Definition of done

`pnpm pipeline sync:full --limit 5` produces 5 .md files, a valid manifest.json,
and sync_state.json in the output directory — with no errors.
```

---

## Session summary (2026-06-09)

**What was built:**
1. Extracted `convertPageData()` as runtime-agnostic pure conversion function
2. Worker queue consumer: full Markdown pipeline with D1 upserts + artifact recording
3. `rag:chunks` CLI using gray-matter frontmatter parsing
4. Content hash skip logic (Worker checks D1, CLI checks metadata.json, --force bypasses)
5. `docs:pull` locale-aware Docusaurus i18n paths
6. Docusaurus sidebar JSON generation (`{type:"category",label,items}` arrays)
7. `diff` CLI: live Notion page vs stored metadata comparison
8. Image asset rehosting via Web Crypto API (download + SHA-256 + URL replacement)
9. `db:migrate` CLI via wrangler d1 execute
10. Rate-limit retry tests (11 tests: 429, 529, non-retryable, max retries, network errors)
11. Worker integration tests (10 tests: health, webhook, admin, manifest routes)
12. Sync watermark persistence (sync:full writes sync_state.json)
13. Multilingual golden fixture (Spanish/Portuguese)
14. Rich text in table cells fixture (bold/italic/code in cells)

**Key decisions:**
- `convertPageData` is now async (asset rehosting needs fetch + crypto.subtle)
- Content hash computed BEFORE asset URL replacement
- Queue consumer uses default export `{fetch, queue, scheduled}` (Cloudflare requirement)
- `maxRps: 999` in retry tests + setTimeout mock to avoid real waits
- Asset key format: `assets/{sha256_hex}{ext}` (sha256: prefix stripped)

**Tools used:** senior-engineer-delegation (delegate.sh) for 8 of 13 tasks, direct implementation for 5 complex ones.

**Final state:** 145 tests, typecheck clean, worker deployed with producer + consumer + cron, 10 commits.
