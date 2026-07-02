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
 * Rewrite inline `<img src="assets/<file>">` to `src="/images/notion/<file>"`
 * and report which asset files were referenced so the caller can copy them
 * into the static dir.
 */
export function rewriteRawImgSrcToStatic(md: string): {
  content: string;
  assets: string[];
} {
  const assets = new Set<string>();
  const content = md.replace(RELATIVE_ASSETS_SRC, (_, file: string) => {
    assets.add(file);
    return `src="${STATIC_IMG_PREFIX}${file}"`;
  });
  return { content, assets: [...assets] };
}
