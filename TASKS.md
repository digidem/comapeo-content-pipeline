# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for pending, actionable tasks. Resolved work lives in git log and the completed milestones section below.

---

## Pending Tasks

### Engineering & Pipeline Improvements (Dev Agent Backlog)

- [x] **P0: Real Docusaurus/MDX Canary Build Gate in CI** ([#19](https://github.com/digidem/comapeo-content-pipeline/pull/19))
   - **Completed:** Added real MDX AST parsing and React DOM Server SSR validation (`scripts/validate-mdx.ts`, `test/validate-mdx.test.ts`). Catches unescaped JSX brackets `<...>`, string/bare `style=` attributes, and broken tags with line and column accuracy. Wires into `npm test`, `npm run validate:mdx`, and `.github/workflows/ci.yml`. Zero false positives on code fences, admonitions, tables, and frontmatter across all golden fixtures and emitted docs.

- [x] **P1: Align Agent Workflow & Tooling Specs in `AGENTS.md`**
   - **Completed:** Formalized Antigravity/Gemini and Claude Code workflows, updated subagent delegation rules, and configured the autonomous merge policy (autonomous merge on consensus + clean CI/Greptile, only prompting human if not confident).

- [x] **P2: Upstream Notion Editorial Diagnostics & Linter Report** ([#20](https://github.com/digidem/comapeo-content-pipeline/pull/20))
   - **Completed:** Added runtime-agnostic linter engine (`src/lib/editorial-linter.ts`), CLI command `bun src/cli/index.ts validate:editorial` (`src/cli/editorial-diagnostics.ts`), and Zod schemas (`EditorialDiagnosticItemSchema`, `EditorialDiagnosticsReportSchema`). Scans all content for broken anchors, oversized base64 data URIs (>10 KB), localized slug drift, and unmapped Notion page references. Generates `output/editorial-diagnostics.json` with console summary table and guidance for editors.

- [x] **P3: Controlled Publish Status Filtering & Element-Type Parity** ([#21](https://github.com/digidem/comapeo-content-pipeline/pull/21))
   - **Context:** Consumers are currently forced to pass `docs:pull --all` because only ~36 pages have an explicit Publish Status in Notion.
   - **Completed Enhancements:**
     - Enforced `isContentPage(doc.element_type || "")` parity across manifest and direct database fallback modes (excluding non-content structural rows: Title, Toggle).
     - Added `--filter-title <regex>` and `--exclude-title <regex>` flags to both manifest and live-query modes in `sync:mark-published`, enabling targeted backfills (e.g. `--exclude-title "^\[(PRUEBA|TESTE)\]"`).
     - Added pre-update live title re-verification in live mode so renamed Notion pages do not bypass exclusions.
     - Documented title regex options in CLI `--help` and added comprehensive unit test suite (917/917 passing).
   - **Audit Evaluation & Publish Gate Decision:**
     - Executed dry-run audit: `bun src/cli/index.ts sync:mark-published --from UNSET --to "Draft published" --limit 50 --dry-run`.
     - Found 210 UNSET rows (including `[PRUEBA]`, `[TESTE]`, unmerged translation stubs). Retiring `--all` in `scripts/sync-to-comapeo-docs.sh` remains held pending editorial status curation per [`docs/editorial-review-workflow.md`](docs/editorial-review-workflow.md).
   - **Files involved:**
     - `src/cli/mark-published.ts`
     - `src/cli/index.ts`
     - `scripts/sync-to-comapeo-docs.sh`
   - **Acceptance Criteria:**
     - [x] Execute a dry-run check: `bun src/cli/index.ts sync:mark-published --from UNSET --to "Draft published" --dry-run` to verify list of affected canonical pages.
     - [x] Implement title regex filtering (`--filter-title`, `--exclude-title`) and element-type parity in `sync:mark-published` ([#21](https://github.com/digidem/comapeo-content-pipeline/pull/21)).
     - [ ] Execute live run with rollback logging once editors curate status: `bun src/cli/index.ts sync:mark-published --from UNSET --to "Draft published" --live`.
     - [ ] Update `scripts/sync-to-comapeo-docs.sh` to remove `--all` from the pull command once status backfill is complete.
     - [ ] Verify downstream `docs:pull` retrieves all required canonical docs under the active status gate.

---

### Notion Editorial Cleanup & Release Gate (Editor Access Required)

1. **Fill or unlink placeholder pages**
   - **Issue:** Troubleshooting pages (e.g., `troubleshooting-mapping-with-collaborators`) are marked "Content coming soon" in Notion, yet 9+ pages link to their anchors (`#exchange-problems` ×9, `#custom-category-set-problems` ×9, `#solution-check-app-permissions` ×5).
   - **Audit / Pipeline Status:** Verified via `docs:pull` that `KNOWN_DOC_ANCHOR_ALIASES` in `src/lib/links.ts` cleanly suppresses dead anchor warnings until editors populate target content.
   - **Action needed (Notion):** Either draft the actual content or remove the incoming links in Notion once final content exists.

2. **Fix mislabeled EN content row & archive orphaned stub**
   - **Issue:** The English introduction contained a Spanish heading ("Sitio web de CoMapeo") and paragraph. In addition, an empty Spanish stub page `3131b081-62d5-8027-aeb1-ca253f17aa67` ("Solución de Problemas: Mapeo con Colaboradores", body `[Insert content here]`) was linked as a child under parent `2a71b081-62d5-8039-8caa-fbe0f822d4a5`.
   - **Resolution (Completed via Notion API):**
     - Updated blocks `27d1b081-62d5-80dc-a09c-e14da19b77bc` and `2871b081-62d5-809a-87b1-de6c3f3a6761` to English ("CoMapeo Website", "Visit comapeo.app for general information..."). Verified via page sync reflection in markdown.
     - Unlinked stub `3131b081-62d5-8027-aeb1-ca253f17aa67` from parent container `2a71b081-62d5-8039-8caa-fbe0f822d4a5`'s `Sub-item` relation (leaving the 4 legitimate EN/PT/ES/PT-automated children).
     - Soft-deleted stub `3131b081-62d5-8027-aeb1-ca253f17aa67` in Notion via `in_trash: true`.
     - Regenerated manifest (`output/manifest.json`), confirming 0 remaining references to the stub.

3. **Clean up base64-pasted image in Notion**
   - **Issue:** Page `3591b081-62d5-802d-840d-cd6344fe95db` ("Using Exchange over the Internet with Remote Archive") contains a raw 581 KB base64 string pasted directly into block `3591b081-62d5-8182-81fc-d736ed109576`.
   - **Audit Status:** Confirmed via page block inspection. Block ID `3591b081-62d5-8182-81fc-d736ed109576` holds a 581,058-character `data:image/png;base64` URI. The Notion REST API does not support uploading binaries directly to Notion AWS S3 (`type: "file"`). The pipeline sync automatically extracts and re-hosts these images to R2 assets.
   - **Architectural Policy (Claude Opus 5.5 Consensus):** Notion blocks should NOT be pointed to R2 generated URLs to preserve clean separation between editorial source and generated output (avoiding circular dependency). Human editors can drag-and-drop replacement images in the Notion UI when convenient to reduce Notion block payload sizes.

4. **Cosmetic link label fix**
   - **Issue:** The video link on `creating-a-new-observation` displayed raw filename `Video: @document_4997224092760278339_trimmed.mp4`.
   - **Resolution (Completed via Notion API):** Localized clean video titles applied across all 3 locales (EN block `26a1b081-62d5-8108-9c4f-c0a649398543`, ES block `3211b081-62d5-800e-a695-e0905005df9e`, PT block `3131b081-62d5-8115-a8e3-d87570e430ef`). Verified with downstream sync generating clean Markdown links.

5. **Status vocabulary catch-up & Publish gate**
   - **Issue:** Only ~36 pages carry an active Publish Status ("Draft published") while the site publishes ~100 docs. Consumers currently use `docs:pull --all` as a workaround.
   - **Audit Status & Gap Measurement (Claude Opus 5.5 Consensus):**
     - Measured actual release gap: `docs:pull --all` pulls **138 docs**, while gated `docs:pull` without `--all` pulls only **15 docs** (a drop of 123 docs from the site; 128 total section-path file differences).
     - Running a blind bulk backfill risks promoting unreviewed placeholders or test pages into "Draft published".
     - Dry-run check with `--exclude-title "^\[(PRUEBA|TESTE)\]"` identified 154 backfill candidates (`/tmp/backfill-candidates.txt`).
   - **Release Gate Decision:**
     - Retain `--all` in `scripts/sync-to-comapeo-docs.sh` to protect live documentation production.
     - Provide the 154-page candidate list to editors per [`docs/editorial-review-workflow.md`](docs/editorial-review-workflow.md).
     - Retire `--all` only when the diff between `docs:pull --all` and gated `docs:pull` reaches 0.

---

## Completed Milestones (Reference)

- [x] **Title Regex Filtering & Element-Type Parity in `sync:mark-published`** ([#21](https://github.com/digidem/comapeo-content-pipeline/pull/21)):
  - Enforced `isContentPage(doc.element_type || "")` parity across manifest-reading and direct database fallback modes (excluding structural rows: Title, Toggle).
  - Added `--filter-title <regex>` and `--exclude-title <regex>` options to both modes with centralized `createRegexFilter` validation and empty argument detection in `parseArgs`.
  - Added pre-update live title re-verification in live mode so renamed Notion pages do not bypass exclusions.
  - Documented title regex options in CLI `--help` and verified with 33 unit tests (917/917 passing across repo).

- [x] **Upstream Notion Editorial Diagnostics & Linter Report** ([#20](https://github.com/digidem/comapeo-content-pipeline/pull/20)):
  - Added runtime-agnostic linter engine (`src/lib/editorial-linter.ts`), CLI command `bun src/cli/index.ts validate:editorial` (`src/cli/editorial-diagnostics.ts`), and Zod schemas (`EditorialDiagnosticItemSchema`, `EditorialDiagnosticsReportSchema`).
  - Scans all content for broken anchors, oversized base64 data URIs (>10 KB), localized slug drift, and unmapped Notion page references.
  - Generates `output/editorial-diagnostics.json` with console summary table and guidance for editors.
  - 906/906 tests passing, clean typecheck, lint, and MDX canary validation.

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
