# Spec: `digidem/comapeo-content-pipeline`

**Status:** Ready for implementation  
**Confidence:** 5/5  
**Date:** 2026-06-09  
**Primary implementation instruction:** Delegate task to forgecode.

---

## 1. Purpose

Create a dedicated content pipeline repo that turns the CoMapeo Notion documentation database into stable generated artifacts for two consumers:

1. `digidem/comapeo-docs` — Docusaurus renderer only.
2. The WhatsApp RAG support bot — grounded support answers from the same approved content.

This repo owns the hard part:

```txt
Notion database → canonical Markdown/MDX → R2 artifacts → manifest → optional RAG chunks
```

It must remove Notion conversion, API service complexity, and generated-content logic from `digidem/comapeo-docs`.

---

## 2. Core Design Decision

**Notion is the editorial source. R2 is the generated content source. Docusaurus and RAG are consumers.**

```txt
Notion
  ↓ webhook / cron / manual sync
comapeo-content-pipeline
  ↓
R2: canonical docs, metadata, manifests, chunks
  ├─ comapeo-docs prebuild downloads files into local docs/
  └─ RAG bot indexes approved chunks
```

Docusaurus should not render live remote R2 content at runtime. Docusaurus expects docs content from a local filesystem path, so `comapeo-docs` should materialize R2 files before `docusaurus build`.

---

## 3. Goals

- Build a reusable Notion-to-content pipeline.
- Generate deterministic Markdown/MDX from Notion.
- Store generated content in Cloudflare R2.
- Track sync state, hashes, and failures in D1.
- Process page updates incrementally using Notion webhooks, Queues, and Cron.
- Generate a manifest contract shared by Docusaurus and the RAG bot.
- Generate optional RAG chunks from the same canonical Markdown.
- Keep the system compatible with Cloudflare Free for incremental sync.
- Make initial full import runnable locally or from CI.
- Provide a small CLI for local sync, validation, and export.

---

## 4. Non-Goals

This repo must not own:

- Docusaurus rendering.
- React UI.
- Search UI.
- WhatsApp bot behavior.
- LLM answer generation.
- Translation workflow beyond preserving/generated localized outputs already represented in Notion.
- Human editorial workflows inside Notion.
- Long-running full rebuilds inside Cloudflare Free workers.

---

## 5. Repo Outputs

### 5.1 R2 Artifact Contract

```txt
r2://comapeo-content/
  manifests/
    latest.json
    versions/{timestamp}.json

  pages/
    {page_id}/
      metadata.json
      raw-page.json
      raw-blocks.json
      canonical.{locale}.md
      canonical.{locale}.mdx

  docs/
    {locale}/docs/{slug}.md
    {locale}/docs/{section_slug}/{slug}.md

  sidebars/
    {locale}.json

  rag/
    chunks/{chunk_id}.json
    chunks-manifest.json

  assets/
    {sha256}.{ext}
```

### 5.2 Manifest Schema

`manifests/latest.json` is the primary contract.

```ts
type ContentManifest = {
  schema_version: '1.0'
  generated_at: string
  source: {
    type: 'notion'
    database_id: string
    data_source_id: string
  }
  docs: ManifestDoc[]
  sidebars: Record<string, string>
  rag?: {
    chunks_manifest_key: string
  }
}

type ManifestDoc = {
  page_id: string
  title: string
  locale: 'en' | 'pt' | 'es' | string
  section: string | null
  section_order: number | null
  element_type: 'Page' | 'Title' | 'Toggle' | string | null
  drafting_status: string | null
  slug: string
  docusaurus_id: string
  docusaurus_path: string
  r2_doc_key: string
  r2_metadata_key: string
  source_url: string
  notion_last_edited_time: string
  content_hash: string
  status: 'active' | 'draft' | 'deprecated' | 'archived'
}
```

### 5.3 Page Metadata Schema

```ts
type PageMetadata = {
  page_id: string
  title: string
  source_url: string
  notion_last_edited_time: string
  content_hash: string
  raw_hash: string
  locale: string
  section: string | null
  section_order: number | null
  slug: string
  docusaurus_id: string
  status: 'active' | 'draft' | 'deprecated' | 'archived'
  properties: Record<string, unknown>
  assets: Array<{
    original_url: string
    r2_key: string
    sha256: string
    mime_type: string | null
  }>
}
```

---

## 6. Runtime Architecture

### 6.1 Cloudflare Incremental Sync

```txt
POST /webhooks/notion
  → verify Notion signature
  → extract page/database/data_source event
  → enqueue page sync job
  → return fast

Queue consumer
  → fetch page metadata
  → recursively fetch block tree
  → convert to canonical Markdown/MDX
  → compute hash
  → if unchanged, mark skipped
  → if changed, write R2 artifacts + D1 rows
  → regenerate manifest
  → optionally generate RAG chunks

Cron
  → query recently changed pages
  → enqueue changed page IDs
```

### 6.2 Local/CI Full Import

Full imports should run outside Cloudflare Free limits:

```bash
pnpm pipeline sync:full
pnpm pipeline validate
pnpm pipeline publish
```

The full import may run on a developer machine, GitHub Actions, or a paid worker environment. It should use the same conversion library as the Cloudflare worker.

---

## 7. Recommended Stack

- TypeScript
- Hono for Worker routes
- Zod for schemas
- Vitest for tests
- Wrangler for Cloudflare deployment
- Cloudflare R2 for artifacts
- Cloudflare D1 for sync state
- Cloudflare Queues for page jobs
- Cloudflare Cron for fallback polling
- Notion SDK or direct Notion REST client
- `gray-matter` for frontmatter
- `github-slugger` or equivalent deterministic slugging
- `unified` / `remark` utilities only where they simplify Markdown validation

---

## 8. Notion Sync Strategy

### 8.1 Source Database

Default source:

```txt
CoMapeo Docs - v0.0.0
https://app.notion.com/p/digidem/1d81b08162d581d397d0fbd08ee35a0c
```

The implementation must configure source IDs via environment variables, not hardcode them.

```txt
NOTION_DATABASE_ID=
NOTION_DATA_SOURCE_ID=
NOTION_ROOT_PAGE_IDS=
```

### 8.2 Incremental Sync Rules

Use three layers:

1. **Webhook trigger** — preferred for fast updates.
2. **Cron watermark** — fallback for missed webhook events.
3. **Content hash** — final authority for whether output changed.

```txt
last_edited_time decides what to fetch.
content_hash decides what to rewrite/reindex.
```

### 8.3 Query Changed Pages

Cron should query the Notion data source sorted by `last_edited_time DESC`, requesting only needed properties.

Required fields:

- title
- last_edited_time
- Content Section
- Element Type
- Drafting Status
- Date Published
- language/locale fields if present
- slug/path fields if present

Stop when all returned pages are older than the last successful watermark, unless `--force` is used.

### 8.4 Fetch Page Tree

For every page job:

1. Retrieve page metadata.
2. Retrieve block children.
3. Recursively fetch children for blocks that contain children.
4. Preserve unsupported blocks as explicit placeholders.
5. Download and rehost supported assets into R2 where possible.
6. Convert final tree to canonical Markdown/MDX.

### 8.5 Rate Limiting

The Notion client must:

- Limit to 3 requests/second by default.
- Retry HTTP 429 using `Retry-After`.
- Retry HTTP 529 with exponential backoff.
- Stop retrying after a configurable max attempt count.
- Store final failure state in D1.

---

## 9. Content Conversion

### 9.1 Supported Blocks

MVP supports:

- Paragraph
- Heading 1, 2, 3
- Bulleted list
- Numbered list
- To-do
- Toggle
- Quote
- Callout
- Code
- Image
- Video/file link as plain link
- Table
- Table row
- Divider
- Bookmark/link preview as link
- Child page reference
- Synced block as explicit placeholder unless fully supported

Unsupported output:

```md
> [!NOTE]
> Unsupported Notion block: `{block_type}`
```

### 9.2 Markdown/MDX Requirements

Generated docs must:

- Include YAML frontmatter.
- Use stable slugs.
- Preserve heading hierarchy.
- Avoid raw Notion URLs where a Docusaurus route is known.
- Keep relative links valid.
- Be deterministic: same Notion input produces byte-identical output.
- Avoid embedding expiring Notion asset URLs.
- Include source metadata in frontmatter.

Example frontmatter:

```yaml
---
id: installing-comapeo-and-onboarding
title: Installing CoMapeo & Onboarding
slug: /installing-comapeo-and-onboarding
sidebar_position: 10
source: notion
notion_page_id: 24f1b08162d58082bc0eec7c70f62a30
notion_last_edited_time: '2026-04-23T04:19:00.000Z'
content_hash: sha256:...
status: active
locale: en
---
```

### 9.3 Slug Rules

Slug generation must be deterministic:

1. Prefer explicit Notion slug/path property if present.
2. Else use normalized title.
3. Lowercase.
4. Remove accents.
5. Replace non-alphanumeric sequences with `-`.
6. Trim `-`.
7. If duplicate, append short page ID suffix.

### 9.4 Status Rules

Map Notion editorial status to generated status:

```txt
EN Done / PT Done / ES Done / Translations Validated / Pre-publish done → active
Not started / Editing in progress / Ready for review / Ready for copy edit → draft
X - Depreciated / deprecated / archive / archived → deprecated
Deleted / inaccessible → archived
```

Only `active` content should be included in the default Docusaurus and RAG manifests. Draft and deprecated content may be emitted to separate debug manifests.

---

## 10. RAG Chunk Generation

The pipeline may generate RAG chunks, but it must not call answer models.

### 10.1 Chunk Rules

- Input: canonical Markdown.
- Target size: 400–800 tokens.
- Overlap: 80–120 tokens.
- Preserve page title and heading path.
- Do not split tables or code blocks unless unavoidable.
- Include source page ID, source URL, slug, locale, status, and content hash.
- Skip draft/deprecated pages by default.

### 10.2 Chunk Schema

```ts
type RagChunk = {
  chunk_id: string
  page_id: string
  title: string
  locale: string
  slug: string
  heading_path: string[]
  text: string
  source_url: string
  docusaurus_path: string
  content_hash: string
  status: 'active'
}
```

Chunk IDs should be deterministic:

```txt
sha256(page_id + content_hash + heading_path + chunk_index)
```

---

## 11. D1 Schema

```sql
CREATE TABLE IF NOT EXISTS source_pages (
  page_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT,
  notion_last_edited_time TEXT,
  content_hash TEXT,
  raw_hash TEXT,
  status TEXT NOT NULL,
  locale TEXT,
  section TEXT,
  section_order INTEGER,
  slug TEXT,
  docusaurus_path TEXT,
  r2_metadata_key TEXT,
  r2_doc_key TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS emitted_artifacts (
  key TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  page_id TEXT,
  content_hash TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Required indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_source_pages_status ON source_pages(status);
CREATE INDEX IF NOT EXISTS idx_source_pages_locale ON source_pages(locale);
CREATE INDEX IF NOT EXISTS idx_source_pages_last_edited ON source_pages(notion_last_edited_time);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status);
```

---

## 12. Worker Routes

```txt
GET  /health
GET  /health/deep
POST /webhooks/notion
POST /admin/sync/page
POST /admin/sync/changed
POST /admin/manifest/regenerate
```

Admin routes require bearer auth.

```txt
Authorization: Bearer ${ADMIN_TOKEN}
```

Webhook route requires Notion signature validation.

---

## 13. CLI Commands

```bash
pnpm pipeline sync:page <page_id>
pnpm pipeline sync:changed
pnpm pipeline sync:full
pnpm pipeline manifest:generate
pnpm pipeline docs:pull --out ./docs
pnpm pipeline rag:chunks
pnpm pipeline validate
pnpm pipeline diff --page <page_id>
```

`docs:pull` is the command `digidem/comapeo-docs` should call before build.

---

## 14. Environment Variables

```txt
# Notion
NOTION_TOKEN=
NOTION_DATABASE_ID=
NOTION_DATA_SOURCE_ID=
NOTION_WEBHOOK_VERIFICATION_TOKEN=
NOTION_VERSION=2025-09-03

# Cloudflare
R2_BUCKET=comapeo-content
D1_DATABASE_NAME=comapeo-content-pipeline
QUEUE_NAME=comapeo-content-sync

# Pipeline
DEFAULT_LOCALES=en,pt,es
DEFAULT_STATUS_FILTER=active
MAX_PAGES_PER_CRON=50
MAX_NOTION_RPS=3
MANIFEST_KEY=manifests/latest.json

# Admin
ADMIN_TOKEN=
```

---

## 15. Testing Requirements

### 15.1 Unit Tests

Required:

- Notion rich text to Markdown.
- Block tree recursion.
- Each supported block conversion.
- Unsupported block placeholder.
- Slug generation.
- Frontmatter generation.
- Status mapping.
- Content hashing.
- Manifest generation.
- RAG chunking.
- R2 key generation.
- Notion rate-limit retry behavior.
- Webhook signature verification.

### 15.2 Golden Fixtures

Create fixtures from representative Notion structures:

```txt
test/fixtures/notion/
  simple-page.json
  headings-and-sections.json
  toggles.json
  tables.json
  images.json
  nested-blocks.json
  unsupported-blocks.json
  multilingual-page.json
```

Each fixture must have expected output:

```txt
test/fixtures/expected/
  simple-page.md
  headings-and-sections.md
  toggles.md
  tables.md
  images.md
  manifest.json
  chunks.json
```

### 15.3 Integration Tests

- Webhook receives event and enqueues job.
- Queue consumer processes one page.
- Unchanged page skips R2 writes.
- Changed page rewrites artifacts.
- Failed Notion call retries and records failure.
- Manifest regenerates after changed content.
- `docs:pull` writes local Docusaurus-compatible docs.

---

## 16. Acceptance Criteria

### 16.1 Repo Boundary

- WHEN the repo is implemented, THE SYSTEM SHALL allow `comapeo-docs` to remove Notion extraction code.
- WHEN `comapeo-docs` builds, THE SYSTEM SHALL only need to pull generated docs from R2 before Docusaurus build.
- WHEN the RAG bot indexes content, THE SYSTEM SHALL read generated RAG chunks or canonical Markdown from R2.

### 16.2 Incremental Sync

- WHEN Notion sends a valid webhook event, THE SYSTEM SHALL enqueue only affected page IDs.
- WHEN Notion sends an invalid webhook signature, THE SYSTEM SHALL reject the request.
- WHEN Cron runs, THE SYSTEM SHALL query only recently changed pages.
- WHEN a page content hash has not changed, THE SYSTEM SHALL skip artifact rewrites.
- WHEN a page content hash changes, THE SYSTEM SHALL write new artifacts and update the manifest.

### 16.3 Content Quality

- WHEN a supported Notion block is present, THE SYSTEM SHALL convert it to Markdown/MDX.
- WHEN an unsupported block is present, THE SYSTEM SHALL emit a visible placeholder and continue.
- WHEN two pages produce the same slug, THE SYSTEM SHALL make both paths unique deterministically.
- WHEN an asset is present, THE SYSTEM SHALL rehost it or emit a stable link placeholder.
- WHEN draft/deprecated content exists, THE SYSTEM SHALL exclude it from default docs and RAG manifests.

### 16.4 Free Plan Safety

- WHEN running on Cloudflare Free, THE SYSTEM SHALL process one page per queue job by default.
- WHEN a job would exceed limits, THE SYSTEM SHALL fail safely and retry later.
- WHEN full sync is requested, THE SYSTEM SHALL run locally/CI unless explicitly configured for a paid runtime.
- WHEN Notion returns 429 or 529, THE SYSTEM SHALL back off instead of hammering the API.

---

## 17. Cloudflare Free-Plan Fit

This repo is expected to fit the free plan for incremental sync if it stays small and page-at-a-time:

- Workers Free has 100,000 requests/day and 10 ms CPU per invocation.
- Free accounts support 5 Cron Triggers.
- Queues Free includes 10,000 operations/day; normal successful delivery is roughly write + read + delete.
- R2 Free includes 10 GB-month storage, 1M Class A ops/month, 10M Class B ops/month, and free egress.
- D1 Free includes 5M rows read/day, 100k rows written/day, and 5 GB storage.

Risk: Notion block parsing and Markdown generation may exceed the 10 ms CPU limit for large pages. Mitigation: keep Cloudflare jobs page-sized, use local/CI for full imports, and upgrade Workers only if repeated CPU-limit failures occur.

---

## 18. Implementation Plan

### Phase 1 — Library Core

- Project setup.
- Zod schemas.
- Notion block types.
- Markdown conversion.
- Slug/frontmatter generation.
- Golden fixture tests.

### Phase 2 — Local CLI

- `sync:page`
- `sync:full`
- `manifest:generate`
- `docs:pull`
- `validate`

### Phase 3 — R2/D1 Persistence

- D1 schema/migrations.
- R2 writer/reader.
- Hash-based skip logic.
- Artifact manifest.

### Phase 4 — Cloudflare Worker

- Hono app.
- Health routes.
- Notion webhook route.
- Admin sync routes.
- Queue producer/consumer.
- Cron changed-page sync.

### Phase 5 — RAG Artifacts

- Chunk generator.
- Chunks manifest.
- Golden tests for chunks.
- RAG bot integration notes.

### Phase 6 — `comapeo-docs` Migration

- Add `prebuild` command in `comapeo-docs`:
  ```bash
  pnpm content-pipeline docs:pull --out ./docs
  ```
- Remove old Notion scripts from `comapeo-docs`.
- Keep Docusaurus config/rendering only.
- Confirm Docusaurus build works from pulled files.

---

## 19. Definition of Done

Done means:

- A new repo `digidem/comapeo-content-pipeline` exists.
- It can convert representative Notion fixtures to deterministic Markdown.
- It can sync at least one real Notion page to R2.
- It writes and reads `manifests/latest.json`.
- It can materialize Docusaurus docs locally from R2.
- It can generate RAG chunks from the same canonical docs.
- It handles Notion rate limits and webhook signatures.
- It passes unit, integration, and golden fixture tests.
- `digidem/comapeo-docs` can be simplified to Docusaurus rendering plus prebuild pull.
- Incremental sync can run on Cloudflare Free, with full import documented as local/CI.

---

## 20. References Checked

- Docusaurus docs plugin uses a filesystem `path` for docs content: https://docusaurus.io/docs/api/plugins/@docusaurus/plugin-content-docs
- Notion webhooks and signature validation: https://developers.notion.com/reference/webhooks
- Notion data source query, sorts, and `filter_properties`: https://developers.notion.com/reference/query-a-data-source
- Notion block children require recursive retrieval for complete block trees: https://developers.notion.com/reference/get-block-children
- Notion request limits and 429/529 behavior: https://developers.notion.com/reference/request-limits
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers pricing for Queues, D1, R2: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
