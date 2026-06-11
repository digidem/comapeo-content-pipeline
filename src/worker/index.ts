/**
 * Cloudflare Worker entry point — Hono router.
 *
 * Routes per spec §12:
 *   GET  /health
 *   GET  /health/deep
 *   POST /webhooks/notion
 *   POST /admin/sync/page
 *   POST /admin/sync/changed
 *   POST /admin/manifest/regenerate
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { verifyWebhookSignature, verifyBearerAuth, parseWebhookEvent } from "../lib/webhook.js";
import { convertPageData } from "../lib/sync.js";
import type { NotionBlock } from "../lib/notion-converter.js";
import { NotionClient } from "../lib/notion-client.js";
import { classifyError, ErrorCategory } from "../lib/errors.js";
import { R2_PATHS } from "../persistence/r2.js";
import type { SidebarItem } from "../schemas/manifest.js";

// Minimal Cloudflare Workers type declarations (avoid @cloudflare/workers-types conflicts with @types/node)
declare global {
  interface D1Result<T = unknown> {
    results: T[];
    success: boolean;
  }
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(colName?: string): Promise<T | null>;
    all<T = unknown>(): Promise<D1Result<T>>;
    run(): Promise<D1Result>;
    raw<T = unknown>(): Promise<T[]>;
  }
  class D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1Result>;
  }

  interface R2Object {
    key: string;
    size: number;
  }
  interface R2ObjectBody extends R2Object {
    body: ReadableStream;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  }
  interface R2Bucket {
    head(key: string): Promise<R2Object | null>;
    get(key: string): Promise<R2ObjectBody | null>;
    put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<R2Object>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string }): Promise<{ objects: R2Object[] }>;
  }

  interface QueueSendOptions {
    delaySeconds?: number;
  }
  interface Queue<T = unknown> {
    send(message: T, options?: QueueSendOptions): Promise<void>;
    sendBatch(messages: Array<{ body: T; options?: QueueSendOptions }>): Promise<void>;
  }

  interface Message<T = unknown> {
    body: T;
    id: string;
    timestamp: Date;
    attempts: number;
  }
  interface MessageBatch<T = unknown> {
    messages: Message<T>[];
    queue: string;
    ackAll(): void;
    retryAll(options?: { delaySeconds?: number }): void;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface ScheduledEvent {
    cron: string;
    scheduledTime: number;
  }
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

interface Env {
  NOTION_TOKEN: string;
  NOTION_DATABASE_ID: string;
  NOTION_DATA_SOURCE_ID: string;
  NOTION_WEBHOOK_VERIFICATION_TOKEN: string;
  ADMIN_TOKEN: string;
  SYNC_QUEUE: Queue<SyncJobMessage>;
  DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
}

interface SyncJobMessage {
  type: "sync_page";
  pageId: string;
  sourceId: string;
}

export const app = new Hono<{ Bindings: Env }>();

// ── Health ──

app.get("/health", (c: Context) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/health/deep", async (c: Context) => {
  const env = c.env as Env;
  const checks: Record<string, string> = {};

  // Check Notion token
  checks.notion_token = env.NOTION_TOKEN ? "configured" : "missing";

  // Check D1
  try {
    await env.DB.prepare("SELECT 1").run();
    checks.d1 = "ok";
  } catch {
    checks.d1 = "error";
  }

  // Check R2
  try {
    await env.CONTENT_BUCKET.head("manifests/latest.json");
    checks.r2 = "ok";
  } catch {
    checks.r2 = "unavailable";
  }

  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ── Webhook ──

app.post("/webhooks/notion", async (c: Context) => {
  const env = c.env as Env;
  const rawBody = await c.req.raw.clone().arrayBuffer();
  const body = await c.req.json<Record<string, unknown>>();

  // Notion one-time endpoint verification: echo back the verification_token
  // This happens when you first add the webhook URL in the Notion dashboard.
  if (body.verification_token) {
    console.log("Notion verification token:", body.verification_token);
    return c.json({ verification_token: body.verification_token }, 200);
  }

  // Runtime events: verify HMAC signature
  const signature = c.req.header("x-notion-verification-signature") || "";
  if (!(await verifyWebhookSignature(new Uint8Array(rawBody), signature, env.NOTION_WEBHOOK_VERIFICATION_TOKEN))) {
    return c.json({ error: "invalid signature" }, 401);
  }
  const event = parseWebhookEvent(body);

  if (!event) {
    return c.json({ error: "unrecognized event" }, 400);
  }

  // Enqueue affected pages
  const pageIds: string[] = [];
  if (event.pageId) pageIds.push(event.pageId);

  for (const pageId of pageIds) {
    await env.SYNC_QUEUE.send({
      type: "sync_page",
      pageId,
      sourceId: env.NOTION_DATA_SOURCE_ID || env.NOTION_DATABASE_ID,
    });
  }

  return c.json({
    accepted: true,
    event_type: event.type,
    enqueued: pageIds.length,
  });
});

// ── Admin: sync single page ──

app.post("/admin/sync/page", async (c: Context) => {
  const env = c.env as Env;
  if (!verifyBearerAuth(c.req.header("Authorization") || "", env.ADMIN_TOKEN)) {
    return c.json({ error: "unauthorized" }, 403);
  }

  const body = await c.req.json<{ page_id: string }>();
  if (!body.page_id) {
    return c.json({ error: "page_id required" }, 400);
  }

  await env.SYNC_QUEUE.send({
    type: "sync_page",
    pageId: body.page_id,
    sourceId: env.NOTION_DATA_SOURCE_ID || env.NOTION_DATABASE_ID,
  });

  return c.json({ enqueued: true, page_id: body.page_id });
});

// ── Admin: sync changed pages ──

app.post("/admin/sync/changed", async (c: Context) => {
  const env = c.env as Env;
  if (!verifyBearerAuth(c.req.header("Authorization") || "", env.ADMIN_TOKEN)) {
    return c.json({ error: "unauthorized" }, 403);
  }

  // Query recently changed pages from Notion
  const since = await getLastSyncWatermark(env.DB);
  const pages = await queryChangedPages(env, since);
  let enqueued = 0;

  for (const pageId of pages) {
    await env.SYNC_QUEUE.send({
      type: "sync_page",
      pageId,
      sourceId: env.NOTION_DATA_SOURCE_ID || env.NOTION_DATABASE_ID,
    });
    enqueued++;
  }

  return c.json({ enqueued, since });
});

// ── Admin: regenerate manifest ──

app.post("/admin/manifest/regenerate", async (c: Context) => {
  const env = c.env as Env;
  if (!verifyBearerAuth(c.req.header("Authorization") || "", env.ADMIN_TOKEN)) {
    return c.json({ error: "unauthorized" }, 403);
  }

  // Read all pages from D1, rebuild manifest
  const { results } = await env.DB.prepare(
    "SELECT * FROM source_pages WHERE status = 'active'",
  ).all<{
    page_id: string; title: string; locale: string; section: string | null;
    section_order: number | null; slug: string; docusaurus_path: string;
    content_hash: string; notion_last_edited_time: string; status: string;
  }>();

  const manifest = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    source: {
      type: "notion",
      database_id: env.NOTION_DATABASE_ID,
      data_source_id: env.NOTION_DATA_SOURCE_ID,
    },
    docs: results.map((row) => ({
      page_id: row.page_id,
      title: row.title,
      locale: row.locale,
      section: row.section,
      section_order: row.section_order,
      slug: row.slug,
      docusaurus_id: row.docusaurus_path || row.slug,
      docusaurus_path: `/${row.slug}`,
      r2_doc_key: `docs/${row.locale}/docs/${row.section ? row.section + "/" : ""}${row.slug}.md`,
      r2_metadata_key: `pages/${row.page_id}/metadata.json`,
      source_url: `https://notion.so/${row.page_id.replace(/-/g, "")}`,
      notion_last_edited_time: row.notion_last_edited_time,
      content_hash: row.content_hash,
      status: row.status as "active" | "draft" | "deprecated" | "archived",
    })),
    sidebars: {},
  };

  await env.CONTENT_BUCKET.put(
    "manifests/latest.json",
    JSON.stringify(manifest, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );

  return c.json({ regenerated: true, docs_count: results.length });
});

// ── Queue consumer ──

export async function queueHandler(batch: MessageBatch<SyncJobMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
  for (const msg of batch.messages) {
    const { pageId } = msg.body;

    try {
      // Mark job as started
      await env.DB.prepare(
        "INSERT OR REPLACE INTO sync_jobs (id, source_type, source_id, job_type, status, started_at) VALUES (?, 'notion', ?, 'sync_page', 'running', datetime('now'))",
      ).bind(msg.id, pageId).run();

      // Fetch page and blocks via NotionClient (handles rate limiting, retry, recursive blocks)
      const client = new NotionClient({ token: env.NOTION_TOKEN });

      const page = await client.getPage(pageId);
      const { results: blocks, children } = await client.getPageBlocks(pageId);

      const rawBlocks = {
        object: "list" as const,
        results: blocks as NotionBlock[],
        children: children as Record<string, NotionBlock[]>,
      };

      // Run conversion pipeline
      const converted = await convertPageData({ pageId, rawPage: page, rawBlocks });
      const { metadata, canoncialMd, hash } = converted;

      // Skip logic: compare content_hash + status with stored row (spec §8.2)
      const existing = await env.DB.prepare(
        "SELECT content_hash, status FROM source_pages WHERE page_id = ?",
      ).bind(pageId).first<{ content_hash: string; status: string }>();

      if (existing && existing.content_hash === metadata.content_hash && existing.status === metadata.status) {
        console.log(`Skipping page ${pageId}: content unchanged`);
        await env.DB.prepare(
          "UPDATE sync_jobs SET status = 'skipped', error = 'content unchanged', finished_at = datetime('now') WHERE id = ?",
        ).bind(msg.id).run();
        // Still update watermark so cron doesn't re-enqueue
        await env.DB.prepare(
          "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('last_sync_watermark', ?, datetime('now'))",
        ).bind(new Date().toISOString()).run();
        continue;
      }

      const metadataKey = R2_PATHS.metadata(pageId);
      const docKey = R2_PATHS.doc(metadata.locale, metadata.section, metadata.slug);

      // Write all artifacts to R2 in parallel
      await Promise.all([
        env.CONTENT_BUCKET.put(metadataKey, JSON.stringify(metadata, null, 2), { httpMetadata: { contentType: "application/json" } }),
        env.CONTENT_BUCKET.put(docKey, canoncialMd, { httpMetadata: { contentType: "text/markdown" } }),
        env.CONTENT_BUCKET.put(R2_PATHS.rawPage(pageId), JSON.stringify(page, null, 2), { httpMetadata: { contentType: "application/json" } }),
        env.CONTENT_BUCKET.put(R2_PATHS.rawBlocks(pageId), JSON.stringify(rawBlocks, null, 2), { httpMetadata: { contentType: "application/json" } }),
      ]);

      // Upload rehosted asset binaries to R2 (non-fatal on failure)
      for (const asset of converted.assetBinaries) {
        try {
          await env.CONTENT_BUCKET.put(asset.r2Key, asset.data.buffer as ArrayBuffer, { httpMetadata: { contentType: asset.contentType } });
        } catch (err) {
          console.warn(`Failed to upload asset ${asset.r2Key}:`, err);
        }
      }

      // Upsert source_pages row
      await env.DB.prepare(`
        INSERT OR REPLACE INTO source_pages
          (page_id, title, source_url, notion_last_edited_time, content_hash, raw_hash,
           status, locale, section, section_order, slug, docusaurus_path,
           r2_metadata_key, r2_doc_key, last_synced_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(
        metadata.page_id,
        metadata.title,
        metadata.source_url,
        metadata.notion_last_edited_time,
        metadata.content_hash,
        metadata.raw_hash,
        metadata.status,
        metadata.locale,
        metadata.section,
        metadata.section_order,
        metadata.slug,
        metadata.docusaurus_id,
        metadataKey,
        docKey,
      ).run();

      // Record emitted artifacts
      const artifactRows: Array<[string, string, string, string | null, number]> = [
        [metadataKey, "metadata", pageId, metadata.content_hash, JSON.stringify(metadata).length],
        [docKey, "doc", pageId, hash, canoncialMd.length],
        [R2_PATHS.rawPage(pageId), "raw_page", pageId, null, JSON.stringify(page).length],
        [R2_PATHS.rawBlocks(pageId), "raw_blocks", pageId, null, JSON.stringify(rawBlocks).length],
      ];

      for (const [key, type, pid, contentHash, sizeBytes] of artifactRows) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO emitted_artifacts (key, artifact_type, page_id, content_hash, size_bytes) VALUES (?, ?, ?, ?, ?)",
        ).bind(key, type, pid, contentHash, sizeBytes).run();
      }

      // Regenerate sidebar for this locale
      await regenerateSidebar(env, metadata.locale, metadata);

      // Mark job complete
      await env.DB.prepare(
        "UPDATE sync_jobs SET status = 'completed', finished_at = datetime('now') WHERE id = ?",
      ).bind(msg.id).run();

      // Update watermark
      await env.DB.prepare(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('last_sync_watermark', ?, datetime('now'))",
      ).bind(new Date().toISOString()).run();

    } catch (err) {
      console.error(`Failed to sync page ${pageId}:`, err);
      await env.DB.prepare(
        "UPDATE sync_jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?",
      ).bind(String(err), msg.id).run();

      // Retry transient failures — don't lose the message
      const classified = classifyError(err, `sync:${pageId}`);
      if (
        classified.category === ErrorCategory.NETWORK ||
        classified.category === ErrorCategory.TIMEOUT ||
        classified.category === ErrorCategory.RATE_LIMIT ||
        classified.category === ErrorCategory.HTTP_SERVER
      ) {
        console.warn(`Retrying transient error for page ${pageId}: ${classified.category}`);
        batch.retryAll({ delaySeconds: 60 });
        return; // Don't ack — retryAll schedules redelivery
      }
    }
  }
}

// ── Cron trigger ──

async function scheduledHandler(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const maxPages = 50; // from MAX_PAGES_PER_CRON
  const since = await getLastSyncWatermark(env.DB);
  const pages = await queryChangedPages(env, since, maxPages);

  for (const pageId of pages) {
    await env.SYNC_QUEUE.send({
      type: "sync_page",
      pageId,
      sourceId: env.NOTION_DATA_SOURCE_ID || env.NOTION_DATABASE_ID,
    });
  }

  console.log(`Cron: enqueued ${pages.length} changed pages since ${since}`);
}

// ── Helpers ──

/**
 * Read existing Docusaurus sidebar from R2, upsert the page's entry, write back.
 *
 * Format: `SidebarItem[]` (Docusaurus sidebar JSON).
 * - Uncategorized pages (no section): plain string ID.
 * - Categorized pages: placed inside the matching category's items array.
 */
async function regenerateSidebar(
  env: Env,
  locale: string,
  metadata: { docusaurus_id: string; slug: string; section: string | null; section_order: number | null; title: string },
): Promise<void> {
  const sidebarKey = R2_PATHS.sidebar(locale);

  let items: SidebarItem[];
  const existing = await env.CONTENT_BUCKET.get(sidebarKey);
  if (existing) {
    items = JSON.parse(await existing.text()) as SidebarItem[];
  } else {
    items = [];
  }

  const docId = metadata.docusaurus_id;
  const section = metadata.section;

  // Remove any previous occurrence of this docId from categories and top-level
  for (const item of items) {
    if (typeof item !== "string" && item.type === "category") {
      item.items = item.items.filter((id) => id !== docId);
    }
  }
  items = items.filter((id) => id !== docId);

  if (section) {
    // Find or create the category
    let category = items.find(
      (item): item is Extract<typeof item, { type: "category" }> =>
        typeof item !== "string" && item.type === "category" && item.label === section,
    );
    if (!category) {
      category = { type: "category", label: section, items: [] };
      items.push(category);
    }
    category.items.push(docId);
  } else {
    // Uncategorized: plain string
    items.push(docId);
  }

  await env.CONTENT_BUCKET.put(
    sidebarKey,
    JSON.stringify(items, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
}

async function getLastSyncWatermark(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare(
      "SELECT value FROM sync_state WHERE key = 'last_sync_watermark'",
    ).first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function queryChangedPages(
  env: Env,
  since: string | null,
  limit = 50,
): Promise<string[]> {
  // Use /v1/search — the working query endpoint with API version 2026-03-11
  const body: Record<string, unknown> = {
    query: "",
    filter: { property: "object", value: "page" },
    sort: {
      direction: "descending",
      timestamp: "last_edited_time",
    },
    page_size: limit,
  };

  const resp = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2026-03-11",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) return [];

  const data = (await resp.json()) as {
    results: Array<{ id: string; last_edited_time: string; parent?: { database_id?: string } }>;
  };

  const dbId = env.NOTION_DATABASE_ID;
  const normalizedDbId = dbId ? dbId.replace(/-/g, "") : null;
  const pageIds: string[] = [];

  for (const page of data.results ?? []) {
    // Filter by database_id on the client side (normalize UUIDs for comparison)
    if (normalizedDbId) {
      const pageDbId = (page.parent?.database_id ?? "").replace(/-/g, "");
      if (pageDbId !== normalizedDbId) continue;
    }

    // Filter by watermark (stop at pages older than `since`)
    if (since && page.last_edited_time <= since) continue;

    pageIds.push(page.id);
  }

  return pageIds;
}

export default {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx as any),
  queue: queueHandler,
  scheduled: scheduledHandler,
};
