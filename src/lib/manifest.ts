/**
 * Manifest generation — produces `manifests/latest.json`.
 */

import type { ContentManifest, ManifestDoc } from "../schemas/manifest.js";
import type { PageMetadata } from "../schemas/metadata.js";

export interface ManifestInput {
  databaseId: string;
  dataSourceId: string;
  pages: PageMetadata[];
  /** Locale → R2 sidebar key */
  sidebars?: Record<string, string>;
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
      element_type: meta.properties?.["Element Type"] as string | null ?? null,
      drafting_status: meta.properties?.["Drafting Status"] as string | null ?? null,
      slug: meta.slug,
      docusaurus_id: meta.docusaurus_id,
      docusaurus_path: `/${meta.slug}`,
      r2_doc_key: buildR2DocKey(meta),
      r2_metadata_key: buildR2MetadataKey(meta.page_id),
      source_url: meta.source_url,
      notion_last_edited_time: meta.notion_last_edited_time,
      content_hash: meta.content_hash,
      status: meta.status,
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

// ── Key builders ──

function buildR2DocKey(meta: PageMetadata): string {
  const section = meta.section ? `${meta.section}/` : "";
  return `docs/${meta.locale}/docs/${section}${meta.slug}.md`;
}

function buildR2MetadataKey(pageId: string): string {
  return `pages/${pageId}/metadata.json`;
}

// ── Sidebar generation ──

function buildDefaultSidebars(
  pages: PageMetadata[],
): Record<string, string> {
  // Group pages by locale, create sidebar entries
  const sidebars: Record<string, string> = {};
  const locales = new Set(pages.map((p) => p.locale));

  for (const locale of locales) {
    const localePages = pages.filter((p) => p.locale === locale && p.status === "active");
    localePages.sort((a, b) => {
      if (a.section !== b.section) {
        return (a.section ?? "").localeCompare(b.section ?? "");
      }
      return (a.section_order ?? 999) - (b.section_order ?? 999);
    });

    // Build a simple sidebar with docs grouped by section
    const items: string[] = [];
    let currentSection: string | null = null;

    for (const page of localePages) {
      if (page.section !== currentSection) {
        if (page.section) {
          items.push(`  - label: ${page.section}`);
          items.push("    items:");
        }
        currentSection = page.section;
      }
      const indent = page.section ? "      " : "  ";
      items.push(`${indent}- ${page.docusaurus_id}`);
    }

    sidebars[locale] = items.join("\n");
  }

  return sidebars;
}
