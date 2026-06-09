/**
 * Notion webhook signature verification.
 *
 * Per: https://developers.notion.com/reference/webhooks
 *
 * Notion signs webhook payloads with HMAC-SHA256 using the
 * NOTION_WEBHOOK_VERIFICATION_TOKEN as the secret. The signature
 * is sent in the `x-notion-verification-signature` header.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Notion webhook signature.
 *
 * @param rawBody - Raw request body bytes (Buffer or Uint8Array)
 * @param signature - Value of `x-notion-verification-signature` header
 * @param secret - NOTION_WEBHOOK_VERIFICATION_TOKEN
 * @returns true if signature is valid
 */
export function verifyWebhookSignature(
  rawBody: Uint8Array,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  const computed = hmac.digest("hex");

  // Use timing-safe comparison
  try {
    const computedBuf = Buffer.from(computed, "hex");
    const sigBuf = Buffer.from(signature, "hex");
    return computedBuf.length === sigBuf.length && timingSafeEqual(computedBuf, sigBuf);
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

  const part1 = Buffer.from(parts[1]);
  const part2 = Buffer.from(expectedToken);
  if (part1.length !== part2.length) return false;

  return timingSafeEqual(part1, part2);
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
