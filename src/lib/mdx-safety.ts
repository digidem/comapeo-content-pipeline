/**
 * Lightweight MDX-safety scanner.
 *
 * A full `docusaurus build` is the only thing that authoritatively catches
 * MDX/SSG failures, but it needs the consumer repo + content and can't run in
 * this repo's CI. This scanner is a dependency-free proxy for the construct
 * that has actually broken the production build before:
 *
 *  - String / bare `style=` attributes. Docusaurus parses .md as MDX, so a
 *    style prop MUST be a JSX object (`style={{color:"red"}}`); a string
 *    (`style="color:red"`) or bare (`style=color:red`) value throws at SSG.
 *
 * Scope note: unbalanced `**` (dangling bold) is intentionally NOT flagged —
 * it renders a literal `**` but does not fail the build (real content has many
 * valid `***word****` adjacencies), so it is a rendering concern guarded by the
 * converter's own tests, not a build gate.
 *
 * Code fences and inline code are ignored to avoid false positives.
 *
 * Runtime-agnostic (no Node APIs).
 */

export interface MdxHazard {
  /** 1-based line number in the original content. */
  line: number;
  kind: "string-or-bare-style";
  snippet: string;
}

/** Mask fenced/inline code (preserving line count) so it isn't scanned. */
function maskCode(content: string): string[] {
  let inFence = false;
  return content.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return "";
    }
    if (inFence) return "";
    return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
  });
}

/**
 * Scan rendered Markdown/MDX for known build-breaking hazards.
 * Returns an empty array when the content is safe.
 */
export function findMdxHazards(content: string): MdxHazard[] {
  const hazards: MdxHazard[] = [];
  if (!content) return hazards;

  maskCode(content).forEach((line, i) => {
    // A `style=` not immediately followed by `{{` is a string/bare style.
    if (/\bstyle=(?!\{\{)/.test(line)) {
      hazards.push({
        line: i + 1,
        kind: "string-or-bare-style",
        snippet: line.trim().slice(0, 120),
      });
    }
  });

  return hazards;
}
