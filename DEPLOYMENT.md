# Deploying content to docs.comapeo.app

This is the full, reproducible path from a Notion edit to live content on production. It spans two repos — this repo generates content, `digidem/comapeo-docs` serves it — and nothing describes the whole chain in one place, so it's written down here.

`comapeo-docs` already documents its own last-mile deploy mechanics well: see [`context/workflows/PRODUCTION_DEPLOYMENT.md`](https://github.com/digidem/comapeo-docs/blob/main/context/workflows/PRODUCTION_DEPLOYMENT.md) in that repo for how `content-lock.sha` and `deploy-production.yml` work. This doc covers everything upstream of that — generating content and getting it into `comapeo-docs`'s `content` branch safely — plus two failure modes that aren't obvious from either repo's code.

## Overview

```
Notion (editorial source)
  ↓ sync:full
comapeo-content-pipeline/output/          (canonical Markdown + metadata + manifest)
  ↓ docs:pull --all --clean-orphans
comapeo-docs/{docs,i18n,static/images/notion}/   (local, gitignored on main)
  ↓ build a commit based on the LIVE locked SHA, not content branch tip
comapeo-docs `content` branch               (push)
  ↓ gh workflow run deploy-production.yml -f content_sha=<sha>
Cloudflare Pages → docs.comapeo.app
```

## Prerequisites

- `.env` populated in this repo (`NOTION_TOKEN`, `NOTION_DATABASE_ID`, `NOTION_DATA_SOURCE_ID`; see README)
- `comapeo-docs` cloned somewhere on disk, with `bun install` already run there at least once (its `node_modules` gets reused for the local build check in Step 4)
- `gh` CLI authenticated with push access to `digidem/comapeo-docs`

Set this once per session — every command below uses it, so the rest of this doc works regardless of where you've cloned `comapeo-docs`:

```bash
export COMAPEO_DOCS=/absolute/path/to/comapeo-docs   # e.g. ../comapeo-docs, resolved to absolute
COMAPEO_DOCS=$(realpath "$COMAPEO_DOCS")
```

## Step 1 — Generate fresh content

```bash
bun src/cli/index.ts sync:full --out ./output
```

Pulls every page from Notion into `./output` (canonical Markdown, per-page metadata, `manifest.json`). Takes a few minutes for the full corpus. Never pass `--all` here — it disables the API-level dead-row exclusion (see TASKS.md).

## Step 2 — Materialize + verify locally

```bash
DOCS_DIR="$COMAPEO_DOCS" bash scripts/sync-to-comapeo-docs.sh
```

The script reads `$DOCS_DIR` (not `$COMAPEO_DOCS`) and defaults it to `../comapeo-docs` relative to this repo — pass it explicitly as shown above so it always targets the checkout you set in Prerequisites, regardless of where it's actually cloned.

This one script does `docs:pull --all --clean-orphans`, rsyncs the result into `../comapeo-docs/{docs,i18n,static/images/notion}` (scoped deletes — it never touches hand-maintained files outside those trees), and runs a local Docusaurus build (`npx docusaurus build`, not the `IS_PRODUCTION=true` build Step 4 does — good enough to catch MDX/asset errors early, not a substitute for Step 4). **Do not proceed past a failed build here.**

Serve and spot-check it before continuing:

```bash
cd "$COMAPEO_DOCS" && python3 -m http.server 8765 --directory build
```

Check at least one page per locale (EN/ES/PT) and any page you know references an image, in a browser or via `curl`.

## Step 3 — Build the `content` branch commit

**Do this in a separate git worktree**, not in the `comapeo-docs` working copy you just verified — you need to diff against a different base than what's currently checked out there.

```bash
cd "$COMAPEO_DOCS"
git fetch origin content main

# The LIVE SHA (what's actually deployed) can differ from content branch's tip.
# Always base the new commit on the live SHA, never on the branch tip blindly —
# see "Gotcha 1" below for why.
LIVE_SHA=$(git show origin/main:content-lock.sha)
echo "$LIVE_SHA"

WORKTREE=/tmp/comapeo-docs-content-deploy
rm -rf "$WORKTREE"   # in case a previous attempt left one behind
git worktree add "$WORKTREE" origin/content
cd "$WORKTREE"
git checkout -b content-deploy-$(date +%F)

# Reset docs/i18n/static/images to what's actually live, so anything hand-maintained
# under static/images/ that our pipeline doesn't own is preserved.
git checkout "$LIVE_SHA" -- docs/ i18n/ static/images/

# Wholesale-replace the generated trees with today's fresh output (the directory
# you verified in Step 2 — $COMAPEO_DOCS, NOT this worktree).
rm -rf docs i18n static/images/notion
cp -r "$COMAPEO_DOCS/docs" .
cp -r "$COMAPEO_DOCS/i18n" .
cp -r "$COMAPEO_DOCS/static/images/notion" static/images/
```

### Gotcha 1 — `content` branch tip ≠ live site

`main`'s `content-lock.sha` pins what's actually deployed. The `content` branch can keep moving (old bots, manual edits) without anyone promoting a new lock SHA — we found it 89 days stale and not even an ancestor of the branch tip the first time this was done. If you base your new commit on the branch tip instead of the live SHA, you can silently drop hand-maintained assets that only exist at the live SHA. Always resolve `$LIVE_SHA` from `main:content-lock.sha` as shown above.

### Gotcha 2 — the `assets/` gitignore trap

`content` branch's `.gitignore` has an **unanchored** `assets/` rule (no leading slash), which matches every `docs/<section>/assets/` and `i18n/<locale>/.../<section>/assets/` folder in the tree — not just a top-level one. `git add docs/ i18n/` silently drops all of them, no error, no warning. The build then fails at MDX compilation with "couldn't be resolved to an existing local image file" for every image in an affected section.

**Always force-add and verify zero remaining ignored files before committing:**

```bash
git add -f docs/ i18n/ static/images/notion/
git status --porcelain --ignored -- docs/ i18n/ static/images/ | grep '^!!'
# must print NOTHING — if it prints paths, they were dropped and need -f too
```

## Step 4 — Build locally before pushing (non-negotiable)

Don't rely on CI to catch a broken commit — a failed production build run is visible to anyone watching Actions, and by the time it fails the commit is already on the shared `content` branch.

```bash
cd "$WORKTREE"
ln -s "$COMAPEO_DOCS/node_modules" node_modules   # reuse already-installed deps
IS_PRODUCTION=true bun run build
```

Expect the build to succeed with only the known content-state broken-link/anchor warnings (~180, tracked in `TASKS.md` task 1 — Notion editorial issues, not pipeline bugs). Any MDX compilation error means go back to Gotcha 2. Remove the `node_modules` symlink before committing (don't let it get committed):

```bash
rm -f node_modules
```

## Step 5 — Commit and push

```bash
git add -f docs/ i18n/ static/images/notion/
git commit -m "content: regenerate docs/i18n/static from comapeo-content-pipeline ($(date +%F))"
git push origin HEAD:content --force-with-lease
```

This rewrites history on a shared branch — `--force-with-lease` blocks it if someone else pushed to `content` since your `git fetch` above, rather than clobbering them. If it's rejected, re-fetch, re-check Gotcha 1 (the live SHA may have moved too), and redo Step 3 on top of the new tip before retrying — don't reach for plain `--force`.

## Step 6 — Trigger the production deploy

Capture the SHA into a variable — **never hand-retype a short hash into the full 40-char form**, a typo there fails the workflow's SHA-existence check (safely, but it wastes a round trip).

```bash
DEPLOY_SHA=$(git rev-parse HEAD)   # still in $WORKTREE from the previous step
gh workflow run deploy-production.yml --repo digidem/comapeo-docs \
  -f environment=production -f content_sha="$DEPLOY_SHA"
```

Watch it:

```bash
gh run list --repo digidem/comapeo-docs --workflow=deploy-production.yml --limit 1 --json databaseId,url
gh run watch <run-id> --repo digidem/comapeo-docs --exit-status
```

### Known non-blocking failure: "Update Notion status to Published"

This step (last in the workflow) currently fails on every run — it references a Notion select option (`"Staging"`) that no longer exists in the live Publish Status vocabulary. It records 0 status changes before failing, so it never touches Notion data. The actual deploy (build → Cloudflare Pages → `content-lock.sha` promotion) completes and reports success in the steps *before* this one. Check those steps (`Build documentation`, `Deploy to Cloudflare Pages`, `Persist promoted content lock SHA`) for the real pass/fail signal, not the job's overall red/green.

## Step 7 — Verify live, don't just trust the green checkmarks

```bash
# content-lock.sha on main should now be $DEPLOY_SHA
git fetch origin main && git show origin/main:content-lock.sha

curl -sL -o /dev/null -w "%{http_code}\n" https://docs.comapeo.app/docs/introduction/
curl -sL -o /dev/null -w "%{http_code}\n" https://docs.comapeo.app/es/docs/creating-a-new-observation/
curl -sL -o /dev/null -w "%{http_code}\n" https://docs.comapeo.app/pt/docs/creating-a-new-observation/
```

Spot-check a page that has an inline image — Docusaurus rehashes asset filenames at build time, so check the actual rendered `<img src>`, not the raw content-repo path:

```bash
curl -sL https://docs.comapeo.app/docs/<some-slug>/ | grep -oE '<img[^>]*src="[^"]*"'
```

## Cleanup

```bash
cd "$COMAPEO_DOCS" && git worktree remove /tmp/comapeo-docs-content-deploy --force
```

## Rollback

See `comapeo-docs`'s own [`PRODUCTION_DEPLOYMENT.md`](https://github.com/digidem/comapeo-docs/blob/main/context/workflows/PRODUCTION_DEPLOYMENT.md) rollback section — revert `content-lock.sha` on `main` to a previous SHA via PR, or re-trigger `deploy-production.yml` with an older `content_sha`. Not duplicated here since it's already correct there.
