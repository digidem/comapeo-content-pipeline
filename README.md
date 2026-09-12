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
# Notion
NOTION_TOKEN=           # Notion API token
NOTION_DATABASE_ID=     # Source database ID
NOTION_DATA_SOURCE_ID=  # Data source ID (v5 API)
NOTION_VERSION=2025-09-03

# Admin
ADMIN_TOKEN=            # Bearer token for admin routes

# Translation LLM (see "AI translations" below)
OPENAI_API_KEY=         # or DEEPSEEK_API_KEY / POOLSIDE_API_KEY / TRANSLATION_API_KEY
```

See `.env.example` for the full list, including Cloudflare (R2/D1/Queue) and
optional per-provider base URL / model overrides.

## AI translations

`scripts/translate-missing.ts` generates AI translations for missing `pt`/`es`
pages through any OpenAI-compatible chat-completions API:

```bash
# Preview what would be translated
bun scripts/translate-missing.ts

# Generate translations and write files + manifest
bun scripts/translate-missing.ts --apply
```

### Providers

The provider is auto-detected from the environment; within each group the first
set variable wins, and the `--api-key` / `--base-url` / `--model` flags override
everything:

| Provider | API key | Default base URL | Default model |
|---|---|---|---|
| OpenAI (production) | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-4o` |
| DeepSeek (production) | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Poolside (testing) | `POOLSIDE_API_KEY` | `https://inference.poolside.ai/v1` | `poolside/laguna-s-2.1` |

Within each group the first set variable wins:

- API key: `TRANSLATION_API_KEY` > `OPENAI_API_KEY` > `DEEPSEEK_API_KEY` > `POOLSIDE_API_KEY`
- Base URL: `TRANSLATION_BASE_URL` > `OPENAI_BASE_URL` > `DEEPSEEK_BASE_URL` > provider default
- Model: `TRANSLATION_MODEL` > `OPENAI_MODEL` > `DEEPSEEK_MODEL` > provider default

Detection rules:

- A key with the `sky_` prefix, or a key equal to `POOLSIDE_API_KEY` (when no
  `OPENAI_*`/`DEEPSEEK_*`/`TRANSLATION_*` base URL is set), selects Poolside.
- A key equal to `DEEPSEEK_API_KEY`, a `DEEPSEEK_BASE_URL`, or any configured
  base URL containing `deepseek` selects DeepSeek.
- Anything else defaults to OpenAI.

`TRANSLATION_*` variables are generic overrides that work with any provider;
`src/lib/` never reads `process.env` directly — callers pass an `env` record to
`AITranslator`, so the same code runs on Node/Bun and Cloudflare Workers.

### Flags

```bash
bun scripts/translate-missing.ts --apply \
  --locale es \              # only this locale (default: es, then pt)
  --limit 5 \                # cap number of pages
  --base-url https://api.deepseek.com/v1 \   # override base URL
  --model deepseek-chat \    # override model
  --api-key "$DEEPSEEK_API_KEY"              # override credentials
```

Run `bun scripts/translate-missing.ts --help` for the full option list.

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
