import { z } from "zod";

/** A single RAG chunk generated from canonical Markdown */
export const RagChunkSchema = z.object({
  chunk_id: z.string(),
  page_id: z.string(),
  title: z.string(),
  locale: z.string(),
  slug: z.string(),
  heading_path: z.array(z.string()),
  text: z.string(),
  source_url: z.string(),
  docusaurus_path: z.string(),
  content_hash: z.string(),
  status: z.literal("active"),
});

export type RagChunk = z.infer<typeof RagChunkSchema>;

/** Manifest of all RAG chunks */
export const RagChunksManifestSchema = z.object({
  schema_version: z.literal("1.0"),
  generated_at: z.string(),
  chunks: z.array(RagChunkSchema),
});

export type RagChunksManifest = z.infer<typeof RagChunksManifestSchema>;
