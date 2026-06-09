import matter from "gray-matter";
import type { PageMetadata } from "../schemas/metadata.js";

/**
 * Docusaurus-compatible frontmatter that goes on every generated doc.
 *
 * Reference: ../comapeo-docs/scripts/notion-fetch/frontmatterBuilder.ts
 */
export interface DocFrontmatter {
  id: string;
  title: string;
  slug: string;
  sidebar_label?: string;
  sidebar_position?: number;
  pagination_label?: string;
  custom_edit_url?: string;
  source: "notion";
  notion_page_id: string;
  notion_last_edited_time: string;
  content_hash: string;
  status: string;
  locale: string;
  section?: string;
  keywords?: string[];
  tags?: string[];
  last_update?: {
    date: string;
    author: string;
  };
}

/**
 * Format a date string to en-US locale (MM/DD/YYYY).
 */
function formatDate(dateStr: string): string {
  try {
    // dateStr is ISO format e.g., "2026-05-25" or "2026-05-25T15:49:00.000Z"
    const [year, month, day] = dateStr.split(/[-T]/).map(Number);
    const date = new Date(year, (month || 1) - 1, day || 1);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString("en-US");
    }
  } catch {
    // fall through
  }
  return new Date().toLocaleDateString("en-US");
}

/**
 * Build the custom_edit_url for Docusaurus "Edit this page" link.
 */
function buildEditUrl(locale: string, section: string | null | undefined, slug: string): string {
  const parts = [locale, "docs"];
  if (section) {
    // Sections are like "10 - Tutorials" → "10-tutorials"
    const sectionSlug = section
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    parts.push(sectionSlug);
  }
  parts.push(`${slug}.md`);
  return `https://github.com/digidem/comapeo-docs/edit/main/docs/${parts.join("/")}`;
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
    | "keywords"
    | "tags"
    | "icon"
    | "published_date"
  >,
): DocFrontmatter {
  const docusaurusSlug = `/${metadata.slug}`;
  const editUrl = buildEditUrl(metadata.locale, metadata.section, metadata.slug);

  const fm: DocFrontmatter = {
    id: metadata.section
      ? `${metadata.section}/${metadata.slug}`
      : metadata.slug,
    title: metadata.title,
    slug: docusaurusSlug,
    sidebar_label: metadata.title,
    sidebar_position: metadata.section_order ?? undefined,
    pagination_label: metadata.title,
    custom_edit_url: editUrl,
    source: "notion",
    notion_page_id: metadata.page_id,
    notion_last_edited_time: metadata.notion_last_edited_time,
    content_hash: metadata.content_hash,
    status: metadata.status,
    locale: metadata.locale,
    section: metadata.section ?? undefined,
    keywords: metadata.keywords,
    tags: metadata.tags,
    last_update: {
      date: formatDate(metadata.published_date || metadata.notion_last_edited_time),
      author: "Awana Digital",
    },
  };

  return fm;
}

/**
 * Strip undefined values from an object (for clean YAML serialization).
 */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Serialize frontmatter + body into a full Markdown/MDX string.
 */
export function serializeDoc(
  frontmatter: DocFrontmatter,
  body: string,
): string {
  // gray-matter might not handle nested last_update well, so we handle it manually
  const data = stripUndefined(frontmatter as unknown as Record<string, unknown>);
  return matter.stringify(body, data);
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
