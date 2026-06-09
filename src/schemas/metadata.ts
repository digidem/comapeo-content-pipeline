import { z } from "zod";

/** Per-page metadata stored alongside canonical content in R2 */
export const PageAssetSchema = z.object({
  original_url: z.string(),
  r2_key: z.string(),
  sha256: z.string(),
  mime_type: z.string().nullable(),
});

export const PageMetadataSchema = z.object({
  page_id: z.string(),
  title: z.string(),
  source_url: z.string(),
  notion_last_edited_time: z.string(),
  content_hash: z.string(),
  raw_hash: z.string(),
  locale: z.string(),
  section: z.string().nullable(),
  section_order: z.number().nullable(),
  slug: z.string(),
  docusaurus_id: z.string(),
  status: z.enum(["active", "draft", "deprecated", "archived"]),
  properties: z.record(z.string(), z.unknown()),
  assets: z.array(PageAssetSchema),
});

export type PageMetadata = z.infer<typeof PageMetadataSchema>;
export type PageAsset = z.infer<typeof PageAssetSchema>;
