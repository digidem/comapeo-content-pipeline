/**
 * Integration tests for Worker Hono routes and queue consumer.
 *
 * Uses Hono's built-in `app.request()` for HTTP route testing.
 * Mock D1, R2, and Queue bindings via plain objects.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// We only import types and the default export (Hono app) + queue consumer.
// The worker module has side effects (global type declarations) — fine.
import app from "./index.js";

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
      ).mockReturnValue(true);

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
