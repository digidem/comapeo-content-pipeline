# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for all pending and resolved tasks in the CoMapeo Notion-to-Markdown content pipeline. Detailed history of resolved work lives in the git log (see the condensed changelog at the bottom).

---

## Pending Tasks

### 1. Notion editorial cleanup (content-state broken refs — not pipeline bugs)
Full-output production build (2026-07-02): **46 broken links + 182 broken anchor refs across 35 pages** (warnings only; build succeeds). Every sampled case traces to content state in Notion. Needs an editor with Notion access:
- [ ] **Fill or unlink placeholder pages**: `troubleshooting-mapping-with-collaborators` (and other troubleshooting pages) are "Content coming soon" in Notion, yet 9+ pages link into their anchors (`#exchange-problems` ×9, `#custom-category-set-problems` ×9, `#solution-check-app-permissions` ×5). Either write the content or remove the links until it exists.
- [ ] **Fix stale localized-slug links**: ES pages link to localized routes that don't exist (`/es/docs/entiende-como-funciona-el-intercambio` ×8, `/es/docs/seleccion-de-roles-y-equipos-de-dispositivos` ×7, `/es/docs/comprende-las-bases-sobre-proyectos` ×5, ~15 more) — pages were renamed or never published; translations publish under the English slug. Update the links in Notion to the English slugs (or the pipeline's anchor-localization work below can absorb some of this).
- [ ] **Fix authoring errors**: a nested markdown link (`[Deleting Observations & Tracks](/docs/editing…) /docs/deleting…`), a `/doc/` (missing "s") typo, and same-page `#adding-photos`/`#deleting-audio` anchors that actually belong to a different page.
- [ ] **Mislabeled row**: the EN `troubleshooting-mapping-with-collaborators` page carries a Spanish title ("Solución de Problemas: Mapeo con Colaboradores"); the EN introduction contains a Spanish heading ("Sitio web de CoMapeo").
- [ ] **Cosmetic**: give the `Video: @document_4997224092760278339_trimmed.mp4` Drive link on creating-a-new-observation (EN+ES) a human-readable label.
- [ ] **Status vocabulary catch-up**: only 36 pages carry an active Publish Status ("Draft published") while the site publishes ~100 docs — consumers must keep using `docs:pull --all` until editors set real statuses. Once statuses are trustworthy, flip the default publish gate to active-only and retire `--all` from the sync script.

### 2. Anchor localization (optional pipeline feature — the one residual the pipeline could eliminate)
- [ ] Translated pages linking to headings break when the fragment language doesn't match the target page's heading language (e.g. `/pt/docs/creating-a-new-observation#deleting-audio` vs the PT heading "Excluindo áudio"; `#configuracion-de-intercambio` on a page whose ES translation fell back to English content). Design: build an EN↔translated heading-anchor map per page group during `docs:pull` (headings are positionally parallel across a group's language children) and rewrite link fragments to the target page's actual heading ids, falling back to the English anchor when the target fell back to English content. Extends `src/lib/links.ts`. Only worth doing if editorial can't keep anchors consistent (see task 1).

### 3. Repo housekeeping
- [ ] **Cosmetic markdownlint residuals** (optional): 13 heading-level jumps (MD001) and 5 list-indent inconsistencies (MD005) originate in Notion authoring structure. Harmless to rendering; fix in Notion or add a normalization pass only if they ever matter.

---

## Done (condensed changelog — details in git log)

**ESLint flat-config migration (2026-07-07):** `eslint.config.js` added (ESLint 10 + typescript-eslint 8 recommended, flat config); `lint` script is now check-only (`lint:fix` autofixes); lint step re-enabled in CI; all 23 pre-existing violations fixed (dead code removed, unnecessary regex escapes dropped, invisible whitespace in the callout separator regex converted to `\uXXXX` escapes — semantics preserved, locked by the existing golden-fixture tests).

**Markdown quality audit + renderer verification (2026-07-02, commits `8e4f156`…`4acad60`):** audited all 99 emitted files with markdownlint, `findMdxHazards`, a full production Docusaurus build, and visual inspection in Chrome across EN/ES/PT. Fixed in the converter/docs:pull, each locked with tests: emphasis whitespace hoisting (814 literal-asterisk hits → 0), punctuation-only emphasis (42 → 0), table-cell newlines (35 split-row hits → 0), nested-admonition fence depth (orphan `:::` gone), divider-as-setext, padded headings, bold+italic callout titles, and inline emoji/icon 404s (assets now published to `static/images/notion/` with site-root srcs — the consumer's `ideal-image` plugin breaks webpack-import alternatives).

**Follow-up fixes (2026-07-02, `ca83616`, `8afe6cb`, `a39d786`):** `manifest:generate` made safe (sync emits `.metadata.json` blobs; no-clobber guards); `normalizeLocale` case-insensitive for the live `"ES - automated"`/`"PT - automated"` values; `mapStatus` realigned to the live 13-option Publish Status vocabulary (active = Ready to publish / Adding to staging site / Draft published / Published; Remove → deprecated; Unplublished → archived), backed by an investigation of the old system's pull/write-back semantics.

**Notion API-level status filtering, plan v4 all phases (2026-07-01, `addec89`, `5ccd605`):** constants consolidated and the Publish Status property read fixed (previously every page classified draft); SDK v5 `dataSources.query` with exclusion filter replaces the `/v1/search` workaround in CLI + Worker cron (fixes >50-page cron truncation; live-verified: 284 rows → 280 kept, exactly the 4 dead rows excluded); worker deployed and validated end-to-end (queue → convert → R2, `status: active` in prod). Plan archived at `plans/2026-06-27-notion-api-status-filtering-4.0.md`.

**Content hygiene (2026-07-01, `41b1cd5`, `39f800e`):** standalone `[Image: <url>]` author-note lines stripped; internal staging containers (and their sub-item children) excluded from publishing by title annotation.

**Worker & RAG validation (2026-07-01):** queue consumer verified live in production; all RAG chunks + manifest validate against the zod schemas; 0/62 structural pages leak into chunks.

**June 2026 (pre-dating this cycle):** reference-output gap mitigation (admonitions, post-processing sanitizer, frontmatter enrichment, spacers, sidebar fallback), dangling-asterisk fix, internal link/anchor resolution via `links.ts` + github-slugger, JSX style preservation, CI typecheck/test gate, clean 3-locale re-sync.
