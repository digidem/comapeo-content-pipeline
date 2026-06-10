import { z } from "zod";

// ── Docusaurus sidebar types ──

/** A single item in a Docusaurus sidebar array */
export type SidebarItem = string | SidebarCategory;
export interface SidebarCategory {
  type: "category";
  label: string;
  items: SidebarItem[];
}

/** Recursive Zod schema for Docusaurus sidebar items */
export const SidebarItemSchema: z.ZodType<SidebarItem> = z.union([
  z.string(),
  z.object({
    type: z.literal("category"),
    label: z.string(),
    items: z.lazy(() => z.array(SidebarItemSchema)),
  }),
]);

/** A single document entry in the content manifest */
export const ManifestDocSchema = z.object({
  page_id: z.string(),
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
  sub_items: z.array(z.string()).optional(),
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
