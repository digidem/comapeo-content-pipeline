# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Content pipeline that turns the CoMapeo Notion documentation database into stable generated artifacts for two consumers: `digidem/comapeo-docs` (Docusaurus renderer) and a WhatsApp RAG support bot. The core design rule (spec §2): **Notion is the editorial source, R2 is the generated content source, Docusaurus and RAG are consumers.** This repo owns all Notion conversion complexity so `comapeo-docs` doesn't have to.

The same code runs in two environments:
- **CLI** (`src/cli/index.ts`) — runs under **Bun**, uses Node `fs` via `FilesystemStorage`. For local/manual sync and CI prebuild.
- **Cloudflare Worker** (`src/worker/index.ts`) — runs on Workers runtime with R2/D1/Queue bindings. For webhook/cron-driven sync.

Shared library code in `src/lib/` must stay runtime-agnostic (no Node-only APIs) so both entry points can import it.

## Commands

```bash
bun src/cli/index.ts <cmd>   # run CLI (package.json "pipeline" script; README shows `pnpm pipeline`)
npm run dev                  # wrangler dev (local Worker)
npm run deploy               # wrangler deploy
npm test                     # vitest run (all *.test.ts under src/ and test/)
npm run test:watch
npm run test:coverage
npm run typecheck            # tsc --noEmit
npm run lint                 # eslint src --ext .ts --fix

# Run a single test file
npx vitest run src/rag/chunker.test.ts
# Run tests matching a name
npx vitest run -t "slug"
```

CLI subcommands: `sync:page <id>`, `sync:full [--out --limit --filter]`, `manifest:generate`, `docs:pull --out ./docs`, `validate`, `diff`, `rag:chunks`. Note `rag:chunks` and `diff` are stubs — see TASKS.md.

## Architecture / data flow

A page sync is a pure transform in `src/lib/sync.ts::syncPage`: fetch page + blocks → `convertBlocks` (Notion blocks → Markdown) → compute `content_hash` (of markdown body) and `raw_hash` (of raw JSON) → extract metadata properties → `generateSlug` → `buildFrontmatter` → serialize. It does NOT decide `changed`; the caller compares the returned hash against the stored hash in D1.

Notion property names are domain-specific and read by string in `sync.ts` extract helpers: title from `Content elements`/`Name`, plus `Language`, `Content Section`, `Order`, `Element Type`, `Drafting Status`. `mapStatus` (`src/lib/status.ts`) maps Notion drafting status → content status.

**Persistence is abstracted behind `StorageBackend`** (`src/persistence/r2.ts`): `FilesystemStorage` for CLI, R2 binding for Worker. All artifact keys are centralized in `R2_PATHS` — change layout there, not inline:
- `manifests/latest.json` + `manifests/versions/{ts}.json`
- `docs/{locale}/docs/{section}/{slug}.md` — canonical Markdown consumed by `docs:pull`
- `pages/{pageId}/metadata.json|raw-page.json|raw-blocks.json`
- `rag/chunks/{chunkId}.json` + `rag/chunks-manifest.json`

D1 schema (`migrations/0001_initial.sql`, queries in `src/persistence/d1.ts`): `source_pages` (per-page state + hashes + R2 keys), `sync_jobs`, `sync_state` (key/value, e.g. cron cursor), `emitted_artifacts`.

## Worker specifics

Hono app. Routes: `GET /health`, `GET /health/deep` (D1+R2+Notion check), `POST /webhooks/notion` (verification challenge + enqueue), `POST /admin/sync/page|sync/changed|manifest/regenerate`. Admin routes require `Authorization: Bearer ${ADMIN_TOKEN}`. `scheduled` cron (`*/5 * * * *`) queries Notion for changed pages and enqueues.

**Queue Consumer:** The queue consumer is enabled in `wrangler.toml` and processes events using the shared runtime-agnostic `convertPageData` to generate Markdown and upload assets to R2.

## Conventions

- ESM throughout (`"type": "module"`); relative imports use explicit `.js` extensions even for `.ts` sources (bundler resolution).
- Zod schemas in `src/schemas/` are the source of truth for `manifest`, `metadata`, `rag` shapes — update schema + its `.test.ts` together.
- Converter tests are golden-file based: input `test/fixtures/notion/*.json` → expected `test/fixtures/expected/*.md`. Add a fixture pair when adding block-type support.
- `strict` TypeScript; `src/cli/index.ts` is excluded from coverage.
- TASKS.md tracks remaining work against the spec's Definition of Done; `comapeo_content_pipeline_spec.md` is the authoritative spec.
