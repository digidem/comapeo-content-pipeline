import { z } from "zod";

// ── Docusaurus sidebar types ──

/** A single item in a Docusaurus sidebar array */
export type SidebarItem = string | SidebarCategory;
export interface SidebarCategory {
  type: "category";
  label: string;
  items: SidebarItem[];
  collapsible?: boolean;
  collapsed?: boolean;
  link?: { type: string; title?: string };
  customProps?: Record<string, unknown>;
  /** Stable, locale-independent unique key for Docusaurus sidebar translation. */
  key?: string;
}

/** Recursive Zod schema for Docusaurus sidebar items */
export const SidebarItemSchema: z.ZodType<SidebarItem> = z.union([
  z.string(),
  z.object({
    type: z.literal("category"),
    label: z.string(),
    items: z.lazy(() => z.array(SidebarItemSchema)),
    collapsible: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    link: z.object({ type: z.string(), title: z.string().optional() }).optional(),
    customProps: z.record(z.string(), z.unknown()).optional(),
    key: z.string().optional(),
  }),
]);

/** Safe page ID regex: alphanumeric characters, hyphens, and underscores only */
export const PAGE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Safe page ID schema: must be a non-empty string containing only alphanumeric characters,
 * hyphens, and underscores. Prevents path traversal and unsafe characters when page IDs
 * are used to form filesystem paths.
 */
export const PageIdSchema = z
  .string()
  .min(1)
  .regex(PAGE_ID_REGEX, {
    message: "Invalid page_id: must contain only alphanumeric characters, dashes, and underscores",
  });

/** A single document entry in the content manifest */
export const ManifestDocSchema = z.object({
  page_id: PageIdSchema,
  title: z.string(),
  locale: z.string(),
  section: z.string().nullable(),
  section_order: z.number().nullable(),
  element_type: z.string().nullable(),
  drafting_status: z.string().nullable(),
  slug: z.string(),
  docusaurus_id: z.string(),
  docusaurus_path: z.string(),
  r2_doc_key: z.string(),
  r2_metadata_key: z.string(),
  source_url: z.string(),
  notion_last_edited_time: z.string(),
  content_hash: z.string(),
  status: z.enum(["active", "draft", "deprecated", "archived"]),
  /** Page IDs of sub-items (translations) linked via Sub-item relation */
  sub_items: z.array(PageIdSchema).optional(),
  /** Language provenance: how the locale was determined */
  language_source: z.enum(["explicit", "automated", "fallback"]).optional(),
});

export type ManifestDoc = z.infer<typeof ManifestDocSchema>;

/** The top-level content manifest */
export const ContentManifestSchema = z.object({
  schema_version: z.literal("1.0"),
  generated_at: z.string(),
  source: z.object({
    type: z.literal("notion"),
    database_id: z.string(),
    data_source_id: z.string(),
  }),
  docs: z.array(ManifestDocSchema),
  sidebars: z.record(z.string(), z.array(SidebarItemSchema)),
  rag: z
    .object({
      chunks_manifest_key: z.string(),
    })
    .optional(),
});

export type ContentManifest = z.infer<typeof ContentManifestSchema>;
