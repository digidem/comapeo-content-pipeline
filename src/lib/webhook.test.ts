import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyWebhookSignature,
  verifyBearerAuth,
  parseWebhookEvent,
} from "./webhook.js";

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";
  const payload = Buffer.from(JSON.stringify({ type: "page.updated", data: { id: "abc" } }));

  function sign(data: Uint8Array, key: string): string {
    return createHmac("sha256", key).update(data).digest("hex");
  }

  it("accepts valid signature", () => {
    const sig = sign(payload, secret);
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it("rejects invalid signature", () => {
    expect(verifyWebhookSignature(payload, sign(payload, "wrong-secret"), secret)).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(verifyWebhookSignature(payload, "", secret)).toBe(false);
  });

  it("rejects empty secret", () => {
    expect(verifyWebhookSignature(payload, "abc", "")).toBe(false);
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
