import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateCmd,
  diffCmd,
  diffMetadata,
  ValidationError,
  type DiffPageFetcher,
} from "./validate-diff.js";

/**
 * Hermetic tests for the validate / diff commands.
 *
 * Each test builds a tiny manifest (or stored metadata blob) in a fresh temp
 * dir, runs the extracted entry points (no argv parsing, no process.exit), and
 * asserts real behavior. No network — diff's Notion fetch is injected.
 *
 * What the commands actually read:
 *  - validate: the manifest file only (ad-hoc checks on schema_version + each
 *    doc's slug / page_id / content_hash; it does NOT touch metadata blobs or
 *    chunk files, and does not run the Zod schema).
 *  - diff: a live page fetch (injected) compared field-by-field against the
 *    stored `<page_id>.metadata.json`.
 */

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Fresh temp dir tracked for afterEach cleanup. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

interface FixtureDoc {
  page_id?: string;
  slug?: string;
  content_hash?: string;
  title?: string;
}

/** Write a manifest with the given docs to a temp file and return its path. */
function writeManifest(docs: FixtureDoc[], overrides: Record<string, unknown> = {}): string {
  const dir = tempDir("validate-in-");
  const manifest = {
    schema_version: "1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    source: { type: "notion", database_id: "db", data_source_id: "ds" },
    docs,
    sidebars: {},
    ...overrides,
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

/** A well-formed two-doc manifest that validateCmd accepts. */
function validDocs(): FixtureDoc[] {
  return [
    { page_id: "p1", slug: "intro", content_hash: "hash-1", title: "Intro" },
    { page_id: "p2", slug: "config", content_hash: "hash-2", title: "Config" },
  ];
}

/** Minimal live-metadata object diff compares against. */
function metadata(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Getting Started",
    content_hash: "hash-live",
    status: "active",
    notion_last_edited_time: "2026-02-01T00:00:00.000Z",
    ...over,
  };
}

/** Injected fetcher returning a fixed live page (no network). */
function stubFetcher(live: Record<string, unknown>): DiffPageFetcher {
  return async () => ({ metadata: live });
}

/** Collect console.log lines into an array while the callback runs. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    const out = await fn();
    return { out, lines };
  } finally {
    spy.mockRestore();
  }
}

// ── validate ──

describe("validateCmd", () => {
  it("resolves on a valid manifest and logs the success line", async () => {
    const manifestPath = writeManifest(validDocs());
    const { lines } = await captureLog(() => validateCmd({ input: manifestPath }));

    expect(lines).toContain("✓ Valid manifest with 2 docs");
  });

  it("throws ValidationError naming the failure on a schema-version mismatch", async () => {
    const manifestPath = writeManifest(validDocs(), { schema_version: "2.0" });

    await expect(validateCmd({ input: manifestPath })).rejects.toSatisfy((err: unknown) => {
      return err instanceof ValidationError && /Unsupported schema version: 2\.0/.test(err.message);
    });
  });

  it("throws ValidationError naming a doc missing content_hash", async () => {
    const manifestPath = writeManifest([
      { page_id: "p1", slug: "intro", content_hash: "hash-1", title: "Intro" },
      { page_id: "p2", slug: "config", title: "Config" }, // no content_hash
    ]);

    await expect(validateCmd({ input: manifestPath })).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ValidationError && /Missing content_hash for: Config/.test(err.message)
      );
    });
  });

  it("throws ValidationError on a duplicate slug", async () => {
    const manifestPath = writeManifest([
      { page_id: "p1", slug: "intro", content_hash: "h1", title: "Intro" },
      { page_id: "p2", slug: "intro", content_hash: "h2", title: "Intro Again" },
    ]);

    await expect(validateCmd({ input: manifestPath })).rejects.toSatisfy((err: unknown) => {
      return err instanceof ValidationError && /Duplicate slug: intro/.test(err.message);
    });
  });

  it("lists multiple failures in one message", async () => {
    const manifestPath = writeManifest(validDocs(), { schema_version: "0.9" });

    await expect(validateCmd({ input: manifestPath })).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ValidationError &&
        /1 validation errors:/.test(err.message) &&
        /Unsupported schema version: 0\.9/.test(err.message)
      );
    });
  });

  it("throws ValidationError (not process.exit) when the input path is missing", async () => {
    const missing = join(tempDir("validate-in-"), "nope.json");

    await expect(validateCmd({ input: missing })).rejects.toBeInstanceOf(ValidationError);
  });
});

// ── diffMetadata (pure helper) ──

describe("diffMetadata", () => {
  it("returns no changes for identical metadata", () => {
    const m = metadata();
    expect(diffMetadata(m, m)).toEqual([]);
  });

  it("reports a changed content_hash", () => {
    const stored = metadata({ content_hash: "old-hash" });
    const current = metadata({ content_hash: "new-hash" });

    expect(diffMetadata(stored, current)).toEqual([
      { label: "content_hash", old: "old-hash", cur: "new-hash" },
    ]);
  });

  it("reports every changed field, in display order", () => {
    const stored = metadata({
      title: "Old Title",
      content_hash: "old",
      status: "draft",
      notion_last_edited_time: "2026-01-01T00:00:00.000Z",
    });
    const current = metadata({
      title: "New Title",
      content_hash: "new",
      status: "active",
      notion_last_edited_time: "2026-02-01T00:00:00.000Z",
    });

    expect(diffMetadata(stored, current)).toEqual([
      { label: "title", old: "Old Title", cur: "New Title" },
      { label: "content_hash", old: "old", cur: "new" },
      { label: "status", old: "draft", cur: "active" },
      { label: "last_edited", old: "2026-01-01T00:00:00.000Z", cur: "2026-02-01T00:00:00.000Z" },
    ]);
  });

  it("coerces a missing stored field to empty string", () => {
    const stored: Record<string, unknown> = { title: "T", content_hash: "h", status: "active" };
    const current = metadata();

    // stored has no notion_last_edited_time → old coerces to ""; current has one.
    const changes = diffMetadata(stored, current);
    expect(changes.map((c) => c.label)).toContain("last_edited");
    expect(changes.find((c) => c.label === "last_edited")).toEqual({
      label: "last_edited",
      old: "",
      cur: "2026-02-01T00:00:00.000Z",
    });
  });
});

// ── diffCmd (injected fetch, no network) ──

describe("diffCmd", () => {
  it("throws ValidationError (not process.exit) when no page is given", async () => {
    await expect(diffCmd({}, stubFetcher(metadata()))).rejects.toSatisfy((err: unknown) => {
      return err instanceof ValidationError && /Usage: pnpm pipeline diff --page/.test(err.message);
    });
  });

  it("wraps a fetch failure in a ValidationError", async () => {
    const fail: DiffPageFetcher = async () => {
      throw new Error("network down");
    };

    await expect(diffCmd({ page: "p1" }, fail)).rejects.toSatisfy((err: unknown) => {
      return err instanceof ValidationError && /Failed to fetch page:/.test(err.message);
    });
  });

  it("reports 'No stored metadata found' when nothing is stored on disk", async () => {
    const out = tempDir("diff-out-"); // empty — no <page>.metadata.json

    const { lines } = await captureLog(() =>
      diffCmd({ page: "p1", out }, stubFetcher(metadata())),
    );

    expect(lines.some((l) => l.includes("No stored metadata found at:"))).toBe(true);
    expect(lines.some((l) => l.includes("Title: Getting Started"))).toBe(true);
  });

  it("detects a changed content_hash against stored metadata", async () => {
    const dir = tempDir("diff-out-");
    writeFileSync(
      join(dir, "p1.metadata.json"),
      JSON.stringify(metadata({ content_hash: "old-hash", status: "draft" }), null, 2),
    );

    const { lines } = await captureLog(() =>
      diffCmd(
        { page: "p1", out: dir },
        stubFetcher(metadata({ content_hash: "new-hash", status: "active" })),
      ),
    );

    expect(lines.some((l) => l.includes("Changes:"))).toBe(true);
    expect(lines.some((l) => l.includes('content_hash: "old-hash" → "new-hash"'))).toBe(true);
    expect(lines.some((l) => l.includes('status: "draft" → "active"'))).toBe(true);
    expect(lines.some((l) => l.includes("No changes detected"))).toBe(false);
  });

  it("reports no changes when stored metadata matches the live page", async () => {
    const dir = tempDir("diff-out-");
    const live = metadata();
    writeFileSync(join(dir, "p1.metadata.json"), JSON.stringify(live, null, 2));

    const { lines } = await captureLog(() =>
      diffCmd({ page: "p1", out: dir }, stubFetcher(live)),
    );

    expect(lines.some((l) => l.includes("No changes detected"))).toBe(true);
    expect(lines.some((l) => l.includes("Changes:"))).toBe(false);
  });

  it("throws ValidationError when stored metadata is unparseable", async () => {
    const dir = tempDir("diff-out-");
    writeFileSync(join(dir, "p1.metadata.json"), "{ not valid json");

    await expect(
      diffCmd({ page: "p1", out: dir }, stubFetcher(metadata())),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ValidationError &&
        /Failed to parse stored metadata:/.test(err.message)
      );
    });
  });
});
