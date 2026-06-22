# TASK.md — Remaining work to complete the Notion → Docusaurus migration

Working model: **senior/junior delegation**.
- **Senior — Opus 4.8 (me):** plan, decompose, write each task spec, review diffs, run all builds/tests/syncs (the junior can edit files but cannot reliably run `bun`/network/builds), make architecture/data-model decisions.
- **Junior — GLM 5.2** (via `senior-engineer-delegation`/`scripts/delegate.sh`; fall back to `forge`+`nex-n2-pro` if GLM is exhausted): mechanical implementation from a self-contained spec. One coherent unit per call; parallelize only across disjoint files.
- **Verification gate:** every change is validated by `npm run typecheck` + `npm test`, a `docs:pull` regeneration, and — for anything touching rendered output — a full production build: `cd ../comapeo-docs && bun run build` (the only thing that surfaces MDX/broken-link errors; dev-server compiling is NOT sufficient).

Current state (2026-06-22): conversion is correct (English-from-child, emoji rehosted, ordering, i18n labels, no test/internal/stub leakage); the production build **passes for all 3 locales**. **Tasks 1–4 below are DONE** (see commit log). `output/` regenerated from a clean full sync; build green; zero string-style spans, zero dangling bold markers. Broken refs reduced from 318 (301 links + 17 anchors) to ~179 (151 links + 28 anchors) — the residual are NOT slug-suffix/i18n-slug/anchor-format bugs but: (a) stale localized slugs from renamed Notion pages, (b) links to section/category landing pages (Docusaurus serves these at `/category/<label>`, not `/docs/<section>`), and (c) anchor mismatches where an es/pt page falls back to English content but the link's fragment is in the source language (untranslated-content issue). Remaining work is P1 (CI gate) and P2/P3 below.

## DONE (this session)
- **3. Dangling bold** — `richTextToMarkdown` wraps inline markers per line; unit test + `bold-multiline` golden fixture.
- **1+2. Internal links & anchors** — slug stability (grouped pages publish at the clean title-derived slug; `translationMap` carries it) + new runtime-agnostic `src/lib/links.ts` resolver wired into `cmdDocsPull`: maps localized/suffixed slugs and notion.so/page-id links to the canonical English route with the file's locale prefix, and slugifies heading anchors. `links.test.ts` (15 cases).
- **(found during 4) JSX style objects** — `sanitizeMarkdownContent` masks `style={{…}}` before brace-stripping so color spans (and emoji imgs) survive MDX compilation (a fresh sync exposed `<span style=color:"red">` MDX failures).
- **4. Clean re-sync** — `bun src/cli/index.ts sync:full --out ./output` (sandbox disabled) + `docs:pull` + `cd ../comapeo-docs && bun run build` → green for en/es/pt.

---

## ORIGINAL DEFECT NOTES (kept for reference; 1–4 resolved above)

---

## P0 — Rendering correctness (blocks "renders correctly" claim)

### 1. Internal link integrity (~86 broken links)
**Problem:** internal cross-references resolve to slugs/routes that don't exist. Build warns with 86 broken links.
**Root cause(s):**
- **Slug suffixing:** pages publish at a deduped slug (e.g. `inviting-collaborators-2331b081`) while links point to the clean slug (`/docs/inviting-collaborators`). The suffix is a sync-time collision artifact against the now-skipped container parent.
- **i18n slug mismatch:** es/pt content links to localized slugs (`/es/docs/invita-colaboradores`) but stub pages fall back to the English-slugged route, so the localized route doesn't exist.
- A few links target genuinely missing/filtered pages.
**Files:** `src/lib/slug.ts`, `src/lib/sync.ts` (slug assignment), `src/cli/index.ts` `cmdDocsPull` (slug rewrite + a link-resolution pass), possibly `src/lib/notion-converter.ts` (how `href` internal links are emitted).
**Approach (senior to finalize):** make published slugs **stable/clean** — when the colliding page is a skipped container parent, the surviving child should take the clean slug (no ID suffix). Then add a `docs:pull` link-resolution pass that rewrites internal `](/docs/<slug>)` (and `/es//pt/` variants) to the actual published route for that locale (falling back to the English route when the localized page was stub-skipped). Build a page-id/slug → published-route map from the manifest.
**Junior task:** implement the slug-stability rule + the link-rewrite pass per the senior's spec.
**Acceptance:** production build broken-link count = 0 (or only genuinely-missing-in-Notion targets, explicitly listed); spot-check links resolve in en/es/pt.

### 2. Broken anchors (~13)
**Problem:** links to `#Edit-an-observation`, `#roles-available-in-CoMapeo`, `#adding-photos` don't match generated heading IDs.
**Root cause:** Docusaurus generates heading IDs as lowercase-hyphenated; Notion link anchors preserve original casing/spacing.
**Files:** the same link-resolution pass as task 1 (`src/cli/index.ts`) or `src/lib/notion-converter.ts`.
**Junior task:** when emitting/resolving an internal link with a `#anchor`, slugify the anchor to Docusaurus's heading-ID format (lowercase, non-alphanumeric → `-`, collapse repeats).
**Acceptance:** production build broken-anchor count = 0; the named anchors resolve.

### 3. Dangling asterisks — unterminated bold across newlines
**Problem:** lines like `**Data Privacy & Security` and `**[Encryption & Security](…)` render literal `**`. Bold is never closed.
**Root cause:** `richTextToMarkdown` (`src/lib/notion-converter.ts:~165-186`) wraps a bold/italic/etc. run in `**…**`, but when the run's `plain_text` contains a newline, markdown bold can't span the line break, so the marker dangles.
**Files:** `src/lib/notion-converter.ts` (`richTextToMarkdown` annotation wrapping).
**Junior task:** when an annotated run's text contains line breaks, apply the annotation **per line segment** (wrap each non-empty line), or normalize internal newlines so the marker pair stays on one line. Add a converter golden-test fixture covering a bold run with an embedded newline.
**Acceptance:** no line in generated output has an odd count of `**` / unbalanced inline markers; the Overview/section-index pages render bold correctly; 214+ tests pass.

### 4. Regenerate `output/` from a clean full sync
**Problem:** `output/` currently holds a fresh 295-page sync that was then sed-patched for the span fix (a manual shortcut). After the converter fixes (tasks 2/3) land, `output/` must be regenerated honestly so the persisted dump matches the code.
**Senior task (not delegated — network/long):** run `bun src/cli/index.ts sync:full --out ./output` (sandbox disabled — Notion TLS fails through the sandbox proxy), then `docs:pull` + production build.
**Acceptance:** fresh sync + build green with tasks 1-3 applied; zero string-style spans, zero dangling markers, broken links/anchors at target.

---

## P1 — Guardrails

### 5. CI: production build as a regression gate
**Problem:** only a real `docusaurus build` catches MDX errors (string styles), broken links, broken anchors. There is no automated gate.
**Files:** `.github/workflows/*` (new), and/or a `scripts/` check.
**Junior task:** add CI that, on PR, runs `docs:pull` against a committed fixture manifest (or the latest `output/`) and `docusaurus build`, failing on MDX/SSG errors and (configurably) on broken links/anchors.
**Acceptance:** CI fails on a deliberately-broken link/MDX construct; passes on current main.

---

## P2 — Content hygiene (defensive code; underlying data is Notion-side)

### 6. `[Image: <url>]` author-notes
**Problem:** a few pages contain plain-text `[Image: <expiring-url>]` that the author typed instead of inserting an image block; the URL expires.
**Options:** (a) defensively strip standalone `[Image: <url>]` lines in `docs:pull` (like the `[Insert content here]` strip); (b) leave and flag for Notion cleanup.
**Decision needed (user/content team):** strip vs. fix-in-Notion. If strip — junior task mirrors the existing marker-strip in `cmdDocsPull`.

### 7. `(translating for public page)` container
**Problem:** an internal staging container ("CoMapeo Data & Privacy (translating for public page)") publishes to Uncategorized.
**Decision needed (Notion-side):** recategorize/delete in Notion, or add a title-pattern to the editorial/internal-page filter in `cmdDocsPull`.

---

## P3 — Broader pipeline completeness (beyond the docs renderer)

### 8. Worker conversion path (existing TASKS.md §1)
**Problem:** the Cloudflare Worker fetches raw page/blocks and writes raw JSON to R2 but does **not** run `convertBlocks`/`buildFrontmatter` — it emits no canonical Markdown. The queue consumer is disabled in `wrangler.toml`.
**Senior task:** wire the shared `syncPage`/`convertPageData` logic (Node-API-free) into the Worker; re-enable the queue consumer.
**Junior task:** mechanical wiring per spec; keep `src/lib` runtime-agnostic.
**Acceptance:** Worker `POST /admin/sync/page` produces the same canonical Markdown + assets as the CLI for a given page; queue consumer processes a webhook end-to-end.

### 9. RAG chunks (`rag:chunks` stub)
**Problem:** `rag:chunks` and `diff` are stubs (per CLAUDE.md / spec Definition of Done). The RAG consumer is unbuilt.
**Junior task:** implement `generateChunks`/`generateChunksManifest` per `src/schemas/rag.ts`; add tests.
**Acceptance:** `rag:chunks` emits `rag/chunks/*.json` + `rag/chunks-manifest.json` matching the schema; tests cover chunking rules.

---

## Not code — Notion content work (track separately)
- Untranslated es/pt pages (currently fall back to English) — fill content in Notion.
- `80-Ending a project` / mis-sectioned rows — section hygiene in Notion.
- Replace `[Image: <url>]` author-notes with real image blocks (see task 6).

---

## Suggested order
3 (dangling bold, isolated) → 1 + 2 (link/anchor resolution, shared pass) → 4 (clean re-sync + build) → 5 (CI gate) → 6/7 (decisions) → 8/9 (broader scope).
