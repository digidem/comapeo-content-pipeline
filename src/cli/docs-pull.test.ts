import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { docsPull, DocsPullError } from "./docs-pull.js";

/**
 * Hermetic integration tests for docs:pull.
 *
 * Each test builds a tiny manifest + per-page markdown in a fresh temp dir,
 * runs `docsPull`, and asserts the Docusaurus tree it writes.
 * No network, no real images, no `assets/` dir.
 */

const PAGE_TYPE = { select: { name: "Page" } } as const;
const TOGGLE_TYPE = { select: { name: "Toggle" } } as const;
const TITLE_TYPE = { select: { name: "Title" } } as const;

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
  element_type?: unknown;
}

function buildManifest(docs: FixtureDoc[]): Record<string, unknown> {
  return {
    schema_version: "1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    source: { type: "notion", database_id: "db-id", data_source_id: "ds-id" },
    docs: docs.map((d) => {
      const et = d.element_type ?? PAGE_TYPE;
      const { element_type: _et, ...rest } = d;
      return { element_type: et, ...rest };
    }),
    sidebars: {},
  };
}

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
  writeFileSync(join(inputDir, "en-draft.md"), sourceMd("Draft Page", "draft-page", 30, "Draft body still being written."));
  writeFileSync(join(inputDir, "en-deprecated.md"), sourceMd("Deprecated Page", "deprecated-page", 40, "This page is deprecated."));

  const manifestPath = join(inputDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(buildManifest(docs), null, 2));
  return { inputDir, manifestPath };
}

function freshOut(): string {
  const out = mkdtempSync(join(tmpdir(), "docspull-out-"));
  temps.push(out);
  return out;
}

function readdirSyncRecursive(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readdirSyncRecursive(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const ES_DOCS_CURRENT = ["i18n", "es", "docusaurus-plugin-content-docs", "current"];
const PT_DOCS_CURRENT = ["i18n", "pt", "docusaurus-plugin-content-docs", "current"];

describe("docsPull", () => {
  // ── Original baseline tests ──

  it("default run: writes active EN page with frontmatter, skips draft and deprecated", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out });

    const enPath = join(out, "docs", "getting-started", "getting-started.md");
    expect(existsSync(enPath)).toBe(true);
    const written = readFileSync(enPath, "utf8");
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toContain("title: Getting Started");
    expect(written).toContain("Welcome to CoMapeo.");

    expect(existsSync(join(out, "docs", "draft-section", "draft-page.md"))).toBe(false);
    expect(existsSync(join(out, "docs", "deprecated", "deprecated-page.md"))).toBe(false);
  });

  it("--all: writes the draft page but still never writes deprecated", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true" });

    expect(existsSync(join(out, "docs", "draft-section", "draft-page.md"))).toBe(true);
    expect(existsSync(join(out, "docs", "deprecated", "deprecated-page.md"))).toBe(false);
  });

  it("publishes ES translation under i18n and emits _category_.json on both sides", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out });

    const esFile = join(out, ...ES_DOCS_CURRENT, "getting-started", "getting-started.md");
    expect(existsSync(esFile)).toBe(true);

    expect(existsSync(join(out, "docs", "getting-started", "_category_.json"))).toBe(true);
    expect(existsSync(join(out, ...ES_DOCS_CURRENT, "getting-started", "_category_.json"))).toBe(true);

    expect(readFileSync(esFile, "utf8")).toContain('id: "getting-started"');
  });

  it("missing ES source file: EN still publishes, ES is skipped", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out });

    expect(existsSync(join(out, "docs", "configuring-devices", "configuring-devices.md"))).toBe(true);
    const esMissing = join(out, ...ES_DOCS_CURRENT, "configuring-devices", "configuring-devices.md");
    expect(existsSync(esMissing)).toBe(false);
  });

  it("--clean-orphans: removes stale .md under docs/, leaves non-managed files untouched", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    mkdirSync(join(out, "docs", "getting-started"), { recursive: true });
    writeFileSync(join(out, "docs", "getting-started", "stale-orphan.md"), "ghost of a deleted page");
    mkdirSync(join(out, "extras"), { recursive: true });
    writeFileSync(join(out, "extras", "keep-me.md"), "hand-authored");
    writeFileSync(join(out, "README-top.md"), "top-level, outside docs/");

    await docsPull({ input: manifestPath, "input-dir": inputDir, out, "clean-orphans": "true" });

    expect(existsSync(join(out, "docs", "getting-started", "stale-orphan.md"))).toBe(false);
    expect(existsSync(join(out, "extras", "keep-me.md"))).toBe(true);
    expect(existsSync(join(out, "README-top.md"))).toBe(true);
    expect(existsSync(join(out, "docs", "getting-started", "getting-started.md"))).toBe(true);
  });

  it("--clean-orphans removes the stale file of a manifest doc excluded by an internal gate", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

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

    mkdirSync(join(out, "docs", "getting-started"), { recursive: true });
    const stalePath = join(out, "docs", "getting-started", "old-guide.md");
    writeFileSync(stalePath, "previously published staging page");

    await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true", "clean-orphans": "true" });

    expect(existsSync(stalePath)).toBe(false);
  });

  it("throws DocsPullError when the manifest path does not exist", async () => {
    const { inputDir } = buildFixture();
    const out = freshOut();
    const missing = join(inputDir, "does-not-exist.json");

    await expect(
      docsPull({ input: missing, "input-dir": inputDir, out }),
    ).rejects.toBeInstanceOf(DocsPullError);
  });

  it("path-traversal inline asset: nothing escapes static/images/notion/", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-trav-in-"));
    temps.push(inputDir);
    const out = freshOut();

    mkdirSync(join(inputDir, "assets"), { recursive: true });
    writeFileSync(join(inputDir, "assets", "icon.gif"), "GIF87a-fake");
    writeFileSync(join(inputDir, "evil.txt"), "SECRET");

    const body =
      'Safe <img src="assets/icon.gif" alt="ok" /> and ' +
      'evil <img src="assets/../evil.txt" alt="x" />.';
    writeFileSync(join(inputDir, "trav.md"), sourceMd("Traversal Page", "trav-page", 10, body));

    const docs: FixtureDoc[] = [
      { page_id: "trav", title: "Traversal Page", locale: "en", section: "10-Trav", section_order: 10, status: "active", slug: "trav-page" },
    ];
    const manifestPath = join(inputDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(buildManifest(docs), null, 2));

    await docsPull({ input: manifestPath, "input-dir": inputDir, out });

    expect(existsSync(join(out, "static", "images", "notion", "icon.gif"))).toBe(true);
    expect(existsSync(join(out, "static", "images", "evil.txt"))).toBe(false);
    expect(existsSync(join(out, "evil.txt"))).toBe(false);
  });

  // ── New hierarchy tests ──

  it("P0: EN container canonical slug comes from container title, not EN child (no route drift)", async () => {
    // Regression: EN child title "Changing Backgroud Maps" (typo) must NOT
    // override the canonical container slug "changing-background-maps".
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-p0-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "en-container", title: "Changing Background Maps", locale: "en", section: "10-Basics", section_order: 10, status: "active", slug: "container-slug", sub_items: ["en-child", "es-child"] },
      { page_id: "en-child", title: "Changing Backgroud Maps", locale: "en", section: "10-Basics", section_order: 10, status: "active", slug: "changing-backgroud-maps", element_type: PAGE_TYPE },
      { page_id: "es-child", title: "Cambiando Mapas", locale: "es", section: "10-Basics", section_order: 10, status: "active", slug: "cambiando-mapas", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-container.md"), sourceMd("Changing Background Maps", "container-slug", 10, "EN content."));
    writeFileSync(join(inputDir, "en-child.md"), sourceMd("Changing Backgroud Maps", "changing-backgroud-maps", 10, "EN child content."));
    writeFileSync(join(inputDir, "es-child.md"), sourceMd("Cambiando Mapas", "cambiando-mapas", 10, "ES content."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // EN page uses container's title slug "changing-background-maps", NOT "changing-backgroud-maps"
    const enPath = join(out, "docs", "basics", "changing-background-maps.md");
    expect(existsSync(enPath)).toBe(true);
    const enContent = readFileSync(enPath, "utf8");
    expect(enContent).toContain('id: "changing-background-maps"');
    expect(enContent).toContain("slug: /changing-background-maps");

    // ES translation also uses canonical slug
    const esPath = join(out, ...ES_DOCS_CURRENT, "basics", "changing-background-maps.md");
    expect(existsSync(esPath)).toBe(true);
    expect(readFileSync(esPath, "utf8")).toContain('id: "changing-background-maps"');
  });

  it("P1: Title row sets customProps.title on the next Toggle category (Title→Toggle)", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-tt-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "title-en-parent", title: "Preparing to Use CoMapeo", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "t-en-p", sub_items: ["title-es"], element_type: TITLE_TYPE },
      { page_id: "title-es", title: "Preparación para usar CoMapeo", locale: "es", section: null as unknown as string, section_order: 99, status: "active", slug: "t-es", element_type: TITLE_TYPE },
      { page_id: "toggle-en-parent", title: "Customizing CoMapeo", locale: "en", section: "10-Basics", section_order: 2, status: "active", slug: "toggle-en-p", sub_items: ["toggle-es"], element_type: TOGGLE_TYPE },
      { page_id: "toggle-es", title: "Personaliza CoMapeo", locale: "es", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-es", element_type: TOGGLE_TYPE },
      { page_id: "en-page", title: "Custom Categories", locale: "en", section: "10-Basics", section_order: 3, status: "active", slug: "custom-categories", element_type: PAGE_TYPE },
      { page_id: "es-page", title: "Categorías Personalizadas", locale: "es", section: "10-Basics", section_order: 3, status: "active", slug: "categorias-es", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-page.md"), sourceMd("Custom Categories", "custom-categories", 3, "Content."));
    writeFileSync(join(inputDir, "es-page.md"), sourceMd("Categorías Personalizadas", "categorias-es", 3, "Contenido ES."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Toggle creates a nested category with its title as label
    const enCatPath = join(out, "docs", "basics", "customizing-comapeo", "_category_.json");
    const enCat = JSON.parse(readFileSync(enCatPath, "utf8"));
    expect(enCat.label).toBe("Customizing CoMapeo");
    // Custom props title comes from the Title row
    expect(enCat.customProps.title).toBe("Preparing to Use CoMapeo");

    // ES side: Toggle "Personaliza CoMapeo" gets customProps.title from ES Title
    const esCatPath = join(out, ...ES_DOCS_CURRENT, "basics", "customizing-comapeo", "_category_.json");
    const esCat = JSON.parse(readFileSync(esCatPath, "utf8"));
    expect(esCat.label).toBe("Personaliza CoMapeo");
    expect(esCat.customProps.title).toBe("Preparación para usar CoMapeo");

    // Page is inside the Toggle directory
    expect(existsSync(join(out, "docs", "basics", "customizing-comapeo", "custom-categories.md"))).toBe(true);
  });

  it("P1: Title row before a Page (no Toggle) injects sidebar_custom_props.title", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-tp-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "title-en-parent", title: "Site Map Title", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "t-p", sub_items: ["title-es"], element_type: TITLE_TYPE },
      { page_id: "title-es", title: "Título del Mapa", locale: "es", section: null as unknown as string, section_order: 99, status: "active", slug: "t-es", element_type: TITLE_TYPE },
      { page_id: "en-page", title: "Site Map", locale: "en", section: "10-Basics", section_order: 2, status: "active", slug: "site-map", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-page.md"), sourceMd("Site Map", "site-map", 2, "Content."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Page is emitted at its section dir (Title resets Toggle context, page goes to section root)
    expect(existsSync(join(out, "docs", "basics", "site-map.md"))).toBe(true);
  });

  it("P1: Structural families resolve null child section through parent relation (not coincidental order)", async () => {
    // PT Toggle child has section=null and DIFFERENT order (42) from parent (44).
    // It should inherit parent's section=10 and order=44, NOT match by coincidental 42==42.
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-family-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "toggle-en-parent", title: "Getting Started Essentials", locale: "en", section: "10-Basics", section_order: 44, status: "active", slug: "t-en-p", sub_items: ["toggle-pt"], element_type: TOGGLE_TYPE },
      { page_id: "toggle-pt", title: "Introdução - Noções básicas", locale: "pt", section: null as unknown as string, section_order: 42, status: "active", slug: "toggle-pt", element_type: TOGGLE_TYPE },
      { page_id: "en-page", title: "Basic Setup", locale: "en", section: "10-Basics", section_order: 45, status: "active", slug: "basic-setup", element_type: PAGE_TYPE },
      { page_id: "pt-page", title: "Configuração Básica", locale: "pt", section: "10-Basics", section_order: 45, status: "active", slug: "config-basica", element_type: PAGE_TYPE },
    ];

    // Keep pt-page as standalone content page in same section
    const m = buildManifest(docs) as Record<string, unknown>;
    (m.docs as Array<Record<string, unknown>>)[0].element_type = TOGGLE_TYPE;
    (m.docs as Array<Record<string, unknown>>)[1].element_type = TOGGLE_TYPE;
    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(m, null, 2));
    writeFileSync(join(inputDir, "en-page.md"), sourceMd("Basic Setup", "basic-setup", 45, "Content."));
    writeFileSync(join(inputDir, "pt-page.md"), sourceMd("Configuração Básica", "config-basica", 45, "Conteúdo."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // PT category exists under the EN section + toggle dir ("basics/getting-started-essentials")
    const ptCatPath = join(out, ...PT_DOCS_CURRENT, "basics", "getting-started-essentials", "_category_.json");
    expect(existsSync(ptCatPath)).toBe(true);
    const ptCat = JSON.parse(readFileSync(ptCatPath, "utf8"));
    expect(ptCat.label).toBe("Introdução - Noções básicas");
  });

  it("P1: Two Toggles in one broad section produce separate nested category files", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-two-tog-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "toggle-en-a", title: "Customizing CoMapeo", locale: "en", section: "10-Basics", section_order: 42, status: "active", slug: "t-en-a", sub_items: ["toggle-es-a"], element_type: TOGGLE_TYPE },
      { page_id: "toggle-es-a", title: "Personaliza CoMapeo", locale: "es", section: null as unknown as string, section_order: 41, status: "active", slug: "t-es-a", element_type: TOGGLE_TYPE },
      { page_id: "toggle-en-b", title: "Getting Started Essentials", locale: "en", section: "10-Basics", section_order: 44, status: "active", slug: "t-en-b", sub_items: ["toggle-es-b"], element_type: TOGGLE_TYPE },
      { page_id: "toggle-es-b", title: "Introducción - Conceptos básicos", locale: "es", section: null as unknown as string, section_order: 36, status: "active", slug: "t-es-b", element_type: TOGGLE_TYPE },
      // EN content family A with ES child (order 43, inside first Toggle)
      { page_id: "en-page-a", title: "Custom Categories", locale: "en", section: "10-Basics", section_order: 43, status: "active", slug: "custom-categories", sub_items: ["es-page-a"], element_type: PAGE_TYPE },
      { page_id: "es-page-a", title: "Categorías Personalizadas", locale: "es", section: "10-Basics", section_order: 43, status: "active", slug: "cat-es-a", element_type: PAGE_TYPE },
      // EN content family B with ES child (order 45, inside second Toggle)
      { page_id: "en-page-b", title: "Setup", locale: "en", section: "10-Basics", section_order: 45, status: "active", slug: "setup", sub_items: ["es-page-b"], element_type: PAGE_TYPE },
      { page_id: "es-page-b", title: "Configuración", locale: "es", section: "10-Basics", section_order: 45, status: "active", slug: "config-es", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-page-a.md"), sourceMd("Custom Categories", "custom-categories", 43, "Content A."));
    writeFileSync(join(inputDir, "es-page-a.md"), sourceMd("Categorías Personalizadas", "cat-es-a", 43, "ES A."));
    writeFileSync(join(inputDir, "en-page-b.md"), sourceMd("Setup", "setup", 45, "Content B."));
    writeFileSync(join(inputDir, "es-page-b.md"), sourceMd("Configuración", "config-es", 45, "ES B."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Two separate toggle-level category files exist (ES side)
    const esCat1 = join(out, ...ES_DOCS_CURRENT, "basics", "customizing-comapeo", "_category_.json");
    expect(existsSync(esCat1)).toBe(true);
    expect(JSON.parse(readFileSync(esCat1, "utf8")).label).toBe("Personaliza CoMapeo");

    const esCat2 = join(out, ...ES_DOCS_CURRENT, "basics", "getting-started-essentials", "_category_.json");
    expect(existsSync(esCat2)).toBe(true);
    expect(JSON.parse(readFileSync(esCat2, "utf8")).label).toBe("Introducción - Conceptos básicos");

    // EN side also has both
    expect(existsSync(join(out, "docs", "basics", "customizing-comapeo", "_category_.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "docs", "basics", "customizing-comapeo", "_category_.json"), "utf8")).label).toBe("Customizing CoMapeo");
    expect(JSON.parse(readFileSync(join(out, "docs", "basics", "getting-started-essentials", "_category_.json"), "utf8")).label).toBe("Getting Started Essentials");

    // Page ends up in the last Toggle's directory (order 44 > 42)
    expect(existsSync(join(out, "docs", "basics", "getting-started-essentials", "setup.md"))).toBe(true);
  });

  it("P1: Title clears after one use — second Toggle does not get the same heading", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-title-clear-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "title-en", title: "Section Heading", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "title-en", sub_items: [], element_type: TITLE_TYPE },
      { page_id: "toggle-en-a", title: "First Group", locale: "en", section: "10-Basics", section_order: 2, status: "active", slug: "toggle-a", sub_items: [], element_type: TOGGLE_TYPE },
      { page_id: "en-page-a", title: "First Page", locale: "en", section: "10-Basics", section_order: 2, status: "active", slug: "first-page", element_type: PAGE_TYPE },
      { page_id: "toggle-en-b", title: "Second Group", locale: "en", section: "10-Basics", section_order: 3, status: "active", slug: "toggle-b", sub_items: [], element_type: TOGGLE_TYPE },
      { page_id: "en-page-b", title: "Second Page", locale: "en", section: "10-Basics", section_order: 4, status: "active", slug: "page", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-page-a.md"), sourceMd("First Page", "first-page", 2, "First content."));
    writeFileSync(join(inputDir, "en-page-b.md"), sourceMd("Second Page", "page", 4, "Second content."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // First Toggle gets the heading
    const cat1Path = join(out, "docs", "basics", "first-group", "_category_.json");
    expect(existsSync(cat1Path)).toBe(true);
    const cat1 = JSON.parse(readFileSync(cat1Path, "utf8"));
    expect(cat1.label).toBe("First Group");
    expect(cat1.customProps.title).toBe("Section Heading");

    // Second Toggle does NOT get the heading
    const cat2Path = join(out, "docs", "basics", "second-group", "_category_.json");
    expect(existsSync(cat2Path)).toBe(true);
    const cat2 = JSON.parse(readFileSync(cat2Path, "utf8"));
    expect(cat2.label).toBe("Second Group");
    expect(cat2.customProps.title).toBeNull();
  });

  it("P1: Non-EN container publishes children at EN child's canonical slug", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-nonen-cont-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "pt-container", title: "Creating a New Project", locale: "pt", section: "50-Projects", section_order: 23, status: "active", slug: "pt-cont", sub_items: ["en-child", "pt-child"], element_type: PAGE_TYPE },
      { page_id: "en-child", title: "Creating a New Project", locale: "en", section: "50-Projects", section_order: 23, status: "active", slug: "creating-a-new-project", element_type: PAGE_TYPE },
      { page_id: "pt-child", title: "Criando um Novo Projeto", locale: "pt", section: "50-Projects", section_order: 23, status: "active", slug: "criando", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "pt-container.md"), sourceMd("Creating a New Project", "pt-cont", 23, "Container."));
    writeFileSync(join(inputDir, "en-child.md"), sourceMd("Creating a New Project", "creating-a-new-project", 23, "EN."));
    writeFileSync(join(inputDir, "pt-child.md"), sourceMd("Criando um Novo Projeto", "criando", 23, "PT."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // EN child publishes under its own slug
    const enFile = join(out, "docs", "projects", "creating-a-new-project.md");
    expect(existsSync(enFile)).toBe(true);
    // PT child may or may not be published depending on selection — EN is always published
    const content = readFileSync(enFile, "utf8");
    expect(content).toContain("EN.");
  });

  // ── Translation page frontmatter preservation ──

  it("Translated page frontmatter: title preserved, id/slug rewritten to canonical", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-fm-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "en-container", title: "Getting Started", locale: "en", section: "10-Getting Started", section_order: 10, status: "active", slug: "getting-started", sub_items: ["es-child"] },
      { page_id: "es-child", title: "Empezando", locale: "es", section: "10-Getting Started", section_order: 10, status: "active", slug: "empezando-es" },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-container.md"), sourceMd("Getting Started", "getting-started", 10, "EN content."));
    writeFileSync(join(inputDir, "es-child.md"), sourceMd("Empezando", "empezando-es", 10, "ES content."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    const esFile = join(out, ...ES_DOCS_CURRENT, "getting-started", "getting-started.md");
    expect(existsSync(esFile)).toBe(true);
    const content = readFileSync(esFile, "utf8");
    expect(content).toContain("title: Empezando");
    expect(content).toContain('id: "getting-started"');
    expect(content).toContain("slug: /getting-started");
    expect(content).toContain("ES content.");
  });

  // ── P0: Invalid Markdown / frontmatter safety ──

  it("P0: empty localized source with valid frontmatter is treated as stub and skipped", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-stub-fm-"));
    temps.push(inputDir);
    const out = freshOut();

    // ES translation child with valid frontmatter but EMPTY body (just `---` delimiters)
    const docs: FixtureDoc[] = [
      { page_id: "en-container", title: "Reviewing Observations", locale: "en", section: "30-Review", section_order: 20, status: "active", slug: "reviewing-observations", sub_items: ["es-stub"] },
      { page_id: "es-stub", title: "Explorando Lista", locale: "es", section: "30-Review", section_order: 20, status: "active", slug: "explorando-lista" },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    // EN body contains an internal link to its own canonical route
    writeFileSync(join(inputDir, "en-container.md"), sourceMd("Reviewing Observations", "reviewing-observations", 20, "EN content. See also [more](/docs/reviewing-observations)."));
    // ES stub: valid frontmatter but empty body
    writeFileSync(join(inputDir, "es-stub.md"), `---
title: Explorando Lista
id: explorando-lista
slug: /explorando-lista
sidebar_position: 20
---
`);

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // ES stub gets emitted with EN body fallback (header-preserving behavior)
    const esFile = join(out, ...ES_DOCS_CURRENT, "review", "reviewing-observations.md");
    expect(existsSync(esFile)).toBe(true);
    const esContent = readFileSync(esFile, "utf8");
    expect(esContent).toContain("title: Explorando Lista"); // localized title preserved
    expect(esContent).toContain("EN content."); // EN body fallback
    // Internal link rewritten to ES locale prefix
    expect(esContent).toContain("](/es/docs/reviewing-observations)");
    expect(esContent).not.toContain("](/docs/reviewing-observations)");
  });

  it("P0: every emitted .md file has a closed frontmatter pair (--- open + --- close)", async () => {
    const { inputDir, manifestPath } = buildFixture();
    const out = freshOut();

    await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true" });

    function hasValidFrontmatter(filePath: string): boolean {
      const content = readFileSync(filePath, "utf8");
      // Must start with ---
      if (!content.startsWith("---\n")) return false;
      // Must have closing --- after the frontmatter block
      const closeIdx = content.indexOf("\n---\n", 4);
      if (closeIdx === -1) return false;
      // Body after closing --- must be non-empty (at minimum a newline)
      const body = content.slice(closeIdx + 5);
      return body.length > 0 || content.endsWith("---\n");
    }

    const mds = readdirSyncRecursive(out).filter((f) => f.endsWith(".md") && !f.includes("_category_"));
    expect(mds.length).toBeGreaterThan(0);
    for (const md of mds) {
      expect(hasValidFrontmatter(md), `Invalid frontmatter in ${md}`).toBe(true);
    }
  });

  // ── Event replay & strong hierarchy tests ──

  it("Title→Page: page gets sidebar_custom_props.title from preceding Title", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-tp2-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "title-en", title: "Page Heading", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "title", sub_items: [], element_type: TITLE_TYPE },
      { page_id: "en-page", title: "Content Page", locale: "en", section: "10-Basics", section_order: 2, status: "active", slug: "content-page", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-page.md"), sourceMd("Content Page", "content-page", 2, "Real body content."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    const content = readFileSync(join(out, "docs", "basics", "content-page.md"), "utf8");
    expect(content).toContain('title: "Page Heading"');
    expect(content).toContain("Real body content.");
  });

  it("Event replay: Page-before-Toggle, Page-inside-Toggle, Title-reset, Page-after-Title, second Toggle", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-events-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      // Page before any toggle — at section root
      { page_id: "page-before", title: "Before Toggle", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "before-toggle", element_type: PAGE_TYPE },
      // Toggle A
      { page_id: "toggle-a", title: "Group A", locale: "en", section: "10-Basics", section_order: 2, status: "active", slug: "toggle-a", sub_items: [], element_type: TOGGLE_TYPE },
      // Page inside Toggle A
      { page_id: "page-in-a", title: "In Group A", locale: "en", section: "10-Basics", section_order: 3, status: "active", slug: "in-group-a", element_type: PAGE_TYPE },
      // Title reset
      { page_id: "title-reset", title: "Reset Title", locale: "en", section: "10-Basics", section_order: 4, status: "active", slug: "title-reset", sub_items: [], element_type: TITLE_TYPE },
      // Page after Title — at section root (Title reset cleared Toggle)
      { page_id: "page-after-title", title: "After Title", locale: "en", section: "10-Basics", section_order: 5, status: "active", slug: "after-title", element_type: PAGE_TYPE },
      // Toggle B
      { page_id: "toggle-b", title: "Group B", locale: "en", section: "10-Basics", section_order: 6, status: "active", slug: "toggle-b", sub_items: [], element_type: TOGGLE_TYPE },
      // Page inside Toggle B
      { page_id: "page-in-b", title: "In Group B", locale: "en", section: "10-Basics", section_order: 7, status: "active", slug: "in-group-b", element_type: PAGE_TYPE },
    ];

    const m = buildManifest(docs) as Record<string, unknown>;
    (m.docs as Array<Record<string, unknown>>)[1].element_type = TOGGLE_TYPE;
    (m.docs as Array<Record<string, unknown>>)[3].element_type = TITLE_TYPE;
    (m.docs as Array<Record<string, unknown>>)[5].element_type = TOGGLE_TYPE;
    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(m, null, 2));

    for (const d of docs) {
      writeFileSync(join(inputDir, `${d.page_id}.md`), sourceMd(d.title, d.slug, d.section_order, "Content."));
    }

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Page before toggle: at section root
    expect(existsSync(join(out, "docs", "basics", "before-toggle.md"))).toBe(true);
    // Page inside Toggle A
    expect(existsSync(join(out, "docs", "basics", "group-a", "in-group-a.md"))).toBe(true);
    // Page after Title: at section root (Title reset toggle context)
    expect(existsSync(join(out, "docs", "basics", "after-title.md"))).toBe(true);
    expect(readFileSync(join(out, "docs", "basics", "after-title.md"), "utf8")).toContain('title: "Reset Title"');
    // Page inside Toggle B
    expect(existsSync(join(out, "docs", "basics", "group-b", "in-group-b.md"))).toBe(true);
    // No empty Toggle A category for Group B page
    expect(existsSync(join(out, "docs", "basics", "group-a", "after-title.md"))).toBe(false);
  });

  it("PT non-EN container: PT child publishes with localized title and English body fallback for stub", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-pt-cont2-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "pt-container", title: "Creating a New Project", locale: "pt", section: "50-Projects", section_order: 23, status: "active", slug: "pt-cont", sub_items: ["en-child", "pt-child"], element_type: PAGE_TYPE },
      { page_id: "en-child", title: "Creating a New Project", locale: "en", section: "50-Projects", section_order: 23, status: "active", slug: "creating-a-new-project", element_type: PAGE_TYPE },
      { page_id: "pt-child", title: "Criando um Novo Projeto", locale: "pt", section: "50-Projects", section_order: 23, status: "active", slug: "criando", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "pt-container.md"), sourceMd("Creating a New Project", "pt-cont", 23, "Container."));
    writeFileSync(join(inputDir, "en-child.md"), sourceMd("Creating a New Project", "creating-a-new-project", 23, "EN body content."));
    // PT child is a stub (empty body)
    writeFileSync(join(inputDir, "pt-child.md"), `---
title: Criando um Novo Projeto
id: criando
slug: /criando
sidebar_position: 23
---
`);

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // PT file exists at canonical slug with Portuguese title and EN body fallback
    const ptFile = join(out, ...PT_DOCS_CURRENT, "projects", "creating-a-new-project.md");
    expect(existsSync(ptFile)).toBe(true);
    const ptContent = readFileSync(ptFile, "utf8");
    expect(ptContent).toContain("title: Criando um Novo Projeto");
    expect(ptContent).toContain("EN body content.");
  });

  it("Archived child is excluded from family selection", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-archived-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "en-cont", title: "Page Title", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "page-title", sub_items: ["es-good", "es-archived"], element_type: PAGE_TYPE },
      { page_id: "es-good", title: "Título Español", locale: "es", section: "10-Basics", section_order: 1, status: "active", slug: "titulo-es", element_type: PAGE_TYPE },
      { page_id: "es-archived", title: "Viejo Título", locale: "es", section: "10-Basics", section_order: 1, status: "archived", slug: "viejo", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-cont.md"), sourceMd("Page Title", "page-title", 1, "EN."));
    writeFileSync(join(inputDir, "es-good.md"), sourceMd("Título Español", "titulo-es", 1, "ES."));
    writeFileSync(join(inputDir, "es-archived.md"), sourceMd("Viejo Título", "viejo", 1, "Old."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    const esFile = join(out, ...ES_DOCS_CURRENT, "basics", "page-title.md");
    expect(existsSync(esFile)).toBe(true);
    const esContent = readFileSync(esFile, "utf8");
    // Must select the active ES child, not the archived one
    expect(esContent).toContain("Título Español");
    expect(esContent).not.toContain("Viejo Título");
  });

  it("Dead parent does not leak children as standalone pages", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-dead-parent-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "dead-parent", title: "Dead Page", locale: "en", section: "10-Basics", section_order: 1, status: "deprecated", slug: "dead-parent", sub_items: ["child1"], element_type: PAGE_TYPE },
      { page_id: "child1", title: "Leaked Child", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "leaked-child", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "dead-parent.md"), sourceMd("Dead Page", "dead-parent", 1, "Dead."));
    writeFileSync(join(inputDir, "child1.md"), sourceMd("Leaked Child", "leaked-child", 1, "Child."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Child must NOT leak as standalone (was claimed by family, parent gate blocks family)
    expect(existsSync(join(out, "docs", "basics", "leaked-child.md"))).toBe(false);
    expect(existsSync(join(out, "docs", "basics", "dead-parent.md"))).toBe(false);
  });

  it("Explicit reviewed ES beats automated dated ES duplicate", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-explicit-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "en-cont", title: "Reviewing Individual Observations", locale: "en", section: "30-Review", section_order: 11, status: "active", slug: "reviewing-individual", sub_items: ["es-reviewed", "es-automated"], element_type: PAGE_TYPE },
      { page_id: "es-reviewed", title: "Revisando Observaciones", locale: "es", section: "30-Review", section_order: 5, status: "active", slug: "revisando-obs", element_type: PAGE_TYPE },
      { page_id: "es-automated", title: "Revisando una Observación - 2026-04-13 translation", locale: "es", section: "30-Review", section_order: 20, status: "active", slug: "revisando-auto", element_type: PAGE_TYPE },
    ];

    // Set language_source in manifest to simulate sync-time detection
    const m = buildManifest(docs) as Record<string, unknown>;
    (m.docs as Array<Record<string, unknown>>)[1].language_source = "explicit";
    (m.docs as Array<Record<string, unknown>>)[2].language_source = "automated";
    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(m, null, 2));
    writeFileSync(join(inputDir, "en-cont.md"), sourceMd("Reviewing Individual Observations", "reviewing-individual", 11, "EN body."));
    writeFileSync(join(inputDir, "es-reviewed.md"), sourceMd("Revisando Observaciones", "revisando-obs", 5, "ES reviewed body."));
    writeFileSync(join(inputDir, "es-automated.md"), sourceMd("Revisando una Observación - 2026-04-13 translation", "revisando-auto", 20, "ES auto body."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    const esFile = join(out, ...ES_DOCS_CURRENT, "review", "reviewing-individual-observations.md");
    expect(existsSync(esFile)).toBe(true);
    const esContent = readFileSync(esFile, "utf8");
    // Must select the explicit reviewed ES, not the automated dated one
    expect(esContent).toContain("Revisando Observaciones");
    expect(esContent).not.toContain("Revisando una Observación");
  });

  it("eventOrder vs canonicalOrder: page goes into Toggle by EN child eventOrder, sidebar_position uses parent canonicalOrder", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-eventorder-"));
    temps.push(inputDir);
    const out = freshOut();

    // Toggle at order 30, page at canonicalOrder 40 (parent order), but EN child eventOrder is 15
    const docs: FixtureDoc[] = [
      { page_id: "toggle-en", title: "Troubleshooting", locale: "en", section: "10-Basics", section_order: 30, status: "active", slug: "trouble", sub_items: [], element_type: TOGGLE_TYPE },
      // Content family: parent has high canonicalOrder (40), but EN child has low eventOrder (15)
      { page_id: "en-parent", title: "Site Map Page", locale: "en", section: "10-Basics", section_order: 40, status: "active", slug: "site-map-parent", sub_items: ["en-child"], element_type: PAGE_TYPE },
      { page_id: "en-child", title: "Site Map", locale: "en", section: "10-Basics", section_order: 15, status: "active", slug: "site-map", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-parent.md"), sourceMd("Site Map Page", "site-map-parent", 40, "Content."));
    writeFileSync(join(inputDir, "en-child.md"), sourceMd("Site Map", "site-map", 15, "Site map body."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Page goes BEFORE the Toggle because EN child eventOrder (15) < Toggle order (30)
    // So page is at section root, not inside Toggle dir
    // Canonical slug comes from EN parent title "Site Map Page" → "site-map-page"
    expect(existsSync(join(out, "docs", "basics", "site-map-page.md"))).toBe(true);
    expect(existsSync(join(out, "docs", "basics", "trouble", "site-map-page.md"))).toBe(false);

    // sidebar_position uses parent canonicalOrder (40), not EN child order
    const pageContent = readFileSync(join(out, "docs", "basics", "site-map-page.md"), "utf8");
    expect(pageContent).toContain("sidebar_position: 40");
  });

  it("P1: same canonical slug in different sections produces both output files", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-dual-section-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      { page_id: "a", title: "Overview", locale: "en", section: "10-A", section_order: 1, status: "active", slug: "overview", element_type: PAGE_TYPE },
      { page_id: "b", title: "Overview", locale: "en", section: "20-B", section_order: 1, status: "active", slug: "overview", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "a.md"), sourceMd("Overview", "overview", 1, "Section A content."));
    writeFileSync(join(inputDir, "b.md"), sourceMd("Overview", "overview", 1, "Section B content."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Both exist — different sections, same canonical slug
    expect(existsSync(join(out, "docs", "a", "overview.md"))).toBe(true);
    expect(existsSync(join(out, "docs", "b", "overview.md"))).toBe(true);
    expect(readFileSync(join(out, "docs", "a", "overview.md"), "utf8")).toContain("Section A");
    expect(readFileSync(join(out, "docs", "b", "overview.md"), "utf8")).toContain("Section B");
  });

  it("P1: same final public route key — one wins, diagnostic emitted, customPropsTitle preserved", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-collision-"));
    temps.push(inputDir);
    const out = freshOut();

    // Two pages with same locale + section + slug — collision
    const docs: FixtureDoc[] = [
      { page_id: "en-good", title: "Getting Started", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "getting-started", element_type: PAGE_TYPE },
      { page_id: "en-bad", title: "Getting Started - 2026-04-13 translation", locale: "en", section: "10-Basics", section_order: 99, status: "active", slug: "getting-started", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-good.md"), sourceMd("Getting Started", "getting-started", 1, "Good content."));
    writeFileSync(join(inputDir, "en-bad.md"), sourceMd("Getting Started - 2026-04-13 translation", "getting-started", 99, "Bad content."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Only one file exists
    expect(existsSync(join(out, "docs", "basics", "getting-started.md"))).toBe(true);
    const content = readFileSync(join(out, "docs", "basics", "getting-started.md"), "utf8");
    // Typed, non-staging first page wins
    expect(content).toContain("Getting Started");
    expect(content).not.toContain("2026-04-13");
  });


  it("P1: standalone page uses stored doc.slug when it differs from title-derived slug", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-stored-slug-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      // Title "Installing CoMapeo and Onboarding" → slug would be "installing-comapeo-and-onboarding"
      // But stored slug is "installing-comapeo-onboarding" (different from title-derived)
      { page_id: "en-page", title: "Installing CoMapeo and Onboarding", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "installing-comapeo-onboarding", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-page.md"), sourceMd("Installing CoMapeo and Onboarding", "installing-comapeo-onboarding", 1, "Content."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Output uses stored doc.slug, not title-derived slug
    expect(existsSync(join(out, "docs", "basics", "installing-comapeo-onboarding.md"))).toBe(true);
    const content = readFileSync(join(out, "docs", "basics", "installing-comapeo-onboarding.md"), "utf8");
    expect(content).toContain("id: installing-comapeo-onboarding");
    expect(content).toContain("slug: /installing-comapeo-onboarding");
  });

  // ── Category key regression tests ──

  it("parent/child categories with identical localized labels have distinct keys", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-dupkey-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      // Toggle whose title matches the section name → same localized label as section
      { page_id: "toggle-en", title: "Gathering Observations & Tracks", locale: "en", section: "10-Gathering Observations", section_order: 10, status: "active", slug: "toggle", sub_items: [], element_type: TOGGLE_TYPE },
      { page_id: "en-page", title: "Some Page", locale: "en", section: "10-Gathering Observations", section_order: 11, status: "active", slug: "some-page", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-page.md"), sourceMd("Some Page", "some-page", 11, "Content in toggle."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Section-level _category_.json
    const sectionCatPath = join(out, "docs", "gathering-observations", "_category_.json");
    expect(existsSync(sectionCatPath)).toBe(true);
    const sectionCat = JSON.parse(readFileSync(sectionCatPath, "utf8"));
    expect(sectionCat.key).toBe("gathering-observations");

    // Toggle-level _category_.json — nested dir; toggleDir uses slugify (no &→and)
    const toggleCatPath = join(out, "docs", "gathering-observations", "gathering-observations-tracks", "_category_.json");
    expect(existsSync(toggleCatPath)).toBe(true);
    const toggleCat = JSON.parse(readFileSync(toggleCatPath, "utf8"));
    expect(toggleCat.key).toBe("gathering-observations/gathering-observations-tracks");

    // Labels may be identical but keys must differ
    expect(sectionCat.key).not.toBe(toggleCat.key);
  });

  it("same structural category has identical key across en/es/pt _category_.json", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "docspull-crossloc-"));
    temps.push(inputDir);
    const out = freshOut();

    const docs: FixtureDoc[] = [
      // Toggle with ES/PT translations
      { page_id: "toggle-en", title: "Customizing CoMapeo", locale: "en", section: "10-Basics", section_order: 2, status: "active", slug: "toggle-en", sub_items: ["toggle-es", "toggle-pt"], element_type: TOGGLE_TYPE },
      { page_id: "toggle-es", title: "Personaliza CoMapeo", locale: "es", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-es", element_type: TOGGLE_TYPE },
      { page_id: "toggle-pt", title: "Personaliza CoMapeo", locale: "pt", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-pt", element_type: TOGGLE_TYPE },
      { page_id: "en-page", title: "Custom Categories", locale: "en", section: "10-Basics", section_order: 3, status: "active", slug: "custom-categories", element_type: PAGE_TYPE },
      { page_id: "es-page", title: "Categorías Personalizadas", locale: "es", section: "10-Basics", section_order: 3, status: "active", slug: "cat-es", element_type: PAGE_TYPE },
      { page_id: "pt-page", title: "Categorias Personalizadas", locale: "pt", section: "10-Basics", section_order: 3, status: "active", slug: "cat-pt", element_type: PAGE_TYPE },
    ];

    writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
    writeFileSync(join(inputDir, "en-page.md"), sourceMd("Custom Categories", "custom-categories", 3, "EN."));
    writeFileSync(join(inputDir, "es-page.md"), sourceMd("Categorías Personalizadas", "cat-es", 3, "ES."));
    writeFileSync(join(inputDir, "pt-page.md"), sourceMd("Categorias Personalizadas", "cat-pt", 3, "PT."));

    await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

    // Section-level keys must be identical regardless of locale
    const enSec = JSON.parse(readFileSync(join(out, "docs", "basics", "_category_.json"), "utf8"));
    const esSec = JSON.parse(readFileSync(join(out, ...ES_DOCS_CURRENT, "basics", "_category_.json"), "utf8"));
    const ptSec = JSON.parse(readFileSync(join(out, ...PT_DOCS_CURRENT, "basics", "_category_.json"), "utf8"));
    expect(enSec.key).toBe("basics");
    expect(esSec.key).toBe("basics");
    expect(ptSec.key).toBe("basics");

    // Toggle-level keys must also be identical across locales
    const enToggle = JSON.parse(readFileSync(join(out, "docs", "basics", "customizing-comapeo", "_category_.json"), "utf8"));
    const esToggle = JSON.parse(readFileSync(join(out, ...ES_DOCS_CURRENT, "basics", "customizing-comapeo", "_category_.json"), "utf8"));
    const ptToggle = JSON.parse(readFileSync(join(out, ...PT_DOCS_CURRENT, "basics", "customizing-comapeo", "_category_.json"), "utf8"));
    expect(enToggle.key).toBe("basics/customizing-comapeo");
    expect(esToggle.key).toBe("basics/customizing-comapeo");
    expect(ptToggle.key).toBe("basics/customizing-comapeo");

    // Labels differ by locale but keys do not
    expect(enToggle.label).not.toBe(esToggle.label);
    expect(enToggle.key).toBe(esToggle.key);
  });

  // ── current.json sidebar translation tests ──
  // Docusaurus 3.10.1 reads i18n/<locale>/docusaurus-plugin-content-docs/current.json
  // for sidebar category translations, ignoring localized _category_.json labels.
  // Keys use CategoryEntry.key (locale-independent). Messages are localized labels;
  // descriptions are the English labels for translator context.

  describe("current.json", () => {
    function currentJsonPath(out: string, locale: string): string {
      return join(out, "i18n", locale, "docusaurus-plugin-content-docs", "current.json");
    }

    function buildMultisectionFixture(): {
      inputDir: string; manifestPath: string;
    } {
      const inputDir = mkdtempSync(join(tmpdir(), "docspull-curjson-"));
      temps.push(inputDir);

      const docs: FixtureDoc[] = [
        // Section 10: Overview (has curated ES/PT translations)
        { page_id: "en-overview", title: "Overview", locale: "en", section: "10-Overview", section_order: 1, status: "active", slug: "overview" },
        { page_id: "es-overview", title: "Vista General", locale: "es", section: "10-Overview", section_order: 1, status: "active", slug: "overview-es" },
        { page_id: "pt-overview", title: "Visão Geral", locale: "pt", section: "10-Overview", section_order: 1, status: "active", slug: "overview-pt" },
        // Section 20: Troubleshooting (has curated ES/PT translations)
        // Toggle with same name as section for nested same-label collision
        { page_id: "toggle-en-trouble", title: "Troubleshooting", locale: "en", section: "20-Troubleshooting", section_order: 2, status: "active", slug: "toggle-trouble", element_type: TOGGLE_TYPE, sub_items: ["toggle-es-trouble", "toggle-pt-trouble"] },
        { page_id: "toggle-es-trouble", title: "Solución de Problemas", locale: "es", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-es-trouble", element_type: TOGGLE_TYPE },
        { page_id: "toggle-pt-trouble", title: "Solução de Problemas", locale: "pt", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-pt-trouble", element_type: TOGGLE_TYPE },
        // Page inside toggle (order 3 > toggle order 2)
        { page_id: "en-trouble-page", title: "Common Issues", locale: "en", section: "20-Troubleshooting", section_order: 3, status: "active", slug: "common-issues", sub_items: ["es-trouble-page", "pt-trouble-page"] },
        { page_id: "es-trouble-page", title: "Problemas Comunes", locale: "es", section: "20-Troubleshooting", section_order: 3, status: "active", slug: "common-issues-es" },
        { page_id: "pt-trouble-page", title: "Problemas Comuns", locale: "pt", section: "20-Troubleshooting", section_order: 3, status: "active", slug: "common-issues-pt" },
      ];

      const manifestPath = join(inputDir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(buildManifest(docs), null, 2));
      for (const d of docs) {
        writeFileSync(join(inputDir, `${d.page_id}.md`), sourceMd(d.title, d.slug, d.section_order, "Content."));
      }
      return { inputDir, manifestPath };
    }

    function buildHierarchyFixture(): {
      inputDir: string; manifestPath: string;
    } {
      const inputDir = mkdtempSync(join(tmpdir(), "docspull-curjson-h-"));
      temps.push(inputDir);

      const docs: FixtureDoc[] = [
        // Title → Toggle → Page hierarchy
        { page_id: "title-en", title: "Preparing to Use CoMapeo", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "t-en", element_type: TITLE_TYPE, sub_items: [] },
        { page_id: "toggle-en", title: "Customizing CoMapeo", locale: "en", section: "10-Basics", section_order: 2, status: "active", slug: "toggle-en", element_type: TOGGLE_TYPE, sub_items: ["toggle-es", "toggle-pt"] },
        { page_id: "toggle-es", title: "Personaliza CoMapeo", locale: "es", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-es", element_type: TOGGLE_TYPE },
        { page_id: "toggle-pt", title: "Personalizar CoMapeo", locale: "pt", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-pt", element_type: TOGGLE_TYPE },
        { page_id: "en-page", title: "Custom Categories", locale: "en", section: "10-Basics", section_order: 3, status: "active", slug: "custom-categories" },
        { page_id: "es-page", title: "Categorías Personalizadas", locale: "es", section: "10-Basics", section_order: 3, status: "active", slug: "cat-es" },
        { page_id: "pt-page", title: "Categorias Personalizadas", locale: "pt", section: "10-Basics", section_order: 3, status: "active", slug: "cat-pt" },
      ];

      const manifestPath = join(inputDir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(buildManifest(docs), null, 2));
      for (const d of docs) {
        const body = isContentPageLike(d) ? "Content." : "";
        writeFileSync(join(inputDir, `${d.page_id}.md`), sourceMd(d.title, d.slug, d.section_order, body));
      }
      return { inputDir, manifestPath };
    }

    function isContentPageLike(d: FixtureDoc): boolean {
      const et = (d.element_type as Record<string, unknown> | undefined);
      if (!et) return true;
      const name = (et as { select?: { name?: string } }).select?.name ?? "";
      return name === "" || name === "Page";
    }

    it("emits current.json for ES and PT with version.label + category entries", async () => {
      const { inputDir, manifestPath } = buildMultisectionFixture();
      const out = freshOut();

      await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true" });

      // ── ES current.json ──
      const esPath = currentJsonPath(out, "es");
      expect(existsSync(esPath), `Missing ${esPath}`).toBe(true);
      const es = JSON.parse(readFileSync(esPath, "utf8"));

      // version.label — exact Docusaurus write-translations output
      expect(es["version.label"]).toEqual({
        message: "Latest",
        description: "The label for version current",
      });

      // Section category: key = sectionDir ("overview")
      expect(es["sidebar.docsSidebar.category.overview"]).toBeDefined();
      expect(es["sidebar.docsSidebar.category.overview"].message).toBe("Vista General");
      expect(es["sidebar.docsSidebar.category.overview"].description).toBe(
        "The label for category 'Overview' in sidebar 'docsSidebar'",
      );
      expect(es["sidebar.docsSidebar.category.overview.link.generated-index.title"]).toBeDefined();
      expect(es["sidebar.docsSidebar.category.overview.link.generated-index.title"].message).toBe("Vista General");
      expect(es["sidebar.docsSidebar.category.overview.link.generated-index.title"].description).toBe(
        "The generated-index page title for category 'Overview' in sidebar 'docsSidebar'",
      );

      // Section category: key = sectionDir ("troubleshooting")
      const esTroubleKey = "sidebar.docsSidebar.category.troubleshooting";
      expect(es[esTroubleKey]).toBeDefined();
      expect(es[esTroubleKey].message).toBe("Solución de Problemas");
      expect(es[esTroubleKey].description).toBe(
        "The label for category 'Troubleshooting' in sidebar 'docsSidebar'",
      );
      expect(es[`${esTroubleKey}.link.generated-index.title`]).toBeDefined();
      expect(es[`${esTroubleKey}.link.generated-index.title`].description).toBe(
        "The generated-index page title for category 'Troubleshooting' in sidebar 'docsSidebar'",
      );

      // ── PT current.json ──
      const ptPath = currentJsonPath(out, "pt");
      expect(existsSync(ptPath), `Missing ${ptPath}`).toBe(true);
      const pt = JSON.parse(readFileSync(ptPath, "utf8"));
      expect(pt["sidebar.docsSidebar.category.overview"].message).toBe("Visão Geral");
      expect(pt["sidebar.docsSidebar.category.overview"].description).toBe(
        "The label for category 'Overview' in sidebar 'docsSidebar'",
      );
      expect(pt["sidebar.docsSidebar.category.troubleshooting"].message).toBe("Solução de Problemas");
      expect(pt["sidebar.docsSidebar.category.troubleshooting"].description).toBe(
        "The label for category 'Troubleshooting' in sidebar 'docsSidebar'",
      );
    });

    it("no English leakage — ES/PT message values are NOT English when translations exist", async () => {
      const { inputDir, manifestPath } = buildMultisectionFixture();
      const out = freshOut();

      await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true" });

      const es = JSON.parse(readFileSync(currentJsonPath(out, "es"), "utf8"));
      const pt = JSON.parse(readFileSync(currentJsonPath(out, "pt"), "utf8"));

      for (const key of Object.keys(es)) {
        if (key === "version.label") continue;
        const msg = es[key].message as string;
        expect(
          msg,
          `ES current.json key "${key}" message is English: "${msg}"`
        ).not.toMatch(/^(Overview|Gathering Observations|Uncategorized|Preparing|Customizing)/);
      }

      for (const key of Object.keys(pt)) {
        if (key === "version.label") continue;
        const msg = pt[key].message as string;
        expect(
          msg,
          `PT current.json key "${key}" message is English: "${msg}"`
        ).not.toMatch(/^(Overview|Gathering Observations|Uncategorized|Preparing|Customizing)/);
      }
    });

    it("nested same-label category produces distinct keys with slash separator", async () => {
      const { inputDir, manifestPath } = buildMultisectionFixture();
      const out = freshOut();

      await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true" });

      const es = JSON.parse(readFileSync(currentJsonPath(out, "es"), "utf8"));

      // Section-level key (sectionDir only): "troubleshooting"
      const sectionKey = "sidebar.docsSidebar.category.troubleshooting";
      expect(es[sectionKey]).toBeDefined();
      // Toggle-level key (sectionDir/toggleDir): "troubleshooting/troubleshooting" — same section, nested toggle with same label
      const toggleKey = "sidebar.docsSidebar.category.troubleshooting/troubleshooting";
      expect(es[toggleKey]).toBeDefined();
      // Both must be distinct keys
      expect(sectionKey).not.toBe(toggleKey);
    });

    it("keys are locale-independent — same key across ES and PT", async () => {
      const { inputDir, manifestPath } = buildHierarchyFixture();
      const out = freshOut();

      await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true" });

      const es = JSON.parse(readFileSync(currentJsonPath(out, "es"), "utf8"));
      const pt = JSON.parse(readFileSync(currentJsonPath(out, "pt"), "utf8"));

      const esKeys = Object.keys(es).sort();
      const ptKeys = Object.keys(pt).sort();
      expect(esKeys).toEqual(ptKeys);

      // Toggle-level category key
      const toggleCatKey = "sidebar.docsSidebar.category.basics/customizing-comapeo";
      expect(es[toggleCatKey].message).not.toBe(pt[toggleCatKey].message);
      expect(es[toggleCatKey].description).toBe(pt[toggleCatKey].description); // both use EN
    });

    it("description uses English label in Docusaurus write-translations template", async () => {
      const { inputDir, manifestPath } = buildMultisectionFixture();
      const out = freshOut();

      await docsPull({ input: manifestPath, "input-dir": inputDir, out, all: "true" });

      const es = JSON.parse(readFileSync(currentJsonPath(out, "es"), "utf8"));
      const pt = JSON.parse(readFileSync(currentJsonPath(out, "pt"), "utf8"));

      // Collect English labels from EN _category_.json files (source of truth)
      const enLabels = new Set<string>();
      const enOver = JSON.parse(readFileSync(join(out, "docs", "overview", "_category_.json"), "utf8"));
      enLabels.add(enOver.label);
      const enTrouble = JSON.parse(readFileSync(join(out, "docs", "troubleshooting", "_category_.json"), "utf8"));
      enLabels.add(enTrouble.label);
      const enTroubleToggle = JSON.parse(readFileSync(join(out, "docs", "troubleshooting", "troubleshooting", "_category_.json"), "utf8"));
      enLabels.add(enTroubleToggle.label);

      for (const json of [es, pt]) {
        for (const key of Object.keys(json)) {
          if (key === "version.label") continue;
          const desc = json[key].description as string;
          const isLabelKey = !key.includes(".link.generated-index.title");
          if (isLabelKey) {
            const match = desc.match(/^The label for category '(.+)' in sidebar 'docsSidebar'$/);
            expect(match, `Description "${desc}" for key "${key}" does not match label template`).not.toBeNull();
            expect(enLabels.has(match![1]), `English label "${match![1]}" not found in EN _category_.json`).toBe(true);
          } else {
            const match = desc.match(/^The generated-index page title for category '(.+)' in sidebar 'docsSidebar'$/);
            expect(match, `Description "${desc}" for key "${key}" does not match generated-index template`).not.toBeNull();
            expect(enLabels.has(match![1]), `English label "${match![1]}" not found in EN _category_.json`).toBe(true);
          }
        }
      }
    });

    it("deterministic output — rerunning produces identical current.json", async () => {
      const { inputDir, manifestPath } = buildHierarchyFixture();
      const out1 = freshOut();
      const out2 = freshOut();

      await docsPull({ input: manifestPath, "input-dir": inputDir, out: out1, all: "true" });
      await docsPull({ input: manifestPath, "input-dir": inputDir, out: out2, all: "true" });

      for (const loc of ["es", "pt"]) {
        const p1 = currentJsonPath(out1, loc);
        const p2 = currentJsonPath(out2, loc);
        expect(existsSync(p1)).toBe(true);
        expect(existsSync(p2)).toBe(true);
        expect(JSON.parse(readFileSync(p1, "utf8"))).toEqual(JSON.parse(readFileSync(p2, "utf8")));
      }
    });

    it("single-locale only EN: no current.json emitted", async () => {
      const inputDir = mkdtempSync(join(tmpdir(), "docspull-curjson-enonly-"));
      temps.push(inputDir);
      const out = freshOut();

      const docs: FixtureDoc[] = [
        { page_id: "en-page", title: "Getting Started", locale: "en", section: "10-Basics", section_order: 1, status: "active", slug: "getting-started" },
      ];

      writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
      writeFileSync(join(inputDir, "en-page.md"), sourceMd("Getting Started", "getting-started", 1, "Content."));

      await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

      expect(existsSync(currentJsonPath(out, "es"))).toBe(false);
      expect(existsSync(currentJsonPath(out, "pt"))).toBe(false);
    });

    it("Uncategorized section is excluded from current.json (plain sidebar IDs)", async () => {
      const inputDir = mkdtempSync(join(tmpdir(), "docspull-curjson-uncat-"));
      temps.push(inputDir);
      const out = freshOut();

      const docs: FixtureDoc[] = [
        { page_id: "en-null", title: "Misc Page", locale: "en", section: null as unknown as string, section_order: 9999, status: "active", slug: "misc" },
        { page_id: "es-null", title: "Página Variada", locale: "es", section: null as unknown as string, section_order: 9999, status: "active", slug: "misc-es" },
      ];

      writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
      writeFileSync(join(inputDir, "en-null.md"), sourceMd("Misc Page", "misc", 9999, "EN."));
      writeFileSync(join(inputDir, "es-null.md"), sourceMd("Página Variada", "misc-es", 9999, "ES."));

      await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

      const es = JSON.parse(readFileSync(currentJsonPath(out, "es"), "utf8"));
      // Uncategorized pages are plain sidebar IDs — Docusaurus write-translations
      // emits no category key for them
      expect(es["sidebar.docsSidebar.category.uncategorized"]).toBeUndefined();
      // Root pages are written straight into the locale root, not into an
      // "uncategorized" subdirectory — no _category_.json should exist there
      // (an empty one would render as a phantom clickable category).
      expect(existsSync(join(out, "docs", "uncategorized"))).toBe(false);
      expect(existsSync(join(out, ...ES_DOCS_CURRENT, "uncategorized"))).toBe(false);
    });

    it("Toggle nested under the Uncategorized section gets its own directory, not an 'uncategorized/' prefix", async () => {
      const inputDir = mkdtempSync(join(tmpdir(), "docspull-curjson-uncat-toggle-"));
      temps.push(inputDir);
      const out = freshOut();

      const docs: FixtureDoc[] = [
        { page_id: "toggle-en", title: "Root Group", locale: "en", section: null as unknown as string, section_order: 1, status: "active", slug: "toggle-en", sub_items: [], element_type: TOGGLE_TYPE },
        { page_id: "en-page", title: "Nested Page", locale: "en", section: null as unknown as string, section_order: 2, status: "active", slug: "nested-page" },
      ];

      writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
      writeFileSync(join(inputDir, "en-page.md"), sourceMd("Nested Page", "nested-page", 2, "EN body."));

      await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

      // The page lands under docs/root-group/, not docs/uncategorized/root-group/.
      expect(existsSync(join(out, "docs", "root-group", "nested-page.md"))).toBe(true);
      expect(existsSync(join(out, "docs", "root-group", "_category_.json"))).toBe(true);
      expect(existsSync(join(out, "docs", "uncategorized"))).toBe(false);
    });

    it("excludes empty EN toggle category when no EN canonical page exists in that toggleDir", async () => {
      const inputDir = mkdtempSync(join(tmpdir(), "docspull-curjson-et-"));
      temps.push(inputDir);
      const out = freshOut();

      const docs: FixtureDoc[] = [
        // Section: Overview (populated → section key must survive)
        { page_id: "en-overview", title: "Overview", locale: "en", section: "10-Overview", section_order: 1, status: "active", slug: "overview" },
        { page_id: "es-overview", title: "Vista General", locale: "es", section: "10-Overview", section_order: 1, status: "active", slug: "overview-es" },
        { page_id: "pt-overview", title: "Visão Geral", locale: "pt", section: "10-Overview", section_order: 1, status: "active", slug: "overview-pt" },
        // EN Toggle parent with ES/PT translations (no EN content page inside)
        { page_id: "toggle-en-empty", title: "Empty Toggle", locale: "en", section: "10-Overview", section_order: 2, status: "active", slug: "toggle-empty", element_type: TOGGLE_TYPE, sub_items: ["toggle-es-empty", "toggle-pt-empty"] },
        { page_id: "toggle-es-empty", title: "Conmutador Vacío", locale: "es", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-es-empty", element_type: TOGGLE_TYPE },
        { page_id: "toggle-pt-empty", title: "Alternador Vazio", locale: "pt", section: null as unknown as string, section_order: 99, status: "active", slug: "toggle-pt-empty", element_type: TOGGLE_TYPE },
        // ES and PT content pages inside the toggle (no matching EN canonical page)
        { page_id: "es-toggle-page", title: "Página ES", locale: "es", section: "10-Overview", section_order: 3, status: "active", slug: "es-toggle-page" },
        { page_id: "pt-toggle-page", title: "Página PT", locale: "pt", section: "10-Overview", section_order: 3, status: "active", slug: "pt-toggle-page" },
      ];

      writeFileSync(join(inputDir, "manifest.json"), JSON.stringify(buildManifest(docs), null, 2));
      for (const d of docs) {
        const body = isContentPageLike(d) ? "Content." : "";
        writeFileSync(join(inputDir, `${d.page_id}.md`), sourceMd(d.title, d.slug, d.section_order, body));
      }

      await docsPull({ input: join(inputDir, "manifest.json"), "input-dir": inputDir, out, all: "true" });

      const emptyToggleKey = "sidebar.docsSidebar.category.overview/empty-toggle";
      const sectionKey = "sidebar.docsSidebar.category.overview";

      for (const loc of ["es", "pt"]) {
        const json = JSON.parse(readFileSync(currentJsonPath(out, loc), "utf8"));
        expect(json[sectionKey], `${loc} current.json must retain populated section key`).toBeDefined();
        expect(json[emptyToggleKey], `${loc} current.json must exclude empty EN toggle key`).toBeUndefined();
      }
    });
  });
});
