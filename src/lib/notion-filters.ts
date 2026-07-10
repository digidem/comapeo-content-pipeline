/**
 * Filter builders for Notion API queries.
 *
 * Centralizes the logic for constructing status-guard and time-window filters,
 * keeping them in one place so callers (CLI, Worker cron) stay consistent.
 */

import { NOTION_PROPERTIES, DEAD_STATUSES } from "./notion-properties.js";

/**
 * Build a Notion API query filter suitable for `NotionClient.queryDatabase()`.
 *
 * Default behavior: exclude pages whose Publish Status is in DEAD_STATUSES,
 * while keeping all empty-status rows (container parents, untranslated children).
 *
 * @param options.includeAll - When true, returns undefined (no filter → fetch all rows).
 * @param options.since      - When provided, wraps the status guard with a
 *                             `last_edited_time.after` time window.
 *
 * Implementation note: the status guard is exclusion-based (keep rows whose
 * status is empty OR not a dead value) rather than enumerating active values,
 * so any new "live" status name is automatically included.
 * Never references "Parent item" or "Sub-item" — all rows (containers + children)
 * must pass through for the docs:pull emit logic to work correctly.
 *
 * Nesting constraint: the Notion API rejects compound filters nested more than
 * two levels deep. The naive shape `and[ts, or[empty, and[not-dead…]]]` is
 * three levels and returns a 400 validation error (this silently broke the
 * Worker cron in production). So the guard distributes the OR over the AND:
 * `(empty OR (¬A AND ¬B)) ≡ ((empty OR ¬A) AND (empty OR ¬B))`, giving a flat
 * `and` of two-level `or` clauses that composes with the time window without
 * exceeding the limit.
 */
export function buildQueryFilter(options?: {
  includeAll?: boolean;
  since?: string | null;
}): Record<string, unknown> | undefined {
  if (options?.includeAll) return undefined;

  // One clause per dead value: keep the row if its status is empty or ≠ value.
  const statusGuards: Array<Record<string, unknown>> = DEAD_STATUSES.map((v) => ({
    or: [
      {
        property: NOTION_PROPERTIES.PUBLISH_STATUS,
        select: { is_empty: true },
      },
      {
        property: NOTION_PROPERTIES.PUBLISH_STATUS,
        select: { does_not_equal: v },
      },
    ],
  }));

  if (options?.since) {
    // Prepend a time-window filter so the cron only re-processes pages edited
    // after the watermark.
    return {
      and: [
        {
          timestamp: "last_edited_time",
          last_edited_time: { after: options.since },
        },
        ...statusGuards,
      ],
    };
  }

  return statusGuards.length === 1 ? statusGuards[0] : { and: statusGuards };
}
