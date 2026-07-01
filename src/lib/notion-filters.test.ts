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

  it("default filter has or-clause at top level", () => {
    const filter = buildQueryFilter() as Record<string, unknown>;
    expect(filter).toHaveProperty("or");
    expect(Array.isArray(filter.or)).toBe(true);
  });

  it("default filter or-clause includes is_empty branch for Publish Status", () => {
    const filter = buildQueryFilter() as { or: Array<Record<string, unknown>> };
    const isEmptyBranch = filter.or.find(
      (clause) =>
        typeof clause === "object" &&
        "property" in clause &&
        clause.property === NOTION_PROPERTIES.PUBLISH_STATUS &&
        typeof clause.select === "object" &&
        clause.select !== null &&
        "is_empty" in (clause.select as object),
    );
    expect(isEmptyBranch).toBeDefined();
  });

  it("default filter or-clause includes and-of-does_not_equal for each DEAD_STATUSES value", () => {
    const filter = buildQueryFilter() as { or: Array<Record<string, unknown>> };
    const andBranch = filter.or.find(
      (clause) => typeof clause === "object" && "and" in clause,
    ) as { and: Array<{ property: string; select: { does_not_equal: string } }> } | undefined;

    expect(andBranch).toBeDefined();
    expect(andBranch!.and).toHaveLength(DEAD_STATUSES.length);

    for (const deadStatus of DEAD_STATUSES) {
      const clause = andBranch!.and.find((c) => c.select.does_not_equal === deadStatus);
      expect(
        clause,
        `Expected does_not_equal clause for "${deadStatus}"`,
      ).toBeDefined();
      expect(clause!.property).toBe(NOTION_PROPERTIES.PUBLISH_STATUS);
    }
  });

  it("with since: wraps status guard in and-clause with last_edited_time.after", () => {
    const since = "2026-05-01T00:00:00.000Z";
    const filter = buildQueryFilter({ since }) as { and: Array<Record<string, unknown>> };

    expect(filter).toHaveProperty("and");
    expect(Array.isArray(filter.and)).toBe(true);
    expect(filter.and).toHaveLength(2);

    // First element: time window
    const timeClause = filter.and[0];
    expect(timeClause).toMatchObject({
      timestamp: "last_edited_time",
      last_edited_time: { after: since },
    });

    // Second element: the status guard (or-clause)
    const statusGuard = filter.and[1] as { or: unknown[] };
    expect(statusGuard).toHaveProperty("or");
    expect(Array.isArray(statusGuard.or)).toBe(true);
  });

  it("with since: null does not add time clause (returns status guard only)", () => {
    const filter = buildQueryFilter({ since: null });
    expect(filter).not.toHaveProperty("and");
    expect(filter).toHaveProperty("or");
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

  it("'Unplublished' (Notion typo) → status 'deprecated'", () => {
    const property = { type: "select", select: { name: "Unplublished" } };
    const value = extractSelectValue(property);
    expect(mapStatus(value)).toBe("deprecated");
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
