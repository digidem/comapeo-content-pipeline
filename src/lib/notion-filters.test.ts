/**
 * Tests for buildQueryFilter (plan items 5.2, 5.7, 5.8).
 */
import { describe, it, expect } from "vitest";
import { buildQueryFilter } from "./notion-filters.js";
import { DEAD_STATUSES, NOTION_PROPERTIES } from "./notion-properties.js";
import { mapStatus } from "./status.js";

// ── 5.2 buildQueryFilter ──

describe("buildQueryFilter", () => {
  it("returns undefined when includeAll is true", () => {
    expect(buildQueryFilter({ includeAll: true })).toBeUndefined();
  });

  it("returns undefined when includeAll is true even with since", () => {
    expect(buildQueryFilter({ includeAll: true, since: "2026-01-01T00:00:00Z" })).toBeUndefined();
  });

  it("returns a filter when called with no arguments", () => {
    const filter = buildQueryFilter();
    expect(filter).toBeDefined();
  });

  // The status guard distributes the OR over the AND — one `or[is_empty, ≠value]`
  // clause per dead status — so composing with the `since` time window never
  // exceeds Notion's two-level compound-filter nesting limit.
  type OrClause = { or: Array<{ property: string; select: Record<string, unknown> }> };

  function assertStatusGuardClauses(clauses: OrClause[]) {
    expect(clauses).toHaveLength(DEAD_STATUSES.length);
    for (const deadStatus of DEAD_STATUSES) {
      const clause = clauses.find((c) =>
        c.or.some((leaf) => leaf.select.does_not_equal === deadStatus),
      );
      expect(clause, `Expected or-clause for "${deadStatus}"`).toBeDefined();
      // Each clause: is_empty branch + does_not_equal branch, both on Publish Status
      expect(clause!.or).toHaveLength(2);
      for (const leaf of clause!.or) {
        expect(leaf.property).toBe(NOTION_PROPERTIES.PUBLISH_STATUS);
      }
      expect(clause!.or.some((leaf) => leaf.select.is_empty === true)).toBe(true);
    }
  }

  it("default filter is an and of per-dead-status or-clauses", () => {
    const filter = buildQueryFilter() as { and: OrClause[] };
    expect(filter).toHaveProperty("and");
    assertStatusGuardClauses(filter.and);
  });

  it("with since: prepends last_edited_time.after to the same flat and-clause", () => {
    const since = "2026-05-01T00:00:00.000Z";
    const filter = buildQueryFilter({ since }) as { and: Array<Record<string, unknown>> };

    expect(filter.and).toHaveLength(1 + DEAD_STATUSES.length);
    expect(filter.and[0]).toMatchObject({
      timestamp: "last_edited_time",
      last_edited_time: { after: since },
    });
    assertStatusGuardClauses(filter.and.slice(1) as OrClause[]);
  });

  it("with since: null does not add time clause (returns status guard only)", () => {
    const filter = buildQueryFilter({ since: null }) as { and: Array<Record<string, unknown>> };
    expect(filter.and).toHaveLength(DEAD_STATUSES.length);
    expect(JSON.stringify(filter)).not.toContain("last_edited_time");
  });

  // Regression (2026-07-09 prod bug): the Notion API rejects compound filters
  // nested more than two levels deep. The old `and[ts, or[empty, and[…]]]`
  // shape 400'd on every cron tick. Guard the maximum compound depth directly.
  it("regression: never nests compound filters more than two levels deep", () => {
    function compoundDepth(node: unknown): number {
      if (node === null || typeof node !== "object") return 0;
      const obj = node as Record<string, unknown>;
      let depth = 0;
      for (const key of ["and", "or"]) {
        const branch = obj[key];
        if (Array.isArray(branch)) {
          depth = Math.max(depth, 1 + Math.max(0, ...branch.map(compoundDepth)));
        }
      }
      return depth;
    }
    expect(compoundDepth(buildQueryFilter())).toBeLessThanOrEqual(2);
    expect(compoundDepth(buildQueryFilter({ since: "2026-01-01T00:00:00Z" }))).toBeLessThanOrEqual(2);
  });

  // Regression guard (v3 bug): filter must NEVER mention parent/sub-item relations
  it("regression: filter JSON never contains 'Parent item'", () => {
    const filterWithSince = buildQueryFilter({ since: "2026-01-01T00:00:00Z" });
    const filterDefault = buildQueryFilter();
    expect(JSON.stringify(filterWithSince)).not.toContain("Parent item");
    expect(JSON.stringify(filterDefault)).not.toContain("Parent item");
  });

  it("regression: filter JSON never contains 'Sub-item'", () => {
    const filterWithSince = buildQueryFilter({ since: "2026-01-01T00:00:00Z" });
    const filterDefault = buildQueryFilter();
    expect(JSON.stringify(filterWithSince)).not.toContain("Sub-item");
    expect(JSON.stringify(filterDefault)).not.toContain("Sub-item");
  });
});

// ── 5.7 Status fixture: "Publish Status" property extraction → mapStatus ──

describe("Publish Status property → mapStatus (fixture 5.7)", () => {
  // Simulate extracting the select value from a Notion property object
  function extractSelectValue(prop: unknown): string | null {
    if (prop === null || prop === undefined || typeof prop !== "object") return null;
    const p = prop as { type?: string; select?: { name?: string } | null };
    if (p.select === null || p.select === undefined) return null;
    return p.select.name ?? null;
  }

  it("'Published' → status 'active'", () => {
    const property = { type: "select", select: { name: "Published" } };
    const value = extractSelectValue(property);
    expect(value).toBe("Published");
    expect(mapStatus(value)).toBe("active");
  });

  it("'Draft published' → status 'active'", () => {
    const property = { type: "select", select: { name: "Draft published" } };
    const value = extractSelectValue(property);
    expect(mapStatus(value)).toBe("active");
  });

  it("'Ready to publish' → status 'active'", () => {
    const property = { type: "select", select: { name: "Ready to publish" } };
    const value = extractSelectValue(property);
    expect(mapStatus(value)).toBe("active");
  });

  it("'Remove' → status 'deprecated'", () => {
    const property = { type: "select", select: { name: "Remove" } };
    const value = extractSelectValue(property);
    expect(value).toBe("Remove");
    expect(mapStatus(value)).toBe("deprecated");
  });

  it("'Unplublished' (Notion typo) → status 'archived' (page was live, now taken down)", () => {
    const property = { type: "select", select: { name: "Unplublished" } };
    const value = extractSelectValue(property);
    expect(mapStatus(value)).toBe("archived");
  });

  it("empty/missing Publish Status → status 'draft'", () => {
    expect(mapStatus(null)).toBe("draft");
    expect(mapStatus(undefined)).toBe("draft");
    expect(mapStatus("")).toBe("draft");
  });
});

// ── 5.8 Model-safety test ──

/**
 * Local predicate that mirrors the buildQueryFilter status guard logic:
 * a page passes if its status is null/empty OR not in DEAD_STATUSES.
 *
 * This lets us write a test-internal evaluator without calling the Notion API.
 */
function passesStatusGuard(publishStatus: string | null | undefined): boolean {
  if (!publishStatus) return true; // is_empty branch
  return !DEAD_STATUSES.includes(publishStatus as typeof DEAD_STATUSES[number]);
}

describe("Model-safety: status guard matches data model (plan 5.8)", () => {
  const containerParent = { id: "parent-id", publishStatus: null };       // placeholder, no status
  const enChild        = { id: "en-child",   publishStatus: "Published" }; // real active option
  const esChild        = { id: "es-child",   publishStatus: null };        // empty, awaiting translation
  const ptChild        = { id: "pt-child",   publishStatus: "Ready to publish" }; // real active option
  const removedChild   = { id: "removed",    publishStatus: "Remove" };    // dead

  it("container parent (empty status) passes the guard", () => {
    expect(passesStatusGuard(containerParent.publishStatus)).toBe(true);
  });

  it("en child (Published) passes the guard", () => {
    expect(passesStatusGuard(enChild.publishStatus)).toBe(true);
  });

  it("es child (empty status) passes the guard", () => {
    expect(passesStatusGuard(esChild.publishStatus)).toBe(true);
  });

  it("pt child (Ready to publish) passes the guard", () => {
    expect(passesStatusGuard(ptChild.publishStatus)).toBe(true);
  });

  it("all four live docs (parent + en + es + pt) pass the guard", () => {
    const liveDocs = [containerParent, enChild, esChild, ptChild];
    for (const doc of liveDocs) {
      expect(
        passesStatusGuard(doc.publishStatus),
        `Expected ${doc.id} (status=${doc.publishStatus ?? "null"}) to pass`,
      ).toBe(true);
    }
  });

  it("'Remove' child is excluded by the guard", () => {
    expect(passesStatusGuard(removedChild.publishStatus)).toBe(false);
  });

  it("'Unplublished' child is excluded by the guard", () => {
    expect(passesStatusGuard("Unplublished")).toBe(false);
  });

  it("guard never references Parent-item or Sub-item (v3 regression check on filter JSON)", () => {
    // The real filter from buildQueryFilter must also be clean
    const filterStr = JSON.stringify(buildQueryFilter());
    expect(filterStr).not.toContain("Parent item");
    expect(filterStr).not.toContain("Sub-item");
  });
});
