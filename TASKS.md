# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for pending, actionable tasks. Resolved work lives in git log and the completed milestones section below.

---

## Pending Tasks

### Engineering & Pipeline Improvements (Dev Agent Backlog)

- [x] **P0: Real Docusaurus/MDX Canary Build Gate in CI** ([#19](https://github.com/digidem/comapeo-content-pipeline/pull/19))
   - **Completed:** Added real MDX AST parsing and React DOM Server SSR validation (`scripts/validate-mdx.ts`, `test/validate-mdx.test.ts`). Catches unescaped JSX brackets `<...>`, string/bare `style=` attributes, and broken tags with line and column accuracy. Wires into `npm test`, `npm run validate:mdx`, and `.github/workflows/ci.yml`. Zero false positives on code fences, admonitions, tables, and frontmatter across all golden fixtures and emitted docs.

- [x] **P1: Align Agent Workflow & Tooling Specs in `AGENTS.md`**
   - **Completed:** Formalized Antigravity/Gemini and Claude Code workflows, updated subagent delegation rules, and configured the autonomous merge policy (autonomous merge on consensus + clean CI/Greptile, only prompting human if not confident).

3. **P2: Upstream Notion Editorial Diagnostics & Linter Report**
   - **Context:** Hardcoded dictionaries in `src/lib/links.ts` (`KNOWN_SLUG_ALIASES`, `KNOWN_DOC_ANCHOR_ALIASES`) compensate for upstream authoring errors (dead anchors, stale localized slugs, base64 image pastes) by accumulating debt in code.
   - **Files involved:**
     - `src/cli/index.ts`
     - `scripts/editorial-diagnostics.ts` (or `src/lib/editorial-linter.ts`)
     - `src/schemas/metadata.ts` / `src/lib/links.ts`
   - **Acceptance Criteria:**
     - Add CLI command `bun src/cli/index.ts validate:editorial` (or `bun scripts/editorial-diagnostics.ts`).
     - Scans all fetched Notion pages and reports:
       1. Broken anchors targeting missing/placeholder sections (`#exchange-problems`, etc.).
       2. Blocks containing raw base64 data URIs (>10 KB).
       3. Localized slug drift and unmapped internal Notion page references.
     - Emits `output/editorial-diagnostics.json` with page IDs, block IDs, and human-readable guidance for editors.
     - Adds a summary table to console output.

4. **P3: Controlled Publish Status Backfill & Publish Gate Migration**
   - **Context:** Consumers are currently forced to pass `docs:pull --all` because only ~36 pages have an explicit Publish Status in Notion.
   - **Status / Audit Evaluation:**
     - Executed dry-run audit: `bun src/cli/index.ts sync:mark-published --from UNSET --to "Draft published" --limit 50 --dry-run`.
     - Found 210 UNSET rows (including `[PRUEBA]`, `[TESTE]`, unmerged translation stubs, and Title/Toggle structural rows). Without `--all`, `buildHierarchyPlan` emits only 15 canonical pages vs 138 with `--all`.
     - **Decision:** A blind automated `--from UNSET` live backfill would promote internal draft/test pages to production. Retiring `--all` in `scripts/sync-to-comapeo-docs.sh` is held pending editorial status curation per [`docs/editorial-review-workflow.md`](docs/editorial-review-workflow.md).
   - **Files involved:**
     - `src/cli/mark-published.ts`
     - `scripts/sync-to-comapeo-docs.sh`
   - **Acceptance Criteria:**
     - [x] Execute a dry-run check: `bun src/cli/index.ts sync:mark-published --from UNSET --to "Draft published" --dry-run` to verify list of affected canonical pages.
     - [ ] Execute live run with rollback logging once editors curate status: `bun src/cli/index.ts sync:mark-published --from UNSET --to "Draft published" --live`.
     - [ ] Update `scripts/sync-to-comapeo-docs.sh` to remove `--all` from the pull command once status backfill is complete.
     - [ ] Verify downstream `docs:pull` retrieves all required canonical docs under the active status gate.

---

### Notion Editorial Cleanup & Release Gate (Editor Access Required)

1. **Fill or unlink placeholder pages**
   - **Issue:** Troubleshooting pages (e.g., `troubleshooting-mapping-with-collaborators`) are marked "Content coming soon" in Notion, yet 9+ pages link to their anchors (`#exchange-problems` ×9, `#custom-category-set-problems` ×9, `#solution-check-app-permissions` ×5).
   - **Audit / Pipeline Status:** Verified via `docs:pull` that `KNOWN_DOC_ANCHOR_ALIASES` in `src/lib/links.ts` cleanly suppresses dead anchor warnings until editors populate target content.
   - **Action needed (Notion):** Either draft the actual content or remove the incoming links in Notion once final content exists.

2. **Fix mislabeled EN content row**
   - **Issue:** The English `troubleshooting-mapping-with-collaborators` page carries a Spanish title ("Solución de Problemas: Mapeo con Colaboradores") and the English introduction contains a Spanish heading ("Sitio web de CoMapeo").
   - **Action needed (Notion):** Update the title and heading to English in Notion.

3. **Clean up base64-pasted image in Notion**
   - **Issue:** Page `3591b081-62d5-802d-840d-cd6344fe95db` ("Using Exchange over the Internet with Remote Archive") contains a raw 581 KB base64 string pasted directly into block `3591b081-62d5-8182-81fc-d736ed109576`.
   - **Audit Status:** Confirmed via page block inspection. Block ID `3591b081-62d5-8182-81fc-d736ed109576` holds a 581,058-character `data:image/png;base64` URI.
   - **Action needed (Notion):** Replace the pasted base64 data with a standard Notion file/image upload.

4. **Cosmetic link label fix**
   - **Issue:** The video link on `creating-a-new-observation` (EN+ES) displays as `Video: @document_4997224092760278339_trimmed.mp4`.
   - **Action needed (Notion):** Provide a human-readable title/label for the Drive link.

5. **Status vocabulary catch-up & Publish gate**
   - **Issue:** Only ~36 pages carry an active Publish Status ("Draft published") while the site publishes ~100 docs. Consumers currently use `docs:pull --all` as a workaround.
   - **Audit Status:** Evaluated 210 UNSET pages. Blind backfill risks publishing test pages.
   - **Action needed (Pipeline / Editors):**
     1. Backfill statuses via `sync:mark-published --from UNSET` after editors approve pages per [`docs/editorial-review-workflow.md`](docs/editorial-review-workflow.md).
     2. Once Notion statuses are accurate, flip the default publish gate in `scripts/sync-to-comapeo-docs.sh` to active-only and retire `--all`.

---

## Completed Milestones (Reference)

- [x] **Real Docusaurus/MDX Canary Build Gate in CI** ([#19](https://github.com/digidem/comapeo-content-pipeline/pull/19)):
  - Added real MDX AST parsing and React DOM Server SSR validation (`scripts/validate-mdx.ts`, `test/validate-mdx.test.ts`).
  - Catches unescaped JSX brackets `<...>`, string/bare `style=` attributes, and broken tags with line and column accuracy.
  - Wires into `npm test`, `npm run validate:mdx`, and `.github/workflows/ci.yml`.
  - Zero false positives on code fences, admonitions, tables, and frontmatter across all golden fixtures and emitted docs.

- [x] **Track B2: Update `comapeo-docs` Deploy Production Workflow** ([comapeo-docs#185](https://github.com/digidem/comapeo-docs/issues/185), [comapeo-docs#215](https://github.com/digidem/comapeo-docs/pull/215)):
  - Updated `.github/workflows/deploy-production.yml` in `comapeo-docs` to replace legacy `bun run notionStatus:publish-production` with `bun .pipeline/src/cli/index.ts sync:mark-published --from "Draft published" --to "Published" --live`.
  - Pipeline checkout is pinned to commit revision (`81e536fb5fb100099a9236e69f7323fce6008cca`) with `continue-on-error: true` so pipeline checkout or status update failures are non-blocking to production site deployments.
  - Added step outcome check to deployment summary to distinguish between successful status write-back and skipped/failed write-back.
  - Fixed pre-existing `comapeo-docs` CI issues: patched `image-size` to `2.0.4` resolving Trivy CVE-2025-71329 and CVE-2025-71330, and fixed sharp build in `deploy-pr-preview.yml`.

- [x] **Track B1: Direct Database Query Fallback in `sync:mark-published`** ([#18](https://github.com/digidem/comapeo-content-pipeline/pull/18)):
  - Added direct Notion database query fallback in `src/cli/mark-published.ts` using `client.queryDatabase` when `output/manifest.json` is absent on disk (enabling standalone CI runs in downstream consumer repos).
  - Status casing normalization via `CANONICAL_NOTION_STATUSES` mapping.
  - Page element filtering to only process active content pages (`Element Type` == 'Page' / 'Title' / 'Toggle').
  - Joined multi-segment Notion rich text titles for accurate dry-run reporting and rollback logging.
  - 864/864 Vitest tests passing, clean typecheck and lint.

- [x] **AI Translation Generator (PT & ES)** (`feat/ai-translation-generator`):
  - Inverted block translation engine (`src/lib/ai-translator.ts`, `src/lib/block-translator.ts`, `src/lib/page-translator.ts`) with CoMapeo bilingual domain glossary (`config/glossary.json`).
  - CLI runner (`scripts/translate-missing.ts`) with dry-run, single-page, batch limit, and apply modes.
  - Notion write-back (`src/lib/notion-writer.ts`) supporting stub updates and new page creation parented as siblings under container parents with `Publish Status: "Automated translations generated"`.
  - Notion native `custom_emoji` mention preservation (`data-emoji-id` roundtrip).
  - Image block resolution for private Notion S3 URLs and inline base64 data URIs to permanent public asset URLs.
  - Automated translation rollout for 100% of missing Spanish and Portuguese pages.
  - Configured production LLM credentials and provider auto-detection (`OPENAI_*`, `DEEPSEEK_*`).
  - Provided Notion editorial review workflow guide ([`docs/editorial-review-workflow.md`](docs/editorial-review-workflow.md) and live in Notion).
  - Evaluated Cloudflare Worker integration and maintained CLI operator model for safety/rate-limits.
  - Handled Notion nested-children depth limit (>2 levels) recursively.
  - Refined container parent vs child `Sub-item` linking.

- [x] **Internal Links, Slugs, and Anchors Healing** (#16):
  - Automated slug aliasing (`KNOWN_SLUG_ALIASES` in `src/lib/links.ts`) mapping stale localized slugs to canonical published English slugs.
  - Automated link healing for nested markdown link anomalies, `/doc/` route typos, missing leading slashes, and Notion ID fallbacks.
  - Target-scoped cross-language heading anchor resolution (`KNOWN_DOC_ANCHOR_ALIASES`).
  - Archived orphaned duplicate draft toggle row in Notion.

- [x] **Repo Housekeeping & Notion Status Write-Back** (#15, #16):
  - Moved status write-back ownership into this pipeline via CLI `sync:mark-published` (`src/cli/mark-published.ts`) with `--dry-run`, rollback logging, and non-blocking failure semantics ([comapeo-docs#185](https://github.com/digidem/comapeo-docs/issues/185)).
  - Supported `UNSET` status backfill for pages without explicit Publish Status.
  - Decommissioned legacy `scripts/notion-fetch/` in comapeo-docs for PR previews ([comapeo-docs#187](https://github.com/digidem/comapeo-docs/issues/187)).

- [x] **Pipeline Hardening & API-Level Status Filtering** (#1):
  - Centralized Notion property constants, element types, and locales in `src/lib/notion-properties.ts`.
  - Implemented API-level exclusion filter for `DEAD_STATUSES` ("Remove", "Unplublished").
  - Worker/CLI parity for markdown conversion and asset uploading.
  - Full automated regression test suite (855+ tests passing).
