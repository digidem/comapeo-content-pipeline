/**
 * Manifest generation — produces `manifests/latest.json`.
 */

import type { ContentManifest, ManifestDoc, SidebarItem } from "../schemas/manifest.js";
import type { PageMetadata } from "../schemas/metadata.js";
import { PageMetadataSchema } from "../schemas/metadata.js";

export interface ManifestInput {
  databaseId: string;
  dataSourceId: string;
  pages: PageMetadata[];
  /** Locale → Docusaurus sidebar items */
  sidebars?: Record<string, SidebarItem[]>;
  ragChunksManifestKey?: string;
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
    sidebars: input.sidebars ?? buildDefaultSidebars(input.pages),
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
 * Read a manifest doc's element_type. Conformant manifests (2026-07-09+) carry
 * a plain string; manifests generated before the fix carried the raw Notion
 * select object — keep unwrapping those so older manifests still pull.
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
 * Generate a Docusaurus sidebar array from page metadata.
 *
 * - Pages with a `section` are grouped into `{ type: "category", label, items }`.
 * - Pages without a section appear as plain string IDs.
 * - Categories are sorted by the lowest `section_order` of their pages.
 * - Items within categories are sorted by `section_order`.
 */
export function generateSidebarJson(pages: PageMetadata[]): SidebarItem[] {
  const active = pages.filter((p) => p.status === "active");

  // Partition: categorized vs uncategorized
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

  // Sort items within each category by section_order
  for (const list of categorized.values()) {
    list.sort((a, b) => (a.section_order ?? 999) - (b.section_order ?? 999));
  }

  // Sort categories by their lowest section_order
  const sortedCategories = [...categorized.entries()].sort(([, a], [, b]) => {
    const minA = Math.min(...a.map((p) => p.section_order ?? 999));
    const minB = Math.min(...b.map((p) => p.section_order ?? 999));
    return minA - minB;
  });

  // Build items: categories first (in order), then uncategorized (in order)
  const items: SidebarItem[] = [];

  for (const [section, pages] of sortedCategories) {
    items.push({
      type: "category",
      label: section,
      items: pages.map((p) => p.docusaurus_id),
    });
  }

  uncategorized.sort((a, b) => (a.section_order ?? 999) - (b.section_order ?? 999));
  for (const page of uncategorized) {
    items.push(page.docusaurus_id);
  }

  return items;
}

function buildDefaultSidebars(
  pages: PageMetadata[],
): Record<string, SidebarItem[]> {
  const sidebars: Record<string, SidebarItem[]> = {};
  const locales = new Set(pages.map((p) => p.locale));

  for (const locale of locales) {
    const localePages = pages.filter((p) => p.locale === locale);
    sidebars[locale] = generateSidebarJson(localePages);
  }

  return sidebars;
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
  /** Keys of metadata blobs that failed to parse/validate (never throws). */
  skipped: string[];
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

  for (const key of metadataKeys) {
    let raw: string | null;
    try {
      raw = await storage.get(key);
    } catch {
      skipped.push(key);
      continue;
    }
    if (raw == null) {
      skipped.push(key);
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

  const manifest = generateManifest({
    databaseId: opts.databaseId,
    dataSourceId: opts.dataSourceId,
    pages,
  });

  return { manifest, skipped };
}
