# Editorial review workflow for AI translations

This guide is for **human editors and reviewers** who turn machine-generated
Portuguese (pt) and Spanish (es) translations into approved, published
documentation. It covers where to find automated translations in Notion, what
to check, which statuses to set, and how operators can regenerate a translation.

Notion is the editorial source of truth: edits happen in Notion, and the
pipeline picks them up on the next sync (`sync:page` / `sync:full` /
webhook-triggered). Nothing needs to be edited in this repository to approve a
translation.

## 1. Purpose and lifecycle

`scripts/translate-missing.ts` generates AI translations for English
documentation pages that are missing a `pt`/`es` counterpart, and writes them
back to Notion. Every page it creates or fills in carries:

| Notion property | Value on automated pages |
| --- | --- |
| `Publish Status` | `Automated translations generated` |
| `Language` | `PT - automated` / `ES - automated` |
| `Parent item` | Same container parent as the English source page |
| `Sub-item` | Relation to the English source page |

Machine output is a **first draft, not a publication**. A reviewer must inspect
it, fix what the model got wrong, and advance its status before it reaches the
live site. The lifecycle is:

```
Automated translations generated   ← machine draft lands here
        │  (reviewer picks it up, edits in Notion)
        ▼
     Draft published               ← approved, live on staging / open for editorial iteration
        │  (final sign-off)
        ▼
      Published                    ← live in production (docs.comapeo.app)
```

While a translation sits at `Automated translations generated` it is treated as
a draft by the pipeline and is **not** included in default publishes — it only
reaches consumers once a reviewer sets an active status (see
[§4](#4-status-transitions-and-release-stages)).

## 2. Locating pages to review in Notion

In the CoMapeo content database, create (or reuse) a **review queue view**:

1. Add a filter: `Publish Status` **is** `Automated translations generated`.
2. Optionally narrow by locale: `Language` **is** `PT - automated` or
   `ES - automated`.
3. Sort by `Content Section`, then `Order`, to walk the docs tree in reading
   order.

Tips:

- The `Language` select values on machine-generated pages are
  `PT - automated` / `ES - automated`. Plain `Portuguese` / `Spanish` mark
  **explicit human translations** — the pipeline never overwrites those without
  an explicit `--force` override (see [§5](#5-regenerating-a-translation)).
- Each translated page is parented alongside its English source and linked to
  it via the `Sub-item` relation. Open both side by side: the English page is
  the review reference.
- For a repo-side overview of coverage (what is missing, automated, or
  explicit), run `npm run translations:report` and open
  `translation-report.html`.

## 3. Review checklist

Work through each item against the English source page. Fix issues directly in
Notion; the pipeline re-syncs the edited blocks.

### 3.1 CoMapeo glossary adherence

`config/glossary.json` is injected into the translation prompt and is the
source of truth for domain terminology. Verify these terms are used exactly:

| English | Português | Español |
| --- | --- | --- |
| Observation / Observations | Observação / Observações | Observación / Observaciones |
| Track / Tracks | Trajeto / Trajetos | Trayecto / Trayectos |
| Exchange | Troca | Intercambio |
| Peer-to-peer | Ponto a ponto | Punto a punto |
| Background Map(s) | Mapa(s) de fundo | Mapa(s) de fondo |
| Device Role(s) | Função do dispositivo / Funções do dispositivo | Rol del dispositivo / Roles de dispositivos |
| Team / Teams | Equipe / Equipes | Equipo / Equipos |
| Project / Projects | Projeto / Projetos | Proyecto / Proyectos |
| Category / Categories | Categoria / Categorias | Categoría / Categorías |
| Passcode | Código de acesso | Código de acceso |
| Sync | Sincronização | Sincronización |

Notes:

- **Beware false friends.** Portuguese must use *Troca* (not
  *Intercâmbio*) for Exchange; Spanish uses *Intercambio*.
- Terms **not** in `config/glossary.json` have no mandated translation. Product
  and feature names (e.g. CoMapeo, Remote Archive) generally stay in English —
  the curated section labels, for instance, render as "Usando Exchange pela
  Internet" / "Usando Exchange por Internet", keeping "Exchange" as the feature
  name. When a better established translation exists on the live site, match
  it, and propose adding recurring terms to `config/glossary.json` so the
  generator picks them up.
- Terminology must be consistent across the page, its headings, and its links.

### 3.2 Technical elements preservation

The translation engine only extracts and re-inserts human-readable text; block
layout, images, admonitions, and code stay structurally intact. Confirm that:

- **Code**: code-block bodies are untouched (only code captions are
  translated), and inline code spans (`like this`) are verbatim.
- **Equations**: math delimiters survived translation (equations are masked
  before the LLM call and restored after — a mangled result looks like plain
  text or stray delimiters).
- **Callouts, toggles, admonitions and tables**: structure preserved, and table
  cell counts match the English source.
- **Custom emojis**: native Notion `custom_emoji` mentions round-trip intact
  (they are carried as `data-emoji-id`). If an emoji turned into a fallback
  glyph or plain text, re-insert it.
- **Inline HTML**: `<img …>` / `<br />` tags are token-masked during
  translation; none should appear broken or duplicated in the output.
- **Placeholders and URLs**: nothing inside code spans or URLs was
  "helpfully" translated.

### 3.3 Links and slug parity

- Translated pages **publish under the English slug**: the Portuguese route is
  `/pt/docs/<english-slug>`, the Spanish route is `/es/docs/<english-slug>`.
  Do not rename slugs or expect localized slugs — they are intentionally shared
  with English.
- Links to other doc pages must point at routes that exist. Watch for **stale
  localized links** (e.g. `/es/docs/<translated-slug>` for pages that were
  renamed or never published — a known cleanup class tracked in `TASKS.md`).
  Point these at the English slug route instead.
- Heading anchors: cross-page links ending in `#anchor` must resolve on the
  target page; same-page anchors must match a heading that actually exists on
  the page (not on a different page).
- External URLs must be unchanged from the English source.

### 3.4 Images, media, and formatting

- All images, videos, and file embeds from the English page are present and
  render correctly (assets are rehosted to permanent public URLs during
  generation).
- **Captions** are translated; alt/caption text is not left in English by
  accident — or machine-translated when it shouldn't be (e.g. screenshot text
  references).
- Formatting (bold, italic, lists, quotes, dividers) mirrors the English
  source; no duplicated or dropped empty blocks.
- Tone and register: instructions read naturally for the target audience;
  anglicisms other than mandated product names are rephrased.

## 4. Status transitions and release stages

`Publish Status` is a Notion select. Use these exact values — the pipeline maps
them to content statuses (`src/lib/status.ts`):

| Stage | `Publish Status` | Pipeline meaning |
| --- | --- | --- |
| Machine draft | `Automated translations generated` | `draft` — not emitted by default; awaiting review |
| Under review (optional) | `Reviewing translations` | `draft` — signals an in-progress review to other editors |
| Approved for staging | `Draft published` | `active` — included in default pulls / staging preview; open for editorial iteration |
| Production sign-off | `Published` | `active` — live for production deploy |

Guidance:

- **`Automated translations generated` → `Draft published`** is the reviewer's
  approval gate. Only set it once the checklist in §3 passes. This is the step
  that makes the page visible to consumers.
- Use `Reviewing translations` while a review is in progress if others may
  stumble onto the page, and set it back to `Automated translations generated`
  if you need the generator to safely top it up again (see §5).
- **`Draft published` → `Published`** is the production sign-off, aligned with
  the deploy flow in [`DEPLOYMENT.md`](../DEPLOYMENT.md).
- Never use the dead statuses `Remove` or `Unplublished` to "park" a
  translation — they mean take-this-page-down and the pipeline will exclude it
  from every publish. Use a draft status instead.

## 5. Regenerating a translation

Operators can re-run or regenerate the translation for a single page and write
it back to Notion:

```bash
bun scripts/translate-missing.ts \
  --page <page-id-or-slug> \
  --locale <pt|es> \
  --apply \
  --write-notion \
  --force
```

- `--page` accepts the English page's slug or Notion page ID; omit it to run a
  batch (add `--limit <n>` to cap it).
- `--apply` generates translations and writes files + manifest (omit for a
  dry-run preview).
- `--write-notion` writes the result back to Notion (requires `NOTION_TOKEN`
  and `NOTION_DATABASE_ID`).
- `--force` overrides the **human-edit safety lock**. Without it, the writer
  refuses to overwrite a page that already has non-stub content unless its
  `Publish Status` is still `Automated translations generated`.

⚠️ **`--force` discards human edits.** It rewrites the page body and resets
`Publish Status` to `Automated translations generated`. Coordinate with the
editor before running it on a page that has been reviewed or edited, and plan
to re-run the review checklist afterwards. Prefer regenerating **early** in the
lifecycle — before a review starts.

Related tooling:

- `npm run translations:missing` — report which English pages lack pt/es
  translations.
- `npm run translations:report` — HTML coverage report
  (`translation-report.html`).
- `bun scripts/translate-missing.ts --help` — full option list, including
  provider/model overrides (`--base-url`, `--model`, `--api-key`).

## Quick reference

| Task | Where / how |
| --- | --- |
| Find pages to review | Notion view filtered on `Publish Status` = `Automated translations generated` |
| Review reference | The linked English page (`Sub-item` relation) |
| Terminology | `config/glossary.json` (table in §3.1) |
| Approve for staging | Set `Publish Status` = `Draft published` |
| Sign off for production | Set `Publish Status` = `Published` |
| Regenerate a page | `bun scripts/translate-missing.ts --page <id-or-slug> --locale <pt\|es> --apply --write-notion --force` |
