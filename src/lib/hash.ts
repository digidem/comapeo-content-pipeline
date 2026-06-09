import { createHash } from "node:crypto";

/**
 * Compute a deterministic SHA-256 hash of arbitrary input.
 * Returns a prefixed string: `sha256:<hexdigest>`.
 */
export function contentHash(input: string): string {
  const hash = createHash("sha256").update(input, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Compare two content hashes for equality (handles prefixed and unprefixed).
 */
export function hashesEqual(a: string, b: string): boolean {
  return a === b;
}

/**
 * Determine if content has changed based on hash comparison.
 */
export function contentChanged(
  previousHash: string | null | undefined,
  currentHash: string,
): boolean {
  if (!previousHash) return true;
  return previousHash !== currentHash;
}

/**
 * Hash raw JSON (canonical serialization sort).
 */
export function hashJSON(obj: unknown): string {
  const canonical = JSON.stringify(obj, sortedKeys);
  return contentHash(canonical);
}

/**
 * Replacer that sorts object keys for deterministic serialization.
 */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (value as Record<string, unknown>)[k];
        return acc;
      }, {});
  }
  return value;
}
