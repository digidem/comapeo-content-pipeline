/**
 * Compute a deterministic SHA-256 hash of arbitrary input.
 * Returns a prefixed string: `sha256:<hexdigest>`.
 *
 * Uses Web Crypto API (crypto.subtle.digest) which works in both
 * Node 19+ and Cloudflare Workers.
 */
export async function contentHash(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hashHex}`;
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
export async function hashJSON(obj: unknown): Promise<string> {
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
