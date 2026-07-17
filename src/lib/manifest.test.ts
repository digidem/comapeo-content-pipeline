import { describe, it, expect } from "vitest";
import { generateManifest, generateSidebarJson, buildManifestFromStorage, manifestElementType, projectSidebars } from "./manifest.js";
import type { ManifestStorage } from "./manifest.js";
import { buildHierarchyPlan } from "./hierarchy.js";
import type { ManifestDoc, SidebarCategory } from "../schemas/manifest.js";
import { SidebarItemSchema } from "../schemas/manifest.js";
import { isStructuralPage } from "./notion-properties.js";
import type { PageMetadata } from "../schemas/metadata.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../test/fixtures");

const basePage: PageMetadata = {
  page_id: "abc123",
  title: "Getting Started",
  source_url: "https://notion.so/abc123",
  notion_last_edited_time: "2026-04-23T04:19:00.000Z",
  content_hash: "sha256:abc",
  raw_hash: "sha256:def",
  locale: "en",
  section: "basics",
  section_order: 1,
  slug: "getting-started",
  docusaurus_id: "basics/getting-started",
  status: "active",
  properties: {},
  assets: [],
};

describe("generateManifest", () => {
  it("generates manifest from page list", () => {
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage],
    });

    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.source.database_id).toBe("db1");
    expect(manifest.docs).toHaveLength(1);
    expect(manifest.docs[0].page_id).toBe("abc123");
    expect(manifest.docs[0].slug).toBe("getting-started");
    expect(manifest.docs[0].r2_doc_key).toBe("docs/en/docs/basics/getting-started.md");
    expect(manifest.sidebars).toBeDefined();
  });

  it("includes rag reference when provided", () => {
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage],
      ragChunksManifestKey: "rag/chunks-manifest.json",
    });

    expect(manifest.rag?.chunks_manifest_key).toBe("rag/chunks-manifest.json");
  });

  it("filters non-active pages from sidebar defaults", () => {
    const draftPage: PageMetadata = { ...basePage, page_id: "draft1", status: "draft" };
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage, draftPage],
    });

    // Both appear in docs array
    expect(manifest.docs).toHaveLength(2);

    // But sidebar only contains active
    const enSidebar = manifest.sidebars.en;
    const sidebarIds = JSON.stringify(enSidebar);
    expect(sidebarIds).toContain("basics/getting-started");
    expect(sidebarIds).not.toContain("draft1");
  });

  it("generates correct R2 keys", () => {
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage],
    });

    expect(manifest.docs[0].r2_doc_key).toBe("docs/en/docs/basics/getting-started.md");
    expect(manifest.docs[0].r2_metadata_key).toBe("pages/abc123/metadata.json");
  });

  it("produces Docusaurus sidebar format", () => {
    const manifest = generateManifest({
      databaseId: "db1",
      dataSourceId: "ds1",
      pages: [basePage],
    });

    const sidebar = manifest.sidebars.en;
    expect(sidebar).toHaveLength(1);
    expect(sidebar[0]).toEqual({
      type: "category",
      label: "basics",
      key: "basics",
      items: ["basics/getting-started"],
      collapsed: true,
      collapsible: true,
      link: { type: "generated-index", title: "basics" },
      customProps: { title: null },
    });
  });
});

// ── Golden fixture (spec §15.2) ──

describe("generateManifest — golden fixture", () => {
  it("deep-equals test/fixtures/expected/manifest.json", () => {
    // Deterministic input: 3 hand-written PageMetadata (EN sectioned, ES
    // translation, EN unsectioned). properties carry the raw Notion property
    // objects for Element Type / Publish Status, but the manifest must read the
    // extracted top-level element_type / drafting_status fields.
    const pages = JSON.parse(
      readFileSync(join(fixturesDir, "golden", "golden-pages.json"), "utf8"),
    ) as PageMetadata[];

    const manifest = generateManifest({
      databaseId: "db-golden",
      dataSourceId: "ds-golden",
      pages,
    });

    // generated_at is the only volatile field — normalize to a literal.
    (manifest as { generated_at: string }).generated_at = "<GENERATED_AT>";

    const expected = JSON.parse(
      readFileSync(join(fixturesDir, "expected", "manifest.json"), "utf8"),
    );

    // Round-trip both sides through JSON so key order / undefined handling is
    // identical, then deep-equal against the frozen golden file.
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(expected);
  });
});

describe("generateSidebarJson", () => {
  it("groups pages by section into categories", () => {
    const pages: PageMetadata[] = [
      { ...basePage, docusaurus_id: "intro", section: null, section_order: 0 },
      { ...basePage, docusaurus_id: "install", section: "Getting Started", section_order: 1 },
      { ...basePage, docusaurus_id: "account", section: "Getting Started", section_order: 2 },
      { ...basePage, docusaurus_id: "advanced", section: "Advanced", section_order: 10 },
    ];

    const sidebar = generateSidebarJson(pages);

    // "Getting Started" (min order 1) comes before "Advanced" (min order 10)
    // Uncategorized page at the end
    expect(sidebar).toHaveLength(3);
    expect(sidebar[0]).toEqual({
      type: "category",
      label: "Getting Started",
      items: ["install", "account"],
    });
    expect(sidebar[1]).toEqual({
      type: "category",
      label: "Advanced",
      items: ["advanced"],
    });
    // Uncategorized at the end
    expect(sidebar[2]).toBe("intro");
  });

  it("returns empty array for no active pages", () => {
    const pages: PageMetadata[] = [
      { ...basePage, status: "draft" },
    ];
    expect(generateSidebarJson(pages)).toEqual([]);
  });

  it("handles all uncategorized pages", () => {
    const pages: PageMetadata[] = [
      { ...basePage, docusaurus_id: "doc-a", section: null, section_order: 2 },
      { ...basePage, docusaurus_id: "doc-b", section: null, section_order: 1 },
    ];

    const sidebar = generateSidebarJson(pages);
    expect(sidebar).toEqual(["doc-b", "doc-a"]);
  });
});

// ── buildManifestFromStorage ──

/** In-memory ManifestStorage stub backed by a key→body map. */
function memStorage(entries: Record<string, string>): ManifestStorage {
  const map = new Map(Object.entries(entries));
  return {
    get: async (key) => map.get(key) ?? null,
    list: async (prefix) =>
      [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, size: v.length })),
  };
}

describe("buildManifestFromStorage", () => {
  it("builds manifest from valid blobs, skips corrupt ones, populates required doc fields", async () => {
    const one: PageMetadata = {
      ...basePage,
      page_id: "p1",
      slug: "page-one",
      section: "intro",
      section_order: 1,
      status: "active",
      element_type: "page",
      drafting_status: "Draft published",
      // Raw Notion property objects, as sync actually stores them — the manifest
      // must read the extracted top-level fields above, never these (regression:
      // casting these to string shipped objects inside element_type).
      properties: {
        "Element Type": { id: "nqRr", type: "select", select: { name: "Page" } },
        "Publish Status": { id: "BQMv", type: "select", select: { name: "Draft published" } },
      },
      sub_items: ["p2"],
    };
    const two: PageMetadata = {
      ...basePage,
      page_id: "p2",
      slug: "page-two",
      section: null,
      section_order: null,
      status: "active",
    };

    const storage = memStorage({
      "pages/p1/metadata.json": JSON.stringify(one),
      "pages/p2/metadata.json": JSON.stringify(two),
      "pages/p3/metadata.json": "{not valid json",
      // Non-metadata blobs under pages/ must be ignored by the filter.
      "pages/p1/raw-page.json": "{}",
      "pages/p1/raw-blocks.json": "[]",
    });

    const { manifest, skipped } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    expect(manifest.docs).toHaveLength(2);

    const d1 = manifest.docs.find((d) => d.page_id === "p1");
    expect(d1).toBeDefined();
    // Required fields that D1 rows omit — now sourced from the metadata blobs.
    expect(d1!.element_type).toBe("page");
    expect(d1!.drafting_status).toBe("Draft published");
    expect(d1!.sub_items).toEqual(["p2"]);

    // sidebars must be populated (not {}), built from the active pages.
    expect(Object.keys(manifest.sidebars)).toContain("en");
    expect(manifest.sidebars.en.length).toBeGreaterThan(0);

    expect(skipped).toEqual(["pages/p3/metadata.json"]);
  });

  it("skips blobs that fail PageMetadataSchema validation", async () => {
    const valid: PageMetadata = { ...basePage, page_id: "p1", status: "active" };
    // Missing required fields (no content_hash, no status) → schema rejects.
    const invalid = { page_id: "p2", title: "No hash" };

    const storage = memStorage({
      "pages/p1/metadata.json": JSON.stringify(valid),
      "pages/p2/metadata.json": JSON.stringify(invalid),
    });

    const { manifest, skipped } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    expect(manifest.docs).toHaveLength(1);
    expect(manifest.docs[0].page_id).toBe("p1");
    expect(skipped).toEqual(["pages/p2/metadata.json"]);
  });

  it("returns an empty doc set when no metadata blobs exist", async () => {
    const storage = memStorage({});
    const { manifest, skipped } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });
    expect(manifest.docs).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("reads each page's real R2 body to rank family-selection candidates by real content over a stub", async () => {
    // A PT container links two EN children: one with a real body (lower
    // section_order isn't in its favor) and one that's an empty stub (listed
    // first in the relation, with a LOWER section_order so it would win a
    // pure order-based tiebreak). Without reading actual R2 body content,
    // buildHierarchyPlan would treat both as bodyless and fall through to the
    // order tiebreak, incorrectly picking the empty stub as the canonical EN
    // source — which would publish the sidebar route under the stub's own
    // title-derived slug ("empty-stub") instead of the real page's
    // ("real-page").
    const container: PageMetadata = {
      ...basePage, page_id: "pt-container", title: "Creando un Proyecto", locale: "pt",
      section: "50-Projects", section_order: 1, slug: "pt-cont",
      sub_items: ["en-empty", "en-real"],
    };
    const enEmpty: PageMetadata = {
      ...basePage, page_id: "en-empty", title: "Empty Stub", locale: "en",
      section: "50-Projects", section_order: 1, slug: "empty-stub",
    };
    const enReal: PageMetadata = {
      ...basePage, page_id: "en-real", title: "Real Page", locale: "en",
      section: "50-Projects", section_order: 2, slug: "real-page",
    };

    const storage = memStorage({
      "pages/pt-container/metadata.json": JSON.stringify(container),
      "pages/en-empty/metadata.json": JSON.stringify(enEmpty),
      "pages/en-real/metadata.json": JSON.stringify(enReal),
      // R2 doc bodies, at the same keys buildR2DocKey computes for each page.
      "docs/pt/docs/50-Projects/pt-cont.md": "---\ntitle: x\n---\nContainer.\n",
      "docs/en/docs/50-Projects/empty-stub.md": "---\ntitle: x\n---\n",
      "docs/en/docs/50-Projects/real-page.md": "---\ntitle: x\n---\nReal content here.\n",
    });

    const { manifest } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    const allIds = JSON.stringify(manifest.sidebars);
    expect(allIds).toContain("real-page");
    expect(allIds).not.toContain("empty-stub");
  });

  it("routes a transient storage.get throw to readErrors, not skipped", async () => {
    const valid: PageMetadata = { ...basePage, page_id: "p1", status: "active" };
    const storage = memStorage({
      "pages/p1/metadata.json": JSON.stringify(valid),
      "pages/p2/metadata.json": JSON.stringify({ ...basePage, page_id: "p2", status: "active" }),
    });
    // p2's get throws — a transient R2/network hiccup, not a corrupt blob.
    const realGet = storage.get;
    storage.get = async (key) => {
      if (key === "pages/p2/metadata.json") throw new Error("R2 transient");
      return realGet(key);
    };

    const { manifest, skipped, readErrors } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    expect(manifest.docs).toHaveLength(1);
    expect(manifest.docs[0].page_id).toBe("p1");
    expect(readErrors).toEqual(["pages/p2/metadata.json"]);
    // The transient key must not be confused with a permanent parse/schema failure.
    expect(skipped).toEqual([]);
  });

  it("routes a vanished key (get returns null) to readErrors, not skipped", async () => {
    const valid: PageMetadata = { ...basePage, page_id: "p1", status: "active" };
    const storage = memStorage({
      "pages/p1/metadata.json": JSON.stringify(valid),
      "pages/p2/metadata.json": JSON.stringify({ ...basePage, page_id: "p2", status: "active" }),
    });
    // p2 vanished between list and get.
    const realGet = storage.get;
    storage.get = async (key) => {
      if (key === "pages/p2/metadata.json") return null;
      return realGet(key);
    };

    const { skipped, readErrors } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    expect(readErrors).toEqual(["pages/p2/metadata.json"]);
    expect(skipped).toEqual([]);
  });

  it("routes a transient body-read throw to readErrors instead of silently treating the page as bodyless", async () => {
    // Body availability ranks family/duplicate selection (see the "empty stub
    // vs real content" family-selection test above), so a swallowed transient
    // R2 failure while reading a page's Markdown body could pick the wrong
    // canonical page. It must be routed to readErrors, exactly like a
    // transient metadata-read failure, so the caller refuses to publish.
    const valid: PageMetadata = { ...basePage, page_id: "p1", status: "active" };
    const docKey = "docs/en/docs/basics/getting-started.md";
    const storage = memStorage({
      "pages/p1/metadata.json": JSON.stringify(valid),
      [docKey]: "---\ntitle: x\n---\nReal content.\n",
    });
    const realGet = storage.get;
    storage.get = async (key) => {
      if (key === docKey) throw new Error("R2 transient");
      return realGet(key);
    };

    const { readErrors, skipped } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    expect(readErrors).toEqual([docKey]);
    expect(skipped).toEqual([]);
  });

  it("keeps corrupt-JSON blobs in skipped alongside a transient get throw in readErrors", async () => {
    const valid: PageMetadata = { ...basePage, page_id: "p1", status: "active" };
    const storage = memStorage({
      "pages/p1/metadata.json": JSON.stringify(valid),
      "pages/p2/metadata.json": "{not valid json", // permanent → skipped
      "pages/p3/metadata.json": JSON.stringify({ ...basePage, page_id: "p3", status: "active" }),
    });
    const realGet = storage.get;
    storage.get = async (key) => {
      if (key === "pages/p3/metadata.json") throw new Error("R2 transient"); // transient → readErrors
      return realGet(key);
    };

    const { skipped, readErrors } = await buildManifestFromStorage(storage, {
      databaseId: "db1",
      dataSourceId: "ds1",
    });

    expect(skipped).toEqual(["pages/p2/metadata.json"]);
    expect(readErrors).toEqual(["pages/p3/metadata.json"]);
  });
});

// ── manifestElementType ──

describe("manifestElementType", () => {
  it("returns a plain string element_type unchanged", () => {
    expect(manifestElementType({ element_type: "Toggle" })).toBe("Toggle");
    expect(manifestElementType({ element_type: "page" })).toBe("page");
  });

  it("unwraps the legacy raw Notion select object shape", () => {
    expect(manifestElementType({ element_type: { select: { name: "Toggle" } } })).toBe("Toggle");
    expect(manifestElementType({ element_type: { select: { name: "Title" } } })).toBe("Title");
  });

  it("unwraps the legacy bare-name object shape", () => {
    expect(manifestElementType({ element_type: { name: "Page" } })).toBe("Page");
  });

  it("returns empty string for null, undefined, or non-string/object values", () => {
    expect(manifestElementType({ element_type: null })).toBe("");
    expect(manifestElementType({ element_type: undefined })).toBe("");
    expect(manifestElementType({})).toBe("");
    expect(manifestElementType({ element_type: 42 })).toBe("");
  });

  // Regression: rag:chunks filters structural pages via
  // isStructuralPage(manifestElementType(doc)). Before the fix, rag:chunks
  // still unwrapped element_type as the old object shape, so a plain-string
  // "Toggle" yielded "" → isStructuralPage("") === false → Toggle/Title pages
  // leaked into rag/chunks/ (the "0/62 structural pages leak" guarantee broke).
  it("supports the rag:chunks structural-page filter on plain-string element_type", () => {
    const toggle = { element_type: "Toggle" };
    const title = { element_type: "Title" };
    const page = { element_type: "Page" };

    expect(isStructuralPage(manifestElementType(toggle))).toBe(true);
    expect(isStructuralPage(manifestElementType(title))).toBe(true);
    expect(isStructuralPage(manifestElementType(page))).toBe(false);
  });
});

// ── Production-path sidebar tests ──

function makeDoc(overrides: Partial<ManifestDoc> & { page_id: string; title: string }): ManifestDoc {
  return {
    section: null, section_order: null, element_type: "Page", drafting_status: null,
    slug: overrides.slug ?? slugify(overrides.title),
    docusaurus_id: overrides.docusaurus_id ?? overrides.slug ?? slugify(overrides.title),
    docusaurus_path: `/${overrides.slug ?? slugify(overrides.title)}`,
    r2_doc_key: `docs/en/docs/${overrides.slug ?? slugify(overrides.title)}.md`,
    r2_metadata_key: `pages/${overrides.page_id}/metadata.json`,
    source_url: `https://notion.so/${overrides.page_id}`,
    notion_last_edited_time: "2026-01-01T00:00:00.000Z",
    content_hash: "sha256:test",
    status: "active", locale: "en",
    ...overrides,
  };
}

function slugify(t: string): string { return t.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

describe("generateManifest canonical sidebars", () => {
  it("EN container with ES/PT children: canonical slug change, structural/container IDs absent", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "en-c", title: "Getting Started", slug: "getting-started", section: "10-Intro", section_order: 1, sub_items: ["es-t", "pt-t"] }),
      makeDoc({ page_id: "es-t", title: "Empezando", slug: "empezando", locale: "es", section: "10-Intro", section_order: 1 }),
      makeDoc({ page_id: "pt-t", title: "Começando", slug: "comecando", locale: "pt", section: "10-Intro", section_order: 1 }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);
    // EN sidebar: category with canonical ID
    expect(sb.en).toHaveLength(1);
    expect(sb.en[0]).toMatchObject({ type: "category", label: "Intro" });
    const enCat = sb.en[0] as SidebarCategory;
    expect(enCat.items).toEqual(["intro/getting-started"]);
    // ES sidebar
    expect(sb.es).toBeDefined();
    expect(sb.es![0]).toMatchObject({ type: "category", label: "Intro" });
    expect((sb.es![0] as SidebarCategory).items).toEqual(["intro/getting-started"]);
    // PT sidebar
    expect(sb.pt).toBeDefined();
    // No container IDs (en-c, es-t, pt-t are not directly used)
    const allIds = JSON.stringify(sb);
    expect(allIds).not.toContain("en-c");
    expect(allIds).not.toContain("es-t");
    expect(allIds).not.toContain("pt-t");
    // Canonical slug used
    expect(allIds).toContain("getting-started");
  });

  it("Title then two Toggles, content families inside each, localized labels and customProps", () => {
    const docs: ManifestDoc[] = [
      // Title (EN parent with ES/PT children)
      { ...makeDoc({ page_id: "title-en", title: "Section Heading", section: "10-Basics", section_order: 1, sub_items: ["title-es", "title-pt"], element_type: "Title" }), slug: "title-en" },
      makeDoc({ page_id: "title-es", title: "Encabezado", locale: "es", section: null as unknown as string, section_order: 1, element_type: "Title", slug: "title-es" }),
      makeDoc({ page_id: "title-pt", title: "Cabeçalho", locale: "pt", section: null as unknown as string, section_order: 1, element_type: "Title", slug: "title-pt" }),
      // Toggle Z (lexically after A but order comes from CategoryEntry)
      { ...makeDoc({ page_id: "tog-b", title: "Group B", section: "10-Basics", section_order: 30, sub_items: ["tog-es-b", "tog-pt-b"], element_type: "Toggle" }), slug: "tog-b" },
      makeDoc({ page_id: "tog-es-b", title: "Grupo B ES", locale: "es", section: null as unknown as string, section_order: 30, element_type: "Toggle", slug: "tog-es-b" }),
      // Toggle A (comes first by order)
      { ...makeDoc({ page_id: "tog-a", title: "Group A", section: "10-Basics", section_order: 10, sub_items: ["tog-es-a"], element_type: "Toggle" }), slug: "tog-a" },
      makeDoc({ page_id: "tog-es-a", title: "Grupo A ES", locale: "es", section: null as unknown as string, section_order: 10, element_type: "Toggle", slug: "tog-es-a" }),
      // Content family in Group A
      makeDoc({ page_id: "en-a", title: "Page A", section: "10-Basics", section_order: 11, sub_items: ["es-a"], slug: "page-a" }),
      makeDoc({ page_id: "es-a", title: "Página A", locale: "es", section: "10-Basics", section_order: 11, slug: "es-a" }),
      // Content family in Group B
      makeDoc({ page_id: "en-b", title: "Page B", section: "10-Basics", section_order: 31, sub_items: ["es-b"], slug: "page-b" }),
      makeDoc({ page_id: "es-b", title: "Página B", locale: "es", section: "10-Basics", section_order: 31, slug: "es-b" }),
      // Root doc (Uncategorized)
      makeDoc({ page_id: "root-doc", title: "Root Page", section: null, section_order: 1, slug: "root-page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);

    // EN sidebar
    expect(sb.en).toHaveLength(2);
    // Section category
    expect(sb.en[0]).toMatchObject({ type: "category", label: "Basics" });
    const enSec = sb.en[0] as SidebarCategory;
    // Section category has customProps { title: null }
    expect(enSec.customProps).toEqual({ title: null });
    // Group A before Group B (by order 10 < 30, not lexically)
    expect(enSec.items).toHaveLength(2);
    const enGa = enSec.items[0] as SidebarCategory;
    expect(enGa.label).toBe("Group A");
    expect(enGa.customProps).toEqual({ title: "Section Heading" }); // Title heading consumed
    expect(enGa.items).toEqual(["basics/group-a/page-a"]);

    const enGb = enSec.items[1] as SidebarCategory;
    expect(enGb.label).toBe("Group B");
    expect(enGb.customProps).toEqual({ title: null }); // heading already consumed
    expect(enGb.items).toEqual(["basics/group-b/page-b"]);

    // ES sidebar
    expect(sb.es).toBeDefined();
    const esSec = sb.es![0] as SidebarCategory;
    expect(esSec.label).toBe("Basics");
    const esGa = esSec.items[0] as SidebarCategory;
    expect(esGa.label).toBe("Grupo A ES");
    expect(esGa.customProps).toEqual({ title: "Encabezado" });

    // Root doc
    expect(sb.en[1]).toBe("root-page");
  });

  it("same toggleDir in different sections does not collide", () => {
    const docs: ManifestDoc[] = [
      { ...makeDoc({ page_id: "t-a", title: "Overview", section: "10-A", section_order: 1, sub_items: [], element_type: "Toggle" }), slug: "t-a" },
      makeDoc({ page_id: "en-a", title: "Page A", section: "10-A", section_order: 2, slug: "page-a" }),
      { ...makeDoc({ page_id: "t-b", title: "Overview", section: "20-B", section_order: 1, sub_items: [], element_type: "Toggle" }), slug: "t-b" },
      makeDoc({ page_id: "en-b", title: "Page B", section: "20-B", section_order: 2, slug: "page-b" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);
    const en0 = sb.en[0] as SidebarCategory;
    const en1 = sb.en[1] as SidebarCategory;
    expect((en0.items[0] as SidebarCategory).items).toEqual(["a/overview/page-a"]);
    expect((en1.items[0] as SidebarCategory).items).toEqual(["b/overview/page-b"]);
  });

  it("direct page ordered between two Toggles in same section", () => {
    const docs: ManifestDoc[] = [
      // Toggle 1 at order 5 with nested page
      { ...makeDoc({ page_id: "t1", title: "First Toggle", section: "10-X", section_order: 5, sub_items: [], element_type: "Toggle" }), slug: "t1" },
      makeDoc({ page_id: "tp1", title: "Toggle Page 1", section: "10-X", section_order: 6, slug: "tp1" }),
      // Title reset at order 10
      makeDoc({ page_id: "title-r", title: "Reset Title", section: "10-X", section_order: 10, slug: "title-r", element_type: "Title", sub_items: [] }),
      // Direct page at order 11
      makeDoc({ page_id: "dp", title: "Direct Page", section: "10-X", section_order: 11, slug: "direct-page" }),
      // Toggle 2 at order 15 with nested page
      { ...makeDoc({ page_id: "t2", title: "Second Toggle", section: "10-X", section_order: 15, sub_items: [], element_type: "Toggle" }), slug: "t2" },
      makeDoc({ page_id: "tp2", title: "Toggle Page 2", section: "10-X", section_order: 16, slug: "tp2" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);
    const sec = sb.en[0] as SidebarCategory;
    // Order: Toggle 1 (order 5), direct page (order 11), Toggle 2 (order 15)
    expect(sec.items).toHaveLength(3);
    expect((sec.items[0] as SidebarCategory).label).toBe("First Toggle");
    expect(sec.items[1]).toBe("x/direct-page");
    expect((sec.items[2] as SidebarCategory).label).toBe("Second Toggle");
  });

  it("Toggle nested directly under the root (Uncategorized) section keeps its own category, not flattened", () => {
    const docs: ManifestDoc[] = [
      // Plain root page BEFORE the Toggle, so it's not swept into the Toggle's
      // group (activeToggleDir only starts applying to pages after the Toggle
      // event, per the existing event-replay ordering rules).
      makeDoc({ page_id: "root-page", title: "Plain Root Page", section: null, section_order: 1, slug: "plain-root-page" }),
      { ...makeDoc({ page_id: "toggle-en", title: "Root Group", section: null, section_order: 2, slug: "toggle-en", element_type: "Toggle", sub_items: [] }) },
      makeDoc({ page_id: "en-page", title: "Nested Page", section: null, section_order: 3, slug: "nested-page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);
    // The Toggle group still renders as its own category (with a real label
    // and translation key), sitting alongside the plain root page — neither
    // is wrapped in a synthetic "Uncategorized" category.
    expect(sb.en).toHaveLength(2);
    expect(sb.en[0]).toBe("plain-root-page");
    const toggleCat = sb.en[1] as SidebarCategory;
    expect(toggleCat.type).toBe("category");
    expect(toggleCat.label).toBe("Root Group");
    expect(toggleCat.items).toEqual(["root-group/nested-page"]);
  });

  it("identical canonical slugs in different sections both appear in sidebar", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "a1", title: "Overview", section: "10-A", section_order: 1, slug: "overview" }),
      makeDoc({ page_id: "b1", title: "Overview", section: "20-B", section_order: 1, slug: "overview" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);
    expect(sb.en).toHaveLength(2);
    // Section A has "overview" and section B has "overview" — distinct final keys
    expect((sb.en[0] as SidebarCategory).items).toContain("a/overview");
    expect((sb.en[1] as SidebarCategory).items).toContain("b/overview");
  });

  it("draft page excluded from sidebar", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "active", title: "Active Page", section: "10-Basics", section_order: 1, slug: "active", status: "active" }),
      makeDoc({ page_id: "draft", title: "Draft Page", section: "10-Basics", section_order: 2, slug: "draft", status: "draft" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);
    const items = (sb.en[0] as SidebarCategory).items;
    expect(items).toContain("basics/active");
    expect(items).not.toContain("basics/draft");
  });

  it("schema round-trip: SidebarItemSchema accepts category with link and customProps title null", () => {
    const data = {
      type: "category",
      label: "Intro",
      items: ["intro/page"],
      collapsed: true,
      collapsible: true,
      link: { type: "generated-index", title: "Intro" },
      customProps: { title: null },
    };
    const result = SidebarItemSchema.parse(data);
    expect(result).toEqual(data);
  });

  it("projectSidebars preserves empty section-level category with structural Title+Toggle but omits empty Toggle", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "t1", title: "Section Title", section: "10-A", section_order: 1, slug: "t1", element_type: "Title", sub_items: [] }),
      { ...makeDoc({ page_id: "tg", title: "Empty Toggle", section: "10-A", section_order: 2, slug: "tg", element_type: "Toggle", sub_items: [] }), slug: "tg" },
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true });
    const sb = projectSidebars(plan);
    expect(sb.en).toBeDefined();
    expect(sb.en!.length).toBe(1);
    const sec = sb.en![0] as SidebarCategory;
    expect(sec.label).toBe("A");
    expect(sec.items.length).toBe(0); // Toggle omitted, no content pages
  });

  it("section and toggle categories have distinct locale-independent keys even when labels match", () => {
    const docs: ManifestDoc[] = [
      // Toggle with same title as section → section and toggle labels may collide
      { ...makeDoc({ page_id: "tg", title: "Gathering Observations & Tracks", section: "10-Gathering Observations", section_order: 1, sub_items: [], element_type: "Toggle" }), slug: "tg" },
      makeDoc({ page_id: "en-p", title: "Some Page", section: "10-Gathering Observations", section_order: 2, slug: "some-page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);

    const sec = sb.en[0] as SidebarCategory;
    // Section key must be present and different from toggle key
    expect(sec.key).toBe("gathering-observations");
    const toggle = sec.items[0] as SidebarCategory;
    expect(toggle.key).toBe("gathering-observations/gathering-observations-tracks");
    expect(sec.key).not.toBe(toggle.key);
  });

  it("toggle category keys are identical across en/es/pt sidebars", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "tg-en", title: "Customizing CoMapeo", section: "10-Basics", section_order: 1, sub_items: ["tg-es", "tg-pt"], element_type: "Toggle", slug: "tg-en" }),
      makeDoc({ page_id: "tg-es", title: "Personaliza", locale: "es", section: null as unknown as string, section_order: 1, element_type: "Toggle", slug: "tg-es" }),
      makeDoc({ page_id: "tg-pt", title: "Personaliza", locale: "pt", section: null as unknown as string, section_order: 1, element_type: "Toggle", slug: "tg-pt" }),
      makeDoc({ page_id: "en-p", title: "Page", section: "10-Basics", section_order: 2, slug: "page" }),
      makeDoc({ page_id: "es-p", title: "Página", locale: "es", section: "10-Basics", section_order: 2, slug: "es-page" }),
      makeDoc({ page_id: "pt-p", title: "Página", locale: "pt", section: "10-Basics", section_order: 2, slug: "pt-page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: false });
    const sb = projectSidebars(plan);

    function toggleKey(sidebar: SidebarCategory): string {
      return (sidebar.items[0] as SidebarCategory).key ?? "";
    }

    const enKey = toggleKey(sb.en[0] as SidebarCategory);
    const esKey = toggleKey(sb.es![0] as SidebarCategory);
    const ptKey = toggleKey(sb.pt![0] as SidebarCategory);

    expect(enKey).toBe("basics/customizing-comapeo");
    expect(esKey).toBe(enKey);
    expect(ptKey).toBe(enKey);
  });

  it("schema round-trip: SidebarCategory with key validates", () => {
    const data = {
      type: "category" as const,
      label: "Intro",
      key: "intro",
      items: ["intro/page"],
      collapsed: true,
      collapsible: true,
      link: { type: "generated-index" as const, title: "Intro" },
      customProps: { title: null },
    };
    const result = SidebarItemSchema.parse(data);
    expect(result).toEqual(data);
  });
});
