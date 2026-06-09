/**
 * Map Notion editorial status to standardized content status.
 *
 * Per spec §9.4:
 *   EN Done / PT Done / ES Done / Translations Validated / Pre-publish done → active
 *   Not started / Editing in progress / Ready for review / Ready for copy edit → draft
 *   X - Depreciated / deprecated / archive / archived → deprecated
 *   Deleted / inaccessible → archived
 */

type ContentStatus = "active" | "draft" | "deprecated" | "archived";

const ACTIVE_PATTERNS = [
  /done/i,
  /validated/i,
  /pre-publish/i,
  /published/i,
  /ready to publish/i,
  /ready-to-publish/i,
];

const DEPRECATED_PATTERNS = [
  /depreciated/i,
  /deprecated/i,
  /archive/i,
  /archived/i,
];

const DELETED_PATTERNS = [
  /deleted/i,
  /inaccessible/i,
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

  if (DELETED_PATTERNS.some((p) => p.test(trimmed))) return "archived";
  if (DEPRECATED_PATTERNS.some((p) => p.test(trimmed))) return "deprecated";
  if (ACTIVE_PATTERNS.some((p) => p.test(trimmed))) return "active";
  if (DRAFT_PATTERNS.some((p) => p.test(trimmed))) return "draft";

  // Default: treat unknown status as draft
  return "draft";
}

export type { ContentStatus };
