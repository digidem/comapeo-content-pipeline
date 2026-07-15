import { describe, it, expect } from "vitest";
import { buildHierarchyPlan } from "./hierarchy.js";
import type { ManifestDoc } from "../schemas/manifest.js";

function makeDoc(overrides: Partial<ManifestDoc> & { page_id: string; title: string }): ManifestDoc {
  return {
    section: null, section_order: null, element_type: "Page", drafting_status: null,
    slug: overrides.slug ?? overrides.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    docusaurus_id: overrides.docusaurus_id ?? `basics/${overrides.slug ?? ""}`,
    docusaurus_path: `/${overrides.slug ?? ""}`,
    r2_doc_key: "", r2_metadata_key: "", source_url: "", notion_last_edited_time: "",
    content_hash: "sha256:test", status: "active", locale: "en",
    ...overrides,
  };
}

describe("buildHierarchyPlan dedupe", () => {
  it("later higher-quality candidate replaces earlier with diagnostic naming both", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "early", title: "Page Draft", section: "10-Basics", section_order: 5, slug: "page-slug", element_type: "" }),
      makeDoc({ page_id: "later", title: "Real Page", section: "10-Basics", section_order: 5, slug: "page-slug", element_type: "Page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true, hasBodyById: { later: true, early: false } });
    expect(plan.canonicalPages.length).toBe(1);
    expect(plan.canonicalPages[0].pageId).toBe("later");
    const diag = plan.diagnostics.find((d) => d.category === "duplicate-public-route");
    expect(diag).toBeDefined();
    expect(diag!.detail).toContain("early");
    expect(diag!.detail).toContain("later");
  });

  it("customPropsTitle transferred from dropped to winner when winner lacks it", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "title", title: "My Heading", section: "10-Basics", section_order: 1, slug: "t", element_type: "Title", sub_items: [] }),
      makeDoc({ page_id: "early", title: "Early Page", section: "10-Basics", section_order: 2, slug: "same-slug" }),
      makeDoc({ page_id: "later", title: "Later Page", section: "10-Basics", section_order: 2, slug: "same-slug" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true, hasBodyById: { later: true, early: false, title: false } });
    const winner = plan.canonicalPages.find((cp) => cp.pageId === "later");
    expect(winner).toBeDefined();
    expect(winner!.customPropsTitle).toBe("My Heading");
  });

  it("real body beats stub body", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "stub", title: "Page", section: "10-Basics", section_order: 1, slug: "p" }),
      makeDoc({ page_id: "real", title: "Page", section: "10-Basics", section_order: 1, slug: "p" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true, hasBodyById: { real: true, stub: false } });
    expect(plan.canonicalPages[0].pageId).toBe("real");
  });

  it("fallback-backed PT stub beats standalone PT stub, enFallbackPageId is correct", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "en-cont", title: "My Page", locale: "en", section: "10-Basics", section_order: 1, slug: "en-slug", sub_items: ["pt-fam"], status: "active" }),
      makeDoc({ page_id: "pt-fam", title: "Minha Página", locale: "pt", section: "10-Basics", section_order: 1, slug: "pt-fam-slug" }),
      // standalone PT page with canonical slug matching the family (my-page)
      makeDoc({ page_id: "pt-alone", title: "Minha Página Alone", locale: "pt", section: "10-Basics", section_order: 1, slug: "my-page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true, hasBodyById: { "en-cont": true, "pt-fam": false, "pt-alone": false } });
    // The PT family member "pt-fam" has enFallbackPageId from en-cont; the standalone "pt-alone" does not
    const ptPages = plan.canonicalPages.filter((cp) => cp.locale === "pt" && cp.canonicalSlug === "my-page");
    expect(ptPages.length).toBe(1);
    expect(ptPages[0].pageId).toBe("pt-fam");
    expect(ptPages[0].enFallbackPageId).toBe("en-cont");
  });

  it("languageSourceById explicit over automated", () => {
    // doc.language_source is absent (misleading), but languageSourceById sets provenance
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "auto", title: "Page", section: "10-Basics", section_order: 1, slug: "p" }),
      makeDoc({ page_id: "expl", title: "Page", section: "10-Basics", section_order: 1, slug: "p" }),
    ];
    const plan = buildHierarchyPlan({
      docs, includeDrafts: true,
      languageSourceById: { auto: "automated", expl: "explicit" },
      hasBodyById: { auto: true, expl: true },
    });
    expect(plan.canonicalPages[0].pageId).toBe("expl");
  });

  it("root null versus literal 90-Uncategorized with same slug do not collide", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "root", title: "Root Page", section: null, section_order: 1, slug: "root-page" }),
      makeDoc({ page_id: "literal", title: "Literal Page", section: "90-Uncategorized", section_order: 1, slug: "root-page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true, hasBodyById: { root: true, literal: true } });
    expect(plan.canonicalPages.length).toBe(2);
  });

  it("three-way collision: exactly one diagnostic with pageId b, dropped a and c", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "a", title: "Page A", section: "10-Basics", section_order: 1, slug: "p", element_type: "" }),
      makeDoc({ page_id: "b", title: "Page B", section: "10-Basics", section_order: 1, slug: "p", element_type: "Page" }),
      makeDoc({ page_id: "c", title: "Page C", section: "10-Basics", section_order: 1, slug: "p", element_type: "Page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true });
    expect(plan.canonicalPages.length).toBe(1);
    const diags = plan.diagnostics.filter((d) => d.category === "duplicate-public-route");
    expect(diags.length).toBe(1); // exactly one diagnostic
    expect(diags[0].pageId).toBe("b"); // b wins (typed, lower doc index than c)
    expect(diags[0].detail).toContain("a"); // a was dropped
    expect(diags[0].detail).toContain("c"); // c was dropped
  });

  it("same slug in different sections both survive", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "a", title: "Overview", section: "10-A", section_order: 1, slug: "overview" }),
      makeDoc({ page_id: "b", title: "Overview", section: "20-B", section_order: 1, slug: "overview" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true });
    expect(plan.canonicalPages.length).toBe(2);
  });

  it("same slug in different Toggle paths both survive", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "t1", title: "Toggle 1", section: "10-Basics", section_order: 1, slug: "t1", element_type: "Toggle", sub_items: [] }),
      makeDoc({ page_id: "pa", title: "Overview", section: "10-Basics", section_order: 2, slug: "overview" }),
      makeDoc({ page_id: "t2", title: "Toggle 2", section: "10-Basics", section_order: 3, slug: "t2", element_type: "Toggle", sub_items: [] }),
      makeDoc({ page_id: "pb", title: "Overview", section: "10-Basics", section_order: 4, slug: "overview" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true });
    expect(plan.canonicalPages.length).toBe(2);
  });

  it("tuple-ambiguity: root page under Uncategorized Toggle vs direct page in section 10-A with same slug", () => {
    const docs: ManifestDoc[] = [
      // Toggle in Uncategorized at order 1
      makeDoc({ page_id: "t-root", title: "A", section: null, section_order: 1, slug: "t-root", element_type: "Toggle", sub_items: [] }),
      // Root page after Toggle → toggleDir "a", section sectionComponent "" (Uncategorized)
      makeDoc({ page_id: "root-b", title: "Root B", section: null, section_order: 2, slug: "b" }),
      // Direct page in section 10-A with no Toggle → toggleDir undefined, section "a"
      makeDoc({ page_id: "sec-b", title: "Section B", section: "10-A", section_order: 1, slug: "b" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true, hasBodyById: { "root-b": true, "sec-b": true } });
    expect(plan.canonicalPages.length).toBe(2);
    // root-b: section "" (Uncategorized), toggleDir "a" (from Toggle "A")
    const rootPage = plan.canonicalPages.find((cp) => cp.pageId === "root-b");
    expect(rootPage).toBeDefined();
    expect(rootPage!.toggleDir).toBe("a");
    expect(rootPage!.canonicalSection).toBe("Uncategorized");
    // sec-b: section "10-A" → sectionDir "a", no toggleDir
    const secPage = plan.canonicalPages.find((cp) => cp.pageId === "sec-b");
    expect(secPage).toBeDefined();
    expect(secPage!.toggleDir).toBeUndefined();
    expect(secPage!.canonicalSection).toBe("10-A");
  });
});

describe("buildHierarchyPlan edge cases", () => {
  it("an ordinary-titled empty EN sub-item does not win family selection over a real EN parent", () => {
    // Same root cause as the internal-placeholder case, but the child's title
    // carries no internal marker at all — it's just an empty editorial stub
    // sitting alongside the real translations in sub_items. selectLocaleMember
    // must not pick it purely because it's the only EN relation child; the
    // parent's real body must win.
    const docs: ManifestDoc[] = [
      makeDoc({
        page_id: "en-parent", title: "Getting Started", locale: "en",
        section: "10-Basics", section_order: 1, slug: "getting-started",
        sub_items: ["en-stub-child", "pt-child"], status: "active",
      }),
      makeDoc({
        page_id: "en-stub-child", title: "Getting Started (WIP)", locale: "en",
        section: "10-Basics", section_order: 1, slug: "getting-started-wip",
      }),
      makeDoc({
        page_id: "pt-child", title: "Introdução", locale: "pt",
        section: "10-Basics", section_order: 1, slug: "introducao",
      }),
    ];
    const plan = buildHierarchyPlan({
      docs, includeDrafts: true,
      hasBodyById: { "en-parent": true, "en-stub-child": false, "pt-child": true },
    });
    const enPage = plan.canonicalPages.find((cp) => cp.locale === "en");
    expect(enPage).toBeDefined();
    expect(enPage!.pageId).toBe("en-parent");
  });

  it("internal placeholder child does not win family selection over a real parent", () => {
    const docs: ManifestDoc[] = [
      makeDoc({
        page_id: "en-parent", title: "Getting Started", locale: "en",
        section: "10-Basics", section_order: 1, slug: "getting-started",
        sub_items: ["en-placeholder", "pt-child"], status: "active",
      }),
      makeDoc({
        page_id: "en-placeholder", title: "[Add content here]", locale: "en",
        section: "10-Basics", section_order: 1, slug: "en-placeholder-slug",
      }),
      makeDoc({
        page_id: "pt-child", title: "Introdução", locale: "pt",
        section: "10-Basics", section_order: 1, slug: "introducao",
      }),
    ];
    const plan = buildHierarchyPlan({
      docs, includeDrafts: true,
      hasBodyById: { "en-parent": true, "en-placeholder": false, "pt-child": true },
    });
    const enPage = plan.canonicalPages.find((cp) => cp.locale === "en");
    expect(enPage).toBeDefined();
    expect(enPage!.pageId).toBe("en-parent");
    // The placeholder must not surface as a published page under any locale.
    expect(plan.canonicalPages.some((cp) => cp.pageId === "en-placeholder")).toBe(false);
  });

  it("child that itself carries sub_items does not form a duplicate nested family", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "a", title: "Parent A", locale: "en", section: "10-X", section_order: 1, slug: "parent-a", sub_items: ["b"], status: "active" }),
      makeDoc({ page_id: "b", title: "Child B", locale: "es", section: "10-X", section_order: 1, slug: "child-b", sub_items: ["c"], status: "active" }),
      makeDoc({ page_id: "c", title: "Grandchild C", locale: "pt", section: "10-X", section_order: 1, slug: "grandchild-c", status: "active" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true, hasBodyById: { a: true, b: true, c: true } });
    // "b" must be published exactly once (as A's ES family member), not a second
    // time as its own family's root under a different canonical slug.
    const bPages = plan.canonicalPages.filter((cp) => cp.pageId === "b");
    expect(bPages.length).toBe(1);
    expect(bPages[0].canonicalSlug).toBe("parent-a");
    const diag = plan.diagnostics.find((d) => d.category === "nested-family-skipped");
    expect(diag).toBeDefined();
    expect(diag!.pageId).toBe("b");
  });

  it("pendingHeading does not leak across an untranslated Title event into unrelated later content", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "title1-en", title: "Heading One", section: "10-Basics", section_order: 1, slug: "title1-en", element_type: "Title", sub_items: ["title1-es"] }),
      makeDoc({ page_id: "title1-es", title: "Encabezado Uno", locale: "es", section: "10-Basics", section_order: 1, element_type: "Title", slug: "title1-es-slug" }),
      makeDoc({ page_id: "title2-en", title: "Heading Two", section: "10-Basics", section_order: 3, slug: "title2-en", element_type: "Title", sub_items: [] }),
      makeDoc({ page_id: "es-page", title: "Página ES", locale: "es", section: "10-Basics", section_order: 4, slug: "es-page" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true });
    const esPage = plan.canonicalPages.find((cp) => cp.pageId === "es-page");
    expect(esPage).toBeDefined();
    // Title Two (order 3, EN-only) must reset the pending heading for ES even
    // though ES has no translated row there — otherwise Title One's heading
    // ("Encabezado Uno") would incorrectly bleed onto this unrelated ES page.
    expect(esPage!.customPropsTitle).toBeUndefined();
  });

  it("Toggle without a translated member for a locale still gets a fallback localized category when pages are nested under it", () => {
    const docs: ManifestDoc[] = [
      makeDoc({ page_id: "toggle1-en", title: "Group A", section: "10-Basics", section_order: 1, slug: "toggle1-en", element_type: "Toggle", sub_items: ["toggle1-es"] }),
      makeDoc({ page_id: "toggle1-es", title: "Grupo A", locale: "es", section: "10-Basics", section_order: 1, element_type: "Toggle", slug: "toggle1-es-slug" }),
      makeDoc({ page_id: "toggle2-en", title: "Group B", section: "10-Basics", section_order: 5, slug: "toggle2-en", element_type: "Toggle", sub_items: [] }),
      makeDoc({ page_id: "en-page2", title: "Page Two", section: "10-Basics", section_order: 6, slug: "page-two", sub_items: ["es-page2"] }),
      makeDoc({ page_id: "es-page2", title: "Página Dos", locale: "es", section: "10-Basics", section_order: 6, slug: "pagina-dos" }),
    ];
    const plan = buildHierarchyPlan({ docs, includeDrafts: true });
    const esPage2 = plan.canonicalPages.find((cp) => cp.locale === "es" && cp.pageId === "es-page2");
    expect(esPage2).toBeDefined();
    expect(esPage2!.toggleDir).toBe("group-b");
    const esToggleCat = plan.categories.find((c) => c.locale === "es" && c.toggleDir === "group-b");
    expect(esToggleCat).toBeDefined();
    expect(esToggleCat!.label).toBe("Group B");
  });
});
