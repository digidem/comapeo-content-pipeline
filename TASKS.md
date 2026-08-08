# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for pending, actionable tasks. Resolved work lives in git log; accepted/won't-fix decisions live in PR discussion and code comments, not here.

---

## Pending Tasks

### 1. Notion editorial cleanup (content-state broken refs — not pipeline bugs)
Full-output production build (2026-07-02): **46 broken links + 182 broken anchor refs across 35 pages** (warnings only; build succeeds). Every sampled case traces to content state in Notion. Needs an editor with Notion access:
- [ ] **Fill or unlink placeholder pages**: `troubleshooting-mapping-with-collaborators` (and other troubleshooting pages) are "Content coming soon" in Notion, yet 9+ pages link into their anchors (`#exchange-problems` ×9, `#custom-category-set-problems` ×9, `#solution-check-app-permissions` ×5). Either write the content or remove the links until it exists.
- [ ] **Fix stale localized-slug links**: ES pages link to localized routes that don't exist (`/es/docs/entiende-como-funciona-el-intercambio` ×8, `/es/docs/seleccion-de-roles-y-equipos-de-dispositivos` ×7, `/es/docs/comprende-las-bases-sobre-proyectos` ×5, ~15 more) — pages were renamed or never published; translations publish under the English slug. Update the links in Notion to the English slugs.
- [ ] **Fix authoring errors**: a nested markdown link (`[Deleting Observations & Tracks](/docs/editing…) /docs/deleting…`), a `/doc/` (missing "s") typo, and same-page `#adding-photos`/`#deleting-audio` anchors that actually belong to a different page.
- [ ] **Mislabeled row**: the EN `troubleshooting-mapping-with-collaborators` page carries a Spanish title ("Solución de Problemas: Mapeo con Colaboradores"); the EN introduction contains a Spanish heading ("Sitio web de CoMapeo").
- [ ] **Cosmetic**: give the `Video: @document_4997224092760278339_trimmed.mp4` Drive link on creating-a-new-observation (EN+ES) a human-readable label.
- [ ] **Duplicate EN Toggle rows** (found 2026-07-09): section "40-Managing Data and Privacy" has two EN Toggles — "Managing Data Privacy and Security" and "Managing Data Privacy & Security". The sidebar label picker takes the first by manifest order, so the label flips between "&" and "and" depending on which command generated the manifest. Delete one of the duplicates in Notion.
- [ ] **Status vocabulary catch-up**: only 36 pages carry an active Publish Status ("Draft published") while the site publishes ~100 docs — consumers must keep using `docs:pull --all` until editors set real statuses. Once statuses are trustworthy, flip the default publish gate to active-only and retire `--all` from the sync script.

### 2. Repo housekeeping (comapeo-docs)
- [ ] **Execution plan for the remaining comapeo-docs items below**: [`plans/2026-07-14-remaining-work-execution-plan.md`](plans/2026-07-14-remaining-work-execution-plan.md). Read this before starting either item below — it supersedes the two design docs' own "next step" sections.
- [ ] **`comapeo-docs`'s "Update Notion status to Published" deploy step is broken** — owner decision 2026-07-14: move status write-back ownership into this pipeline instead of patching `comapeo-docs`. Design doc: [`plans/2026-07-14-notion-status-writeback-design.md`](plans/2026-07-14-notion-status-writeback-design.md). Not yet implemented — needs open design questions resolved first (trigger point, page-scoping via manifest, write-scope token). Tracked as [comapeo-docs#185](https://github.com/digidem/comapeo-docs/issues/185) — confirmed still OPEN.
- [ ] **`scripts/notion-fetch/` (comapeo-docs) — NOT decommissioned**: still actively used by `deploy-pr-preview.yml` to regenerate PR preview content when fetch/convert scripts change. Owner decision 2026-07-14: migrate PR previews to use this pipeline's output instead, then retire the legacy path. Design doc: [`plans/2026-07-14-pr-preview-pipeline-migration-design.md`](plans/2026-07-14-pr-preview-pipeline-migration-design.md). Not yet implemented — the design doc's own recommendation is to first confirm with actual PR-preview users whether most previews even need a fresh Notion pull.
