/**
 * Map a Notion Publish Status select value to a standardized content status.
 *
 * Source of truth: live Notion DB schema for the CoMapeo content database,
 * confirmed 2026-07-01. Old-system production semantics (comapeo-docs pipeline):
 * only "Ready to publish" was pulled; after staging deploy it was rewritten to
 * "Draft published"; after production deploy to "Published". This pipeline is
 * stateless (no write-back), so every post-editorial-gate state must map to
 * active, or previously published pages would vanish on re-sync.
 *
 * Strategy (two-phase):
 * 1. Exact case-insensitive match against LIVE_STATUS_MAP covering all 13 known
 *    live values → their canonical mapping.
 * 2. Fallback regex patterns for unknown/legacy/renamed values so the old test
 *    corpus ("EN Done", "X - Depreciated", etc.) keeps working.
 */

type ContentStatus = "active" | "draft" | "deprecated" | "archived";

/**
 * Exact case-insensitive lookup for all 13 known live Notion Publish Status
 * values (confirmed 2026-07-01). Keys are lowercased for matching; the original
 * Notion values appear verbatim in the comments.
 *
 * active     — page is published or cleared for publishing
 * draft      — pre-publication editorial state; page should not be emitted
 * deprecated — explicit removal request ("Remove")
 * archived   — page was previously live but has been taken down
 *              "Unplublished" is a real Notion typo; both spellings are handled.
 */
const LIVE_STATUS_MAP: Readonly<Record<string, ContentStatus>> = {
  // active
  "ready to publish": "active",        // "Ready to publish"
  "adding to staging site": "active",  // "Adding to staging site"
  "draft published": "active",         // "Draft published"
  published: "active",                 // "Published"
  // draft
  "not started": "draft",                              // "Not started"
  "update in progress": "draft",                       // "Update in progress"
  "ready for translation": "draft",                    // "Ready for translation"
  "automated translation in progress": "draft",        // "Automated translation in progress"
  "automated translations generated": "draft",         // "Automated translations generated"
  "auto translation generated": "draft",               // "Auto translation generated"
  "reviewing translations": "draft",                   // "Reviewing translations"
  // deprecated — explicit removal request
  remove: "deprecated",         // "Remove"
  // archived — page was live, now taken down
  unplublished: "archived",     // "Unplublished" — real Notion typo, kept verbatim
  unpublished: "archived",      // "Unpublished"  — corrected spelling
};

// ── Fallback patterns for unknown/legacy/renamed values ──
// These were the primary classification before the exact map was introduced.
// Order: deleted/archived → deprecated → active → draft.
//
// /unpl?ublished/i lives here in DELETED_PATTERNS (→ archived) rather than in
// DEPRECATED_PATTERNS so it cannot be shadowed by ACTIVE's /published/i when
// a casing variant isn't covered by the exact map.

const DELETED_PATTERNS = [
  /deleted/i,
  /inaccessible/i,
  // Covers "Unplublished" (Notion typo) and "Unpublished" (correct spelling)
  // as a safety net for casing variants not in LIVE_STATUS_MAP.
  /unpl?ublished/i,
];

const DEPRECATED_PATTERNS = [
  /depreciated/i,
  /deprecated/i,
  /archive/i,
  /archived/i,
  /remove/i,
];

const ACTIVE_PATTERNS = [
  /done/i,
  /validated/i,
  /pre-publish/i,
  /published/i,
  /ready to publish/i,
  /ready-to-publish/i,
];

const DRAFT_PATTERNS = [
  /not started/i,
  /editing/i,
  /in progress/i,
  /ready for review/i,
  /ready for copy edit/i,
  /ready-for-review/i,
  /ready-for-copy-edit/i,
];

export function mapStatus(notionStatus: string | null | undefined): ContentStatus {
  if (!notionStatus) return "draft";

  const trimmed = notionStatus.trim();

  // Phase 1: exact case-insensitive lookup against the live schema values.
  const exact = LIVE_STATUS_MAP[trimmed.toLowerCase()];
  if (exact !== undefined) return exact;

  // Phase 2: regex fallback for unknown/legacy/renamed values.
  if (DELETED_PATTERNS.some((p) => p.test(trimmed))) return "archived";
  if (DEPRECATED_PATTERNS.some((p) => p.test(trimmed))) return "deprecated";
  if (ACTIVE_PATTERNS.some((p) => p.test(trimmed))) return "active";
  if (DRAFT_PATTERNS.some((p) => p.test(trimmed))) return "draft";

  // Default: treat unknown status as draft
  return "draft";
}

export type { ContentStatus };
