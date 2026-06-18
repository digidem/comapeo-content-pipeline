# NEW-RENDER-INVENTORY — comapeo-content-pipeline converter + render output

Read-only inventory of the NEW pipeline's Notion → Markdown conversion, focused on
rendering fidelity. All claims cite `file:line` and real generated output under
`output/`. CLI path = `bun src/cli/index.ts` (Bun/Node fs). Dataset inspected:
295 raw per-page `.md` in `output/`, 311 rehosted assets in `output/assets/`.

## 1. Conversion engine

Custom hand-written converter — **not** `notion-to-md`. Entry: `convertBlocks`
(`src/lib/notion-converter.ts:723`) → `convertSingleBlock` switch
(`notion-converter.ts:606-716`). Block-type `case`s handled:

- `paragraph` (216), `heading_1/2/3` (617-622), `bulleted_list_item` (624),
  `numbered_list_item` (626), `to_do` (628), `toggle` (631), `quote` (634),
  `callout` (637), `code` (640), `image` (643), `video`/`file` (645-647),
  `table` (649), `table_row` (652 → returns `""`), `divider` (656),
  `bookmark`/`link_preview` (659-661), `child_page` (663), `embed` (698),
  `pdf` (701), `equation` (704), `breadcrumb` (707 → `""`),
  `table_of_contents` (710 → `""`), `column` (690), `column_list` (672).

The "silently skip" group (`notion-converter.ts:666-688`) — `unsupported`,
`child_database`, `link_to_page`, `synced_block`, `ai_block` — shares the
`column_list` flatten body, which reads `childrenMap[block.id]`; for non-column
types that map is empty, so they **collapse to `""` and emit nothing**.

Fall-through to placeholder: **only the `default` arm** (`notion-converter.ts:713`)
calls `convertUnsupportedBlock` (`:600`), emitting `> [!NOTE] Unsupported Notion
block: \`<type>\``. So a *truly unknown* type string gets a visible placeholder,
but Notion's own `unsupported` type is silently dropped (explicit case at `:667`).
No `default`-arm placeholders were found in the live dataset (0 hits).

## 2. Image pipeline

Notion `file`-type image URLs are signed/expiring (~1 h). The converter **does
download and rehost** them — it does not emit the raw Notion URL.

- URL detection: `extractAssetUrls` (`assets.ts:38`) flags any host in
  `NOTION_HOSTS` (`assets.ts:14-19`: `amazonaws.com`, `notion.so`,
  `secure.notion-static.com`, `prod-files-secure.s3...`) or `data:` URIs.
- Download with 3× exponential-backoff retries: `rehostAsset` (`assets.ts:83`).
  HTTP 4xx is not retried; exhaustion returns `null`.
- SHA-256 content hash → stable key: `assetR2Key` (`assets.ts:178`) ⇒
  `assets/<sha256hex>.<ext>`.
- URL rewrite into the markdown: `sync.ts:182-187` does
  `markdownBody.replaceAll(url, r2Key)` (longest-URL-first). Content hash is
  computed **before** rewrite (`sync.ts:120`) so it's stable across re-syncs.

Result in raw output — relative `assets/<hash>.<ext>`:
```
![Páginas de ayuda de CoMapeo…](assets/bcbc9b464772f3c817d55f7047d6ff4f950ab3088b90ef1a088a5e6342a65c09.png)
```
(`output/21f1b081-62d5-8188-947f-f16fabfc0e7b.md:22`).

`cmdDocsPull` (`src/cli/index.ts:572-604`) copies the **entire** `output/assets/`
pool into each section's `assets/` dir (`docs/{section}/assets/`,
`i18n/{locale}/.../current/{section}/assets/`). It does **no path rewriting** —
none is needed, because the markdown already stores the relative path
`assets/<hash>.<ext>` and the `.md` sits one level above the copied `assets/`
dir. So the emitted image path **does resolve** for Docusaurus as-is.

Hyperlinked images preserve the link wrapper: `[![alt](img)](link)`
(`notion-converter.ts:485`), and `extractAssetUrls` parses that shape first
(`assets.ts:50`).

## 3. Custom emoji & icons

- **Custom emoji** (Notion mention of type `custom_emoji`, a hosted image): in
  `richTextToMarkdown` (`notion-converter.ts:153-160`) it is emitted inline as
  `![<name>](<url>)` using the **raw hosted URL** — it is *not* routed through
  the asset-rehost path at convert time. It only gets rehosted later if
  `extractAssetUrls` matches its host in `NOTION_HOSTS`. Live output shows custom
  emoji left as expiring Notion-static URLs:
  ```
  ![app-icon-comapeo-play](https://s3-us-west-2.amazonaws.com/public.notion-static.com/84163b98-…)
  ```
  (host `s3-us-west-2.amazonaws.com` is in `NOTION_HOSTS`, so this should have
  been rehosted — its continued presence means the download failed and the URL
  was left raw; see weak spots).
- **Standard emoji** in text: passed through verbatim (e.g. `👆🏽`, `👣`).
- **Page icon**: `extractIcon` (`sync.ts:381-387`) keeps **emoji icons only**
  (`icon.type === "emoji"`). It is **not** rendered into the body; it is placed
  in frontmatter `sidebar_custom_props.icon` (`frontmatter.ts:115`), for a
  sidebar renderer to consume. No body markup is emitted for the page icon.

## 4. Callouts

A Notion callout becomes a **Docusaurus admonition** (`:::type title … :::`),
built in `convertCallout` (`notion-converter.ts:319-433`).

- Type from background color via `CALLOUT_COLOR_MAP` (`:436-447`): blue→`info`,
  yellow→`warning`, red→`danger`, green→`tip`, gray→`note`, orange→`caution`;
  purple/pink/brown/default→`note`.
- Emoji icon is **preserved**: stripped from the body line and re-attached as the
  admonition title (`:344-405`). Title is also derived from leading `**Bold**`
  or `Title:` patterns.
- Live examples (`output/2331b081-62d5-8049-a796-f00ff29c3e7f.md`):
  ```
  :::note 💡 Tip
  …
  :::
  ```
  and `:::note 🟢`, `:::note 🖼️`, `:::note 👉🏽 Nota`, `:::note 🚧` elsewhere.
- Callout children render inside the admonition body (`:408-415`).

## 5. Captions

Emitted as the image **alt text** (plain text, formatting stripped — correct,
since HTML `alt` doesn't render markup). `convertImage` (`:456-491`):
`alt = captionRichText.map(rt => rt.plain_text).join("") || "image"`. Live
captioned image (`output/21f1b081...md:22`) shows a full sentence alt. When the
image is itself hyperlinked, the caption is also scanned for a link URL
(`extractCaptionLink`, `:494`) to wrap the image. Video/file blocks use caption
as link label (`convertVideoOrFile`, `:516-532`). Captions are **not** rendered
as visiblefigcaption/em text below the image.

## 6. Other block types

- **columns / column_list**: flattened — columns are concatenated vertically in
  order, **not** laid out side-by-side (`:672-696`). Column geometry is lost.
- **synced_block**: silently dropped (no content inlined) — `:670` skip group.
- **toggle**: HTML `<details><summary>…</summary>…</details>` (`:279-296`).
- **table**: GFM pipe table; first row = header, separator built from column
  count (`convertTable`, `:534-560`). Emoji cell content preserved. Live
  (`output/26a1b081-62d5-8009-a3c1-ececabde2569.md:66`): `| Tópico | Ações… | ✔️ | ❌ |`.
- **equation**: `$$expression$$` (`:581-584`). No live example in dataset.
- **bookmark / link_preview**: `[caption](url)` or `[url](url)` (`:586-593`).
- **embed**: `[Embedded content](url)` (`:566-569`). Live:
  `[Embedded content](https://lh7-rt.googleusercontent.com/…)`.
- **video / file**: `[caption|block.type](url)` link (`:516-532`) — **no inline
  player**, just a hyperlink.
- **pdf**: `[PDF: label](url)` link (`:571-579`).
- **child_page**: `📄 <title>` (`:595-598`) — **0 occurrences** in live dataset;
  no link to the child page is emitted. `link_to_page` is silently dropped.
- **mention**: page/user mentions are not specially rendered (only `custom_emoji`
  mention branch exists, `:153`); other mentions fall through to `plain_text`.
- **divider**: `---` (`:562`).
- **to_do**: `- [x]` / `- [ ]` (`:272-277`).

## 7. Frontmatter

Written by `buildFrontmatter` (`frontmatter.ts:70-119`), serialized by custom
YAML emitter (`serializeFrontmatter`, `:181`) — deliberately bypasses
gray-matter's stringify to survive `:`/HTML in body. Fields: `id`, `title`,
`slug`, `sidebar_label`, `sidebar_position`, `sidebar_custom_props` (only if
page icon), `pagination_label`, `custom_edit_url`, `source: notion`,
`notion_page_id`, `notion_last_edited_time`, `content_hash`, `status`, `locale`,
`section`, `keywords`, `tags`, `last_update.{date,author}`. Real block
(`output/1d81b081-62d5-8164-9b7e-fdc21a0e3c9b.md`):
```yaml
id: introduction
title: Introduction
slug: /introduction
sidebar_label: Introduction
pagination_label: Introduction
custom_edit_url: "https://github.com/digidem/comapeo-docs/edit/main/docs/en/docs/overview/introduction.md"
source: notion
notion_page_id: "1d81b081-62d5-8164-9b7e-fdc21a0e3c9b"
notion_last_edited_time: "2026-04-22T03:58:00.000Z"
content_hash: "sha256:b757179b…"
status: draft
locale: en
section: Overview
keywords: [docs, comapeo]
tags: [comapeo]
last_update:
  date: 4/22/2026
  author: Awana Digital
sidebar_position: 9
```
`id` is the bare slug (no `/`); Docusaurus prefixes the section dir to form the
full doc id (`frontmatter.ts:92-95`).

## 8. Empty / placeholder content

**No `[Insert content here]` or any placeholder string** is emitted for empty
bodies. A page with no body blocks yields a file that is **frontmatter only**
followed by an empty body. Confirmed: `output/2331b081-62d5-800a-8eaa-ee9254e6140c.md`
ends at line 20 (closing `---`) with nothing after, and its `content_hash` is
`sha256:e3b0c44298fc…b855` — the well-known SHA-256 of the empty string. There is
no source string for a placeholder; the converter simply produces `""`
(`convertBlocks` returns `""` when `lines.length === 0`, `:737`). Empty
*paragraphs* within a page do become a visible `<div class="notion-spacer">`
(`convertParagraph`, `:219-223`).

## 9. Build-time dependencies

The emitted markdown targets **Docusaurus + MDX** and assumes standard built-ins;
no custom remark/rehype plugin or theme component is *strictly* required, but
several constructs depend on Docusaurus defaults:

- `:::note` admonitions → Docusaurus built-in admonitions.
- `<details>/<summary>`, `<u>`, `<span style="color:…">`, `<div>` → MDX raw-HTML
  (allowed by default in `.md`).
- `<div class="notion-spacer" …>` → renders as a **no-op div unless the consumer
  ships CSS** for `.notion-spacer` (no height). Cosmetic gap is lost otherwise.
- `sidebar_custom_props.icon` → only renders if the sidebar theme component
  reads `customProps.icon`.
- `$$ … $$` math → requires an MDX/KaTeX plugin if used (none in live dataset).

So it is **self-contained for standard Docusaurus**, with two cosmetic gaps
(spacer CSS, sidebar icon theme) that need consumer-side support to look right.

## Known weak spots

- **Custom-emoji / failed-asset URLs left raw.** Custom emoji emits the hosted
  URL at convert time (`:153`); any Notion-hosted image whose download fails
  (4xx / retry exhaustion) is left as the **original expiring signed URL** — it
  will 404 within ~1 h. Live output still contains raw
  `…notion-static.com/…` and `…amazonaws.com/…` image URLs.
- **Asset duplication.** `cmdDocsPull` copies the full 311-asset pool into
  **every** section dir (`index.ts:590`); N sections ⇒ N×311 files on disk.
- **Columns flattened, not side-by-side** — column layout geometry is lost.
- **`synced_block` / `link_to_page` / `child_database` silently dropped** —
  content vanishes with no placeholder.
- **`child_page` is non-navigational** — emits `📄 Title` with no link; 0 live
  examples.
- **Media is link-only** — video/file/pdf/embed become hyperlinks, no inline
  player or embed.
- **Captions are alt-text only** — not shown as visible figure captions.
- **`unsupported` Notion blocks are silently dropped** (explicit case, not the
  visible placeholder); the visible `Unsupported Notion block` note only fires
  for never-before-seen type strings.
- **Spacer divs need consumer CSS** to produce any vertical gap.
- **Page icon** only surfaces via `sidebar_custom_props.icon`; no body/icon-favicon rendering.
