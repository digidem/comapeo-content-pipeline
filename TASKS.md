# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for pending, actionable tasks. Resolved work lives in git log; accepted/won't-fix decisions live in PR discussion and code comments, not here.

---

## Completed Milestones (Reference)

- [x] **AI Translation Generator (PT & ES)** (`feat/ai-translation-generator`):
  - Inverted block translation engine (`src/lib/ai-translator.ts`, `src/lib/block-translator.ts`, `src/lib/page-translator.ts`) with CoMapeo bilingual domain glossary (`config/glossary.json`).
  - CLI runner (`scripts/translate-missing.ts`) with dry-run, single-page, batch limit, and apply modes.
  - Notion write-back (`src/lib/notion-writer.ts`) supporting stub updates and new page creation parented as siblings under container parents with `Publish Status: "Automated translations generated"`.
  - Notion native `custom_emoji` mention preservation (`data-emoji-id` roundtrip).
  - Image block resolution for private Notion S3 URLs and inline base64 data URIs to permanent public asset URLs.
  - 772 passing unit tests, full verification suite passes, and clean 5/5 merge readiness reviews.

---

## Pending Tasks

### 1. AI Translation Generator — Follow-ups & Rollout
- [ ] **Run initial batch translation for missing pages**: Execute `bun scripts/translate-missing.ts --all --apply --write-notion` across remaining missing Portuguese and Spanish documentation pages to populate Notion with initial translations.
- [ ] **Configure production LLM credentials**: Document and provision production OpenAI / DeepSeek v4 API credentials (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`) alongside the current Poolside Laguna testing credentials (`POOLSIDE_API_KEY`).
- [ ] **Notion editor review workflow**: Provide editorial guidelines for reviewers to inspect pages marked `Publish Status: "Automated translations generated"`, make any human adjustments, and transition them to `Draft published` / `Published`.
- [ ] **Evaluate Worker integration (optional)**: Decide whether translation generation should remain an on-demand CLI operator tool or be exposed via a Cloudflare Worker admin route (e.g. `POST /admin/translate/missing`) or triggered on English page publication.
- [ ] **Handle Notion nested-children depth limit (>2 levels)**: In `notion-writer.ts:prepareBlocksForNotion`, recursively append grandchildren in follow-up `appendBlockChildren` requests if deeply nested lists/toggles exceed Notion API's 2-level embed limit during batch rollout.
- [ ] **Refine translation Sub-item linking under container parents**: Review container parent vs English child `Sub-item` two-way relation linking to decide whether container-parented pages should skip linking to the English child's `Sub-item` to minimize diagnostic warnings in `buildHierarchyPlan`.

### 2. Notion Editorial Cleanup (Content-State Fixes — Editor Access Needed)
Full-output production build: **46 broken links + 182 broken anchor refs across 35 pages** (warnings only; build succeeds). Traced to Notion content state:
- [ ] **Fill or unlink placeholder pages**: `troubleshooting-mapping-with-collaborators` (and other troubleshooting pages) are "Content coming soon" in Notion, yet 9+ pages link into their anchors (`#exchange-problems` ×9, `#custom-category-set-problems` ×9, `#solution-check-app-permissions` ×5). Either write the content or remove the links until it exists.
- [ ] **Fix stale localized-slug links**: ES pages link to localized routes that don't exist (`/es/docs/entiende-como-funciona-el-intercambio` ×8, `/es/docs/seleccion-de-roles-y-equipos-de-dispositivos` ×7, `/es/docs/comprende-las-bases-sobre-proyectos` ×5, ~15 more) — pages were renamed or never published; translations publish under the English slug. Update the links in Notion to the English slugs.
- [ ] **Fix authoring errors**: A nested markdown link (`[Deleting Observations & Tracks](/docs/editing…) /docs/deleting…`), a `/doc/` (missing "s") typo, and same-page `#adding-photos`/`#deleting-audio` anchors that actually belong to a different page.
- [ ] **Mislabeled row**: The EN `troubleshooting-mapping-with-collaborators` page carries a Spanish title ("Solución de Problemas: Mapeo con Colaboradores"); the EN introduction contains a Spanish heading ("Sitio web de CoMapeo").
- [ ] **Clean up base64-pasted image in Notion**: Page `3591b081-62d5-802d-840d-cd6344fe95db` ("Using Exchange over the Internet with Remote Archive") contains a raw 581 KB base64 string pasted into block `3591b081-62d5-8012-9c17-f58c7e97b1a1`. Replace with a standard Notion file upload.
- [ ] **Cosmetic**: Give the `Video: @document_4997224092760278339_trimmed.mp4` Drive link on `creating-a-new-observation` (EN+ES) a human-readable label.
- [ ] **Duplicate EN Toggle rows**: Section "40-Managing Data and Privacy" has two EN Toggles — "Managing Data Privacy and Security" and "Managing Data Privacy & Security". Delete one of the duplicates in Notion.
- [ ] **Status vocabulary catch-up**: Only 36 pages carry an active Publish Status ("Draft published") while the site publishes ~100 docs — consumers must keep using `docs:pull --all` until editors set real statuses. Once statuses are trustworthy, flip the default publish gate to active-only and retire `--all` from the sync script.

### 3. Repo Housekeeping (`comapeo-docs`)
- [ ] **Execution plan for remaining comapeo-docs items**: [`plans/2026-07-14-remaining-work-execution-plan.md`](plans/2026-07-14-remaining-work-execution-plan.md). Read before starting either item below.
- [ ] **`comapeo-docs`'s "Update Notion status to Published" deploy step is broken**: Move status write-back ownership into this pipeline instead of patching `comapeo-docs`. Design doc: [`plans/2026-07-14-notion-status-writeback-design.md`](plans/2026-07-14-notion-status-writeback-design.md). Tracked as [comapeo-docs#185](https://github.com/digidem/comapeo-docs/issues/185).
- [ ] **`scripts/notion-fetch/` (comapeo-docs) decommissioning**: Migrate PR previews to use this pipeline's output instead of legacy fetch scripts. Design doc: [`plans/2026-07-14-pr-preview-pipeline-migration-design.md`](plans/2026-07-14-pr-preview-pipeline-migration-design.md). Tracked as [comapeo-docs#187](https://github.com/digidem/comapeo-docs/issues/187).
