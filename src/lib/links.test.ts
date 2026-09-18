import { describe, it, expect } from "vitest";
import {
  slugifyAnchor,
  buildRouteMaps,
  resolveInternalLinks,
  type DocLite,
} from "./links.js";

describe("slugifyAnchor", () => {
  it("lowercases and hyphenates spaced/cased anchors", () => {
    expect(slugifyAnchor("Edit an observation")).toBe("edit-an-observation");
  });
  it("lowercases already-hyphenated anchors", () => {
    expect(slugifyAnchor("Edit-an-observation")).toBe("edit-an-observation");
    expect(slugifyAnchor("roles-available-in-CoMapeo")).toBe(
      "roles-available-in-comapeo",
    );
  });
  it("trims and drops punctuation (github-slugger semantics)", () => {
    expect(slugifyAnchor("  Adding Photos! ")).toBe("adding-photos");
  });
  it("keeps accented letters (localized anchors)", () => {
    expect(slugifyAnchor("Edición de Observaciones")).toBe(
      "edición-de-observaciones",
    );
  });
});

describe("buildRouteMaps + resolveInternalLinks", () => {
  // Group: container parent (suffixed slug) with en + es + pt children.
  const docs: DocLite[] = [
    { page_id: "parent-1", slug: "inviting-collaborators-2331b081", title: "Inviting Collaborators" },
    { page_id: "en-1", slug: "inviting-collaborators", title: "Inviting Collaborators" },
    { page_id: "es-1", slug: "invita-colaboradores", title: "Invita a colaboradores" },
    { page_id: "pt-1", slug: "convidar-colaboradores", title: "Convidar colaboradores" },
    { page_id: "standalone-1", slug: "encryption-and-security", title: "Encryption & Security" },
  ];

  // Translations (and the en child) inherit the cleaned parent slug.
  const translationMap = new Map<string, string>([
    ["en-1", "inviting-collaborators"],
    ["es-1", "inviting-collaborators"],
    ["pt-1", "inviting-collaborators"],
  ]);
  // The container parent resolves to the same clean group slug as its children.
  const containerCanonical = new Map<string, string>([
    ["parent-1", "inviting-collaborators"],
  ]);
  const canonicalSlugOf = (id: string): string | null => {
    if (translationMap.has(id)) return translationMap.get(id)!;
    if (containerCanonical.has(id)) return containerCanonical.get(id)!;
    const d = docs.find((x) => x.page_id === id);
    return d ? d.slug : null;
  };
  const maps = buildRouteMaps(docs, canonicalSlugOf);

  it("rewrites a clean English link unchanged-but-normalized (en file)", () => {
    const out = resolveInternalLinks("See [here](/docs/inviting-collaborators).", {
      locale: "en",
      maps,
    });
    expect(out).toBe("See [here](/docs/inviting-collaborators).");
  });

  it("maps a localized slug to the en slug with locale prefix (es file)", () => {
    const out = resolveInternalLinks("Ver [aquí](/docs/invita-colaboradores).", {
      locale: "es",
      maps,
    });
    expect(out).toBe("Ver [aquí](/es/docs/inviting-collaborators).");
  });

  it("rewrites a suffixed slug to the clean route", () => {
    const out = resolveInternalLinks(
      "[x](/docs/inviting-collaborators-2331b081)",
      { locale: "en", maps },
    );
    expect(out).toBe("[x](/docs/inviting-collaborators)");
  });

  it("resolves a raw page-id link", () => {
    const out = resolveInternalLinks("[x](/26a1b08162d5803991cfec8619e7d676)", {
      locale: "en",
      maps,
    });
    // unknown page id → unchanged
    expect(out).toBe("[x](/26a1b08162d5803991cfec8619e7d676)");
    const out2 = resolveInternalLinks("[x](/es1000000000000000000000000000000)", {
      locale: "en",
      maps,
    });
    expect(out2).toBe("[x](/es1000000000000000000000000000000)");
  });

  it("strips a notion.so host then resolves", () => {
    const out = resolveInternalLinks(
      "[x](https://www.notion.so/docs/inviting-collaborators)",
      { locale: "pt", maps },
    );
    expect(out).toBe("[x](/pt/docs/inviting-collaborators)");
  });

  it("slugifies anchors and preserves them", () => {
    const out = resolveInternalLinks(
      "[x](/docs/inviting-collaborators#Roles-Available)",
      { locale: "en", maps },
    );
    expect(out).toBe("[x](/docs/inviting-collaborators#roles-available)");
  });

  it("drops trailing slash and existing locale prefix before resolving", () => {
    const out = resolveInternalLinks(
      "[x](/es/docs/invita-colaboradores/#Exchange-Problems)",
      { locale: "es", maps },
    );
    expect(out).toBe("[x](/es/docs/inviting-collaborators#exchange-problems)");
  });

  it("normalizes %20 / double-dash slug variants", () => {
    const out = resolveInternalLinks("[x](/docs/encryption--and-security)", {
      locale: "en",
      maps,
    });
    expect(out).toBe("[x](/docs/encryption-and-security)");
  });

  it("slugifies same-page anchors", () => {
    const out = resolveInternalLinks("[x](#Adding Photos)", { locale: "en", maps });
    expect(out).toBe("[x](#adding-photos)");
  });

  it("doesn't misparse a link label containing '](' as two links (child_page titles)", () => {
    // convertChildPage (notion-converter.ts) strips "[" and "]" from titles
    // rather than backslash-escaping them, precisely because this regex has
    // no notion of escapes and would otherwise split an escaped-but-present
    // "]" into a spurious second link here.
    const out = resolveInternalLinks(
      "[📄 Foo(https://evil.example)Bar](https://www.notion.so/26a1b08162d5803991cfec8619e7d676)",
      { locale: "en", maps },
    );
    // one link, unknown page id → target left unchanged, label untouched
    expect(out).toBe(
      "[📄 Foo(https://evil.example)Bar](https://www.notion.so/26a1b08162d5803991cfec8619e7d676)",
    );
  });

  it("leaves images and external links untouched", () => {
    const out = resolveInternalLinks(
      "![alt](/docs/inviting-collaborators) and [ext](https://example.com/docs/x)",
      { locale: "es", maps },
    );
    expect(out).toBe(
      "![alt](/docs/inviting-collaborators) and [ext](https://example.com/docs/x)",
    );
  });

  it("leaves unknown internal targets unchanged", () => {
    const out = resolveInternalLinks("[x](/docs/does-not-exist)", {
      locale: "en",
      maps,
    });
    expect(out).toBe("[x](/docs/does-not-exist)");
  });

  it("resolves canonical slug to localized prefix when slug differs from all source slugs and title-derived slugs", () => {
    // Canonical slug "getting-started" does NOT match any source slug or title-derived key.
    // EN container has slug "gs-en" and title "Intro to CoMapeo" → title slug "intro-to-comapeo"
    // EN child has slug "start-here", PT child has slug "comecar"
    // The canonical slug itself must still resolve through Pass 3.
    const docs: DocLite[] = [
      { page_id: "en-c", slug: "gs-en", title: "Intro to CoMapeo" },
      { page_id: "en-child", slug: "start-here", title: "Start Here" },
      { page_id: "pt-child", slug: "comecar", title: "Começar" },
    ];
    const canonicalSlugOf = (pid: string) => {
      if (pid === "en-c" || pid === "en-child" || pid === "pt-child") return "getting-started";
      return null;
    };
    const maps = buildRouteMaps(docs, canonicalSlugOf);
    // "getting-started" differs from all source slugs and title-derived slugs,
    // but Pass 3 registers it from the canonical slug itself
    const ptOut = resolveInternalLinks("[link](/docs/getting-started)", { locale: "pt", maps });
    expect(ptOut).toBe("[link](/pt/docs/getting-started)");
  });

  it("auto-heals stale localized slugs via KNOWN_SLUG_ALIASES", () => {
    const testDocs: DocLite[] = [
      { page_id: "ex-1", slug: "understanding-how-exchange-works", title: "Understanding How Exchange Works" },
      { page_id: "roles-1", slug: "selecting-device-roles-and-teams", title: "Selecting Device Roles and Teams" },
      { page_id: "proj-1", slug: "understanding-projects", title: "Understanding Projects" },
    ];
    const testMaps = buildRouteMaps(testDocs, (id) => {
      const d = testDocs.find((x) => x.page_id === id);
      return d ? d.slug : null;
    });

    // Stale Spanish exchange slug
    const esOut = resolveInternalLinks(
      "Ver [Intercambio](/docs/entiende-como-funciona-el-intercambio)",
      { locale: "es", maps: testMaps },
    );
    expect(esOut).toBe("Ver [Intercambio](/es/docs/understanding-how-exchange-works)");

    // Stale Spanish roles slug
    const esRoles = resolveInternalLinks(
      "Ver [Roles](/docs/seleccion-de-roles-y-equipos-de-dispositivos)",
      { locale: "es", maps: testMaps },
    );
    expect(esRoles).toBe("Ver [Roles](/es/docs/selecting-device-roles-and-teams)");

    // Stale Spanish project slug
    const esProj = resolveInternalLinks(
      "Ver [Bases](/docs/comprende-las-bases-sobre-proyectos)",
      { locale: "es", maps: testMaps },
    );
    expect(esProj).toBe("Ver [Bases](/es/docs/understanding-projects)");
  });

  it("auto-heals path typos (missing leading slash, singular /doc/)", () => {
    const testDocs: DocLite[] = [
      { page_id: "obs-1", slug: "using-observations-outside-of-comapeo", title: "Using Observations outside of CoMapeo" },
      { page_id: "del-1", slug: "deleting-observations-and-tracks", title: "Deleting Observations and Tracks" },
    ];
    const testMaps = buildRouteMaps(testDocs, (id) => {
      const d = testDocs.find((x) => x.page_id === id);
      return d ? d.slug : null;
    });

    // /doc/ typo
    const out1 = resolveInternalLinks(
      "See [link](/doc/using-observations-outside-of-comapeo)",
      { locale: "en", maps: testMaps },
    );
    expect(out1).toBe("See [link](/docs/using-observations-outside-of-comapeo)");

    // Missing leading slash
    const out2 = resolveInternalLinks(
      "See [link](docs/deleting-observations-and-tracks)",
      { locale: "en", maps: testMaps },
    );
    expect(out2).toBe("See [link](/docs/deleting-observations-and-tracks)");
  });

  it("cleans nested markdown link anomalies from Notion authoring", () => {
    const testDocs: DocLite[] = [
      { page_id: "del-1", slug: "deleting-observations-and-tracks", title: "Deleting Observations & Tracks" },
    ];
    const testMaps = buildRouteMaps(testDocs, (id) => {
      const d = testDocs.find((x) => x.page_id === id);
      return d ? d.slug : null;
    });

    const malformed = "Go to 🔗 [Deleting Observations & Tracks]([Deleting%20Observations%20&%20Tracks](/docs/editing-observations-and-tracks)%20%20/docs/deleting-observations-and-tracks) to learn more";
    const out = resolveInternalLinks(malformed, { locale: "en", maps: testMaps });
    expect(out).toBe("Go to 🔗 [Deleting Observations & Tracks](/docs/deleting-observations-and-tracks) to learn more");
  });

  it("maps cross-language heading anchors for known target docs", () => {
    const testDocs: DocLite[] = [
      { page_id: "tb-1", slug: "troubleshooting-mapping-with-collaborators", title: "Troubleshooting: Mapping with Collaborators" },
      { page_id: "cs-1", slug: "common-solutions", title: "Common Solutions" },
    ];
    const testMaps = buildRouteMaps(testDocs, (id) => {
      const d = testDocs.find((x) => x.page_id === id);
      return d ? d.slug : null;
    });

    // ES anchor mapping for troubleshooting-mapping-with-collaborators
    const esOut = resolveInternalLinks(
      "Ver [Problemas](/docs/troubleshooting-mapping-with-collaborators#exchange-problems)",
      { locale: "es", maps: testMaps },
    );
    expect(esOut).toBe("Ver [Problemas](/es/docs/troubleshooting-mapping-with-collaborators#problemas-de-intercambio)");

    // PT anchor mapping for common-solutions
    const ptOut = resolveInternalLinks(
      "Ver [Permissões](/docs/common-solutions#solution-check-app-permissions)",
      { locale: "pt", maps: testMaps },
    );
    expect(ptOut).toBe("Ver [Permissões](/pt/docs/common-solutions#solução-verificar-permissões-do-aplicativo)");
  });

  it("falls back to resolving target from link label text when target is an unknown hex id", () => {
    const testDocs: DocLite[] = [
      { page_id: "track-1", slug: "creating-a-new-track", title: "Criando uma nova trilha" },
    ];
    const testMaps = buildRouteMaps(testDocs, (id) => {
      const d = testDocs.find((x) => x.page_id === id);
      return d ? d.slug : null;
    });

    const out = resolveInternalLinks(
      "[✔️ Acesse 🔗 Criando uma nova trilha](/26a1b08162d5803991cfec8619e7d676)",
      { locale: "pt", maps: testMaps },
    );
    expect(out).toBe("[✔️ Acesse 🔗 Criando uma nova trilha](/pt/docs/creating-a-new-track)");
  });

  it("resolves category links with canonical category directory keys", () => {
    const testMaps = buildRouteMaps([], () => null);

    const esOut = resolveInternalLinks(
      "Ir a [Solución de problemas](/category/solucion-de-problemas)",
      { locale: "es", maps: testMaps },
    );
    expect(esOut).toBe("Ir a [Solución de problemas](/es/docs/category/miscellaneous)");

    const enOut = resolveInternalLinks(
      "Go to [Managing Projects](/category/managing-projects)",
      { locale: "en", maps: testMaps },
    );
    expect(enOut).toBe("Go to [Managing Projects](/docs/category/managing-projects)");
  });
});
