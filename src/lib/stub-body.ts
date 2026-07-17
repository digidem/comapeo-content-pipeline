/**
 * Shared "does this page have real content?" check, used both by docs:pull
 * (reading files off disk) and by the Worker's manifest rebuild (reading
 * bodies from R2) to feed buildHierarchyPlan's hasBodyById map. Runtime-agnostic:
 * operates on the already-read Markdown string, no I/O.
 */

/** Notion-authored "no content yet" markers (e.g. "[Insert content here]", "[ADD content here]"). */
const STUB_BODY_MARKER = /\[\s*(insert|add)\s+content\s+here\s*\]/i;

/**
 * The doc body (everything after frontmatter), stripped of spacer divs, `---`
 * thematic-break lines and whitespace — i.e. its meaningful content.
 */
function meaningfulBody(content: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = fmMatch ? fmMatch[2] : content;
  return body
    .replace(/<div class="notion-spacer"[^>]*><\/div>/g, "")
    .replace(/^---\s*$/gm, "")
    .trim();
}

/**
 * A body that carries no real content: empty/whitespace, or only a Notion
 * "[Insert/ADD content here]" placeholder marker.
 */
export function isStubBody(content: string): boolean {
  const body = meaningfulBody(content);
  if (body.length === 0) return true;
  return STUB_BODY_MARKER.test(body) && body.replace(STUB_BODY_MARKER, "").trim().length === 0;
}
