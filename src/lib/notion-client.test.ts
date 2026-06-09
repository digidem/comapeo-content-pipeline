import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NotionClient, setRetryAfterCallback } from "./notion-client.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function rateLimitedResponse(retryAfter?: number): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) {
    headers.set("Retry-After", String(retryAfter));
  }
  return new Response("rate limited", { status: 429, headers });
}

function serviceUnavailableResponse(): Response {
  return new Response("overloaded", { status: 529 });
}

function errorResponse(status: number, statusText = "Error"): Response {
  return new Response("bad request", { status, statusText });
}

describe("NotionClient retry behavior", () => {
  let client: NotionClient;
  let fetchMock: ReturnType<typeof vi.fn>;
  let retryAfterValues: number[];

  beforeEach(() => {
    retryAfterValues = [];

    // Make setTimeout fire immediately so sleep() resolves instantly
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );

    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    client = new NotionClient({ token: "test-token", maxRps: 999 });
    setRetryAfterCallback((secs) => retryAfterValues.push(secs));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRetryAfterCallback(null);
  });

  // ── 429 tests ──

  it("retries on 429 and calls retryAfterCallback with header value", async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse(3))
      .mockResolvedValueOnce(okResponse({ id: "page-1" }));

    const result = await client.getPage("page-1");
    expect(result.id).toBe("page-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retryAfterValues).toEqual([3]);
  });

  it("defaults to 1 second when 429 has no Retry-After header", async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(okResponse({ id: "page-2" }));

    const result = await client.getPage("page-2");
    expect(result.id).toBe("page-2");
    expect(retryAfterValues).toEqual([1]);
  });

  it("retries multiple 429 responses before succeeding", async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse(1))
      .mockResolvedValueOnce(rateLimitedResponse(2))
      .mockResolvedValueOnce(okResponse({ id: "page-3" }));

    const result = await client.getPage("page-3");
    expect(result.id).toBe("page-3");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retryAfterValues).toEqual([1, 2]);
  });

  // ── 529 tests ──

  it("retries on 529 with exponential backoff", async () => {
    fetchMock
      .mockResolvedValueOnce(serviceUnavailableResponse())
      .mockResolvedValueOnce(okResponse({ id: "page-4" }));

    const result = await client.getPage("page-4");
    expect(result.id).toBe("page-4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Non-retryable errors ──

  it("does NOT retry on non-rate-limit client errors (e.g. 400)", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, "Bad Request"));

    await expect(client.getPage("bad-page")).rejects.toThrow(
      "Notion API error 400",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

    await expect(client.getPage("no-access")).rejects.toThrow(
      "Notion API error 401",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 404", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));

    await expect(client.getPage("missing")).rejects.toThrow(
      "Notion API error 404",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Max retries ──

  it("respects max retries (4 retries = 5 total attempts) for 429", async () => {
    for (let i = 0; i < 5; i++) {
      fetchMock.mockResolvedValueOnce(rateLimitedResponse(1));
    }

    await expect(client.getPage("exhausted")).rejects.toThrow(
      "Max retries exceeded",
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  // ── Network errors ──

  it("retries on network error (fetch throws)", async () => {
    const networkError = new TypeError("Failed to fetch");
    fetchMock
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(okResponse({ id: "page-5" }));

    const result = await client.getPage("page-5");
    expect(result.id).toBe("page-5");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries on persistent network errors", async () => {
    const networkError = new TypeError("Failed to fetch");
    for (let i = 0; i < 5; i++) {
      fetchMock.mockRejectedValueOnce(networkError);
    }

    await expect(client.getPage("down")).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
