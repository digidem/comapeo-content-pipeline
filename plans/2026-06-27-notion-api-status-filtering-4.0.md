# Reduce Notion Fetching Time — Consolidated Constants & Model-Safe API-Level Status Filtering (v4)

## What changed from v3 (the fixes)

v4 supersedes `2026-06-27-notion-api-status-filtering-3.0.md`. Two blocking design errors in v3 are corrected, plus a sequencing change:

1. **Removed the `topLevelOnly` / `Parent item is_empty` filter dimension entirely.** v3's default filter dropped every page that has a parent. In this database each content item is a **placeholder parent + en/es/pt child rows** linked via the "Sub-item" relation, and the real content (including English) lives in the **children**. `docs:pull` (`src/cli/index.ts:367-502`) detects containers by `sub_items` and emits the language children under the parent's slug/section/order. A top-level-only filter would drop all child content → silent data loss. v4 never filters on parent/child relation at the API level.

2. **Switched from inclusion to exclusion status filtering (proven, model-safe).** v3 built an `or` of 7 `select.equals` over a hand-enumerated `ACTIVE_STATUSES`. That (a) is unproven against the API, (b) creates a second, divergent source of truth for "active" alongside `mapStatus()`, and (c) drops any active page whose status name isn't in the list. v4 mirrors the **production** old-system filter (`comapeo-docs/scripts/notion-fetch-all/fetchAll.ts:190-220`): keep empty-status rows, exclude only a known dead-status set. Keeping `is_empty` rows is mandatory because containers and es/pt children frequently carry no status.

3. **Split safe refactor from risky migration.** Phase 1 (constants consolidation) and Phase 4 (cron pagination + dead-code cleanup) are independent and shippable on their own. The query/endpoint migration (Phases 2-3) is gated behind an SDK compatibility check and can land in a later PR without holding up the low-risk work.

## Investigation Results (de-risking — completed before implementation)

Four parallel investigations ran against the live code, the installed SDK, the sibling repo, and the live Notion API. Confirmed facts now baked into this plan:

- **SDK is Workers-native.** `@notionhq/client@5.22.0` is installed; `dataSources.query` exists with the expected `{ data_source_id, filter, sorts, start_cursor, page_size }` shape. The package has **zero runtime dependencies**, uses `globalThis.fetch`, and imports no Node built-ins → runs on the Workers runtime without relying on `nodejs_compat`. **Phase 2.1 is now expected to pass; Phase 3B is a contingency only.**
- **Baseline is green.** `tsc --noEmit` clean; **250 tests pass** across 14 files (the "145+" figure was stale).
- **Live "Publish Status" options retrieved.** The only dead/take-down values are **`"Remove"` and `"Unplublished"`** (the latter is a real misspelling in Notion — two p's). All v3 candidate dead values (`"X - Depreciated"`, `"Deleted"`, `"deprecated"`, `"archive"`, `"archived"`, `"inaccessible"`) **do not exist**. `DEAD_STATUSES` is set to the two real values.
- **`data_source_id` works.** `POST /v1/data_sources/{NOTION_DATA_SOURCE_ID}/query` returns 200 + rows. Note: `NOTION_DATA_SOURCE_ID` and `NOTION_DATABASE_ID` in `.env` are the **same UUID** (hyphenated vs not) for this database — they are not distinct (corrects Decision 7).
- **Open follow-up flagged (see "Discovered: status vocabulary drift").** `status.ts`/`mapStatus` is written against a status vocabulary that no longer exists in the live DB.

## Discovered: status vocabulary drift (pre-existing, flagged)

`src/lib/status.ts` maps statuses like `"EN Done"`, `"Translations Validated"`, `"Pre-publish done"`, `"X - Depreciated"`, `"Deleted"` — **none of which exist in the live "Publish Status" property.** Combined with the fact that the pipeline currently reads the **wrong property name** (`"Drafting Status"`, also non-existent → every page's `mapStatus` input is `undefined` → every page currently classifies as `"draft"`), the `status` field is effectively meaningless today. Renaming to `"Publish Status"` (Decision 3) fixes the read, after which the real options map as: `Published` / `Draft published` / `Ready to publish` → `active`; most others → `draft` (via existing `/in progress/i` etc.); `Remove`/`Unplublished` → handled by the consistency fix below. Whether `mapStatus` should be fully realigned to the real vocabulary is a scope decision tracked separately (it is **not** required for the fetch-time optimization, which only needs `DEAD_STATUSES`).

**Decision (confirmed): tight scope.** This plan does NOT realign `mapStatus` beyond adding the `Remove`/`Unplublished` → deprecated patterns. After the property-name fix, `active` = `Published` / `Draft published` / `Ready to publish`; all other live options map to `draft`. Full realignment of the active/draft sets to the real 13-option vocabulary is a deliberate **follow-up**, out of scope here. Do not expand it during implementation.

## Objective

Reduce Notion fetch time by (1) consolidating hardcoded Notion strings into one constants file, (2) replacing the broken `/v1/search` workaround with `@notionhq/client` v5 `dataSources.query` so filtering happens at the API level, and (3) eliminating duplicated query logic between Worker and `NotionClient` — **without** changing which content pages get emitted. The fetch-time win comes from not fetching/processing pages whose status is deprecated, archived, or removed; active, draft, and empty-status pages (including all container/child rows) are unaffected.

## Data Model Invariant (must hold after every change)

> Each content item = one placeholder **parent** row + up to three language **child** rows (en/es/pt), linked via the same-database self-relation **"Sub-item"**. The parent body is a "Process Checklist" placeholder; the actual content for every language lives in the children. All rows (parent + children) are top-level DB rows.

Consequences enforced by this plan:
- The query must return **both** parents and children. Never filter on `Parent item` / `Sub-item` at the API level.
- `excludeSubItems: true` in the current `sync:full` call (`src/cli/index.ts:177`) is a **no-op** — children have a `database_id` parent, not a `page_id` parent, so the client-side `parent.page_id` check never excludes them (`src/lib/notion-client.ts:256`). v4 removes this dead flag; behavior is unchanged because it never excluded anything.
- The status filter must keep `is_empty` rows so section-less es/pt children and status-less containers survive.

## Decisions Made (Definitive)

### Decision 1: Use `@notionhq/client` v5 SDK, with raw-fetch fallback
The SDK (`@notionhq/client`, resolved `5.22.0`, `package.json:18`) is installed but unused. The old `comapeo-docs` proves `dataSources.query` works with compound `select` filters and `notionVersion: "2025-09-03"` (`comapeo-docs/scripts/notionClient.ts:264`). **Investigation confirmed** the installed SDK has zero deps, uses `globalThis.fetch`, and pulls in no Node built-ins, so it runs on the Workers runtime (the `nodejs_compat` flag at `wrangler.toml:4` is not even required for it). **Residual risk is low; Phase 3B raw-fetch fallback is retained only as contingency.**

### Decision 2: Property name is `"Publish Status"`, type `select`
Confirmed two ways: old-system constant `STATUS: "Publish Status"` (`comapeo-docs/scripts/constants.ts:17`) and fixture shape `"Publish Status": { select: { name: status } }` (`comapeo-docs/scripts/test-utils.ts:70`). It is a Notion **`select`** property, not a `status`-type property, so filters use `select.equals` / `select.does_not_equal` / `select.is_empty`. The current `DRAFTING_STATUS: "Drafting Status"` (`src/lib/notion-properties.ts:11`) is stale.

### Decision 3: Rename constant key `DRAFTING_STATUS` → `PUBLISH_STATUS` (value `"Publish Status"`)
Key should match the real property name. Consumed by exactly two locations: `sync.ts:94`, `manifest.ts:30`.

### Decision 4: Keep `drafting_status` as the internal schema field name
Renaming the field (`src/schemas/metadata.ts:37`, `manifest.ts`, `sync.ts:245`) would change the metadata JSON format and force a full re-sync of the schema shape. The field is internal and independent of the Notion property name. A clarifying code comment is sufficient.

### Decision 5: Exclusion-based status filter; `mapStatus` stays the single classifier
The API filter excludes a **dead-status set**; `mapStatus()` (`src/lib/status.ts`) remains the only place that classifies status into `active|draft|deprecated|archived`. To prevent the v3 divergence problem, the dead-status set fed to the API filter is **derived from the same constants** that `mapStatus` documents (deprecated + archived/deleted values), not a separately maintained list. Draft and active pages are **not** excluded by default, preserving current emit behavior.

**Consistency fix:** `mapStatus()` has no pattern for the two real dead values `"Remove"` and `"Unplublished"` — both currently fall through to `"draft"`. Add `/remove/i` and `/unpl?ublished/i` (the `l?` absorbs the real Notion typo "Unplublished" and also matches a corrected "Unpublished") to `DEPRECATED_PATTERNS` in `status.ts` so the dead-status↔`mapStatus` invariant (test 1.2) holds and any such page reaching the classifier via `--all` is treated as deprecated, not draft.

### Decision 6: Default filter excludes dead statuses only; `--all` disables the filter
- **Default** (`sync:full`, cron): exclude deprecated/archived/deleted/removed statuses, keep everything else **including empty status**. This is the proven old-system shape extended with the deprecated/archived values the pipeline already recognizes.
- **`--all` flag**: omit the status filter entirely (fetch every row), matching the old system's `includeRemoved`.
- **`--filter` flag**: pass the user-provided filter object through verbatim.

Default does **not** drop drafts. Draft-skipping would change which pages Docusaurus receives and is deliberately out of scope (can be a follow-up opt-in flag).

### Decision 7: Query the data source directly; drop client-side `database_id` filtering
`dataSources.query` targets `NOTION_DATA_SOURCE_ID`, so results are inherently scoped to the source and the current `/v1/search` + client-side `database_id` normalization dance (`notion-client.ts:242-262`, `worker/index.ts:551-560`) is removed. **Note (corrected):** for this database `NOTION_DATA_SOURCE_ID` and `NOTION_DATABASE_ID` are the *same* UUID (one hyphenated, one not) — not distinct values. Investigation confirmed the id queries successfully as a data source (200 + rows), so the approach holds; just don't assume the two env vars differ. Use `NOTION_DATA_SOURCE_ID` (falling back to `NOTION_DATABASE_ID`) as the `data_source_id`, mirroring `worker/index.ts:179` etc.

## Corrected Filter Design

New module `src/lib/notion-filters.ts`:

```ts
buildQueryFilter(options?: {
  includeAll?: boolean;          // --all: returns undefined (no filter)
  since?: string | null;         // cron watermark: adds last_edited_time.after
}): Record<string, unknown> | undefined
```

- `includeAll: true` → `undefined` (SDK omits `filter`).
- Otherwise build the status guard (keep empty + exclude dead), proven shape:
  ```
  status_guard = { or: [
    { property: PUBLISH_STATUS, select: { is_empty: true } },
    { and: DEAD_STATUSES.map(v => ({ property: PUBLISH_STATUS, select: { does_not_equal: v } })) }
  ] }
  ```
  `DEAD_STATUSES = ["Remove", "Unplublished"]` — the two real take-down options confirmed in the live DB (Investigation Results). The `and` therefore has exactly two `does_not_equal` clauses. Using `does_not_equal` (exclusion) avoids enumerating the open-ended active set and never orphans a live child.
- If `since` is provided (cron), wrap in `and` with `{ timestamp: "last_edited_time", last_edited_time: { after: since } }`.
- No `Parent item` / `Sub-item` condition is ever added.

**Sort order:** `queryDatabase()` always passes `sorts: [{ timestamp: "last_edited_time", direction: "descending" }]` (matching the current `/v1/search` behavior) so the cron watermark logic — which assumes newest-first results — is preserved. `buildQueryFilter()` returns only the `filter`; the sort is set by `queryDatabase()` itself, not the caller.

> Implementation note: if Notion rejects the `and`-of-`does_not_equal` compound (filter-complexity limit), fall back to a single `does_not_equal: "Remove"` guard exactly like the old system, and rely on `mapStatus()` + a post-fetch block-skip for the remaining deprecated/archived pages. Validate the compound shape in Phase 2.

## Current State Audit (verified against code)

### Constants scattered (40+ strings)
| Category | Key locations | Notes |
|---|---|---|
| Property names | `notion-properties.ts` (7), `sync.ts:98,99,106` inline (`"Keywords"`, `"Tags"`, `"Date Published"`) | also `"Parent item"` used by old system |
| Status values | `status.ts:13-42` (regex only) | no enumerated dead-status list exists yet |
| API constants | `notion-client.ts:67,74`, `worker/index.ts:535,539` (duplicated) | `"2026-03-11"`, base URL |
| Element types | `cli/index.ts:416,459,509,716,841` (regex) | `toggle`/`page`/`title` |
| Locale mappings | `sync.ts:348-356`, `cli/index.ts:418,480,564,720` | `"es - automated"` ternary ×4 |
| Section names | `cli/index.ts` (`"Uncategorized"`, magic `9999`) | |

### Duplicated query logic
- `NotionClient.queryDataSource()` (`notion-client.ts:209-265`) — CLI.
- `queryChangedPages()` (`worker/index.ts:519-569`) — standalone `fetch()`, duplicates all API constants.

### Dead code
- `dataSourceId` param in `queryDataSource()` — accepted, never read (`notion-client.ts:210`).
- `dataSourceId` constructor field — stored, never used (`notion-client.ts:73`).
- `excludeSubItems` — passed `true` but never excludes anything (model invariant above).

### Pre-existing bugs
- Cron fetches only first `limit` (50) results, no pagination loop (`worker/index.ts:519-568`) — silently drops changes when >50 pages edited.
- Zero test coverage for `queryDataSource()`, `queryChangedPages()`, cron handler, `/admin/sync/changed`.

## Implementation Plan

### Phase 1 — Consolidate constants (independent, shippable alone)

- [ ] **1.1** In `src/lib/notion-properties.ts`: rename `DRAFTING_STATUS` → `PUBLISH_STATUS` (value `"Publish Status"`); add `KEYWORDS`, `TAGS`, `DATE_PUBLISHED`, `PARENT_ITEM: "Parent item"`. Add a comment noting the internal `drafting_status` field name is intentionally unrelated to this property name (Decision 4).
- [ ] **1.2** Add the dead-status constant (real live values, confirmed in Investigation Results):
  - `DEAD_STATUSES = ["Remove", "Unplublished"]`  // "Unplublished" is the real Notion typo
  - **Add `/remove/i` and `/unpl?ublished/i` to `DEPRECATED_PATTERNS` in `src/lib/status.ts`** (Decision 5 consistency fix) so `mapStatus("Remove") === "deprecated"` and `mapStatus("Unplublished") === "deprecated"`.
  - Add a test asserting every `DEAD_STATUSES` value maps to `deprecated`/`archived` via `mapStatus()` (locks the two in sync). Passes only after the pattern additions.
- [ ] **1.3** Add `NOTION_API`: `BASE_URL`, `SEARCH_VERSION: "2026-03-11"` (legacy `/v1/search` fallback), `DATABASE_VERSION: "2025-09-03"`, `DEFAULT_PAGE_SIZE: 100`.
- [ ] **1.4** Add `NOTION_ELEMENT_TYPES` + helpers `isContentPage(et)` (`/^page$/i` or empty) and `isStructuralPage(et)` (`/^(toggle|title)$/i`), matching current regex semantics at `cli/index.ts:459,509,716,841`.
- [ ] **1.5** Add `NOTION_LOCALES` + `normalizeLocale(locale)` covering `English/Portuguese/Spanish/pt-BR` and automated variants (`"es - automated"→"es"`, `"pt - automated"→"pt"`), passthrough lowercased. Replaces `sync.ts:348-356` and the four ternaries at `cli/index.ts:418,480,564,720`.
- [ ] **1.6** Add `SECTION_NAMES`: `UNCATEGORIZED: "Uncategorized"`, `UNCATEGORIZED_ORDER: 9999`.
- [ ] **1.7** Replace inline references with imports: `sync.ts:94,98,99,106,348-356`; `manifest.ts:30`; `cli/index.ts:416,459,509,716,841` (helpers), `:418,480,564,720` (`normalizeLocale`), Uncategorized/9999 sites; `notion-client.ts:67,74`; `worker/index.ts:535-543`; `worker/index.test.ts:422` comment. **Behavior-preserving only — no query changes in this phase.**

**Ship gate:** `npm run typecheck && npm test` green; the dead-status↔`mapStatus` test (1.2) passes. Phase 1 can be its own PR.

### Phase 2 — Live-DB verification + SDK compatibility gate

- [x] **2.0** **DONE — verified against the live DB during planning.** Results: `"Publish Status"` options = Not started, Update in progress, Ready for translation, Automated translation in progress, Automated translations generated, Auto translation generated, Reviewing translations, Ready to publish, Adding to staging site, Draft published, Published, **Remove**, **Unplublished**. Only `Remove` and `Unplublished` are dead → `DEAD_STATUSES = ["Remove", "Unplublished"]`. `GET /v1/data_sources/{id}` and `POST /v1/data_sources/{id}/query` both returned 200 with `Notion-Version: 2025-09-03`; `NOTION_DATA_SOURCE_ID` == `NOTION_DATABASE_ID` (same UUID). Re-run this check only if the Notion schema changes.
- [ ] **2.1** Minimal Workers test (SDK Node-compat already confirmed statically — this just validates runtime + filter acceptance): import `Client`, construct with `notionVersion: "2025-09-03"`, call `dataSources.query({ data_source_id: NOTION_DATA_SOURCE_ID, filter: buildQueryFilter(), sorts: [{ timestamp: "last_edited_time", direction: "descending" }] })` under `wrangler dev`. Confirm the compound `and`-of-`does_not_equal` (two clauses) is **accepted by the API**. Expected pass → Phase 3A. Only on unexpected failure → Phase 3B / single-`Remove` fallback.
- [ ] **2.2** If SDK fails: capture the raw v5 endpoint path (expected `POST /v1/data_sources/{id}/query`) and request body shape for 3B.

### Phase 3A — SDK-based query (if 2.1 passes)

- [ ] **3A.1** Add `queryDatabase()` to `NotionClient`: lazily construct a `Client` with `DATABASE_VERSION`; call `dataSources.query({ data_source_id, filter, sorts, start_cursor, page_size })`; **default `sorts` to `[{ timestamp: "last_edited_time", direction: "descending" }]`** (preserves cron watermark assumption); full pagination loop with stale-cursor detection (reuse `getAllBlockChildren` pattern, `notion-client.ts:320-347`); return the existing `NotionPageResponse` shape. `data_source_id` comes from the constructor field (now actually used).
- [ ] **3A.2** Implement `buildQueryFilter()` in `src/lib/notion-filters.ts` per the Corrected Filter Design. No relation/parent dimension.
- [ ] **3A.3** `cmdSyncFull()` (`cli/index.ts:174`): replace `queryDataSource({ excludeSubItems: true })` with `queryDatabase({ filter: buildQueryFilter({ includeAll: args.all }) })` (or `JSON.parse(args.filter)` when `--filter`). Remove `excludeSubItems`. Keep emitting all returned rows (parents + children).
- [ ] **3A.4** `queryChangedPages()` (`worker/index.ts:519`): replace standalone `fetch()` with `NotionClient.queryDatabase({ filter: buildQueryFilter({ since }) })`; add the pagination loop (fixes the >50-page data-loss bug); keep the `MAX_PAGES_PER_CRON` per-tick cap.
- [ ] **3A.5** Mark `queryDataSource()` `@deprecated` (points to `queryDatabase()`), keep the body for one release for rollback safety.

### Phase 3B — Raw-fetch query (only if 2.1 fails)

- [ ] **3B.1** `queryDatabase()` via raw `fetch()` to the 2.2 endpoint with `Notion-Version: 2025-09-03`; same params/return/pagination as 3A.1.
- [ ] **3B.2–3B.5** Identical to 3A.2–3A.5 (filter + callers are fetch-mechanism-agnostic).

### Phase 4 — Cleanup (independent, shippable alongside Phase 1)

- [ ] **4.1** Remove the unread `dataSourceId` **parameter** from `queryDataSource()` (the constructor field becomes live in Phase 3; if Phase 3 hasn't landed, leave the field with a TODO).
- [ ] **4.2** Confirm all locale ternaries and element-type regexes are gone (covered by 1.5/1.4); delete any stragglers.
- [ ] **4.3** Cron safety counter (`MAX_PAGES = 10000`) around the new pagination loop to guard runaway loops, matching the old system (`comapeo-docs/scripts/fetchNotionData.ts`).
- [ ] **4.4** Reconcile `wrangler.toml`/`CLAUDE.md`: the queue consumer is **present and active** (`wrangler.toml:22-23`), contradicting the "commented out" note. Update the doc or the config to reflect reality before relying on the consumer path.

### Phase 5 — Tests

- [ ] **5.1** Characterization tests for `queryDataSource()` and `queryChangedPages()` (mocked) capturing current behavior; update (don't delete) post-migration.
- [ ] **5.2** `buildQueryFilter()`: default keeps `is_empty` + excludes each `DEAD_STATUSES` value via `does_not_equal`; `includeAll` → `undefined`; `since` adds `last_edited_time.after`; **assert no `Parent item`/`Sub-item` key ever appears** (regression guard for the v3 bug).
- [ ] **5.3** `queryDatabase()`: filter passed in request body; multi-page pagination with cursor; stale-cursor break.
- [ ] **5.4** Cron handler: only non-dead changed pages enqueued; watermark advances; **>50 changed pages paginate without loss**.
- [ ] **5.5** `normalizeLocale()`: all standard + automated + passthrough cases.
- [ ] **5.6** Element-type helpers: `isContentPage("page")=true`, `("")=true`, `("toggle")=false`; `isStructuralPage("toggle"|"title")=true`, `("page")=false`.
- [ ] **5.7** Add a fixture with `"Publish Status": { select: { name: "Published" } }` (a real active option; current fixtures omit it → default `"draft"`) to exercise extraction→`mapStatus`→emit with the renamed constant. Add a second fixture with `{ name: "Remove" }` to confirm it now maps to `deprecated`.
- [ ] **5.8** **Model-safety test:** a fixture set of one container parent (status empty, `sub_items: [en, es, pt]`) + three children (en `"Published"`, es empty, pt `"Ready to publish"` — all real options); assert the default filter retains all four (none in `DEAD_STATUSES`; empty kept via `is_empty`). Explicit guard against the v3 regression. Conversely, a child with status `"Remove"` is excluded by the filter — document that a removed translation is intentionally dropped.
- [ ] **5.9** Grep test in CI for `DRAFTING_STATUS` references removed and no inline `"Publish Status"`/`"Keywords"`/`"Tags"`/`"Date Published"` outside `notion-properties.ts`.

### Phase 6 — Deploy & verify

- [ ] **6.1** `npx wrangler deploy`; check `/health`; watch logs for 400/429 from Notion (esp. filter rejection).
- [ ] **6.2** `pnpm pipeline sync:full --force` to refresh metadata blobs under the corrected `"Publish Status"` key (stale blobs show `drafting_status: null` until re-synced — cosmetic; mapped `status` is stored separately).
- [ ] **6.3** Post-resync spot check: compare emitted page **count** and the set of en/es/pt children for a few known containers against a pre-change `--all` run, to prove no content pages were dropped by the new filter.

## Verification Criteria

- [ ] All Notion constants (properties, dead-status set, API config, element types, locales, sections) live only in `src/lib/notion-properties.ts` (filters in `notion-filters.ts`).
- [ ] `grep -rn '"Publish Status"\|"Keywords"\|"Tags"\|"Date Published"' src/ --include="*.ts" | grep -v notion-properties` returns nothing.
- [ ] No duplicated API URL/version constants between `notion-client.ts` and `worker/index.ts`.
- [ ] Worker cron uses `NotionClient.queryDatabase()`, paginates, and handles >50 changed pages.
- [ ] Deprecated/archived/removed pages are excluded at the API level; **active, draft, empty-status, and all container/child rows are still fetched and emitted** (5.8 + 6.3 prove it).
- [ ] No API filter ever references `Parent item` or `Sub-item`.
- [ ] `--all` fetches every row (no filter); `--filter` passes through verbatim.
- [ ] `mapStatus` remains the sole status classifier; `mapStatus("Remove") === "deprecated"`; `DEAD_STATUSES`↔`mapStatus` consistency test passes.
- [ ] `DEAD_STATUSES` contains only real `"Publish Status"` select options confirmed in Phase 2.0.
- [ ] `queryDatabase()` sorts `last_edited_time` descending by default; cron watermark behavior unchanged.
- [ ] All 250 existing tests still pass; new tests cover filter construction, query/pagination, cron, locale, element-type, status-fixture, and the model-safety guard.
- [ ] `@notionhq/client` is actively used (or 3B raw path documented as the chosen fallback).

## Risks & Mitigations

1. **SDK incompatible with Workers** — largely retired: investigation confirmed zero deps, `globalThis.fetch`, no Node built-ins. Phase 2.1 runtime check remains; Phase 3B raw fallback is functionally identical if ever needed.
2. **Compound `does_not_equal` filter rejected** — Phase 2 validates it against the live API; fallback to single `does_not_equal: "Remove"` + `mapStatus` block-skip (old-system parity).
3. **A live child sits under a dead-status parent (or vice versa)** — exclusion keeps `is_empty` and everything not in `DEAD_STATUSES`, so a live child is never dropped by its parent's status; a dead child is correctly skipped. 6.3 spot-check confirms.
4. **Stale metadata blobs after the property rename** — cosmetic (`drafting_status` null until re-sync); Phase 6.2 refreshes; note in release notes.
5. **API version `2025-09-03` deprecated later** — SDK `^5.12.0` pins a compatible version; monitor Notion changelog; Phase 2 script re-validates new versions cheaply.
6. **Cron processes more pages once pagination is fixed** — keep `MAX_PAGES_PER_CRON` per-tick cap (`wrangler.toml:33`) plus the 10k safety counter; watermark skips already-processed pages next tick.

## Sequencing / Shipping

- **PR 1 (low risk):** Phase 1 + Phase 4.1/4.2/4.4 + the constants/helper tests (5.5, 5.6, 5.9) + the `DEAD_STATUSES`↔`mapStatus` test (1.2). Pure refactor, no query behavior change.
- **PR 2 (gated):** Phase 2.0 (live-DB verification — do this first) → 2.1 gate → 3A or 3B + filter/query/cron tests (5.1–5.4, 5.7, 5.8) + Phase 4.3. The fetch-time optimization.
- **PR 3 (ops):** Phase 6 deploy, re-sync, and the content-count verification.

## Alternatives (kept for reference)

1. **Client-side block-skip only (no endpoint change):** query all metadata, skip the expensive recursive block fetch for pages whose `mapStatus` is dead. Lowest risk, model-safe, but keeps the broken `/v1/search` workaround and doesn't reduce query volume. Viable if Phase 2 fails on both SDK and raw paths.
2. **Webhooks over cron:** the `POST /webhooks/notion` endpoint exists; eliminates polling but adds missed-event/replay concerns and still needs status filtering. Future enhancement.
3. **CLI-side `last_edited_time` cache:** skip unchanged pages before querying. Helps `sync:full` wall-clock but not API query volume; the Worker already has D1 skip logic. Secondary optimization.
