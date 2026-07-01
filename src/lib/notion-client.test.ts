import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NotionClient, setRetryAfterCallback } from "./notion-client.js";
import { NOTION_API } from "./notion-properties.js";

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

// ── 5.1 Characterization: queryDataSource request shape ──

describe("queryDataSource characterization (plan 5.1)", () => {
  let client: NotionClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The existing NotionClient.request() path uses our own sleep() which uses
    // setTimeout. Mock it so rate-limiter sleeps resolve instantly.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((fn: () => void) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof setTimeout,
    );
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    client = new NotionClient({ token: "tok", databaseId: "db-id", maxRps: 999 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /search with correct shape", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [], next_cursor: null, has_more: false,
    }), { status: 200 }));

    await client.queryDataSource({});

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/search");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.sort?.timestamp).toBe("last_edited_time");
    expect(body.sort?.direction).toBe("descending");
    expect(body.filter?.property).toBe("object");
    expect(body.filter?.value).toBe("page");
    expect(init.headers).toMatchObject({
      "Notion-Version": NOTION_API.SEARCH_VERSION,
    });
  });
});

// ── 5.3 queryDatabase: filter, pagination, stale-cursor ──

describe("queryDatabase (plan 5.3)", () => {
  let client: NotionClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  const DATA_SOURCE_ID = "ds-1234";

  function makePage(id: string, last_edited_time = "2026-01-01T00:00:00.000Z") {
    return { object: "page", id, last_edited_time, properties: {} };
  }

  function sdkResponse(
    pages: ReturnType<typeof makePage>[],
    next_cursor: string | null,
    has_more: boolean,
  ) {
    return new Response(JSON.stringify({
      object: "list",
      type: "page_or_data_source",
      page_or_data_source: {},
      results: pages,
      next_cursor,
      has_more,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  beforeEach(() => {
    // NOTE: Do NOT mock globalThis.setTimeout here.
    // The @notionhq/client SDK uses setTimeout for request timeouts via
    // Promise.race. Mocking setTimeout to fire immediately makes the SDK's
    // timeout win the race before fetch resolves.
    // At maxRps:999 the throttle interval is ~1ms so no sleep is needed.
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    client = new NotionClient({
      token: "tok",
      dataSourceId: DATA_SOURCE_ID,
      maxRps: 999,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends filter in request body", async () => {
    const myFilter = { or: [{ property: "Publish Status", select: { is_empty: true } }] };
    fetchMock.mockResolvedValueOnce(sdkResponse([], null, false));

    await client.queryDatabase({ filter: myFilter });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // SDK sends the filter as part of the POST body
    expect(JSON.stringify(body.filter)).toBe(JSON.stringify(myFilter));
  });

  it("requests the correct data_source endpoint", async () => {
    fetchMock.mockResolvedValueOnce(sdkResponse([], null, false));
    await client.queryDatabase({});

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`data_sources/${DATA_SOURCE_ID}/query`);
  });

  it("uses DATABASE_VERSION Notion-Version header", async () => {
    fetchMock.mockResolvedValueOnce(sdkResponse([], null, false));
    await client.queryDatabase({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Notion-Version"]).toBe(NOTION_API.DATABASE_VERSION);
  });

  it("sends default sort (last_edited_time descending)", async () => {
    fetchMock.mockResolvedValueOnce(sdkResponse([], null, false));
    await client.queryDatabase({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.sorts).toMatchObject([
      { timestamp: "last_edited_time", direction: "descending" },
    ]);
  });

  it("paginates through multiple pages and collects all results", async () => {
    fetchMock
      .mockResolvedValueOnce(sdkResponse([makePage("p1"), makePage("p2")], "cursor-2", true))
      .mockResolvedValueOnce(sdkResponse([makePage("p3")], null, false));

    const result = await client.queryDatabase({});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.results.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(result.next_cursor).toBeNull();
    expect(result.has_more).toBe(false);
  });

  it("sends cursor in subsequent requests", async () => {
    fetchMock
      .mockResolvedValueOnce(sdkResponse([makePage("p1")], "next-cursor", true))
      .mockResolvedValueOnce(sdkResponse([], null, false));

    await client.queryDatabase({});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, initPage2] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body2 = JSON.parse(initPage2.body as string);
    expect(body2.start_cursor).toBe("next-cursor");
  });

  it("breaks on stale cursor to prevent infinite loop", async () => {
    // Both responses return the same cursor — should break after 2nd request
    fetchMock
      .mockResolvedValueOnce(sdkResponse([makePage("p1")], "same-cursor", true))
      .mockResolvedValueOnce(sdkResponse([makePage("p2")], "same-cursor", true));

    const result = await client.queryDatabase({});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Collected p1 + p2 before stale-cursor break
    expect(result.results.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("filters out non-page objects from results", async () => {
    const dataSource = { object: "data_source", id: "ds-obj", properties: {} };
    const page = makePage("page-obj");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        object: "list",
        type: "page_or_data_source",
        page_or_data_source: {},
        results: [page, dataSource],
        next_cursor: null,
        has_more: false,
      }), { status: 200 }),
    );

    const result = await client.queryDatabase({});
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("page-obj");
  });

  it("falls back to databaseId when dataSourceId is not set", async () => {
    const clientWithDb = new NotionClient({ token: "tok", databaseId: "db-fallback", maxRps: 999 });
    fetchMock.mockResolvedValueOnce(sdkResponse([], null, false));

    await clientWithDb.queryDatabase({});

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("data_sources/db-fallback/query");
  });
});
