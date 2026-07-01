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
 * Implementation note: the status guard uses an `or` of `is_empty` + an `and`
 * of `does_not_equal` clauses (exclusion-based) rather than enumerating active
 * values, so any new "live" status name is automatically included.
 * Never references "Parent item" or "Sub-item" — all rows (containers + children)
 * must pass through for the docs:pull emit logic to work correctly.
 */
export function buildQueryFilter(options?: {
  includeAll?: boolean;
  since?: string | null;
}): Record<string, unknown> | undefined {
  if (options?.includeAll) return undefined;

  // Keep pages whose status is empty OR is not one of the dead values.
  const statusGuard: Record<string, unknown> = {
    or: [
      {
        property: NOTION_PROPERTIES.PUBLISH_STATUS,
        select: { is_empty: true },
      },
      {
        and: DEAD_STATUSES.map((v) => ({
          property: NOTION_PROPERTIES.PUBLISH_STATUS,
          select: { does_not_equal: v },
        })),
      },
    ],
  };

  if (options?.since) {
    // Wrap the status guard with a time-window filter so the cron only re-processes
    // pages edited after the watermark.
    return {
      and: [
        {
          timestamp: "last_edited_time",
          last_edited_time: { after: options.since },
        },
        statusGuard,
      ],
    };
  }

  return statusGuard;
}
