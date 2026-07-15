/**
 * Manifest generation — produces `manifests/latest.json`.
 */

import type { ContentManifest, ManifestDoc, SidebarItem, SidebarCategory } from "../schemas/manifest.js";
import type { PageMetadata } from "../schemas/metadata.js";
import { PageMetadataSchema } from "../schemas/metadata.js";
import { stripSectionPrefix, CURATED_SECTION_TRANSLATIONS, SECTION_NAMES, UNCATEGORIZED_ORDER } from "./notion-properties.js";
import { buildHierarchyPlan, toSectionDir, type HierarchyPlan } from "./hierarchy.js";
import { isStubBody } from "./stub-body.js";

export interface ManifestInput {
  databaseId: string;
  dataSourceId: string;
  pages: PageMetadata[];
  /** Locale → Docusaurus sidebar items */
  sidebars?: Record<string, SidebarItem[]>;
  ragChunksManifestKey?: string;
  /**
   * Page-id → "has a real (non-stub) body" map, used for hierarchy family
   * selection (buildSidebarsFromPlan). Only meaningful when `sidebars` is
   * omitted (sidebars are then built from the plan); ignored otherwise.
   */
  hasBodyById?: Record<string, boolean>;
}

/**
 * Generate a ContentManifest from a list of synced page metadata.
 */
export function generateManifest(input: ManifestInput): ContentManifest {
  const docs: ManifestDoc[] = input.pages.map((meta) => {
    const doc: ManifestDoc = {
      page_id: meta.page_id,
      title: meta.title,
      locale: meta.locale,
      section: meta.section,
      section_order: meta.section_order,
      // Use the extracted top-level fields, NOT meta.properties — that record
      // holds raw Notion property objects (select/rollup/…), and casting them
      // to string produced schema-invalid manifests (objects in element_type).
      element_type: meta.element_type ?? null,
      drafting_status: meta.drafting_status ?? null,
      slug: meta.slug,
      docusaurus_id: meta.docusaurus_id,
      docusaurus_path: `/${meta.slug}`,
      r2_doc_key: buildR2DocKey(meta),
      r2_metadata_key: buildR2MetadataKey(meta.page_id),
      source_url: meta.source_url,
      notion_last_edited_time: meta.notion_last_edited_time,
      content_hash: meta.content_hash,
      status: meta.status,
      sub_items: meta.sub_items,
      language_source: meta.language_source,
    };
    return doc;
  });

  const manifest: ContentManifest = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    source: {
      type: "notion",
      database_id: input.databaseId,
      data_source_id: input.dataSourceId,
    },
    docs,
    sidebars: input.sidebars ?? buildSidebarsFromPlan(docs, input.hasBodyById),
  };

  if (input.ragChunksManifestKey) {
    manifest.rag = {
      chunks_manifest_key: input.ragChunksManifestKey,
    };
  }

  return manifest;
}

// ── Manifest consumer helpers ──

/**
 * Read a manifest doc's element_type. Re-exported from notion-properties.ts
 * where the canonical definition lives (avoids hierarchy→manifest import cycle).
 */
export { manifestElementType } from "./notion-properties.js";

// ── Key builders ──

function buildR2DocKey(meta: PageMetadata): string {
  const section = meta.section ? `${meta.section}/` : "";
  return `docs/${meta.locale}/docs/${section}${meta.slug}.md`;
}

function buildR2MetadataKey(pageId: string): string {
  return `pages/${pageId}/metadata.json`;
}

// ── Sidebar generation ──

/**
 * Build Docusaurus sidebar arrays from the hierarchy plan.
 * Content-only: no structural or container IDs. Uses localized Toggle labels
 * and canonical paths/slugs.
 */
function buildSidebarsFromPlan(docs: ManifestDoc[], hasBodyById?: Record<string, boolean>): Record<string, SidebarItem[]> {
  const plan = buildHierarchyPlan({ docs, includeDrafts: false, hasBodyById });
  return projectSidebars(plan);
}

/**
 * Project Docusaurus sidebars from a hierarchy plan.
 * Shared between manifest generation and Worker sidebar rebuild.
 */
export function projectSidebars(plan: HierarchyPlan): Record<string, SidebarItem[]> {
  const sidebars: Record<string, SidebarItem[]> = {};

  // Collect canonical pages per locale + section + toggle
  // Store pages with their canonicalOrder for stable sorting
  interface PageEntry { id: string; order: number; idx: number; pageId: string; }
  const localePages = new Map<string, Map<string, Map<string, PageEntry[]>>>();

  for (let i = 0; i < plan.canonicalPages.length; i++) {
    const cp = plan.canonicalPages[i];
    const id = buildSidebarId(cp.canonicalSection, cp.toggleDir, cp.canonicalSlug);
    if (!localePages.has(cp.locale)) localePages.set(cp.locale, new Map());
    const bySection = localePages.get(cp.locale)!;
    const sectionKey = cp.canonicalSection;
    if (!bySection.has(sectionKey)) bySection.set(sectionKey, new Map());
    const byToggle = bySection.get(sectionKey)!;
    const toggleKey = cp.toggleDir ?? "";
    if (!byToggle.has(toggleKey)) byToggle.set(toggleKey, []);
    byToggle.get(toggleKey)!.push({ id, order: cp.canonicalOrder, idx: i, pageId: cp.pageId });
  }

  // Seed locale+section entries from plan.categories so empty sections
  // with structural rows still appear in the sidebar (high-level categories).
  for (const cat of plan.categories) {
    if (cat.toggleDir) continue; // only section-level
    if (!localePages.has(cat.locale)) localePages.set(cat.locale, new Map());
    const bySection = localePages.get(cat.locale)!;
    const sectionKey = plan.canonicalPages.find((cp) => toSectionDir(cp.canonicalSection) === cat.sectionDir)?.canonicalSection ?? cat.sectionDir;
    if (!bySection.has(sectionKey)) bySection.set(sectionKey, new Map());
    // Ensure empty toggle key exists so the section renders
    const byToggle = bySection.get(sectionKey)!;
    if (!byToggle.has("")) byToggle.set("", []);
  }

  // Sort pages within each toggle by canonicalOrder then original index then pageId
  for (const [, bySection] of localePages) {
    for (const [, byToggle] of bySection) {
      for (const [, entries] of byToggle) {
        entries.sort((a, b) => {
          if (a.order !== b.order) return a.order - b.order;
          if (a.idx !== b.idx) return a.idx - b.idx;
          return a.pageId.localeCompare(b.pageId);
        });
      }
    }
  }

  for (const [locale, bySection] of localePages) {
    const items: SidebarItem[] = [];

    // Sort sections by CategoryEntry position from plan
    const sectionPositions = new Map<string, number>();
    for (const cat of plan.categories) {
      if (cat.toggleDir) continue;
      if (cat.locale === locale && !sectionPositions.has(cat.sectionDir)) {
        sectionPositions.set(cat.sectionDir, cat.position);
      }
    }
    const sections = [...bySection.keys()].sort((a, b) => {
      const pa = sectionPositions.get(toSectionDir(a)) ?? 9999;
      const pb = sectionPositions.get(toSectionDir(b)) ?? 9999;
      if (pa !== pb) return pa - pb;
      return sectionSortKey(a) - sectionSortKey(b);
    });

    for (const section of sections) {
      const byToggle = bySection.get(section)!;
      const secCat = plan.categories.find((c) => c.locale === locale && c.sectionDir === toSectionDir(section) && !c.toggleDir);
      const label = secCat?.label ?? stripSectionPrefix(section);
      const sectionDir = toSectionDir(section);
      const isRootSection = section === SECTION_NAMES.UNCATEGORIZED;

      // Collect toggle keys sorted by Toggle CategoryEntry position
      const toggleKeys = [...byToggle.keys()].filter((tk) => tk !== "");
      const togglePositions = new Map<string, number>();
      for (const cat of plan.categories) {
        if (!cat.toggleDir) continue;
        if (cat.locale === locale && cat.sectionDir === sectionDir) {
          if (!togglePositions.has(cat.toggleDir)) togglePositions.set(cat.toggleDir, cat.position);
        }
      }
      toggleKeys.sort((a, b) => {
        const pa = togglePositions.get(a) ?? 9999;
        const pb = togglePositions.get(b) ?? 9999;
        if (pa !== pb) return pa - pb;
        return a.localeCompare(b);
      });

      // Build combined section items: Toggle categories and direct pages
      // interleaved by order. This applies identically to the root
      // ("Uncategorized") section — a Toggle nested directly under root still
      // needs its own category (matching the real on-disk directory
      // docs-pull.ts writes for it); only plain root pages render as bare IDs.
      const combinedItems: Array<{ order: number; idx: number; item: SidebarItem }> = [];

      for (const tk of toggleKeys) {
        const entries = byToggle.get(tk);
        if (!entries || entries.length === 0) continue;
        const cat = plan.categories.find((c) => c.locale === locale && c.sectionDir === sectionDir && c.toggleDir === tk);
        const tLabel = cat?.label ?? tk;
        const catPos = cat?.position ?? 9999;
        const catIdx = plan.categories.indexOf(cat!);
        const catItem: SidebarCategory = {
          type: "category",
          label: tLabel,
          items: entries.map((e) => e.id),
          collapsible: true,
          collapsed: true,
          link: { type: "generated-index", title: tLabel },
          customProps: cat?.customPropsTitle ? { title: cat.customPropsTitle } : { title: null },
          key: cat?.key,
        };
        combinedItems.push({ order: catPos, idx: catIdx, item: catItem });
      }

      // Direct (non-toggle) pages within this section
      const noTogglePages = byToggle.get("") ?? [];
      for (const e of noTogglePages) {
        combinedItems.push({ order: e.order, idx: e.idx, item: e.id });
      }

      // Sort by order then idx
      combinedItems.sort((a, b) => a.order !== b.order ? a.order - b.order : a.idx - b.idx);
      const sectionItems: SidebarItem[] = combinedItems.map((c) => c.item);

      if (isRootSection) {
        // Root pages render as plain sidebar IDs with no wrapping category —
        // Toggle categories nested under root are still pushed as their own
        // entries, just not wrapped in a synthetic "Uncategorized" category.
        items.push(...sectionItems);
        continue;
      }

      items.push({
        type: "category",
        label,
        items: sectionItems,
        collapsible: true,
        collapsed: true,
        link: { type: "generated-index", title: label },
        customProps: secCat?.customPropsTitle ? { title: secCat.customPropsTitle } : { title: null },
        key: secCat?.key,
      });
    }
    sidebars[locale] = items;
  }
  return sidebars;
}

function buildSidebarId(section: string, toggleDir: string | undefined, slug: string): string {
  const parts: string[] = [];
  if (section && section !== SECTION_NAMES.UNCATEGORIZED) parts.push(toSectionDir(section));
  if (toggleDir) parts.push(toggleDir);
  parts.push(slug);
  return parts.join("/");
}

function sectionSortKey(sec: string): number {
  if (sec === SECTION_NAMES.UNCATEGORIZED) return UNCATEGORIZED_ORDER;
  const m = sec.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Legacy flat sidebar generator. Used by tests that assert original behavior.
 * generateManifest uses buildHierarchyPlan + projectSidebars instead.
 */
export function generateSidebarJson(pages: PageMetadata[]): SidebarItem[] {
  const active = pages.filter((p) => p.status === "active");

  const categorized = new Map<string, PageMetadata[]>();
  const uncategorized: PageMetadata[] = [];

  for (const page of active) {
    if (page.section) {
      const list = categorized.get(page.section) ?? [];
      list.push(page);
      categorized.set(page.section, list);
    } else {
      uncategorized.push(page);
    }
  }

  for (const list of categorized.values()) {
    list.sort((a, b) => (a.section_order ?? 999) - (b.section_order ?? 999));
  }

  const sortedCategories = [...categorized.entries()].sort(([, a], [, b]) => {
    const minA = Math.min(...a.map((p) => p.section_order ?? 999));
    const minB = Math.min(...b.map((p) => p.section_order ?? 999));
    return minA - minB;
  });

  const items: SidebarItem[] = [];

  for (const [section, pages] of sortedCategories) {
    const stripped = stripSectionPrefix(section);
    const locale = pages[0]?.locale ?? "en";
    const label = CURATED_SECTION_TRANSLATIONS[locale]?.[stripped] ?? stripped;
    items.push({
      type: "category",
      label,
      items: pages.map((p) => p.docusaurus_id),
    });
  }

  uncategorized.sort((a, b) => (a.section_order ?? 999) - (b.section_order ?? 999));
  for (const page of uncategorized) {
    items.push(page.docusaurus_id);
  }

  return items;
}

// ── Storage-driven manifest build (runtime-agnostic) ──

/**
 * Minimal structural storage interface. Matches the `get`/`list` subset of
 * `StorageBackend` in `src/persistence/r2.ts`, decoupled from any runtime —
 * both the CLI's filesystem backend and the Worker's R2 adapter satisfy it.
 */
export interface ManifestStorage {
  get(key: string): Promise<string | null>;
  list(prefix: string): Promise<Array<{ key: string; size: number }>>;
}

export interface BuildManifestResult {
  manifest: ContentManifest;
  /** Keys of metadata blobs that failed to parse/validate — permanent; safe to skip. */
  skipped: string[];
  /** Keys whose `storage.get` threw or returned null — transient; caller must NOT publish a partial manifest. */
  readErrors: string[];
}

/**
 * Rebuild a ContentManifest from the per-page `pages/{id}/metadata.json` blobs
 * in storage. Each blob is validated with `PageMetadataSchema`; corrupt or
 * schema-mismatched blobs are collected in `skipped` rather than failing the
 * build. The Worker's R2 metadata blobs are full `PageMetadata` (written by the
 * queue consumer), so `element_type` / `drafting_status` / `sub_items` flow
 * through — unlike the D1 rows the old route used, which omit those fields.
 */
export async function buildManifestFromStorage(
  storage: ManifestStorage,
  opts: { databaseId: string; dataSourceId: string },
): Promise<BuildManifestResult> {
  const listed = await storage.list("pages/");
  const metadataKeys = listed
    .map((o) => o.key)
    .filter((key) => key.endsWith("/metadata.json"));

  const pages: PageMetadata[] = [];
  const skipped: string[] = [];
  const readErrors: string[] = [];

  for (const key of metadataKeys) {
    // A `storage.get` throw (network/R2 hiccup) is transient — distinct from a
    // corrupt blob. A null return (key vanished between list and get) is treated
    // conservatively as transient too. Both land in `readErrors` so the caller
    // can refuse to publish a partial manifest; only parse/schema failures are
    // permanent and land in `skipped`.
    let raw: string | null;
    try {
      raw = await storage.get(key);
    } catch {
      readErrors.push(key);
      continue;
    }
    if (raw == null) {
      readErrors.push(key);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped.push(key);
      continue;
    }

    const result = PageMetadataSchema.safeParse(parsed);
    if (result.success) {
      pages.push(result.data);
    } else {
      skipped.push(key);
    }
  }

  // Determine each page's real-body-vs-stub status by reading its converted
  // Markdown from R2 (the same file docs:pull reads via r2_doc_key), so
  // family selection here matches docs:pull's body-quality ranking instead of
  // treating every candidate as bodyless. A read failure is NOT a fatal
  // readError like the metadata reads above — worst case this page is
  // conservatively treated as bodyless, buildHierarchyPlan's existing default
  // when no signal is available at all.
  const hasBodyById: Record<string, boolean> = {};
  await Promise.all(pages.map(async (page) => {
    try {
      const raw = await storage.get(buildR2DocKey(page));
      hasBodyById[page.page_id] = raw != null && !isStubBody(raw);
    } catch { /* leave unset — treated as bodyless below */ }
  }));

  const manifest = generateManifest({
    databaseId: opts.databaseId,
    dataSourceId: opts.dataSourceId,
    pages,
    hasBodyById,
  });

  return { manifest, skipped, readErrors };
}
