# Migration Guide: comapeo-docs → comapeo-content-pipeline

This document describes the steps to migrate `digidem/comapeo-docs` from owning the full Notion-sync pipeline to being a Docusaurus-only consumer.

## Architecture Change

**Before:**
```
comapeo-docs/
  scripts/notion-fetch/     ← Notion sync lives here
  scripts/notionClient.ts   ← Notion API client
  scripts/fetchNotionData.ts
  docs/*.md                 ← Generated from Notion
  i18n/*/.../docs/*.md      ← Translations generated from Notion
```

**After:**
```
comapeo-content-pipeline/   ← Owns all Notion complexity
  → writes to R2
  → generates manifest

comapeo-docs/               ← Docusaurus rendering only
  prebuild: pulls docs from R2 via `docs:pull`
  build: docusaurus build (reads docs/ directory)
```

## Step-by-Step Migration

### 1. Add prebuild script to comapeo-docs

In `package.json`:

```json
{
  "scripts": {
    "prebuild": "cd ../comapeo-content-pipeline && pnpm pipeline docs:pull --out ../comapeo-docs/docs",
    "build": "docusaurus build"
  }
}
```

Or, if using the pipeline as a dependency:

```json
{
  "scripts": {
    "prebuild": "comapeo-content-pipeline docs:pull --out ./docs",
    "build": "docusaurus build"
  }
}
```

### 2. Verify docs:pull output compatibility

The `docs:pull` command generates Docusaurus-compatible files:
- YAML frontmatter with `id`, `title`, `slug`, `sidebar_position`
- Locale-aware directory structure (`i18n/{locale}/docusaurus-plugin-content-docs/current/`)
- Same file structure as current generated docs (sections as subdirectories)

### 3. Remove old scripts (after verification)

Once `docs:pull` is working correctly, remove:

```bash
# Directories to remove
scripts/notion-fetch/
scripts/notion-fetch-all/
scripts/notion-fetch-one/
scripts/notion-api/
scripts/notion-translate/
scripts/notion-create-template/
scripts/notion-placeholders/
scripts/notion-status/
scripts/notion-version/
scripts/notion-test-pages/
scripts/notion-count-pages/
scripts/migration/
scripts/eval/
scripts/test-scaffold/

# Key files to remove
scripts/fetchNotionData.ts
scripts/fetchNotionData.test.ts
scripts/fetchNotionBlocks.test.ts
scripts/notionClient.ts
scripts/notionClient.test.ts
scripts/notionPageUtils.ts
scripts/notionPageUtils.test.ts
scripts/fix-frontmatter.ts
scripts/fix-frontmatter.test.ts
scripts/run-single-page-translation.ts
scripts/run-single-page-translation-flow.sh
scripts/push-new-translation-to-notion.ts
scripts/push-new-translation-to-notion.test.ts
scripts/test-notion-translate.ts

# Keep
scripts/remark-fix-image-paths.ts   ← Docusaurus plugin
scripts/generate-robots-txt.ts      ← Docusaurus utility
scripts/verify-docker-hub.ts        ← CI/CD
scripts/ci-validation/              ← CI/CD
scripts/docker-publish-workflow.test.ts
```

### 4. Remove Notion dependencies from package.json

Remove or move to devDependencies in the pipeline:

```json
{
  "devDependencies": [
    // Remove from comapeo-docs:
    "@notionhq/client",
    "notion-to-md",
    // Keep what Docusaurus needs:
    "@docusaurus/core",
    // ... etc
  ]
}
```

### 5. Validate the build

```bash
cd comapeo-docs
pnpm prebuild       # pulls docs from R2
pnpm build          # docusaurus build
```

The build should produce identical output to the current pipeline.

## Rollback Plan

If something breaks:
1. Revert to old scripts (all still in git history)
2. Run `pnpm notion:fetch` manually
3. Fix the issue in the pipeline repo
4. Re-attempt migration

## Testing Checklist

- [ ] `docs:pull` creates files in the correct Docusaurus structure
- [ ] Frontmatter is Docusaurus-compatible (`id`, `title`, `slug`, `sidebar_position`)
- [ ] Locale files go to `i18n/{locale}/docusaurus-plugin-content-docs/current/`
- [ ] Section pages are in correct subdirectories with sidebar_position ordering
- [ ] Image paths reference local assets (no expiring Notion URLs)
- [ ] Internal links between pages resolve correctly
- [ ] `docusaurus build` succeeds with no errors
- [ ] RAG chunks are generated for the bot to consume
