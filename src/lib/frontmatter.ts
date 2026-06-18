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
  sidebar_custom_props?: Record<string, unknown>;
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
 *
 * These docs are generated from Notion — the editable source is the Notion
 * page, not the generated markdown (which has no counterpart in the
 * comapeo-docs repo). So the edit link targets the Notion page itself.
 * Returns undefined when no page id is available so the field is omitted
 * rather than emitted as an empty string.
 */
function buildEditUrl(pageId: string | null | undefined): string | undefined {
  if (!pageId) return undefined;
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
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
  const editUrl = buildEditUrl(metadata.page_id);

  const fm: DocFrontmatter = {
    // Use only the slug as base ID — Docusaurus prefixes the source dir
    // (section) automatically, forming "section/slug" as the full doc ID.
    // Including a "/" in the explicit id field is rejected by Docusaurus v3.
    id: metadata.slug,
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
    sidebar_custom_props: metadata.icon ? { icon: metadata.icon } : undefined,
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
 * Serialize a value to a YAML string (simple subset — enough for our frontmatter).
 * Avoids gray-matter's internal YAML parsing of the body, which crashes on
 * content containing colons, HTML tags, or other YAML-significant patterns.
 */
function toYamlLine(key: string, value: unknown, indent: number = 0): string {
  const pad = "  ".repeat(indent);
  if (value === undefined || value === null) return "";

  if (typeof value === "string") {
    // Quote strings that contain YAML-significant characters
    const needsQuote = /[&:\[\]{}|>*!%@`#"'\-]|^\s|^['"]|['"]$/.test(value);
    if (needsQuote) {
      return `${pad}${key}: "${value.replace(/"/g, '\\"')}"`;
    }
    return `${pad}${key}: ${value}`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `${pad}${key}: ${value}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${key}: []`;
    const items = value.map((v) => {
      const needsQuote = typeof v === "string" && /[&:\[\]{}|>*!%@`#"'\-]/.test(v);
      if (needsQuote) return `"${v.replace(/"/g, '\\"')}"`;
      return v;
    });
    return `${pad}${key}: [${items.join(", ")}]`;
  }

  if (typeof value === "object") {
    const lines = [`${pad}${key}:`];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const line = toYamlLine(k, v, indent + 1);
      if (line) lines.push(line);
    }
    return lines.join("\n");
  }

  return "";
}

/**
 * Serialize frontmatter object to YAML string.
 */
export function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (key === "properties" && typeof value === "object") continue; // skip raw Notion props

    // Handle empty arrays
    if (Array.isArray(value) && value.length === 0) continue;

    const line = toYamlLine(key, value, 0);
    if (line) lines.push(line);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * Serialize frontmatter + body into a full Markdown/MDX string.
 *
 * Uses manual YAML serialization instead of gray-matter's stringify
 * to avoid YAML parsing errors on body content containing colons,
 * HTML tags, or other YAML-significant patterns.
 */
export function serializeDoc(
  frontmatter: DocFrontmatter,
  body: string,
): string {
  const data = stripUndefined(frontmatter as unknown as Record<string, unknown>);
  const fm = serializeFrontmatter(data);
  return fm + body;
}

/**
 * Parse an existing doc file to extract frontmatter and body.
 *
 * Uses regex instead of gray-matter to avoid YAML parsing errors
 * when body content contains `---` dividers or other YAML-significant patterns.
 */
export function parseDoc(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  // Use regex to extract frontmatter — avoids gray-matter YAML parsing
  // failures when body contains `---` (dividers, table separators).
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
  if (!fmMatch) {
    // No frontmatter found — try gray-matter as fallback
    try {
      const parsed = matter(content);
      return {
        frontmatter: parsed.data as Record<string, unknown>,
        body: parsed.content,
      };
    } catch {
      return { frontmatter: {}, body: content };
    }
  }

  const fmStr = fmMatch[1];
  const body = fmMatch[2];

  // Parse YAML frontmatter manually (simple key: value pairs)
  const frontmatter: Record<string, unknown> = {};
  const lines = fmStr.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    // Remove surrounding quotes
    frontmatter[key] = value.replace(/^["']|["']$/g, "");
  }

  return { frontmatter, body };
}
