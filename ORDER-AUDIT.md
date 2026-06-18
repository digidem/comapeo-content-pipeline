# ORDER AUDIT — section sidebar order vs Notion `Order`

**Date:** 2026-06-18 · Verified against freshly regenerated content (`docs:pull --all`) and the running dev site.
**Verdict: FAIL** — section order does not match the intended Notion table order.

## How section position is computed (code refs)

`src/cli/index.ts` `cmdDocsPull`:
- **`sectionOrder` map (lines 370–393):** for every EN **Toggle** page, the section's canonical position = that Toggle page's `section_order` (its Notion `Order` property), lowest wins.
- **Category sort (lines 512–529):** `getOrder(name)` returns:
  - `Uncategorized` → `999`
  - else the Toggle order from `sectionOrder` if present,
  - else `/^\d/.test(name) ? 999 : 0` — i.e. a number-prefixed section with **no Toggle** is dumped at 999, a prefix-less section (`Overview`) at 0 (first).
  - tie-break: `a[0].localeCompare(b[0])` on the full prefixed section name.
- Positions are then assigned sequentially `1..N` (line 548).

So: **Overview first (0) → sections by EN-Toggle `Order` → Uncategorized last (999)**. That is exactly what the site renders.

## Two conflicting order signals in the source

1. **Numeric name prefix** baked into each section name — a clean monotonic sequence:
   `10-Preparing`, `20-Gathering`, `30-Reviewing`, `40-Managing Data`, `50-Managing Projects`, `60-Exchanging`, `70-Sharing`, `80-Ending`, `90+-Miscellaneous`, plus prefix-less `Overview`.
2. **EN Toggle `Order` property** (what the code actually sorts by) — messy, with ties and values that contradict the prefixes:

| EN Toggle `Order` | Section |
|---|---|
| 3  | 20-Gathering Observations & Tracks |
| 4  | 40-Managing Data and Privacy |
| 11 | 30-Reviewing Observations & Tracks |
| 11 | 60-Exchanging Observations *(tie with Reviewing)* |
| 23 | 90+ - Miscellaneous |
| 32 | 50-Managing Projects |
| 32 | 10-Preparing to use CoMapeo *(tie; the "10-" section, but Order=32)* |
| —  | 70-Sharing, 80-Ending → no EN Toggle → fall through to 999 |
| 63 | (Overview toggle) |

`section_order` itself is a **per-page** index (1..63 across the dataset), not a per-section field — the Toggle just happens to carry whichever page-index it landed on, so using it as section rank is unreliable.

## Rendered order vs intended (prefix) order

| Pos | Rendered section | Prefix | Prefix-sorted would be |
|----|------------------|--------|------------------------|
| 1 | Overview | (none) | Overview (if first) |
| 2 | Gathering | 20 | Preparing (10) |
| 3 | Managing Data Privacy | 40 | Gathering (20) |
| 4 | Reviewing | 30 | Reviewing (30) |
| 5 | Exchanging | 60 | Managing Data (40) |
| 6 | Troubleshooting/Misc | 90 | Managing Projects (50) |
| 7 | Getting Started (Preparing) | 10 | Exchanging (60) |
| 8 | Managing Projects | 50 | Sharing (70) |
| 9 | Sharing & Exporting | 70 | Ending (80) |
| 10 | Uncategorized | (none) | Miscellaneous (90) |

7 of 10 sections are out of intended order. Order is consistent across en/es/pt (same `_category_.json` positions), so this is a generation bug, not a locale bug.

## Root cause & recommended fix

The sort keys off the EN Toggle `Order` property, whose values do not encode the intended section sequence. The intended sequence is unambiguously the **numeric name prefix**.

**Fix:** make the prefix the primary section sort key. In `getOrder` (cli/index.ts:518–524), parse the leading number from the section name (`/^(\d+)/`) and sort by it; treat prefix-less sections (`Overview`) and `Uncategorized` as the agreed bookends. Drop reliance on `sectionOrder`/Toggle `Order` for ranking (keep Toggle titles only for localized labels). This is robust except for naive string sort of multi-digit prefixes — parse the integer, don't `localeCompare`.

**Open decision (Overview placement):** prefix-less `Overview` has no number. Current build puts it first (commit `b4d0b9f`); PRD §7 wants non-numbered sections last (Overview at 9). Pick one and encode it explicitly (e.g. Overview = 0 for first, or 95 for last).
