import matter from "gray-matter";
import type { PageMetadata } from "../schemas/metadata.js";

/**
 * Docusaurus-compatible frontmatter that goes on every generated doc.
 */
export interface DocFrontmatter {
  id: string;
  title: string;
  slug: string;
  sidebar_position?: number;
  source: "notion";
  notion_page_id: string;
  notion_last_edited_time: string;
  content_hash: string;
  status: string;
  locale: string;
  section?: string;
}

/**
 * Build frontmatter object for Docusaurus docs.
 */
export function buildFrontmatter(
  metadata: Pick<
    PageMetadata,
    | "page_id"
    | "title"
    | "slug"
    | "locale"
    | "status"
    | "content_hash"
    | "notion_last_edited_time"
    | "section"
    | "section_order"
  >,
): DocFrontmatter {
  return {
    id: metadata.section
      ? `${metadata.section}/${metadata.slug}`
      : metadata.slug,
    title: metadata.title,
    slug: `/${metadata.slug}`,
    sidebar_position: metadata.section_order ?? undefined,
    source: "notion",
    notion_page_id: metadata.page_id,
    notion_last_edited_time: metadata.notion_last_edited_time,
    content_hash: metadata.content_hash,
    status: metadata.status,
    locale: metadata.locale,
    section: metadata.section ?? undefined,
  };
}

/**
 * Strip undefined values from an object (for clean YAML serialization).
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Serialize frontmatter + body into a full Markdown/MDX string.
 */
export function serializeDoc(
  frontmatter: DocFrontmatter,
  body: string,
): string {
  return matter.stringify(body, stripUndefined(frontmatter));
}

/**
 * Parse an existing doc file to extract frontmatter and body.
 */
export function parseDoc(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const parsed = matter(content);
  return {
    frontmatter: parsed.data as Record<string, unknown>,
    body: parsed.content,
  };
}
