# CoMapeo Content Pipeline — Tasks & Backlog

This file is the single source of truth for pending, actionable tasks. Resolved work lives in git log and the completed milestones section below.

---

## Pending Tasks

All remaining tasks require Notion editorial access (content state fixes) or editorial sign-off to finalize the publish gate:

### Notion Editorial Cleanup & Release Gate

1. **Fill or unlink placeholder pages**
   - **Issue:** Troubleshooting pages (e.g., `troubleshooting-mapping-with-collaborators`) are marked "Content coming soon" in Notion, yet 9+ pages link to their anchors (`#exchange-problems` ×9, `#custom-category-set-problems` ×9, `#solution-check-app-permissions` ×5).
   - **Action needed (Notion):** Either draft the actual content or remove the incoming links in Notion until the content exists.

2. **Fix mislabeled EN content row**
   - **Issue:** The English `troubleshooting-mapping-with-collaborators` page carries a Spanish title ("Solución de Problemas: Mapeo con Colaboradores") and the English introduction contains a Spanish heading ("Sitio web de CoMapeo").
   - **Action needed (Notion):** Update the title and heading to English in Notion.

3. **Clean up base64-pasted image in Notion**
   - **Issue:** Page `3591b081-62d5-802d-840d-cd6344fe95db` ("Using Exchange over the Internet with Remote Archive") contains a raw 581 KB base64 string pasted directly into block `3591b081-62d5-8182-81fc-d736ed109576`.
   - **Action needed (Notion):** Replace the pasted base64 data with a standard Notion file/image upload.

4. **Cosmetic link label fix**
   - **Issue:** The video link on `creating-a-new-observation` (EN+ES) displays as `Video: @document_4997224092760278339_trimmed.mp4`.
   - **Action needed (Notion):** Provide a human-readable title/label for the Drive link.

5. **Status vocabulary catch-up & Publish gate**
   - **Issue:** Only ~36 pages carry an active Publish Status ("Draft published") while the site publishes ~100 docs. Consumers currently use `docs:pull --all` as a workaround.
   - **Action needed (Pipeline / Editors):**
     1. Backfill statuses via `sync:mark-published --from UNSET` or have editors approve pages per [`docs/editorial-review-workflow.md`](docs/editorial-review-workflow.md).
     2. Once Notion statuses are accurate, flip the default publish gate in `scripts/sync-to-comapeo-docs.sh` to active-only and retire `--all`.

---

## Completed Milestones (Reference)

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
