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
 * Confirmed against the live DB (Phase 2.0, 2026-06-27).
 * "Unplublished" is the actual Notion typo — kept verbatim intentionally.
 * These values must stay in sync with DEPRECATED_PATTERNS in status.ts.
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
 * Covers full language names, automated-translation variants, and pass-through ISO codes.
 */
export const NOTION_LOCALES: Record<string, string> = {
  English: "en",
  Portuguese: "pt",
  Spanish: "es",
  "pt-BR": "pt",
  // Automated translation variants used by the Notion workflow
  "es - automated": "es",
  "pt - automated": "pt",
  // Pass-through ISO codes already in canonical form
  es: "es",
  en: "en",
  pt: "pt",
};

/**
 * Normalize a Notion Language property value to a canonical ISO locale code.
 * Handles full language names ("English"), automated variants ("es - automated"),
 * and ISO codes ("pt"). Falls back to lowercasing the input for unknown values.
 */
export function normalizeLocale(locale: string | null | undefined): string {
  if (!locale) return "en";
  return NOTION_LOCALES[locale] ?? locale.toLowerCase();
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
