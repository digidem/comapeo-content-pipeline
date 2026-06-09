/**
 * Deterministic slug generation from page titles.
 *
 * Rules (per spec §9.3):
 * 1. Lowercase
 * 2. Remove accents
 * 3. Replace non-alphanumeric sequences with `-`
 * 4. Trim `-`
 * 5. If duplicate, append short page ID suffix
 */

const ACCENT_MAP: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", æ: "ae",
  ç: "c",
  è: "e", é: "e", ê: "e", ë: "e",
  ì: "i", í: "i", î: "i", ï: "i",
  ñ: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o",
  ù: "u", ú: "u", û: "u", ü: "u",
  ý: "y", ÿ: "y",
  À: "a", Á: "a", Â: "a", Ã: "a", Ä: "a", Å: "a", Æ: "ae",
  Ç: "c",
  È: "e", É: "e", Ê: "e", Ë: "e",
  Ì: "i", Í: "i", Î: "i", Ï: "i",
  Ñ: "n",
  Ò: "o", Ó: "o", Ô: "o", Õ: "o", Ö: "o", Ø: "o",
  Ù: "u", Ú: "u", Û: "u", Ü: "u",
  Ý: "y", Ÿ: "y",
};

function removeAccents(str: string): string {
  return str
    .split("")
    .map((ch) => ACCENT_MAP[ch] || ch)
    .join("");
}

/**
 * Generate a slug from a title string.
 */
export function slugify(title: string): string {
  const lower = title.toLowerCase();
  const noAccents = removeAccents(lower);
  // Replace non-alphanumeric sequences with single dash
  const dashed = noAccents.replace(/[^a-z0-9]+/g, "-");
  // Trim leading/trailing dashes
  const trimmed = dashed.replace(/^-+|-+$/g, "");
  // Collapse multiple dashes
  return trimmed.replace(/-{2,}/g, "-");
}

/**
 * Generate a unique slug, appending a page ID suffix if a collision is
 * detected via the `usedSlugs` set.
 */
export function generateSlug(
  title: string,
  pageId: string,
  usedSlugs: Set<string> = new Set(),
): string {
  const base = slugify(title);
  if (!usedSlugs.has(base)) {
    usedSlugs.add(base);
    return base;
  }
  // Collision — append short page ID suffix (8 chars)
  const suffix = pageId.replace(/-/g, "").slice(0, 8);
  const unique = `${base}-${suffix}`;
  usedSlugs.add(unique);
  return unique;
}

/**
 * Derive a Docusaurus document ID from a slug.
 * Docusaurus IDs use `/` path separators.
 */
export function slugToDocusaurusId(slug: string, section?: string | null): string {
  if (section) {
    return `${section}/${slug}`;
  }
  return slug;
}
