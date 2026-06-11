/**
 * Integration tests for Worker Hono routes and queue consumer.
 *
 * Uses Hono's built-in `app.request()` for HTTP route testing.
 * Mock D1, R2, and Queue bindings via plain objects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We only import types and the default export (Hono app) + queue consumer.
// The worker module has side effects (global type declarations) — fine.
import { app, queueHandler } from "./index.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convertBlocks } from "../lib/notion-converter.js";
import { contentHash } from "../lib/hash.js";
import { postProcessMarkdown } from "../lib/post-process.js";
import type { NotionBlockList } from "../lib/notion-converter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helper to find a prepare call whose SQL contains a substring ──
function findPrepareCall(
  prepareMock: ReturnType<typeof vi.fn>,
  sqlSubstring: string,
): string[] | undefined {
  const calls = prepareMock.mock.calls as string[][];
  return calls.find((c) => c.length >= 1 && typeof c[0] === "string" && c[0].includes(sqlSubstring));
}

// Local Env shape (matches worker's interface but exported for testing)
interface Env {
  NOTION_TOKEN: string;
  NOTION_DATABASE_ID: string;
  NOTION_DATA_SOURCE_ID: string;
  NOTION_WEBHOOK_VERIFICATION_TOKEN: string;
  ADMIN_TOKEN: string;
  SYNC_QUEUE: { send: (msg: unknown, opts?: { delaySeconds?: number }) => Promise<void>; sendBatch: (msgs: Array<{ body: unknown }>) => Promise<void> };
  DB: ReturnType<typeof mockD1Db>;
  CONTENT_BUCKET: ReturnType<typeof mockR2Bucket>;
}

// ── Mock builders ──

interface MockD1Row {
  [key: string]: unknown;
}

function mockD1Db(rows: Map<string, MockD1Row[]> = new Map()) {
  const db = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    batch: vi.fn(),
    exec: vi.fn(),
    raw: vi.fn(),
  };

  // Default: `run()` resolves successfully
  db.run.mockResolvedValue({ success: true });
  db.all.mockResolvedValue({ results: [], success: true });
  db.first.mockResolvedValue(null);
  db.raw.mockResolvedValue([]);
  db.batch.mockResolvedValue([]);
  db.exec.mockResolvedValue({ success: true });

  // Allow per-query spy setup
  return db;
}

function mockR2Bucket(objects: Map<string, string> = new Map()) {
  return {
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      objects.set(key, value);
      return { key, size: value.length };
    }),
    get: vi.fn().mockImplementation(async (key: string) => {
      const val = objects.get(key);
      if (!val) return null;
      const encoder = new TextEncoder();
      return {
        key,
        size: val.length,
        body: null as unknown as ReadableStream,
        arrayBuffer: async () => encoder.encode(val).buffer,
        text: async () => val,
      };
    }),
    head: vi.fn().mockImplementation(async (key: string) => {
      const val = objects.get(key);
      return val ? { key, size: val.length } : null;
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [] }),
  };
}

function mockQueue() {
  const messages: unknown[] = [];
  return {
    messages,
    send: vi.fn().mockImplementation(async (msg: unknown) => {
      messages.push(msg);
    }),
    sendBatch: vi.fn().mockImplementation(async (batch: Array<{ body: unknown }>) => {
      for (const m of batch) messages.push(m.body);
    }),
  };
}

function buildEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    NOTION_TOKEN: "test-notion-token",
    NOTION_DATABASE_ID: "test-db-id",
    NOTION_DATA_SOURCE_ID: "test-ds-id",
    NOTION_WEBHOOK_VERIFICATION_TOKEN: "test-webhook-secret",
    ADMIN_TOKEN: "test-admin-token",
    SYNC_QUEUE: mockQueue() as unknown as Env["SYNC_QUEUE"],
    DB: mockD1Db() as unknown as Env["DB"],
    CONTENT_BUCKET: mockR2Bucket() as unknown as Env["CONTENT_BUCKET"],
    ...overrides,
  } as Env;
}

// ── Helpers ──

/** Wrap Hono's app.fetch() for use in tests */
async function request(
  appInstance: typeof app,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> },
  env: Env,
) {
  const url = new URL(path, "http://localhost");
  const init: RequestInit = {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...options.headers },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const req = new Request(url.toString(), init);
  // Hono's fetch signature: (request, env, executionCtx)
  return appInstance.fetch(req, env as never, {} as never);
}

// ── Tests ──

describe("Worker HTTP routes", () => {
  let env: ReturnType<typeof buildEnv>;

  beforeEach(() => {
    env = buildEnv();
  });

  // ── Health ──

  describe("GET /health", () => {
    it("returns ok", async () => {
      const res = await request(app, "/health", {}, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; timestamp: string };
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });
  });

  describe("GET /health/deep", () => {
    it("reports configured services", async () => {
      const res = await request(app, "/health/deep", {}, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; checks: Record<string, string> };
      expect(body.status).toBe("ok");
      expect(body.checks.notion_token).toBe("configured");
    });
  });

  // ── Webhook ──

  describe("POST /webhooks/notion", () => {
    it("returns 401 for missing signature on runtime event", async () => {
      const res = await request(app, "/webhooks/notion", {
        method: "POST",
        body: { type: "page.updated", page_id: "abc" },
      }, env);
      expect(res.status).toBe(401);
    });

    it("echoes verification_token for one-time challenge", async () => {
      const res = await request(app, "/webhooks/notion", {
        method: "POST",
        body: { verification_token: "test-challenge" },
      }, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { verification_token: string };
      expect(body.verification_token).toBe("test-challenge");
    });

    it("returns 400 for unrecognized event", async () => {
      // Mock signature verification to pass
      vi.spyOn(
        await import("../lib/webhook.js"),
        "verifyWebhookSignature",
      ).mockResolvedValue(true);

      const res = await request(app, "/webhooks/notion", {
        method: "POST",
        body: { data: {} },
        headers: { "x-notion-verification-signature": "fake-sig" },
      }, env);
      expect(res.status).toBe(400);

      vi.restoreAllMocks();
    });
  });

  // ── Admin routes ──

  describe("admin auth", () => {
    it("returns 403 for missing auth header", async () => {
      const res = await request(app, "/admin/sync/page", {
        method: "POST",
        body: { page_id: "abc" },
      }, env);
      expect(res.status).toBe(403);
    });

    it("returns 403 for wrong bearer token", async () => {
      const res = await request(app, "/admin/sync/page", {
        method: "POST",
        body: { page_id: "abc" },
        headers: { Authorization: "Bearer wrong-token" },
      }, env);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /admin/sync/page", () => {
    it("enqueues a sync job with valid auth", async () => {
      const res = await request(app, "/admin/sync/page", {
        method: "POST",
        body: { page_id: "page-123" },
        headers: { Authorization: "Bearer test-admin-token" },
      }, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { enqueued: boolean; page_id: string };
      expect(body.enqueued).toBe(true);
      expect(body.page_id).toBe("page-123");
    });

    it("returns 400 for missing page_id", async () => {
      const res = await request(app, "/admin/sync/page", {
        method: "POST",
        body: {},
        headers: { Authorization: "Bearer test-admin-token" },
      }, env);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /admin/manifest/regenerate", () => {
    it("regenerates manifest from D1 rows", async () => {
      const db = env.DB;
      (db.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        results: [
          {
            page_id: "p1", title: "Test Page", locale: "en",
            section: null, section_order: null, slug: "test-page",
            docusaurus_path: "/test-page", content_hash: "sha256:abc",
            notion_last_edited_time: "2026-01-01T00:00:00Z", status: "active",
          },
        ],
        success: true,
      });

      const res = await request(app, "/admin/manifest/regenerate", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
      }, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { regenerated: boolean; docs_count: number };
      expect(body.regenerated).toBe(true);
      expect(body.docs_count).toBe(1);
    });
  });
});

// ── Queue consumer integration tests ──

describe("queue consumer", () => {
  let env: ReturnType<typeof buildEnv>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    env = buildEnv();

    // Mock setTimeout so rate limiting resolves instantly
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );

    // Mock global fetch for Notion API calls
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildMessageBatch(pageId: string, jobId = "job-1") {
    return {
      messages: [
        {
          body: { type: "sync_page" as const, pageId, sourceId: "test-ds-id" },
          id: jobId,
          timestamp: new Date(),
          attempts: 1,
        },
      ],
      queue: "test-queue",
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };
  }

  it("processes a sync job end-to-end: fetches page, converts, writes R2 + D1", async () => {
    // Load fixture blocks (simple page, no images → no asset downloads)
    const fixturePath = join(__dirname, "../../test/fixtures/notion/simple-page.json");
    const fixtureBlocks = JSON.parse(readFileSync(fixturePath, "utf8"));

    // Mock page response
    const pageResponse = {
      id: "test-page-id",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      properties: {
        "Content elements": {
          id: "title",
          type: "title",
          title: [{ type: "text", text: { content: "Welcome" }, plain_text: "Welcome", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
        },
      },
    };

    // Mock blocks response (first call for top-level blocks)
    const blocksResponse = {
      object: "list",
      results: fixtureBlocks.results,
      next_cursor: null,
      has_more: false,
    };

    // Set up fetch mock: first call = getPage, second = getBlockChildren
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(blocksResponse), { status: 200 }));

    // D1: no existing page (first sync → no skip)
    env.DB.first.mockResolvedValue(null);

    const batch = buildMessageBatch("test-page-id");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(batch as any, env, {} as any);

    // Verify Notion API was called
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify R2 writes (metadata, doc, raw page, raw blocks)
    const putCalls = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls;
    const putKeys = putCalls.map((c: unknown[]) => c[0]);
    expect(putKeys).toContain("pages/test-page-id/metadata.json");
    expect(putKeys).toContain("docs/en/docs/welcome.md");
    expect(putKeys).toContain("pages/test-page-id/raw-page.json");
    expect(putKeys).toContain("pages/test-page-id/raw-blocks.json");

    // Verify D1 upsert (INSERT OR REPLACE into source_pages)
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "INSERT OR REPLACE INTO source_pages")).toBeDefined();

    // Verify job marked complete
    expect(findPrepareCall(prepareMock, "completed")).toBeDefined();

    // Verify watermark updated
    expect(findPrepareCall(prepareMock, "last_sync_watermark")).toBeDefined();
  });

  it("skips page when content_hash and status unchanged", async () => {
    const fixturePath = join(__dirname, "../../test/fixtures/notion/simple-page.json");
    const fixtureBlocks = JSON.parse(readFileSync(fixturePath, "utf8"));

    // Compute expected hash from the fixture — same as convertPageData would compute
    const rawMarkdown = convertBlocks(fixtureBlocks as NotionBlockList);
    const markdownBody = postProcessMarkdown(rawMarkdown, "Welcome");
    const expectedHash = await contentHash(markdownBody);

    const pageResponse = {
      id: "test-page-id",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      properties: {
        "Content elements": {
          id: "title", type: "title",
          title: [{ type: "text", text: { content: "Welcome" }, plain_text: "Welcome", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
        },
      },
    };

    const blocksResponse = {
      object: "list", results: fixtureBlocks.results, next_cursor: null, has_more: false,
    };

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(blocksResponse), { status: 200 }));

    // D1 returns matching content_hash and status → should skip
    // (status will be "draft" since fixture has no Drafting Status property)
    env.DB.first.mockResolvedValue({
      content_hash: expectedHash,
      status: "draft",
    });

    const batch = buildMessageBatch("test-page-id", "job-skip");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(batch as any, env, {} as any);

    // Verify R2 was NOT written (skip happened)
    const putCalls = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(putCalls.length).toBe(0);

    // Verify job marked skipped
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "skipped")).toBeDefined();
  });

  it("records failure when Notion API errors", async () => {
    // Mock a 500 error from Notion
    fetchMock.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }));

    const batch = buildMessageBatch("error-page", "job-err");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(batch as any, env, {} as any);

    // Verify job marked failed
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "failed")).toBeDefined();
  });
});
