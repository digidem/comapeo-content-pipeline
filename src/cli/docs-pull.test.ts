import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { docsPull, DocsPullError } from "./docs-pull.js";

/**
 * Hermetic integration tests for docs:pull.
 *
 * Each test builds a tiny manifest + per-page markdown in a fresh temp dir,
 * runs `docsPull` (the extracted, testable entry point — no Bun/Node CLI
 * argv parsing, no process.exit), and asserts the Docusaurus tree it writes.
 * No network, no real images, no `assets/` dir (so optimizeAssets early-returns
 * and sharp is never imported). Keeps each run well under 2s.
 */

// Notion content "Page" element type — docs:pull reads element_type as an object
// (`.select.name` / `.name`); "page" passes the isContentPage gate.
const PAGE_TYPE = { select: { name: "Page" } } as const;

/** Canonical source markdown as sync:full emits it: frontmatter + body. */
function sourceMd(title: string, slug: string, position: number, body: string): string {
  return `---
title: ${title}
id: ${slug}
slug: /${slug}
sidebar_position: ${position}
---
${body}
`;
}

interface FixtureDoc {
  page_id: string;
  title: string;
  locale: string;
  section: string;
  section_order: number;
  status: string;
  slug: string;
  sub_items?: string[];
}

function buildManifest(docs: FixtureDoc[]): Record<string, unknown> {
  return {
    schema_version: "1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    source: { type: "notion", database_id: "db-id", data_source_id: "ds-id" },
    docs: docs.map((d) => ({ element_type: PAGE_TYPE, ...d })),
    sidebars: {},
  };
}

/**
 * Writes the shared fixture (6 docs across the scenarios the task requires) into
 * a fresh temp input dir and returns it together with the manifest path.
 *
 * Pages:
 *  - en-active + es-active      : EN content page with an ES translation
 *  - en-missing-es + es-missing : EN page whose ES source .md is absent (fallback case)
 *  - en-draft                   : status "draft"
 *  - en-deprecated              : status "deprecated"
 */
function buildFixture(): { inputDir: string; manifestPath: string } {
  const inputDir = mkdtempSync(join(tmpdir(), "docspull-in-"));
  temps.push(inputDir);

  const docs: FixtureDoc[] = [
    { page_id: "en-active", title: "Getting Started", locale: "en", section: "10-Getting Started", section_order: 10, status: "active", slug: "getting-started", sub_items: ["es-active"] },
    { page_id: "es-active", title: "Getting Started", locale: "es", section: "10-Getting Started", section_order: 10, status: "active", slug: "getting-started-es" },
    { page_id: "en-missing-es", title: "Configuring Devices", locale: "en", section: "20-Configuring Devices", section_order: 20, status: "active", slug: "configuring-devices", sub_items: ["es-missing"] },
    { page_id: "es-missing", title: "Configuring Devices", locale: "es", section: "20-Configuring Devices", section_order: 20, status: "active", slug: "configuring-devices-es" },
    { page_id: "en-draft", title: "Draft Page", locale: "en", section: "30-Draft Section", section_order: 30, status: "draft", slug: "draft-page" },
    { page_id: "en-deprecated", title: "Deprecated Page", locale: "en", section: "40-Deprecated", section_order: 40, status: "deprecated", slug: "deprecated-page" },
  ];

  writeFileSync(join(inputDir, "en-active.md"), sourceMd("Getting Started", "getting-started", 10, "Welcome to CoMapeo."));
  writeFileSync(join(inputDir, "es-active.md"), sourceMd("Getting Started", "getting-started-es", 10, "Bienvenido a CoMapeo."));
  writeFileSync(join(inputDir, "en-missing-es.md"), sourceMd("Configuring Devices", "configuring-devices", 20, "How to configure devices."));
  // NOTE: es-missing.md intentionally NOT written — exercises the missing-source path.
  writeFileSync(join(inputDir, "en-draft.md"), sourceMd("Draft Page", "draft-page", 30, "Draft body still being written."));
  writeFileSync(join(inputDir, "en-deprecated.md"), sourceMd("Deprecated Page", "deprecated-page", 40, "This page is deprecated."));

  const manifestPath = join(inputDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(buildManifest(docs), null, 2));
  return { inputDir, manifestPath };
}

/** Fresh empty output dir for a docs:pull run. */
function freshOut(): string {
  const out = mkdtempSync(join(tmpdir(), "docspull-out-"));
  temps.push(out);
  return out;
}

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const ES_DOCS_CURRENT = ["i18n", "es", "docusaurus-plugin-content-docs", "current"];

describe("docsPull", () => {
  it("default run: writes active EN page with frontmatter, skips draft and deprecated", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out });

    // Active EN page published under docs/<section-dir>/<slug>.md with frontmatter.
    const enPath = join(out, "docs", "getting-started", "getting-started.md");
    expect(existsSync(enPath)).toBe(true);
    const written = readFileSync(enPath, "utf8");
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toContain("title: Getting Started");
    expect(written).toContain("Welcome to CoMapeo.");

    // Draft page NOT written (isPublishableStatus("draft", false) === false).
    expect(existsSync(join(out, "docs", "draft-section", "draft-page.md"))).toBe(false);
    // Deprecated page NOT written.
    expect(existsSync(join(out, "docs", "deprecated", "deprecated-page.md"))).toBe(false);
  });

  it("--all: writes the draft page but still never writes deprecated", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true" });

    // Draft now published (--all widens the gate to drafts).
    expect(existsSync(join(out, "docs", "draft-section", "draft-page.md"))).toBe(true);
    // Deprecated is still gated out even under --all (isPublishableStatus never admits it).
    expect(existsSync(join(out, "docs", "deprecated", "deprecated-page.md"))).toBe(false);
  });

  it("publishes ES translation under i18n and emits _category_.json on both sides", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out });

    // ES translation lands at i18n/es/docusaurus-plugin-content-docs/current/<section>/<slug>.md,
    // sharing the EN slug ("getting-started") as Docusaurus i18n requires.
    const esFile = join(out, ...ES_DOCS_CURRENT, "getting-started", "getting-started.md");
    expect(existsSync(esFile)).toBe(true);

    // _category_.json emitted for the section on the docs/ (en) side…
    expect(existsSync(join(out, "docs", "getting-started", "_category_.json"))).toBe(true);
    // …and on the i18n/es side.
    expect(existsSync(join(out, ...ES_DOCS_CURRENT, "getting-started", "_category_.json"))).toBe(true);

    // The ES doc's id/slug frontmatter was rewritten to the shared EN slug.
    expect(readFileSync(esFile, "utf8")).toContain('id: "getting-started"');
  });

  it("missing ES source file: EN still publishes, ES is skipped (renderer falls back to EN)", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out });

    // The EN page publishes normally.
    expect(existsSync(join(out, "docs", "configuring-devices", "configuring-devices.md"))).toBe(true);
    // The ES counterpart has no source .md on disk: docs:pull logs
    // "Missing source file" and `continue`s, so no ES file is emitted.
    // (Docusaurus then serves the EN content under the localized route — that
    // fallback is the renderer's behaviour, not docs:pull's.)
    const esMissing = join(out, ...ES_DOCS_CURRENT, "configuring-devices", "configuring-devices.md");
    expect(existsSync(esMissing)).toBe(false);
  });

  it("--clean-orphans: removes stale .md under docs/, leaves non-managed files untouched", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    // Pre-seed a stale pipeline .md inside the managed docs/ tree.
    mkdirSync(join(out, "docs", "getting-started"), { recursive: true });
    writeFileSync(join(out, "docs", "getting-started", "stale-orphan.md"), "ghost of a deleted page");
    // Pre-seed files OUTSIDE the managed docs/ + i18n/ trees — clean-orphans
    // only walks those, so these must survive.
    mkdirSync(join(out, "extras"), { recursive: true });
    writeFileSync(join(out, "extras", "keep-me.md"), "hand-authored, not pipeline-managed");
    writeFileSync(join(out, "README-top.md"), "top-level, outside docs/");

    await docsPull({ input: manifestPath, "input-dir": inputDir, out, "clean-orphans": "true" });

    // Stale file inside the managed tree is removed.
    expect(existsSync(join(out, "docs", "getting-started", "stale-orphan.md"))).toBe(false);
    // Non-managed files are untouched (deletion is scoped to docs/ + i18n/{es,pt}).
    expect(existsSync(join(out, "extras", "keep-me.md"))).toBe(true);
    expect(existsSync(join(out, "README-top.md"))).toBe(true);
    // A legit pipeline-managed file is preserved.
    expect(existsSync(join(out, "docs", "getting-started", "getting-started.md"))).toBe(true);
  });

  it("--clean-orphans removes the stale file of a manifest doc excluded by an internal gate", async () => {
    // Regression (review round 10): expected paths were re-derived from the
    // manifest with only the status/structural gates, so a doc the emit loop
    // excludes for OTHER reasons (internal staging annotation, test pages,
    // container parents) kept its previously published file forever. Expected
    // is now exactly the set of files this run wrote.
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    // Add a manifest doc whose title carries an internal staging annotation —
    // active status, Page element, but the emit loop must skip it.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.docs.push({
      page_id: "en-staging",
      title: "Old Guide (translating for public page)",
      locale: "en",
      section: "10-Getting Started",
      section_order: 11,
      element_type: "Page",
      drafting_status: null,
      slug: "old-guide",
      docusaurus_id: "old-guide",
      docusaurus_path: "/old-guide",
      r2_doc_key: "docs/en/docs/10-Getting Started/old-guide.md",
      r2_metadata_key: "pages/en-staging/metadata.json",
      source_url: "https://notion.so/enstaging",
      notion_last_edited_time: "2026-01-01T00:00:00.000Z",
      content_hash: "sha256:staging",
      status: "active",
      sub_items: [],
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(join(inputDir, "en-staging.md"), sourceMd("Old Guide (translating for public page)", "old-guide", 11, "Internal staging content."));

    // Its previously published file sits on disk from an earlier run.
    mkdirSync(join(out, "docs", "getting-started"), { recursive: true });
    const stalePath = join(out, "docs", "getting-started", "old-guide.md");
    writeFileSync(stalePath, "previously published staging page");

    await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true", "clean-orphans": "true" });

    // The emit loop skipped it AND cleanup removed the stale file.
    expect(existsSync(stalePath)).toBe(false);
  });

  it("throws DocsPullError (not process.exit) when the manifest path does not exist", async () => {
    const { inputDir } = buildFixture();
    const out = freshOut();
    const missing = join(inputDir, "does-not-exist.json");

    await expect(
      docsPull({ input: missing, "input-dir": inputDir, out }),
    ).rejects.toBeInstanceOf(DocsPullError);
  });

  it("path-traversal inline asset: nothing escapes static/images/notion/, run does not throw", async () => {
    // Standalone fixture (needs a real assets/ dir + a file outside the pool)
    // rather than buildFixture(), which deliberately omits assets/ to keep
    // sharp unimported. Here the publish loop must run, so assets/ exists;
    // the safe asset is a .gif so optimizeAssets (png/jpg/webp only) skips it.
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-trav-in-"));
    temps.push(inputDir);
    const out = freshOut();

    mkdirSync(join(inputDir, "assets"), { recursive: true });
    writeFileSync(join(inputDir, "assets", "icon.gif"), "GIF87a-fake");
    // Sensitive file OUTSIDE the asset pool that a pre-fix read-side traversal
    // (join(assetsDir, "../evil.txt") === inputDir/evil.txt) would have read.
    writeFileSync(join(inputDir, "evil.txt"), "SECRET");

    // Markdown with a safe inline img AND a malicious traversal src.
    // Pre-fix the rewrite captured `../evil.txt`; the publish loop would then
    //   read  join(assetsDir,        "../evil.txt") = inputDir/evil.txt
    //   write join(static/images/notion, "../evil.txt") = static/images/evil.txt
    // Post-fix img-rewrite drops the traversal src, so evil.txt is never touched.
    const body =
      'Safe <img src="assets/icon.gif" alt="ok" /> and ' +
      'evil <img src="assets/../evil.txt" alt="x" />.';
    writeFileSync(join(inputDir, "trav.md"), sourceMd("Traversal Page", "trav-page", 10, body));

    const docs: FixtureDoc[] = [
      { page_id: "trav", title: "Traversal Page", locale: "en", section: "10-Trav", section_order: 10, status: "active", slug: "trav-page" },
    ];
    const manifestPath = join(inputDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(buildManifest(docs), null, 2));

    // Must not throw.
    await docsPull({ input: manifestPath, "input-dir": inputDir, out });

    // Legit inline asset still published under static/images/notion/.
    expect(existsSync(join(out, "static", "images", "notion", "icon.gif"))).toBe(true);
    // Traversal write blocked: evil.txt did NOT escape one dir above notion.
    expect(existsSync(join(out, "static", "images", "evil.txt"))).toBe(false);
    // Nor land anywhere else under out/.
    expect(existsSync(join(out, "evil.txt"))).toBe(false);
  });
});
