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
  it("collapses repeats and trims", () => {
    expect(slugifyAnchor("  Adding   Photos!! ")).toBe("adding-photos");
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
});
