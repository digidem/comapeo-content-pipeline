# Design: migrate PR-preview content generation to comapeo-content-pipeline

**Status:** proposal, not yet implemented. Addresses the "PR previews" half of [comapeo-docs#187](https://github.com/digidem/comapeo-docs/issues/187), per owner decision 2026-07-14 (chose "migrate previews to the pipeline too" over dropping preview regeneration or leaving the legacy path in place).

## Problem

`comapeo-docs`'s `deploy-pr-preview.yml` is not fully dormant the way `api-server/` is. It has live logic: it diffs the PR against its base branch for changes under `scripts/(notion-fetch/|notion-fetch-all/|fetchNotionData|notionClient|notionPageUtils|constants)`, and if any changed, regenerates preview content using that **legacy** fetch pathway (rather than reusing whatever's cached on the `content` branch). This exists to validate that a PR touching the old content-generation code doesn't break content generation, by actually re-running it.

That legacy code's job — Notion → Markdown conversion — is now `comapeo-content-pipeline`'s job, done better (typed, schema-validated, 477+ tests, golden fixtures) and done for production already. Keeping a second, parallel implementation alive just to validate preview builds is redundant and is the one thing standing between `scripts/notion-fetch/` and full deletion (`api-server/` itself has no such dependency and is being removed separately, see PR #188).

## Goal

Replace the "regenerate via legacy scripts" branch of `deploy-pr-preview.yml` with a call into `comapeo-content-pipeline`, so there is exactly one Notion-to-Markdown implementation, used everywhere (production sync, deploy verification, and PR previews alike).

## Design questions to resolve before implementation

### 1. What should actually trigger regeneration in a preview?

The current trigger (`scripts/notion-fetch/` etc. changed) stops making sense once that code is gone — there's nothing left in *this* repo whose change should trigger a Notion re-fetch. Two different things could still want a "fresh content" preview:

- A PR to `comapeo-content-pipeline` itself, previewed against `comapeo-docs`'s site shell (cross-repo preview) — different workflow, different repo, out of scope for `deploy-pr-preview.yml` specifically.
- A PR to `comapeo-docs` that changes Docusaurus/site code (theming, layout, plugins) and wants to preview it against real content, not stale/cached content.

**Recommend**: default every PR preview to just using whatever's already on the `content` branch (matches production's source of truth, zero extra latency, zero extra Notion calls) — this is the "drop it" behavior for the common case — and only pull fresh content on an explicit opt-in (label or workflow_dispatch input), same pattern the old workflow already used for `fetch-10-pages`/`fetch-all-pages` overrides. This avoids running a Notion sync on every single PR.

### 2. If regeneration is triggered, what does the pipeline call look like?

Mirror `DEPLOYMENT.md`'s Step 1 + Step 2 pattern in CI:
```bash
bun src/cli/index.ts sync:full --out ./output   # or a scoped/limited variant, see Q3
DOCS_DIR="$PREVIEW_CHECKOUT" bash scripts/sync-to-comapeo-docs.sh
```
run from a checkout of `comapeo-content-pipeline` (as a submodule, a separate checkout step, or a published action) inside the `comapeo-docs` preview job.

### 3. Full sync vs. scoped sync — latency

`sync:full` takes "a few minutes for the full corpus" (per `DEPLOYMENT.md`). That's fine for a production deploy but likely too slow for every PR preview build if triggered often. The old system had a `notion:fetch-one` job type and an API `fetch-one` job for single-page fetches — suggests real preview usage was often scoped, not full-corpus. `comapeo-content-pipeline`'s CLI already has `sync:page <id>` for a single page; check whether that's sufficient for the preview use case, or whether `sync:full --limit` is more appropriate. Needs a decision from whoever actually uses PR previews day-to-day about what "preview my content change" means in practice.

### 4. Credentials and scope in preview CI

Preview builds can run against forked-repo PRs. The current `API_KEY_GITHUB_ACTIONS` pattern in the (now-removed) `api-server` implies some awareness of this. Whatever calls into `comapeo-content-pipeline` from preview CI needs:
- A Notion token scoped appropriately for preview use (read-only is sufficient here — no write-back concerns, unlike the status design doc).
- Confirmation that `pull_request` (not `pull_request_target`) triggers don't get secrets exposed to untrusted fork code, if that's a concern for this repo's threat model.

### 5. Toolchain

`comapeo-content-pipeline` runs on Bun; confirm `deploy-pr-preview.yml`'s runner already sets up Bun (likely yes, since `comapeo-docs` itself uses Bun — `package.json` scripts are Bun-first), so this shouldn't add a new toolchain dependency.

## Non-goals

- Not proposing changes to `comapeo-content-pipeline`'s Worker (queue consumer, cron) — this is a CLI-invoked-from-CI use case only, consistent with RAG chunks staying CLI-only (see `TASKS.md` §3).
- Not proposing to delete `scripts/notion-fetch/` in this doc — that's the natural follow-up once this migration lands and the dependency in `deploy-pr-preview.yml` is gone, but should be its own small PR after this ships and is verified, not bundled in.

## Recommended next step

Confirm answers to Q1 and Q3 with whoever actually relies on PR previews (they determine whether this is a small change — default to cached content, opt-in fresh pull via existing `sync:page` — or a bigger one — full-corpus regeneration on every relevant PR). Q1's "default to cached, opt-in fresh" answer likely makes this a much smaller change than "migrate previews to the pipeline" first sounded like, since most previews would need no pipeline call at all.
