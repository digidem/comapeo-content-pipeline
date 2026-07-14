/**
 * Rewrites raw HTML img tags with relative assets/ src attributes to
 * site-root /images/notion/ paths served from the Docusaurus static/ dir.
 *
 * Problem: <img src="assets/xxx.png" ...> in MDX is raw JSX; the MDX bundler
 * leaves the src string untouched and never copies the asset into the build,
 * so every inline emoji/icon 404s. Webpack-based alternatives do not work in
 * the consumer site because @docusaurus/plugin-ideal-image intercepts every
 * png/jpg import and returns an object meant for its <Image> component
 * (verified: `{require(...)}` rendered src="[object Object]" and
 * `require().default` rendered no src at all).
 *
 * The consumer site's established mechanism for non-bundled images is
 * site-root paths under /images/ served from static/ (see comapeo-docs
 * scripts/shared/localeImagePlaceholders.ts `isCanonicalImagePath`). This
 * rewrite emits those, and docs:pull copies the referenced assets into
 * <out>/static/images/notion/.
 *
 * Applied at docs:pull emission time (NOT in the converter) so the canonical
 * Markdown stored in output/ stays plain for the RAG consumer.
 *
 * Runtime-agnostic (no Node APIs).
 */

/**
 * Pattern matches `src="assets/..."` string attributes.
 *
 * Deliberately narrow: only relative paths starting with `assets/`, so
 * absolute URLs (http/https), site-root paths (/images/...), and braced
 * `src={...}` expressions are untouched. Markdown image syntax
 * (`![alt](assets/...)`) uses `(` not `src="`, so it is also unaffected —
 * markdown images ARE processed by the bundler and must keep relative paths.
 */
const RELATIVE_ASSETS_SRC = /\bsrc="assets\/([^"]+)"/g;

/** Site-root prefix where docs:pull publishes inline-image assets. */
export const STATIC_IMG_PREFIX = "/images/notion/";

/**
 * True when `name` is a plain single-segment basename: non-empty and free of
 * path separators (`/`, `\`) and parent-directory (`..`) sequences. Unsafe
 * names are left untouched by the rewriter so a Notion-authored src like
 * `assets/../../.env` can never reach the asset-copy loop, where the name is
 * joined into a filesystem path on BOTH the read and write sides.
 *
 * String ops only on purpose — this module is runtime-agnostic and must not
 * import node:path (see CLAUDE.md).
 */
function isSafeBasename(name: string): boolean {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  return true;
}

/**
 * Rewrite inline `<img src="assets/<file>">` to `src="/images/notion/<file>">`
 * and report which asset files were referenced so the caller can copy them
 * into the static dir.
 *
 * A src whose captured name is not a plain basename (contains `/`, `\`, `..`,
 * or is empty) is left untouched and excluded from the returned asset list —
 * it will 404 harmlessly in the renderer rather than traverse the filesystem.
 */
export function rewriteRawImgSrcToStatic(md: string): {
  content: string;
  assets: string[];
} {
  const assets = new Set<string>();
  const content = md.replace(RELATIVE_ASSETS_SRC, (match, file: string) => {
    if (!isSafeBasename(file)) return match; // leave traversal/segmented srcs as-is
    assets.add(file);
    return `src="${STATIC_IMG_PREFIX}${file}"`;
  });
  return { content, assets: [...assets] };
}
