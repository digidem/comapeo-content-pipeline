/**
 * Notion webhook signature verification.
 *
 * Per: https://developers.notion.com/reference/webhooks
 *
 * Notion signs webhook payloads with HMAC-SHA256 using the
 * NOTION_WEBHOOK_VERIFICATION_TOKEN as the secret. The signature
 * is sent in the `x-notion-verification-signature` header.
 *
 * Uses the Web Crypto API (crypto.subtle) for Cloudflare Workers compat.
 */

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time comparison of two byte arrays.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Verify a Notion webhook signature.
 *
 * @param rawBody - Raw request body bytes
 * @param signature - Value of `x-notion-verification-signature` header
 * @param secret - NOTION_WEBHOOK_VERIFICATION_TOKEN
 * @returns true if signature is valid
 */
export async function verifyWebhookSignature(
  rawBody: Uint8Array,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, rawBody as Uint8Array<ArrayBuffer>);
  const computed = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Use constant-time comparison
  try {
    const computedBytes = hexToBytes(computed);
    const sigBytes = hexToBytes(signature);
    return computedBytes.length === sigBytes.length && constantTimeEqual(computedBytes, sigBytes);
  } catch {
    // If hex decoding fails, do a simple string compare
    return computed === signature;
  }
}

/**
 * Verify bearer token for admin routes.
 */
export function verifyBearerAuth(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (!expectedToken) return false;
  if (!authorizationHeader) return false;

  const parts = authorizationHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;

  const encoder = new TextEncoder();
  const part1 = encoder.encode(parts[1]);
  const part2 = encoder.encode(expectedToken);
  if (part1.length !== part2.length) return false;

  return constantTimeEqual(part1, part2);
}

/**
 * Extract page/database IDs from a Notion webhook event.
 */
export interface WebhookEvent {
  type: "page.updated" | "page.created" | "page.deleted" | "database.updated" | string;
  pageId?: string;
  databaseId?: string;
}

export function parseWebhookEvent(body: Record<string, unknown>): WebhookEvent | null {
  // Notion webhook payload structure (simplified)
  const eventType = (body.type || body.event_type) as string | undefined;
  const data = (body.data || {}) as Record<string, unknown>;

  if (!eventType) return null;

  return {
    type: eventType,
    pageId: data.id as string | undefined,
    databaseId: data.database_id as string | undefined,
  };
}
