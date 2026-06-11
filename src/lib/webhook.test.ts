import { describe, it, expect } from "vitest";
import {
  verifyWebhookSignature,
  verifyBearerAuth,
  parseWebhookEvent,
} from "./webhook.js";

/**
 * Sign data with HMAC-SHA256 using the Web Crypto API (no node:crypto).
 */
async function sign(data: Uint8Array, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";
  const payload = new TextEncoder().encode(JSON.stringify({ type: "page.updated", data: { id: "abc" } }));

  it("accepts valid signature", async () => {
    const sig = await sign(payload, secret);
    expect(await verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it("rejects invalid signature", async () => {
    expect(await verifyWebhookSignature(payload, await sign(payload, "wrong-secret"), secret)).toBe(false);
  });

  it("rejects empty signature", async () => {
    expect(await verifyWebhookSignature(payload, "", secret)).toBe(false);
  });

  it("rejects empty secret", async () => {
    expect(await verifyWebhookSignature(payload, "abc", "")).toBe(false);
  });
});

describe("verifyBearerAuth", () => {
  it("accepts valid bearer token", () => {
    expect(verifyBearerAuth("Bearer my-token", "my-token")).toBe(true);
  });

  it("rejects wrong token", () => {
    expect(verifyBearerAuth("Bearer wrong", "my-token")).toBe(false);
  });

  it("rejects missing header", () => {
    expect(verifyBearerAuth(null, "my-token")).toBe(false);
  });

  it("rejects non-bearer auth", () => {
    expect(verifyBearerAuth("Basic my-token", "my-token")).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("parses page.updated event", () => {
    const event = parseWebhookEvent({
      type: "page.updated",
      data: { id: "abc123" },
    });
    expect(event?.type).toBe("page.updated");
    expect(event?.pageId).toBe("abc123");
  });

  it("returns null for unrecognized payload", () => {
    expect(parseWebhookEvent({})).toBeNull();
  });
});
