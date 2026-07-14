# Design: move Notion status write-back into comapeo-content-pipeline

**Status:** proposal, not yet implemented. Written to resolve [comapeo-docs#185](https://github.com/digidem/comapeo-docs/issues/185) at the architecture level, per owner decision 2026-07-14 (chose "move ownership into comapeo-content-pipeline" over a one-line fix in comapeo-docs).

## Problem

`comapeo-docs`'s `deploy-production.yml` runs a trailing step, `scripts/notion-status --workflow publish-production`, that writes a status back to Notion after every production deploy. It's broken (`from: "Staging"`, a select option that no longer exists) and has been failing harmlessly on every deploy since the Publish Status vocabulary was consolidated (`comapeo-content-pipeline` commit `a39d786`, 2026-07-02).

The one-line fix (`from: "Draft published"`, confirmed correct — see evidence below) would stop the red CI, but the owner chose the bigger move: since `comapeo-content-pipeline` now owns content generation and deploy end-to-end, it should also own telling Notion "this went live," rather than that responsibility sitting in a comapeo-docs deploy workflow that increasingly does nothing but trigger and verify.

## Evidence for the correct transition (already gathered, still valid regardless of where the fix lands)

- Live Notion select has 13 options; `"Staging"` isn't one of them.
- `comapeo-docs/scripts/notion-status/index.ts` already has a correctly-configured sibling workflow in the same file: `publish: { from: "Draft published", to: "Published", setPublishedDate: true }` — identical shape to `publish-production`, differing only in `from`.
- `comapeo-content-pipeline` commit `a39d786` documents the reconstructed old-system lifecycle: *"Ready to publish" is the pull gate; write-backs move pages to "Draft published" then "Published."* This matches the `publish` workflow exactly and confirms `publish-production`'s `from` should be `"Draft published"`.

## Design questions to resolve before implementation

### 1. What triggers the write-back?

The old two-stage lifecycle (`Ready to publish` → staging deploy → `Draft published` → production deploy → `Published`) assumed a staging step that `comapeo-content-pipeline` doesn't have an equivalent of today — the Worker syncs continuously, and the CLI's output goes straight to `comapeo-docs`'s `content` branch for a human-verified production deploy (see `DEPLOYMENT.md`). Two options:

- **(a) Deploy-confirmed write-back**: `comapeo-docs`'s `deploy-production.yml` calls into `comapeo-content-pipeline` (new CLI command or an admin Worker endpoint) *after* Cloudflare Pages deploy + `content-lock.sha` promotion succeed, passing the deployed SHA or manifest version. The pipeline resolves which pages were part of that deploy and writes `Published`.
- **(b) Sync-time write-back**: the pipeline writes status as part of its own sync (`sync:full` / Worker cron), whenever a page transitions into the publishable set — no cross-repo call needed, but loses the "confirmed live in production" semantics the old system had (a page could sync successfully but the deploy could still fail after).

**(a) is closer to the original semantics** (status reflects confirmed-live, not just synced) and keeps the "did this page reach production" signal honest. Recommend (a) unless the owner wants sync-time status for a different reason.

### 2. What identifies "the pages that went live in this deploy"?

The old system did a blanket Notion query (`from: X`) with no page-level scoping. The pipeline already generates a `manifest.json` per sync with per-page IDs and hashes — reuse that instead of a blanket query, so write-back is exact rather than status-pattern-matched. Needs: a stable way to correlate "this manifest version" with "this deployed SHA" (the manifest version timestamp, or embed the manifest's generation identifier into the `comapeo-docs` commit that gets deployed).

### 3. Does the pipeline's Notion integration have write scope today?

`comapeo-content-pipeline` is deliberately read-only by design (see `src/lib/status.ts`: *"this pipeline is stateless (no write-back)... every post-editorial-gate state must map to active."*). Introducing write capability is a real architecture change, not just a relocation — needs its own review of what the integration token can do and whether a separate, more narrowly-scoped write token should be used (principle of least privilege: a token that can flip one property on rows matching a manifest, nothing else).

### 4. Failure isolation

The old step was already non-blocking (last step, deploy already reported success before it runs). Preserve that: write-back failure must never fail the deploy or block anything downstream. If done as an admin endpoint call from `deploy-production.yml`, treat non-2xx as a warning, not a job failure — matching current (accidental) behavior.

### 5. Do "Draft published" and "Ready to publish" still mean anything without a staging deploy?

If (a) is chosen and there's no staging step anymore, is there still a need for a `Draft published` intermediate state, or should the pipeline just write `Published` directly once it owns this? This is a content-lifecycle question for whoever manages editorial workflow in Notion, not a pure engineering call — flag to the content/editorial owner before collapsing the two-stage vocabulary.

## Non-goals

- Not proposing to touch `comapeo-docs/scripts/notion-status/index.ts`'s other workflows (`ready-for-translation`, `translation`, `draft`, `publish`) — those aren't part of the deploy path and are out of scope here.
- Not proposing any change to `mapStatus`'s read-side classification (`src/lib/status.ts`) — this is purely about adding a write path for the one post-deploy transition.

## Recommended next step

Small spike: implement option (a) as a new CLI command (`sync:mark-published --manifest-version <ts>` or similar) that takes a manifest version, writes `Published` to every page ID in it that's currently `Draft published`, and is invoked from `deploy-production.yml` as a non-blocking curl/gh-cli step after the existing "Persist promoted content lock SHA" step. Confirm Notion token write-scope needs before starting.
