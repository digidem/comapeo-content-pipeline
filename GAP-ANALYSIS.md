# GAP ANALYSIS — new pipeline vs old comapeo-docs Notion→render

**Date:** 2026-06-18. Synthesis of `OLD-RENDER-INVENTORY.md` + `NEW-RENDER-INVENTORY.md`.
Question: as the new pipeline replaces the old comapeo-docs scrape, what does it do better, and what fidelity/reliability did it lose? Goal = simpler + more reliable + maintainable, while staying Notion-correct and Docusaurus-ready.

## Where the new pipeline is already BETTER (keep, don't regress)

1. **Custom converter instead of `notion-to-md` + post-hacks.** Old used `notion-to-md@3.1.9` with only 2 custom transformers and converted callouts by *text-matching blockquotes* (`markdownTransform.ts:357`) — fragile, silently falls back on duplicate wording. New has an explicit `case` per block type and converts callouts as a real block transform. Simpler mental model, no library-version risk. ✓
2. **Content-hash assets + relative paths.** Old named images `blockName_index.ext` (renames on re-fetch) and depended on a build-time `remark-fix-image-paths` plugin to decode base64 `__locale_ref__/__remote_ref__` placeholders — so committed markdown would NOT render images without that plugin. New uses `assets/<sha256>.<ext>` (stable, dedup) with plain relative paths that resolve with **no consumer remark plugin**. This is exactly the spec's "comapeo-docs is a dumb consumer" goal. ✓
3. **Single-source frontmatter.** Old split frontmatter between fetch + a `fix-frontmatter` post-step, and the provenance fields (`notion_page_id`, `content_hash`, `status`…) came from a CI/content-branch stage *outside the repo*. New emits everything in `frontmatter.ts` with one serializer. ✓

## Gaps / regressions to fix (prioritized)

### P1 — Reliability: broken output in production
1. **Custom emoji is broken (the flagged issue).** New emits `![name](raw-notion-url)` at convert time (`notion-converter.ts:153-160`). Two problems:
   - **Expiring URL**: it's only rehosted if `extractAssetUrls` matches the host *and* the download succeeds; live output still contains raw `…notion-static.com/…` / `…amazonaws.com/…` emoji URLs that 404 within ~1h.
   - **Wrong size**: even when rehosted it renders as a full-size markdown image, not an inline glyph. Old rendered custom emoji as `<img className="emoji" style={{height:"1.2em",verticalAlign:"text-bottom",…}}>` (`emojiMapping.ts:9`), downloaded to `static/images/emojis/` with content-hash dedup.
   - **Fix**: route custom_emoji through the rehost pipeline (so the body carries a local `assets/…` path) AND emit it as an inline sized `<img class="emoji" …>` instead of `![]()`.
2. **Failed image downloads leak raw expiring URLs.** New's `rehostAsset` returns `null` on failure and the original signed Notion URL is left in the markdown → guaranteed 404. Old had a safety net: a visible `**[Image N]** *(Image failed to download)*` marker + HTML comment, plus `validateAndFixRemainingImages` that re-runs if any S3/`data:` URL remains (`imageReplacer.ts:912`).
   - **Fix**: never emit a raw Notion/S3/`data:` URL — on failure substitute a visible placeholder (or drop) and add a final assertion that no expiring host remains in the output.

### P2 — Silent content loss
3. **`synced_block`, `link_to_page`, `child_database` are silently dropped** (`notion-converter.ts:666-688` collapse to `""`). Old, via `notion-to-md` defaults, inlined synced-block children and emitted page links. Content that authors put in synced blocks simply vanishes with no trace.
   - **Fix**: inline `synced_block` children (resolve the original block's children); render `link_to_page` as a link to the target doc.

### P3 — Performance & maintainability
4. **No image optimization.** Old ran `sharp` (resize maxWidth 1280, jpeg q80 / png lvl9 / webp q80, SVG passthrough). New ships full-resolution Notion images → heavier pages, slower load. Add a resize/compress step in the asset pipeline.
5. **Asset duplication in `docs:pull`.** It copies the entire `output/assets/` pool (311 files) into **every** section dir (`cli/index.ts:590`) — N sections × 311 files. Old kept one shared `static/images/`. Copy only the assets each section references, or emit to one shared dir and reference it. Big disk + maintainability win.

### P4 — UX / fidelity polish (lower priority)
6. **Empty pages render blank.** New emits frontmatter + empty body for a page with no blocks. Old emitted a visible `:::note Content placeholder – add blocks in Notion`. Consider replicating, or excluding empty pages from the sidebar. (Note: the `[Insert content here]` seen in i18n is *Notion source* content, not converter output — confirmed new emits no placeholder string.)
7. **`notion-spacer` div needs consumer CSS.** Both old and new emit `<div class="notion-spacer">` for empty paragraphs; it produces no gap unless comapeo-docs ships CSS for it. Either ship the CSS in the consumer or stop emitting it. (Not a regression — parity with old.)
8. **Columns flattened** (no side-by-side). Same as old (`notion-to-md` also flattened) — note only, not a regression.
9. **Known minor frontmatter bugs** (already noted in STATE.md): stale `custom_edit_url` path (`docs/<locale>/docs/…` vs real i18n path → 404 "Edit this page"), and a doubled `---` at file end.

## Recommended order of work
P1.1 custom emoji + P1.2 failed-URL safety net (same asset-pipeline area, biggest reliability win, directly addresses the flagged concern) → P2.3 synced_block/link_to_page (stop content loss) → P3.5 asset dedup in docs:pull → P3.4 image optimization → P4 polish.
