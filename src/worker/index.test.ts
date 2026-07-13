/**
 * Integration tests for Worker Hono routes and queue consumer.
 *
 * Uses Hono's built-in `app.request()` for HTTP route testing.
 * Mock D1, R2, and Queue bindings via plain objects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We only import types and the default export (Hono app) + queue consumer.
// The worker module has side effects (global type declarations) — fine.
import { app, queueHandler, scheduledHandler, queryChangedPages } from "./index.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convertBlocks } from "../lib/notion-converter.js";
import { contentHash } from "../lib/hash.js";
import { postProcessMarkdown } from "../lib/post-process.js";
import { ContentManifestSchema } from "../schemas/manifest.js";
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

function mockD1Db(_rows: Map<string, MockD1Row[]> = new Map()) {
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
    // Enumerate the in-memory map by prefix so manifest regen can list pages/*.
    list: vi.fn().mockImplementation(async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? "";
      return {
        objects: [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({ key: k, size: v.length })),
      };
    }),
  };
}

/** A full, schema-valid PageMetadata blob (as written by the queue consumer). */
function validMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    page_id: "p1",
    title: "Intro",
    source_url: "https://notion.so/p1",
    notion_last_edited_time: "2026-01-01T00:00:00.000Z",
    content_hash: "sha256:abc",
    raw_hash: "sha256:def",
    locale: "en",
    section: "docs",
    section_order: 1,
    slug: "intro",
    docusaurus_id: "docs/intro",
    status: "active",
    element_type: "page",
    drafting_status: "Draft published",
    // Raw Notion property objects, as sync actually stores them — the manifest
    // reads the extracted top-level fields, never these.
    properties: {
      "Element Type": { id: "nqRr", type: "select", select: { name: "Page" } },
      "Publish Status": { id: "BQMv", type: "select", select: { name: "Draft published" } },
    },
    assets: [],
    sub_items: [],
    ...overrides,
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
    it("writes a schema-valid manifest built from R2 metadata blobs", async () => {
      const objects = new Map([["pages/p1/metadata.json", JSON.stringify(validMetadata())]]);
      env.CONTENT_BUCKET = mockR2Bucket(objects) as unknown as Env["CONTENT_BUCKET"];

      const res = await request(app, "/admin/manifest/regenerate", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
      }, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { regenerated: boolean; docs_count: number; skipped_count: number };
      expect(body.regenerated).toBe(true);
      expect(body.docs_count).toBe(1);
      expect(body.skipped_count).toBe(0);

      // The written latest.json must pass ContentManifestSchema.
      const puts = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const latestPut = puts.find((c) => c[0] === "manifests/latest.json");
      expect(latestPut).toBeDefined();
      const written = JSON.parse(latestPut![1] as string);
      expect(() => ContentManifestSchema.parse(written)).not.toThrow();
      // element_type/drafting_status flow through from the metadata blob.
      expect(written.docs[0].element_type).toBe("page");
      expect(written.docs[0].drafting_status).toBe("Draft published");
      // sidebars populated, not {}.
      expect(Object.keys(written.sidebars)).toContain("en");
    });

    it("refuses to clobber a non-empty manifest with a 0-doc result (409)", async () => {
      const existing = {
        schema_version: "1.0",
        generated_at: "2026-01-01T00:00:00.000Z",
        source: { type: "notion", database_id: "test-db-id", data_source_id: "test-ds-id" },
        docs: [{ page_id: "old", title: "Old", locale: "en" }],
        sidebars: {},
      };
      // No pages/ metadata blobs → buildManifestFromStorage yields 0 docs.
      const objects = new Map([["manifests/latest.json", JSON.stringify(existing)]]);
      env.CONTENT_BUCKET = mockR2Bucket(objects) as unknown as Env["CONTENT_BUCKET"];

      const res = await request(app, "/admin/manifest/regenerate", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
      }, env);
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/clobber/);

      // latest.json must be untouched — no put to that key or a version.
      const puts = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const putKeys = puts.map((c) => c[0] as string);
      expect(putKeys).not.toContain("manifests/latest.json");
      expect(putKeys.some((k) => k.startsWith("manifests/versions/"))).toBe(false);
    });

    it("returns 503 and writes no manifest on transient storage read failures", async () => {
      const objects = new Map([
        ["pages/p1/metadata.json", JSON.stringify(validMetadata())],
        ["pages/p2/metadata.json", JSON.stringify(validMetadata({ page_id: "p2", slug: "two", docusaurus_id: "docs/two" }))],
      ]);
      env.CONTENT_BUCKET = mockR2Bucket(objects) as unknown as Env["CONTENT_BUCKET"];
      // One metadata key's get throws — transient R2 hiccup, distinct from a corrupt blob.
      (env.CONTENT_BUCKET.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
        if (key === "pages/p2/metadata.json") throw new Error("R2 transient");
        const val = objects.get(key);
        if (!val) return null;
        return {
          key,
          size: val.length,
          body: null as unknown as ReadableStream,
          arrayBuffer: async () => new TextEncoder().encode(val).buffer,
          text: async () => val,
        };
      });

      const res = await request(app, "/admin/manifest/regenerate", {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
      }, env);
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string; read_errors: number };
      expect(body.error).toMatch(/transient storage read failures/);
      expect(body.read_errors).toBe(1);

      // No manifest write occurred — the existing manifest is left intact.
      const puts = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      expect(puts.find((c) => c[0] === "manifests/latest.json")).toBeUndefined();
      expect(puts.some((c) => (c[0] as string)?.startsWith("manifests/versions/"))).toBe(false);
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

    // Consumer no longer advances last_sync_watermark — the cron owns it.
    expect(findPrepareCall(prepareMock, "VALUES ('last_sync_watermark'")).toBeUndefined();

    // Changed path must mark the manifest dirty for cron rebuild (spec §6.1)
    expect(findPrepareCall(prepareMock, "manifest_dirty")).toBeDefined();
  });

  it("sets manifest_dirty even when a later step (sidebar regen) fails", async () => {
    // Ordering invariant (review round 5): once the source_pages hash is
    // updated, a retry takes the hash-skip path and never sets the flag — so
    // the flag write must directly follow the upsert, before any fallible
    // step. Here the sidebar R2 put throws; the flag must still be set and the
    // job recorded as failed.
    const fixturePath = join(__dirname, "../../test/fixtures/notion/simple-page.json");
    const fixtureBlocks = JSON.parse(readFileSync(fixturePath, "utf8"));
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
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", results: fixtureBlocks.results, next_cursor: null, has_more: false }), { status: 200 }));
    env.DB.first.mockResolvedValue(null);

    // Sidebar writes go to sidebars/<locale>.json — make exactly those throw.
    const bucket = env.CONTENT_BUCKET as ReturnType<typeof mockR2Bucket>;
    const realPut = bucket.put.getMockImplementation()!;
    bucket.put.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith("sidebars/")) throw new Error("sidebar write failed");
      return realPut(key, value);
    });

    const batch = buildMessageBatch("test-page-id");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(batch as any, env, {} as any);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "manifest_dirty")).toBeDefined();
    expect(findPrepareCall(prepareMock, "'failed'")).toBeDefined();
  });

  /** Arm fetchMock with the page + blocks responses for one queueHandler run. */
  function armPageFetch(fixtureBlocks: { results: unknown[] }, title = "Welcome") {
    const pageResponse = {
      id: "test-page-id",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      properties: {
        "Content elements": {
          id: "title", type: "title",
          title: [{ type: "text", text: { content: title }, plain_text: title, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
        },
      },
    };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", results: fixtureBlocks.results, next_cursor: null, has_more: false }), { status: 200 }));
  }

  const matchingRow = (expectedHash: string) => ({
    content_hash: expectedHash,
    status: "draft",
    title: "Welcome",
    locale: "en",
    section: null,
    section_order: null,
    slug: "welcome",
    r2_doc_key: "docs/en/docs/welcome.md",
  });

  it("skips a second sync of an identical page (D1 row AND stored metadata blob match)", async () => {
    const fixturePath = join(__dirname, "../../test/fixtures/notion/simple-page.json");
    const fixtureBlocks = JSON.parse(readFileSync(fixturePath, "utf8"));
    const rawMarkdown = convertBlocks(fixtureBlocks as NotionBlockList);
    const markdownBody = postProcessMarkdown(rawMarkdown, "Welcome");
    const expectedHash = await contentHash(markdownBody);

    // First run: no existing row → full path writes the metadata blob into the
    // mock bucket. That blob is the authoritative skip gate for run two.
    armPageFetch(fixtureBlocks);
    env.DB.first.mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(buildMessageBatch("test-page-id", "job-first") as any, env, {} as any);

    // Second run: D1 row matches every artifact-affecting field and the stored
    // blob equals the fresh extraction → skip.
    (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mockClear();
    (env.DB.prepare as ReturnType<typeof vi.fn>).mockClear();
    armPageFetch(fixtureBlocks);
    env.DB.first.mockResolvedValue(matchingRow(expectedHash));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(buildMessageBatch("test-page-id", "job-skip") as any, env, {} as any);

    // Verify R2 was NOT written (skip happened)
    const putCalls = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(putCalls.length).toBe(0);

    // Verify job marked skipped
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "skipped")).toBeDefined();

    // Skip path records the observed Notion edit time so the cron can dedupe the
    // boundary-minute re-query on the next tick (perpetual-re-enqueue fix).
    expect(findPrepareCall(prepareMock, "UPDATE source_pages SET notion_last_edited_time")).toBeDefined();
    const bindMock = env.DB.bind as ReturnType<typeof vi.fn>;
    const bindCalls = bindMock.mock.calls as unknown[][];
    // metadata.notion_last_edited_time comes from the page fixture's last_edited_time.
    expect(bindCalls.some((c) => c.includes("2026-01-01T00:00:00.000Z"))).toBe(true);

    // Skip path must NOT advance the watermark (cron owns it) NOR mark the manifest dirty
    expect(findPrepareCall(prepareMock, "VALUES ('last_sync_watermark'")).toBeUndefined();
    expect(findPrepareCall(prepareMock, "manifest_dirty")).toBeUndefined();
  });

  it("blob-only change (e.g. element_type flip) defeats the skip even when the D1 row matches", async () => {
    const fixturePath = join(__dirname, "../../test/fixtures/notion/simple-page.json");
    const fixtureBlocks = JSON.parse(readFileSync(fixturePath, "utf8"));
    const rawMarkdown = convertBlocks(fixtureBlocks as NotionBlockList);
    const markdownBody = postProcessMarkdown(rawMarkdown, "Welcome");
    const expectedHash = await contentHash(markdownBody);

    // First run writes the real blob.
    armPageFetch(fixtureBlocks);
    env.DB.first.mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(buildMessageBatch("test-page-id", "job-seed") as any, env, {} as any);

    // Corrupt the stored blob's element_type — D1 doesn't store that field, so
    // only the blob comparison can catch the difference.
    const bucket = env.CONTENT_BUCKET as ReturnType<typeof mockR2Bucket>;
    const stored = await bucket.get("pages/test-page-id/metadata.json");
    const blob = JSON.parse(await stored!.text());
    blob.element_type = "Toggle";
    await bucket.put("pages/test-page-id/metadata.json", JSON.stringify(blob));

    (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mockClear();
    (env.DB.prepare as ReturnType<typeof vi.fn>).mockClear();
    armPageFetch(fixtureBlocks);
    env.DB.first.mockResolvedValue(matchingRow(expectedHash));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(buildMessageBatch("test-page-id", "job-blob-diff") as any, env, {} as any);

    // Full path: artifacts rewritten, manifest marked dirty.
    const putKeys = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(putKeys).toContain("pages/test-page-id/metadata.json");
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "manifest_dirty")).toBeDefined();
    expect(findPrepareCall(prepareMock, "skipped")).toBeUndefined();
  });

  it("metadata-only change (same hash+status, different section) takes the full path and deletes the moved doc", async () => {
    const fixturePath = join(__dirname, "../../test/fixtures/notion/simple-page.json");
    const fixtureBlocks = JSON.parse(readFileSync(fixturePath, "utf8"));
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
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", results: fixtureBlocks.results, next_cursor: null, has_more: false }), { status: 200 }));

    // Same hash + status, but the stored row carries an OLD section → doc key moved.
    env.DB.first.mockResolvedValue({
      content_hash: expectedHash,
      status: "draft",
      title: "Welcome",
      locale: "en",
      section: "Old Section",
      section_order: 3,
      slug: "welcome",
      r2_doc_key: "docs/en/docs/Old Section/welcome.md",
    });

    const batch = buildMessageBatch("test-page-id", "job-meta-change");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(batch as any, env, {} as any);

    // Full path: artifacts written, manifest marked dirty.
    const putKeys = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(putKeys).toContain("docs/en/docs/welcome.md");
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "manifest_dirty")).toBeDefined();

    // The old doc is NOT deleted inline — the manifest still references it
    // until the cron rebuild. It is queued as a stale_doc sync_state row.
    const deleteCalls = (env.CONTENT_BUCKET.delete as ReturnType<typeof vi.fn>).mock.calls;
    expect(deleteCalls.length).toBe(0);
    const bindMock = env.DB.bind as ReturnType<typeof vi.fn>;
    const bindCalls = bindMock.mock.calls as unknown[][];
    expect(bindCalls.some((c) => c.includes("stale_doc:docs/en/docs/Old Section/welcome.md"))).toBe(true);
  });

  it("asset upload failure fails the job: no source_pages upsert, no manifest_dirty", async () => {
    // images.json fixture carries an image block → convertPageData downloads and
    // rehosts it, producing assetBinaries whose R2 put we make throw.
    const fixturePath = join(__dirname, "../../test/fixtures/notion/images.json");
    const fixtureBlocks = JSON.parse(readFileSync(fixturePath, "utf8"));

    const pageResponse = {
      id: "test-page-id",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      properties: {
        "Content elements": {
          id: "title", type: "title",
          title: [{ type: "text", text: { content: "Pics" }, plain_text: "Pics", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
        },
      },
    };
    // Fetch order: getPage, getBlockChildren, then asset download(s).
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", results: fixtureBlocks.results, next_cursor: null, has_more: false }), { status: 200 }))
      .mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } }));

    env.DB.first.mockResolvedValue(null); // no existing row → full path

    const bucket = env.CONTENT_BUCKET as ReturnType<typeof mockR2Bucket>;
    const realPut = bucket.put.getMockImplementation()!;
    bucket.put.mockImplementation(async (key: string, value: never) => {
      if (key.startsWith("assets/")) throw new Error("R2 hiccup");
      return realPut(key, value);
    });

    const batch = buildMessageBatch("test-page-id", "job-asset-fail");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(batch as any, env, {} as any);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "'failed'")).toBeDefined();
    expect(findPrepareCall(prepareMock, "INSERT OR REPLACE INTO source_pages")).toBeUndefined();
    expect(findPrepareCall(prepareMock, "manifest_dirty")).toBeUndefined();
    // The ClassifiedError(NETWORK) must reach the retry gate — the message is
    // re-queued, not acked (a plain Error classifies unknown and is lost).
    expect(batch.retryAll).toHaveBeenCalled();
  });

  it("asset pages still skip when only raw_hash and signed original_url rotated", async () => {
    // Rotating signed Notion URLs change assets[].original_url and raw_hash on
    // every fetch; the stable-metadata gate must ignore both or asset pages
    // would rewrite artifacts on every redelivery (spec §16.2).
    const fixturePath = join(__dirname, "../../test/fixtures/notion/images.json");
    const fixtureBlocks = JSON.parse(readFileSync(fixturePath, "utf8"));

    const armImagesFetch = () => {
      const pageResponse = {
        id: "test-page-id",
        last_edited_time: "2026-01-01T00:00:00.000Z",
        properties: {
          "Content elements": {
            id: "title", type: "title",
            title: [{ type: "text", text: { content: "Pics" }, plain_text: "Pics", annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
          },
        },
      };
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", results: fixtureBlocks.results, next_cursor: null, has_more: false }), { status: 200 }))
        .mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } }));
    };

    // Seed run writes the real blob (with assets).
    armImagesFetch();
    env.DB.first.mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(buildMessageBatch("test-page-id", "job-seed-assets") as any, env, {} as any);

    // Simulate the rotation: stored blob carries a DIFFERENT raw_hash and
    // original_url than the fresh extraction will produce.
    const bucket = env.CONTENT_BUCKET as ReturnType<typeof mockR2Bucket>;
    const stored = await bucket.get("pages/test-page-id/metadata.json");
    const blob = JSON.parse(await stored!.text());
    expect(Array.isArray(blob.assets) && blob.assets.length > 0).toBe(true);
    blob.raw_hash = "sha256:rotated-raw";
    blob.assets = blob.assets.map((a: Record<string, unknown>) => ({ ...a, original_url: "https://notion.example/rotated?sig=zzz" }));
    await bucket.put("pages/test-page-id/metadata.json", JSON.stringify(blob));

    // D1 row built from the blob's own stable fields → row pre-filter passes.
    (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mockClear();
    (env.DB.prepare as ReturnType<typeof vi.fn>).mockClear();
    armImagesFetch();
    env.DB.first.mockResolvedValue({
      content_hash: blob.content_hash,
      status: blob.status,
      title: blob.title,
      locale: blob.locale,
      section: blob.section,
      section_order: blob.section_order,
      slug: blob.slug,
      r2_doc_key: `docs/${blob.locale}/docs/${blob.slug}.md`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueHandler(buildMessageBatch("test-page-id", "job-rotated") as any, env, {} as any);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "skipped")).toBeDefined();
    expect((env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
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

// ── 5.4 Cron / scheduledHandler tests ──

describe("scheduledHandler (cron, plan 5.4)", () => {
  let env: ReturnType<typeof buildEnv>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const DS_ID = "test-ds-id";

  function makeSdkPageResult(id: string, last_edited_time: string) {
    return { object: "page", id, last_edited_time, properties: {} };
  }

  function sdkQueryResponse(
    pages: ReturnType<typeof makeSdkPageResult>[],
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
    env = buildEnv();

    // NOTE: Do NOT mock globalThis.setTimeout here.
    // The @notionhq/client SDK uses setTimeout for request timeouts. Mocking it
    // to fire immediately causes the SDK's timeout to beat the fetch mock, raising
    // RequestTimeoutError. The NotionClient throttle at maxRps:999 is ~1ms and
    // resolves without sleeping on the first request.

    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // getLastSyncWatermark queries D1 — return null by default (no prior watermark)
    (env.DB.first as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(">50 changed pages: paginates without loss (two API pages → all enqueued)", async () => {
    const page1Pages = Array.from({ length: 5 }, (_, i) =>
      makeSdkPageResult(`page-a${i}`, "2026-06-01T00:00:00.000Z"),
    );
    const page2Pages = Array.from({ length: 4 }, (_, i) =>
      makeSdkPageResult(`page-b${i}`, "2026-06-01T00:00:00.000Z"),
    );

    fetchMock
      .mockResolvedValueOnce(sdkQueryResponse(page1Pages, "cursor-p2", true))
      .mockResolvedValueOnce(sdkQueryResponse(page2Pages, null, false));

    await scheduledHandler({} as never, env, {} as never);

    // All 9 pages (5 + 4) should have been enqueued — not just the first 5
    const queue = env.SYNC_QUEUE as ReturnType<typeof mockQueue>;
    expect(queue.messages).toHaveLength(9);
    expect(queue.messages.map((m) => (m as { pageId: string }).pageId)).toEqual(
      expect.arrayContaining(["page-a0", "page-a4", "page-b0", "page-b3"]),
    );
  });

  it("watermark + 60s lookback: skips older pages, keeps same-minute boundary", async () => {
    const since = "2026-06-01T00:00:00.000Z";

    // Provide a watermark via D1 mock
    (env.DB.first as ReturnType<typeof vi.fn>).mockResolvedValue({ value: since });

    const newPage   = makeSdkPageResult("new-page",  "2026-06-15T00:00:00.000Z");
    const oldPage   = makeSdkPageResult("old-page",  "2026-05-31T00:00:00.000Z"); // before watermark-60s
    const equalPage = makeSdkPageResult("equal-page", since); // exactly equal to watermark

    fetchMock.mockResolvedValueOnce(sdkQueryResponse([newPage, oldPage, equalPage], null, false));

    await scheduledHandler({} as never, env, {} as never);

    // new-page and equal-page are enqueued; old-page (before the 60s lookback
    // window) is skipped. equal-page is kept because the lookback re-queries the
    // watermark's own minute and the consumer hash-skips it.
    const queue = env.SYNC_QUEUE as ReturnType<typeof mockQueue>;
    const enqueuedIds = queue.messages.map((m) => (m as { pageId: string }).pageId);
    expect(enqueuedIds).toContain("new-page");
    expect(enqueuedIds).toContain("equal-page");
    expect(enqueuedIds).not.toContain("old-page");
  });

  it("dead-status transitions stay visible: cron query carries NO status guard", async () => {
    // Inverted contract (review round 4): the cron must see pages whose Publish
    // Status flipped to Remove/Unplublished so consumers can retire them. The
    // dead-status exclusion applies only to full imports, never to the cron.
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));

    await scheduledHandler({} as never, env, {} as never);

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`data_sources/${DS_ID}/query`);

    const body = JSON.parse(init.body as string);
    // No stored watermark in this test → no since → no filter at all.
    expect(body.filter).toBeUndefined();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("Publish Status");
    expect(bodyStr).not.toContain("does_not_equal");
    // Must not reference Parent item or Sub-item (v3 regression guard)
    expect(bodyStr).not.toContain("Parent item");
    expect(bodyStr).not.toContain("Sub-item");
  });

  it("with a stored watermark: cron filter is the time window only, no status clauses", async () => {
    const db = env.DB as ReturnType<typeof mockD1Db>;
    db.first.mockResolvedValueOnce({ value: "2026-06-01T00:10:00.000Z" }); // last_sync_watermark
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));

    await scheduledHandler({} as never, env, {} as never);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filter).toBeDefined();
    const filterStr = JSON.stringify(body.filter);
    expect(filterStr).toContain("last_edited_time");
    expect(filterStr).not.toContain("Publish Status");
    expect(filterStr).not.toContain("does_not_equal");
  });

  it("respects limit cap (MAX_PAGES_PER_CRON=50): stops after 50 pageIds", async () => {
    // Distinct ascending timestamps so the cap cuts cleanly at 50. (Same-minute
    // runs now extend past the cap on purpose — covered by the boundary test below.)
    const pages = Array.from({ length: 60 }, (_, i) =>
      makeSdkPageResult(`page-${i}`, `2026-06-01T00:${String(i).padStart(2, "0")}:00.000Z`),
    );
    fetchMock.mockResolvedValueOnce(sdkQueryResponse(pages, null, false));

    await scheduledHandler({} as never, env, {} as never);

    // scheduledHandler uses maxPages=50, so only 50 should be enqueued
    const queue = env.SYNC_QUEUE as ReturnType<typeof mockQueue>;
    expect(queue.messages).toHaveLength(50);
    // Watermark advanced to the 50th page's timestamp (minute 49); pages 50-59 deferred.
    const bindMock = env.DB.bind as ReturnType<typeof vi.fn>;
    const bindCalls = bindMock.mock.calls as unknown[][];
    expect(bindCalls.some((c) => c.includes("2026-06-01T00:49:00.000Z"))).toBe(true);
  });

  // ── watermark advancement (cron owns the watermark) ──

  it("advances watermark to the newest enqueued timestamp (not wall-clock)", async () => {
    const p1 = makeSdkPageResult("p1", "2026-06-01T00:01:00.000Z");
    const p2 = makeSdkPageResult("p2", "2026-06-01T00:02:00.000Z");
    const p3 = makeSdkPageResult("p3", "2026-06-01T00:03:00.000Z");
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([p1, p2, p3], null, false));

    await scheduledHandler({} as never, env, {} as never);

    const queue = env.SYNC_QUEUE as ReturnType<typeof mockQueue>;
    expect(queue.messages).toHaveLength(3);

    // Watermark written with the newest page's last_edited_time (ascending → last).
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "VALUES ('last_sync_watermark'")).toBeDefined();
    const bindMock = env.DB.bind as ReturnType<typeof vi.fn>;
    const bindCalls = bindMock.mock.calls as unknown[][];
    expect(bindCalls.some((c) => c.includes("2026-06-01T00:03:00.000Z"))).toBe(true);
  });

  it("zero changed pages: leaves the watermark untouched", async () => {
    (env.DB.first as ReturnType<typeof vi.fn>).mockResolvedValue({ value: "2026-06-01T00:30:00.000Z" });
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));

    await scheduledHandler({} as never, env, {} as never);

    // No pages → no enqueue, no watermark write (only the read happens).
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "VALUES ('last_sync_watermark'")).toBeUndefined();
  });

  it("cap extends the slice through a same-minute boundary run", async () => {
    // limit=2; A(t1) B(t2) C(t2) D(t3) → A,B,C enqueued, watermark=t2, D deferred.
    const A = makeSdkPageResult("A", "2026-06-01T00:01:00.000Z");
    const B = makeSdkPageResult("B", "2026-06-01T00:02:00.000Z");
    const C = makeSdkPageResult("C", "2026-06-01T00:02:00.000Z");
    const D = makeSdkPageResult("D", "2026-06-01T00:03:00.000Z");
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([A, B, C, D], null, false));

    const pages = await queryChangedPages(env, null, 2);

    expect(pages.map((p) => p.id)).toEqual(["A", "B", "C"]);
    expect(pages[pages.length - 1].last_edited_time).toBe("2026-06-01T00:02:00.000Z");
  });

  it("60s lookback: query filter uses watermark-60s and includes the same-minute page", async () => {
    const w = "2026-06-01T00:30:00.000Z";
    (env.DB.first as ReturnType<typeof vi.fn>).mockResolvedValue({ value: w });

    // A page edited exactly at the watermark minute — missed without the lookback.
    const boundary = makeSdkPageResult("boundary", w);
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([boundary], null, false));

    await scheduledHandler({} as never, env, {} as never);

    // The API filter's last_edited_time.after = w - 60s.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(JSON.stringify(body.filter)).toContain("2026-06-01T00:29:00.000Z");

    // And the same-minute page is enqueued (hash-skipped later by the consumer).
    const queue = env.SYNC_QUEUE as ReturnType<typeof mockQueue>;
    expect(queue.messages.map((m) => (m as { pageId: string }).pageId)).toContain("boundary");
  });

  // ── cron dedupe against D1 (perpetual boundary re-enqueue fix) ──

  it("dedupes candidates already processed at their current edit time", async () => {
    // p1 already processed (D1 edit time matches); p2 has no D1 row.
    const p1 = makeSdkPageResult("p1", "2026-06-01T00:01:00.000Z");
    const p2 = makeSdkPageResult("p2", "2026-06-01T00:02:00.000Z");
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([p1, p2], null, false));

    // first() = watermark (null); all() = dedupe lookup returning p1's row only.
    (env.DB.first as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (env.DB.all as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ page_id: "p1", notion_last_edited_time: "2026-06-01T00:01:00.000Z" }],
      success: true,
    });

    await scheduledHandler({} as never, env, {} as never);

    // Only p2 enqueued; p1 deduped.
    const queue = env.SYNC_QUEUE as ReturnType<typeof mockQueue>;
    expect(queue.messages.map((m) => (m as { pageId: string }).pageId)).toEqual(["p2"]);

    // Watermark still advanced to the newest candidate time (p2's), pre-dedupe.
    const bindMock = env.DB.bind as ReturnType<typeof vi.fn>;
    const bindCalls = bindMock.mock.calls as unknown[][];
    expect(bindCalls.some((c) => c.includes("2026-06-01T00:02:00.000Z"))).toBe(true);
  });

  it("all candidates deduped: zero enqueues, watermark still advances", async () => {
    const p1 = makeSdkPageResult("p1", "2026-06-01T00:01:00.000Z");
    const p2 = makeSdkPageResult("p2", "2026-06-01T00:02:00.000Z");
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([p1, p2], null, false));

    (env.DB.first as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // Both candidates already processed at their current edit times.
    (env.DB.all as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        { page_id: "p1", notion_last_edited_time: "2026-06-01T00:01:00.000Z" },
        { page_id: "p2", notion_last_edited_time: "2026-06-01T00:02:00.000Z" },
      ],
      success: true,
    });

    await scheduledHandler({} as never, env, {} as never);

    const queue = env.SYNC_QUEUE as ReturnType<typeof mockQueue>;
    expect(queue.messages).toHaveLength(0);

    // Watermark still advances to newest candidate (p2) even with zero enqueues.
    const bindMock = env.DB.bind as ReturnType<typeof vi.fn>;
    const bindCalls = bindMock.mock.calls as unknown[][];
    expect(bindCalls.some((c) => c.includes("2026-06-01T00:02:00.000Z"))).toBe(true);
  });

  // ── manifest_dirty rebuild (spec §6.1) ──

  it("cron sweeps queued stale_doc keys only after a successful manifest write", async () => {
    const db = env.DB as ReturnType<typeof mockD1Db>;
    // Watermark read (null), then manifest_dirty read ("1").
    db.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: "1" });
    // Cron query returns no changed pages.
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));
    // A valid metadata blob so the rebuild writes a non-empty manifest, plus a
    // queued stale_doc row surfaced by the LIKE select.
    const bucket = env.CONTENT_BUCKET as ReturnType<typeof mockR2Bucket>;
    await bucket.put("pages/p1/metadata.json", JSON.stringify(validMetadata()));
    db.all.mockImplementation(async () => ({
      results: [{ key: "stale_doc:docs/en/docs/Old Section/welcome.md" }],
      success: true,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scheduledHandler({} as never, env, {} as any);

    const deleteCalls = (env.CONTENT_BUCKET.delete as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(deleteCalls).toContain("docs/en/docs/Old Section/welcome.md");
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    // Manifest written before the sweep, and the queued row is removed.
    expect(findPrepareCall(prepareMock, "DELETE FROM sync_state WHERE key = ?")).toBeDefined();
    const putKeys = (bucket.put as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(putKeys).toContain("manifests/latest.json");
  });

  it("round-trip guard: a queued stale key that is current again is dequeued but NOT deleted", async () => {
    const db = env.DB as ReturnType<typeof mockD1Db>;
    // Watermark (null), manifest_dirty ("1"), then the sweep's current-key
    // check returns a row → the key is a page's live doc again (A→B→A move).
    db.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: "1" })
      .mockResolvedValueOnce({ one: 1 });
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));
    const bucket = env.CONTENT_BUCKET as ReturnType<typeof mockR2Bucket>;
    await bucket.put("pages/p1/metadata.json", JSON.stringify(validMetadata()));
    db.all.mockImplementation(async () => ({
      results: [{ key: "stale_doc:docs/en/docs/intro.md" }],
      success: true,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scheduledHandler({} as never, env, {} as any);

    const deleteCalls = (bucket.delete as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(deleteCalls).not.toContain("docs/en/docs/intro.md");
    // The queue row is still removed — nothing left to retry.
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "DELETE FROM sync_state WHERE key = ?")).toBeDefined();
  });

  it("manifest_dirty=1: cron rebuilds manifest and resets flag to 0", async () => {
    // No changed pages from Notion.
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));

    // first() call sequence: watermark (null), then manifest_dirty read ({value:"1"}).
    (env.DB.first as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: "1" });

    // Seed one metadata blob so the rebuild produces a 1-doc manifest.
    const objects = new Map([
      ["pages/p1/metadata.json", JSON.stringify(validMetadata())],
      ["manifests/latest.json", JSON.stringify({ docs: [{ page_id: "old" }], sidebars: {} })],
    ]);
    env.CONTENT_BUCKET = mockR2Bucket(objects) as unknown as Env["CONTENT_BUCKET"];

    await scheduledHandler({} as never, env, {} as never);

    // Manifest written + flag cleared to 0.
    const puts = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    expect(puts.find((c) => c[0] === "manifests/latest.json")).toBeDefined();

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "'manifest_dirty', '0'")).toBeDefined();
  });

  it("manifest_dirty absent: cron writes no manifest", async () => {
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));

    // Watermark null, then manifest_dirty read null (flag absent).
    (env.DB.first as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const objects = new Map([["manifests/latest.json", JSON.stringify({ docs: [], sidebars: {} })]]);
    env.CONTENT_BUCKET = mockR2Bucket(objects) as unknown as Env["CONTENT_BUCKET"];

    await scheduledHandler({} as never, env, {} as never);

    // No manifest write.
    const puts = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    expect(puts.find((c) => c[0] === "manifests/latest.json")).toBeUndefined();
  });

  it("manifest_dirty=1: clears the flag to 0 BEFORE the rebuild writes the manifest (call order)", async () => {
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));

    (env.DB.first as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: "1" });

    const objects = new Map([
      ["pages/p1/metadata.json", JSON.stringify(validMetadata())],
    ]);
    env.CONTENT_BUCKET = mockR2Bucket(objects) as unknown as Env["CONTENT_BUCKET"];

    await scheduledHandler({} as never, env, {} as never);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    const putMock = env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>;

    // The "clear to 0" prepare call.
    const clearIdx = prepareMock.mock.calls.findIndex(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("'manifest_dirty', '0'"),
    );
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    // The latest.json put call.
    const putIdx = putMock.mock.calls.findIndex((c) => c[0] === "manifests/latest.json");
    expect(putIdx).toBeGreaterThanOrEqual(0);

    // invocationCallOrder is a shared monotonic counter across all mocks.
    const clearOrder = prepareMock.mock.invocationCallOrder[clearIdx];
    const putOrder = putMock.mock.invocationCallOrder[putIdx];
    // The clear MUST happen before the rebuild's manifest put.
    expect(clearOrder).toBeLessThan(putOrder);
  });

  it("manifest_dirty=1: rebuild failure restores the flag to 1 (clear-then-restore)", async () => {
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));

    (env.DB.first as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: "1" });

    const objects = new Map([
      ["pages/p1/metadata.json", JSON.stringify(validMetadata())],
    ]);
    env.CONTENT_BUCKET = mockR2Bucket(objects) as unknown as Env["CONTENT_BUCKET"];
    // Make the manifest write fail → regenerateManifest throws → caught → flag restored.
    (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("R2 write failed"));

    await scheduledHandler({} as never, env, {} as never);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    // Flag was cleared first, then restored after the throw.
    expect(findPrepareCall(prepareMock, "'manifest_dirty', '0'")).toBeDefined();
    expect(findPrepareCall(prepareMock, "'manifest_dirty', '1'")).toBeDefined();
  });

  it("manifest_dirty=1: transient read errors restore the flag to 1 and write no manifest", async () => {
    fetchMock.mockResolvedValueOnce(sdkQueryResponse([], null, false));

    (env.DB.first as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: "1" });

    const objects = new Map([
      ["pages/p1/metadata.json", JSON.stringify(validMetadata())],
      ["pages/p2/metadata.json", JSON.stringify(validMetadata({ page_id: "p2", slug: "two", docusaurus_id: "docs/two" }))],
    ]);
    env.CONTENT_BUCKET = mockR2Bucket(objects) as unknown as Env["CONTENT_BUCKET"];
    // One metadata key's get throws — transient read error → regenerateManifest returns read_errors.
    (env.CONTENT_BUCKET.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key === "pages/p2/metadata.json") throw new Error("R2 transient");
      const val = objects.get(key);
      if (!val) return null;
      return {
        key,
        size: val.length,
        body: null as unknown as ReadableStream,
        arrayBuffer: async () => new TextEncoder().encode(val).buffer,
        text: async () => val,
      };
    });

    await scheduledHandler({} as never, env, {} as never);

    // No manifest write — the old manifest is left intact.
    const puts = (env.CONTENT_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    expect(puts.find((c) => c[0] === "manifests/latest.json")).toBeUndefined();

    // Flag cleared first, then restored after the read_errors status.
    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(findPrepareCall(prepareMock, "'manifest_dirty', '0'")).toBeDefined();
    expect(findPrepareCall(prepareMock, "'manifest_dirty', '1'")).toBeDefined();
  });
});
