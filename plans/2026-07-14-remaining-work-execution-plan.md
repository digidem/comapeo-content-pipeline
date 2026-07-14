# Execution plan: remaining work from the 2026-07-14 comapeo-docs cleanup

**Status:** proposal, not yet implemented. Consolidates the three still-open threads from the 2026-07-14 session (comapeo-docs#183/#185/#187) into one ordered, concrete task list. Supersedes the "Recommended next step" sections of the two standalone design docs — this file is the one to work from; the design docs remain as background/rationale.

Related reading (unchanged, still the source of the *why*):
- [`2026-07-14-notion-status-writeback-design.md`](2026-07-14-notion-status-writeback-design.md) — background for Track B
- [`2026-07-14-pr-preview-pipeline-migration-design.md`](2026-07-14-pr-preview-pipeline-migration-design.md) — background for Track C
- `TASKS.md` §5 (Repo housekeeping) — where these are tracked at a glance

## The three tracks and how they relate

| Track | What | Repo(s) | Blocks / blocked by |
|---|---|---|---|
| A | Amend comapeo-docs#183 to keep `static/images/` | comapeo-docs | No *logical* block, but see file-overlap note below — do first |
| B | Move Notion status write-back into the pipeline | Both | No logical block; shares `deploy-production.yml` with A |
| C | Migrate PR-preview content generation off legacy scripts | comapeo-docs (+ this pipeline as a consumer) | No logical block; shares `deploy-pr-preview.yml` with A |

No track *logically* blocks another — none needs a capability another produces. But the earlier claim that they "touch different files" is not accurate: verified against the local `comapeo-docs` checkout, Track A's `fix/deploy-pathspec-img` branch edits **all four** `deploy-*.yml` workflows, and two of those files are also edited by other tracks — **B** adds a step to `deploy-production.yml` (Track A changes its checkout-pathspec + image-guard block, lines ~133/169–179; B's insertion is near the "Persist promoted content lock SHA" step, ~213, and the old `bun run notionStatus:publish-production` step it removes, ~229 — different hunks, but same file), and **C** rewrites the regeneration branch of `deploy-pr-preview.yml` (Track A also edits that file's checkout + guard). So there is a real **merge-conflict / rebase** relationship: A must land first (it already leads the ordering), and B's and C's comapeo-docs branches must be cut from **post-A-merge** `main`, not from today's `main`, or they will conflict on those two workflows. This is a soft ordering constraint, not a hard capability dependency.

Given that, the ordering below is by **effort and risk**, cheapest/safest first: closing the small one (A) first both drops the loose-end count and establishes the post-A workflow baseline that B and C rebase onto. Both B and C also need a human decision before any code gets written, so front-loading those decision-asks lets them happen in parallel with implementation work on whichever track resolves first.

---

## Track A — amend comapeo-docs#183 (smallest, do first)

**Owner of the actual edit:** whoever is driving comapeo-docs#183 (its author, per the 2026-07-14 session's PR comment). Nothing for this pipeline to build.

1. On `fix/deploy-pathspec-img`, revert the `static/img/` checkout-pathspec/trigger-grep/paths-filter/guard changes back to `static/images/` across the four workflows (`deploy-production.yml`, `deploy-staging.yml`, `deploy-test.yml`, `deploy-pr-preview.yml`), keeping the PR's real fixes (trigger-decision grep correctness, `paths` filter, empty-dir guards/counters) — i.e. undo only the path-name swap, not the rest of the PR.
2. Verify with a local `bun run build` (or the deploy-preview CI it already triggers) against a checkout that has real `static/images/notion/*` content, confirming images resolve.
3. Merge #183.
4. Close comapeo-docs#186 (referencing the merge).

**Acceptance:** #183 merged, #186 closed, next production deploy's image-count check passes with the real 61+ files.

---

## Track B — Notion status write-back ownership (comapeo-docs#185)

### B0 — Decision checkpoint (blocks B1+, needs a human, not a code change)

Before writing any code, get an explicit answer from whoever owns Notion's editorial workflow to the design doc's Q5: **does the two-stage `Ready to publish` → `Draft published` → `Published` lifecycle still need both stages without a separate staging deploy step?** This determines whether B2 below writes `Draft published`→`Published` (preserves current vocabulary) or collapses straight to `Published` (simpler, but a vocabulary change someone might be relying on for filtering/views in Notion).

Also confirm at this checkpoint: **does the pipeline's existing Notion integration token have write scope**, or does a new, narrowly-scoped token need provisioning? (design doc Q3). This is an infra/credentials question, not a design one — cheap to answer now, expensive to discover mid-implementation.

Third, resolve the design doc's **Q2 correlation problem** — it is a real blocker for B2, not just background. `sync:mark-published` takes `--manifest-version <ts>`, but `deploy-production.yml` today has **no manifest handle at all** — it only knows `content-lock.sha` (a comapeo-docs content-branch commit SHA; verified: no `manifest` reference exists anywhere in that workflow). So B2 cannot invoke B1 until there is a decided mechanism to map "the SHA this deploy promoted" → "the pipeline manifest version that produced it" (design doc Q2's two options: correlate by manifest timestamp, or embed the pipeline's manifest generation identifier into the comapeo-docs commit that gets deployed). Pick one here; without it, B1 is buildable but B2 has nothing to pass.

### B1 — Implement the write-back primitive (this pipeline)

- New CLI command, e.g. `sync:mark-published --manifest-version <ts>` (or `--manifest-key`), in `src/cli/index.ts` (or extracted per the `docs-pull.ts`/`validate-diff.ts` precedent, into its own module if it grows past a few dozen lines).
- Reads the specified manifest version from storage, resolves the page IDs in it whose current Notion status is the pre-published stage decided in B0.
- Writes the resolved to-stage (`Published`, or `Draft published`→`Published` per B0) to each of those pages via the Notion API. Reuses the existing `NotionClient` wrapper (`src/lib/notion-client.ts`) — this is the pipeline's first *write* call, so add an explicit, narrow method (e.g. `updatePageStatus(pageId, status)`) rather than a generic PATCH passthrough, to keep the write surface auditable.
- Non-blocking-failure semantics: log and report per-page failures, but the command's own exit code should reflect whether it *ran*, not whether every page write succeeded — mirrors the old script's behavior of "0 changes is still a successful run."
- **`--dry-run` flag (required before first production use):** since this is the pipeline's first-ever *write* to Notion, the command must support resolving + logging exactly which pages it *would* transition, without writing, so it can be validated against the real production DB before anything is mutated. Do not run the live path against production until a dry-run against the same manifest version has been eyeballed.
- **Decide, don't silently drop, rollback recording.** The legacy `comapeo-docs/scripts/notion-status` system this replaces recorded each page's original status before changing it (`rollbackRecorder.ts`, `enableRollback` defaulted **on**) so a bad batch could be reverted. The new write path has no equivalent. Make an explicit call at B0/B1: either port a minimal equivalent (e.g. write the pre-change status of each touched page into the manifest version's storage, or a sibling `mark-published-rollback/{ts}.json`), or consciously accept that a `Draft published → Published` flip is cheap enough to reverse by hand and skip it. Either is fine — silently having *no* rollback where the predecessor defaulted to having one is the thing to avoid.
- Unit tests: mock the Notion write call, verify manifest→page-ID resolution, verify only pages in the target pre-stage get written (not pages already `Published`, not pages in unrelated drafts); assert `--dry-run` performs resolution but issues zero write calls.

**Acceptance:** `bun src/cli/index.ts sync:mark-published --manifest-version <ts>` runs against a test/staging Notion DB and correctly transitions only the intended pages; tests green; typecheck clean.

### B2 — Wire it into the deploy path (comapeo-docs)

- Add a step to `deploy-production.yml`, after "Persist promoted content lock SHA" succeeds, that invokes B1's command (either by checking out this pipeline as a step, or via a published admin Worker endpoint if that's preferred over a CLI invocation from comapeo-docs's CI — pick whichever needs fewer new secrets in comapeo-docs's CI).
- Treat non-zero exit / non-2xx as a **warning annotation on the run**, not a job failure — matches current behavior (the old broken step never failed the deploy either, it just showed red).
- Remove the old `scripts/notion-status --workflow publish-production` step entirely (superseded, not just fixed).

**Acceptance:** a real production deploy shows the new step running (green or warning, never blocking), and spot-checking a page that was part of that deploy in Notion shows its status updated.

### B3 — Cleanup

- Remove the now-fully-dead `publish-production` entry from `comapeo-docs/scripts/notion-status/index.ts`'s `WORKFLOWS` map (the `publish` workflow and the other non-deploy-path workflows — `ready-for-translation`, `translation`, `draft` — stay, per the design doc's non-goals).
- Update `TASKS.md` and close comapeo-docs#185.

---

## Track C — migrate PR-preview content generation (comapeo-docs#187, remaining half)

### C0 — Decision checkpoint (blocks C1+, needs a human, not a code change)

Ask whoever actually relies on PR previews day-to-day (design doc Q1 and Q3):

1. **Do most PR previews need a fresh Notion pull at all**, or is "whatever's on the `content` branch already" good enough for the vast majority of previews (site-code/theming PRs, which don't touch content)? Recommendation from the design doc: default to cached content, add an explicit opt-in (label, e.g. `preview-fresh-content`, or a `workflow_dispatch` input) for the rare case someone wants to preview against live Notion edits.
2. **If a fresh pull is requested, is a single-page/scoped sync (`sync:page <id>`) enough**, or does the use case actually need a fuller sync? This determines whether C1 needs the full-corpus code path or just the existing single-page one.

These two answers substantially change the size of C1 — get them before starting.

### C1 — Implement the pipeline-backed preview path (comapeo-docs, consuming this pipeline as-is)

- Replace `deploy-pr-preview.yml`'s "SCRIPT_CHANGES detected → regenerate via `scripts/notion-fetch/`" branch with: **default to no regeneration** (use `content` branch as-is, per C0.1), and **only if the opt-in trigger from C0.1 is present**, run this pipeline's CLI (mirroring `DEPLOYMENT.md` Steps 1–2, scoped per C0.2's answer) into a preview-local output directory, then point the Docusaurus build at that directory instead of the `content` branch's checkout.
- Remove the now-unused `SCRIPT_CHANGES` diff-and-regenerate logic entirely — it's being replaced, not kept as a fallback.
- Credentials: use a read-only-scoped Notion token for this job (no write needed, unlike Track B) and confirm the workflow trigger type (`pull_request` vs `pull_request_target`) doesn't expose it to untrusted fork code if forked-repo PRs are in scope for previews.

**Acceptance:** a PR with the opt-in trigger produces a preview build sourced from a fresh pipeline sync; a PR without it builds from cached `content`-branch content exactly as before, with no latency regression.

### C2 — Cleanup (only after C1 is verified stable in production use, not bundled into C1's PR)

- Delete `scripts/notion-fetch/`, `scripts/notion-fetch-all/`, and any other now-fully-unreferenced legacy fetch scripts in comapeo-docs.
- Update `TASKS.md` and close comapeo-docs#187 entirely (both halves now resolved).

---

## Summary task list, in recommended working order

1. [ ] **A**: amend comapeo-docs#183 back to `static/images/`, merge, close #186.
2. [ ] **B0**: settle B0's three decisions — two-stage-vocabulary (content/editorial owner), write-token-scope (infra), and the manifest-version↔deployed-SHA correlation mechanism (an engineering pick, blocks B2) — and make the rollback-recording call (B0/B1).
3. [ ] **C0**: get the "does preview need fresh content" and "scoped vs full sync" decisions from PR-preview users.
4. [ ] **B1**: implement `sync:mark-published` in this pipeline, with tests.
5. [ ] **C1**: implement the gated pipeline-backed preview path in comapeo-docs.
6. [ ] **B2**: wire B1 into `deploy-production.yml`, verify on a real deploy.
7. [ ] **B3**: remove the dead `publish-production` workflow entry, close #185.
8. [ ] **C2**: once C1 is stable, delete the legacy `scripts/notion-fetch/` tree, close #187 fully.

Steps 2 and 3 (the decision checkpoints) can happen in parallel with each other and are the only hard prerequisites blocking 4 and 5 respectively — everything else is a straight-line sequence within its own track.
