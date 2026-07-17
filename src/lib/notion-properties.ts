/**
 * Centralized Notion property name constants, API configuration, and helpers.
 * Update these if Notion database property names change.
 */
export const NOTION_PROPERTIES = {
  TITLE: "Content elements",
  TITLE_FALLBACK_NAME: "Name",
  TITLE_FALLBACK_TITLE: "Title",
  TITLE_FALLBACK_LOWERCASE: "title",
  ELEMENT_TYPE: "Element Type",
  /**
   * The live Notion property is "Publish Status" (select type).
   * Note: the internal metadata field `drafting_status` intentionally keeps its
   * name (Decision 4) — it is independent of this Notion property name.
   */
  PUBLISH_STATUS: "Publish Status",
  SUB_ITEM: "Sub-item",
  LANGUAGE: "Language",
  CONTENT_SECTION: "Content Section",
  ORDER: "Order",
  KEYWORDS: "Keywords",
  TAGS: "Tags",
  DATE_PUBLISHED: "Date Published",
  PARENT_ITEM: "Parent item",
} as const;

/**
 * Real Notion "Publish Status" select values that mean "take this page down".
 * Confirmed against the live DB (2026-07-01).
 * "Unplublished" is the actual Notion typo — kept verbatim intentionally.
 * mapStatus invariant: every value here maps to "deprecated" or "archived".
 *   "Remove"       → "deprecated"  (explicit removal request)
 *   "Unplublished" → "archived"    (page was live, now taken down)
 */
export const DEAD_STATUSES = ["Remove", "Unplublished"] as const;

/** Notion API configuration constants. */
export const NOTION_API = {
  BASE_URL: "https://api.notion.com/v1",
  /** API version for the legacy /v1/search endpoint. */
  SEARCH_VERSION: "2026-03-11",
  /** API version for the v5 dataSources.query endpoint. */
  DATABASE_VERSION: "2025-09-03",
  DEFAULT_PAGE_SIZE: 100,
} as const;

/** Notion element type string constants. */
export const NOTION_ELEMENT_TYPES = {
  PAGE: "page",
  TOGGLE: "toggle",
  TITLE: "title",
} as const;

/**
 * Returns true if the element type represents a publishable content page.
 * Content pages have type "page" (case-insensitive) or an empty/missing type.
 */
export function isContentPage(elementType: string): boolean {
  return elementType === "" || /^page$/i.test(elementType);
}

/**
 * Returns true if the element type is a structural (non-content) page.
 * Structural pages are toggle sections and title rows — they are not directly published.
 */
export function isStructuralPage(elementType: string): boolean {
  return /^(toggle|title)$/i.test(elementType);
}

/**
 * Notion Language property value → ISO locale code mappings.
 * Keys are the actual Notion select-option labels (display-cased).
 * Lookup is case-insensitive — see normalizeLocale.
 *
 * Live Notion select options (confirmed 2026-07-01):
 *   "English", "Portuguese", "PT - automated", "Spanish", "ES - automated"
 */
export const NOTION_LOCALES: Record<string, string> = {
  English: "en",
  Portuguese: "pt",
  Spanish: "es",
  "pt-BR": "pt",
  // Live Notion automated-translation select values (title-cased prefix)
  "ES - automated": "es",
  "PT - automated": "pt",
  // Pass-through ISO codes already in canonical form
  es: "es",
  en: "en",
  pt: "pt",
};

/** Lowercase-keyed version of NOTION_LOCALES for case-insensitive lookup. */
const NOTION_LOCALES_LOWER: Record<string, string> = Object.fromEntries(
  Object.entries(NOTION_LOCALES).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * Normalize a Notion Language property value to a canonical ISO locale code.
 * Lookup is case-insensitive so the live Notion values "ES - automated" and
 * "PT - automated" (title-cased) resolve to "es" and "pt" correctly.
 * Falls back to lowercasing the input for unknown values.
 * Returns "en" for null/undefined/empty input.
 */
export function normalizeLocale(locale: string | null | undefined): string {
  if (!locale) return "en";
  return NOTION_LOCALES_LOWER[locale.toLowerCase()] ?? locale.toLowerCase();
}

/** Section name constants for consistent labeling across CLI and Worker. */
export const SECTION_NAMES = {
  UNCATEGORIZED: "Uncategorized",
} as const;

/**
 * Sidebar sort order assigned to the Uncategorized section so it always
 * appears after all explicitly numbered sections.
 */
export const UNCATEGORIZED_ORDER = 9999;

/**
 * Read a manifest doc's element_type. Conformant manifests carry a plain string;
 * manifests generated before the fix carried the raw Notion select object —
 * keep unwrapping those so older manifests still work.
 */
export function manifestElementType(doc: { element_type?: unknown }): string {
  const et = doc.element_type;
  if (typeof et === "string") return et;
  if (et && typeof et === "object") {
    const o = et as { select?: { name?: string } | null; name?: string };
    return o.select?.name ?? o.name ?? "";
  }
  return "";
}

/**
 * Strip number prefix from section name for display labels.
 * "10-Preparing to use CoMapeo" → "Preparing to use CoMapeo"
 * "90+ - Miscellaneous" → "Miscellaneous"
 */
export function stripSectionPrefix(sectionName: string): string {
  return sectionName.replace(/^\d+[+-]\s*(?:-\s*)?/, "").trim();
}

/**
 * Curated translations for section labels, used as fallback when a locale
 * lacks a Title or Toggle page providing a translated label.
 */
export const CURATED_SECTION_TRANSLATIONS: Record<string, Record<string, string>> = {
  pt: {
    "Uncategorized": "Sem Categoria",
    "Overview": "Visão Geral",
    "Preparing to use CoMapeo": "Preparando-se para usar o CoMapeo",
    "Gathering Observations & Tracks": "Coletando Observações e Trilhas",
    "Reviewing Observations & Tracks": "Revisando Observações e Trilhas",
    "Exchanging Observations": "Trocando Observações",
    "Managing Data and Privacy": "Gestão de Privacidade e Segurança de Dados",
    "Managing Data Privacy and Security": "Gestão de Privacidade de Dados e Segurança",
    "Managing Projects": "Gerenciando Projetos",
    "Sharing and Exporting different data types": "Compartilhando e Exportando Diferentes Tipos de Dados",
    "Troubleshooting": "Solução de Problemas",
    "Using Exchange Over the Internet": "Usando Exchange pela Internet",
    "Miscellaneous": "Variado",
    "Ending a project": "Encerrando um Projeto",
  },
  es: {
    "Uncategorized": "Sin Categoría",
    "Overview": "Vista General",
    "Preparing to use CoMapeo": "Preparándose para usar CoMapeo",
    "Gathering Observations & Tracks": "Registrando Observaciones y Trayectos",
    "Reviewing Observations & Tracks": "Revisando Observaciones y Trayectos",
    "Exchanging Observations": "Intercambiando Observaciones",
    "Managing Data and Privacy": "Gestión de Privacidad y Seguridad de Datos",
    "Managing Data Privacy and Security": "Gestión de Privacidad de Datos y Seguridad",
    "Managing Projects": "Gestión de Proyectos",
    "Sharing and Exporting different data types": "Compartir y Exportar Diferentes Tipos de Datos",
    "Troubleshooting": "Solución de Problemas",
    "Using Exchange Over the Internet": "Usando Exchange por Internet",
    "Miscellaneous": "Misceláneas",
    "Ending a project": "Finalizar un Proyecto",
  },
};
