# comapeo-content-pipeline

Notion → canonical Markdown/MDX → R2 manifest/content pipeline.

Shared pipeline for:
- **`digidem/comapeo-docs`** — Docusaurus renderer
- **RAG bot** — grounded support answers from approved content

## Architecture

```
Notion (editorial source)
  ↓ webhook / cron / manual sync
comapeo-content-pipeline
  ↓
R2: canonical docs, metadata, manifests, chunks
  ├─ comapeo-docs prebuild downloads files into local docs/
  └─ RAG bot indexes approved chunks
```

## Commands

```bash
# Sync a single page from Notion
pnpm pipeline sync:page <page_id>

# Full import of all pages
pnpm pipeline sync:full [--out ./output] [--limit 50]

# Generate manifest from synced metadata
pnpm pipeline manifest:generate [--input ./output] [--out manifest.json]

# Pull docs for Docusaurus build (what comapeo-docs calls before build)
pnpm pipeline docs:pull --manifest ./output/manifest.json --out ./docs

# Generate RAG chunks (not yet implemented in CLI)
pnpm pipeline rag:chunks

# Validate manifest
pnpm pipeline validate [--input manifest.json]

# Run tests
pnpm test
```

## Environment

Copy `.env.example` to `.env` and fill in:

```bash
NOTION_TOKEN=           # Notion API token
NOTION_DATABASE_ID=     # Source database ID
NOTION_DATA_SOURCE_ID=  # Data source ID (v5 API)
NOTION_VERSION=2025-09-03
ADMIN_TOKEN=            # Bearer token for admin routes
```

## Deploying to production

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full, reproducible path from a Notion edit to live content on docs.comapeo.app — generating content here, getting it into `comapeo-docs`'s `content` branch safely, and triggering the production deploy.

## Integration with comapeo-docs

`comapeo-docs` should add a prebuild step:

```json
{
  "scripts": {
    "prebuild": "pnpm content-pipeline docs:pull --out ./docs",
    "build": "docusaurus build"
  }
}
```

Then remove all Notion sync scripts (`scripts/notion-fetch/`, `scripts/notionClient.ts`, etc.) since the pipeline repo owns that complexity.

## Cloudflare Worker

Deployed via `wrangler deploy`. Routes:

- `GET /health` — liveness check
- `GET /health/deep` — D1 + R2 + Notion connectivity check
- `POST /webhooks/notion` — Notion webhook receiver (enqueues page sync)
- `POST /admin/sync/page` — Trigger sync for a page
- `POST /admin/sync/changed` — Query Notion for changed pages, enqueue
- `POST /admin/manifest/regenerate` — Rebuild manifest from D1

Admin routes require: `Authorization: Bearer ${ADMIN_TOKEN}`

## Repository Structure

```
src/
  schemas/         Zod schemas (manifest, metadata, rag)
  lib/             Core library
    slug.ts          Deterministic slug generation
    status.ts        Notion status → content status mapping
    hash.ts          Content hashing (SHA-256)
    frontmatter.ts   Docusaurus frontmatter serialization
    notion-converter.ts  Notion blocks → Markdown
    notion-client.ts Notion API client (rate limiting, retry)
    sync.ts          Page sync orchestrator
    manifest.ts      Manifest generation
    webhook.ts       Webhook signature verification
  persistence/
    d1.ts            D1 schema + queries
    r2.ts            R2 storage abstraction
  rag/
    chunker.ts       RAG chunk generator
  cli/
    index.ts         CLI entry point
  worker/
    index.ts         Cloudflare Worker (Hono routes)
test/
  fixtures/notion/   Golden input fixtures
  fixtures/expected/ Expected Markdown output
```
