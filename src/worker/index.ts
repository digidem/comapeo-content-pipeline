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
import { buildQueryFilter } from "../lib/notion-filters.js";
import { classifyError, ClassifiedError, ErrorCategory } from "../lib/errors.js";
import { R2_PATHS } from "../persistence/r2.js";
import { buildManifestFromStorage } from "../lib/manifest.js";
import type { ManifestStorage } from "../lib/manifest.js";
import { ContentManifestSchema } from "../schemas/manifest.js";
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
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: R2Object[]; truncated?: boolean; cursor?: string }>;
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

  for (const page of pages) {
    await env.SYNC_QUEUE.send({
      type: "sync_page",
      pageId: page.id,
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

  // Rebuild from the per-page R2 metadata blobs (full PageMetadata), not D1
  // rows — D1 omits element_type/drafting_status/sub_items, which the manifest
  // schema requires. Validates against ContentManifestSchema and applies a
  // no-clobber guard (mirrors CLI cmdManifestGenerate).
  const result = await regenerateManifest(env);

  if (result.status === "clobbered") {
    return c.json({ error: "refusing to clobber non-empty manifest with 0-doc result" }, 409);
  }

  if (result.status === "read_errors") {
    return c.json(
      { error: "transient storage read failures; manifest not regenerated", read_errors: result.readErrorsCount },
      503,
    );
  }

  return c.json({
    regenerated: true,
    docs_count: result.docsCount,
    skipped_count: result.skippedCount,
  });
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

      // Skip logic (spec §8.2): the content hash covers only the markdown BODY,
      // so a title/locale/section/order/slug edit leaves it unchanged while the
      // frontmatter, R2 doc key, and manifest entry all need rewriting. Skip
      // only when every artifact-affecting field matches the stored row.
      const existing = await env.DB.prepare(
        "SELECT content_hash, status, title, locale, section, section_order, slug, r2_doc_key FROM source_pages WHERE page_id = ?",
      ).bind(pageId).first<{
        content_hash: string; status: string; title: string; locale: string | null;
        section: string | null; section_order: number | null; slug: string | null;
        r2_doc_key: string | null;
      }>();

      const metadataKey = R2_PATHS.metadata(pageId);
      const docKey = R2_PATHS.doc(metadata.locale, metadata.section, metadata.slug);

      const rowUnchanged =
        existing &&
        existing.content_hash === metadata.content_hash &&
        existing.status === metadata.status &&
        existing.title === metadata.title &&
        existing.locale === metadata.locale &&
        existing.section === metadata.section &&
        existing.section_order === metadata.section_order &&
        existing.slug === metadata.slug;

      // Authoritative gate: D1 stores only a subset of artifact-affecting
      // fields — element_type, drafting_status, sub_items, keywords, tags, icon
      // live only in the R2 metadata blob and feed the manifest + frontmatter.
      // Skip only when the freshly extracted metadata equals the stored blob
      // (ignoring the volatile edit timestamp); a missing or unreadable blob
      // takes the full path (conservative — the rewrite is idempotent).
      let unchanged = false;
      if (rowUnchanged) {
        try {
          const storedBlob = await env.CONTENT_BUCKET.get(metadataKey);
          if (storedBlob) {
            unchanged =
              stableMetadataJson(JSON.parse(await storedBlob.text())) ===
              stableMetadataJson(metadata as unknown as Record<string, unknown>);
          }
        } catch {
          unchanged = false;
        }
      }

      if (unchanged) {
        console.log(`Skipping page ${pageId}: content unchanged`);
        await env.DB.prepare(
          "UPDATE sync_jobs SET status = 'skipped', error = 'content unchanged', finished_at = datetime('now') WHERE id = ?",
        ).bind(msg.id).run();
        // Record the observed Notion edit time so the cron can dedupe this page on
        // the next boundary-minute re-query. Without this, the 60s lookback would
        // re-enqueue it every tick for a hash-skip — perpetual queue messages.
        // A row always exists on this path — reaching it required a D1 hash match.
        await env.DB.prepare(
          "UPDATE source_pages SET notion_last_edited_time = ?, last_synced_at = datetime('now'), updated_at = datetime('now') WHERE page_id = ?",
        ).bind(metadata.notion_last_edited_time, pageId).run();
        // The consumer never advances last_sync_watermark — the cron owns it and
        // advances it at enqueue time. A re-enqueued boundary page is hash-skipped here.
        continue;
      }

      // Write order matters: the metadata blob is the COMMIT MARKER — manifest
      // rebuilds read pages/{id}/metadata.json, so it must land only after
      // every artifact it references. Assets first, then doc + raws, metadata
      // last; a mid-sequence failure leaves the old blob in place and an
      // unrelated manifest rebuild never publishes a partial page.

      // 1. Rehosted asset binaries. Failures FAIL the job: the doc's markdown
      // references assets/<sha256> paths, and the D1 upsert below records the
      // (stable) content hash — swallowing a transient upload failure would
      // make every future sync hash-skip, leaving the image missing in R2
      // permanently. ClassifiedError(NETWORK) so the catch's retry gate
      // re-queues the message (a plain Error classifies as `unknown`, which is
      // acked without retry). The writes are idempotent.
      const failedAssets: string[] = [];
      for (const asset of converted.assetBinaries) {
        try {
          await env.CONTENT_BUCKET.put(asset.r2Key, asset.data.buffer as ArrayBuffer, { httpMetadata: { contentType: asset.contentType } });
        } catch (err) {
          console.warn(`Failed to upload asset ${asset.r2Key}:`, err);
          failedAssets.push(asset.r2Key);
        }
      }
      if (failedAssets.length > 0) {
        throw new ClassifiedError(
          `asset upload failed for ${failedAssets.length} object(s): ${failedAssets.join(", ")}`,
          ErrorCategory.NETWORK,
        );
      }

      // 2. Document + raw snapshots (not referenced by the manifest — order
      // among these three is irrelevant).
      await Promise.all([
        env.CONTENT_BUCKET.put(docKey, canoncialMd, { httpMetadata: { contentType: "text/markdown" } }),
        env.CONTENT_BUCKET.put(R2_PATHS.rawPage(pageId), JSON.stringify(page, null, 2), { httpMetadata: { contentType: "application/json" } }),
        env.CONTENT_BUCKET.put(R2_PATHS.rawBlocks(pageId), JSON.stringify(rawBlocks, null, 2), { httpMetadata: { contentType: "application/json" } }),
      ]);

      // 3. Metadata blob last — the commit marker.
      await env.CONTENT_BUCKET.put(metadataKey, JSON.stringify(metadata, null, 2), { httpMetadata: { contentType: "application/json" } });

      // A section/slug move changes the doc key. The old object must NOT be
      // deleted here: manifests/latest.json references it until the next
      // rebuild. Queue it (one sync_state row per key) — queued AFTER the
      // metadata commit above, so the sweep's eligibility rule ("row older
      // than the last rebuild start") guarantees that rebuild read the
      // post-move blob and the manifest no longer references the old key.
      if (existing?.r2_doc_key && existing.r2_doc_key !== docKey) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, 'queued', datetime('now'))",
        ).bind(`stale_doc:${existing.r2_doc_key}`).run();
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

      // Mark the manifest dirty so the next cron tick rebuilds manifests/latest.json
      // (spec §6.1; rebuilding inline would add latency to every page sync — the cron
      // batches it). This MUST directly follow the source_pages upsert: once the D1
      // hash is updated, any failure below (row cancellation, sidebar regen, job
      // bookkeeping) makes the queue retry take the hash-skip path, which never sets
      // the flag — the manifest would stay stale indefinitely. Only the changed path
      // sets this; the unchanged-skip path does not.
      await env.DB.prepare(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('manifest_dirty', '1', datetime('now'))",
      ).run();

      // Best-effort: this page's doc key is current again — cancel any pending
      // stale-doc deletion queued for it by an earlier move (A→B→A round
      // trip). Non-fatal: the sweep's ownership pre-check and its two-phase
      // swept-confirmation are the correctness layers; this only narrows the
      // window, so a failure here must not fail an already-committed sync.
      try {
        await env.DB.prepare("DELETE FROM sync_state WHERE key = ?")
          .bind(`stale_doc:${docKey}`).run();
      } catch (err) {
        console.warn(`Failed to cancel stale_doc row for ${docKey}:`, err);
      }

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

export async function scheduledHandler(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const maxPages = 50; // from MAX_PAGES_PER_CRON
  const since = await getLastSyncWatermark(env.DB);
  const pages = await queryChangedPages(env, since, maxPages);

  // Dedupe candidates already fully processed at their current Notion edit time
  // (synced or hash-skipped). The 60s lookback re-includes the watermark's
  // boundary minute every tick; without this dedupe those pages would be
  // re-enqueued and hash-skipped forever — perpetual queue messages + full Notion
  // fetches every 5 minutes for nothing.
  const { kept, dropped } = await dedupeCandidates(env.DB, pages);

  for (const page of kept) {
    await env.SYNC_QUEUE.send({
      type: "sync_page",
      pageId: page.id,
      sourceId: env.NOTION_DATA_SOURCE_ID || env.NOTION_DATABASE_ID,
    });
  }

  // Advance the watermark to the newest candidate's last_edited_time (ascending
  // sort → the last element) whenever there were any candidates — even if all
  // were deduped, that proves they're already processed at that time. Written
  // only after the enqueue loop succeeds: a mid-loop throw leaves the watermark
  // untouched, so the next tick re-enqueues. Zero candidates → leave it untouched.
  if (pages.length > 0) {
    const newest = pages[pages.length - 1].last_edited_time;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('last_sync_watermark', ?, datetime('now'))",
    ).bind(newest).run();
  }

  console.log(`Cron: enqueued ${kept.length} changed pages (${dropped} deduped) since ${since}`);

  // ── Manifest regeneration (spec §6.1) ──
  // A page sync marks `manifest_dirty`; rebuild manifests/latest.json here so the
  // manifest reflects the latest R2 metadata blobs.
  const dirtyRow = await env.DB.prepare(
    "SELECT value FROM sync_state WHERE key = 'manifest_dirty'",
  ).first<{ value: string }>();

  if (dirtyRow?.value === "1") {
    // Clear the flag BEFORE rebuilding. A page sync that lands mid-rebuild writes its
    // metadata blob and re-marks dirty="1"; clearing first means that "1" survives (the
    // clear already happened) and the next tick rebuilds again. This inverts the old
    // rebuild-then-clear order, where a mid-rebuild sync's "1" was overwritten by the
    // clear — leaving manifests/latest.json stale indefinitely if no further edits ever
    // arrived. On any rebuild failure (throw, clobber-refusal, or transient read errors)
    // we restore "1" below so the next tick retries.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('manifest_dirty', '0', datetime('now'))",
    ).run();
    // Capture the rebuild START time (D1 clock, same format as row updated_at).
    // Recorded as manifest_rebuilt_at only on success: a stale_doc row queued
    // BEFORE this moment was queued after its move's metadata commit (consumer
    // write order), so a rebuild starting now reads the post-move blob — the
    // manifest provably no longer references that row's key.
    const rebuildStart = await env.DB.prepare("SELECT datetime('now') AS t").first<{ t: string }>();
    try {
      const result = await regenerateManifest(env);
      if (result.status === "written") {
        console.log(`Cron: rebuilt manifest (${result.docsCount} docs, ${result.skippedCount} skipped)`);
        if (rebuildStart?.t) {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('manifest_rebuilt_at', ?, datetime('now'))",
          ).bind(rebuildStart.t).run();
        }
      } else {
        // Clobber-refusal or read_errors: the existing manifest is left intact. Restore
        // the flag so the next tick retries.
        await env.DB.prepare(
          "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('manifest_dirty', '1', datetime('now'))",
        ).run();
        if (result.status === "clobbered") {
          console.warn("Cron: refusing to clobber non-empty manifest with 0-doc result; restored manifest_dirty");
        } else {
          console.warn(`Cron: ${result.readErrorsCount} transient storage read failures; left old manifest, restored manifest_dirty`);
        }
      }
    } catch (err) {
      // Rebuild threw (R2/parse error): restore the flag so the next tick retries.
      await env.DB.prepare(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('manifest_dirty', '1', datetime('now'))",
      ).run();
      console.error("Cron: manifest rebuild failed; restored manifest_dirty:", err);
    }
  }

  // The sweep runs EVERY tick: eligibility is decided per row by the SQL age
  // filter (row older than the last successful rebuild start), not by the
  // dirty flag — reading the flag once and sweeping later raced concurrent
  // consumer moves.
  await sweepStaleDocs(env);
}

/**
 * Delete R2 doc objects whose deletions the queue consumer deferred (moved
 * pages). Correctness layers:
 *
 * 1. Eligibility (SQL): only rows with `updated_at < manifest_rebuilt_at`.
 *    The consumer queues a row AFTER its metadata commit, so any rebuild that
 *    started after the row was queued read the post-move blob — the live
 *    manifest provably does not reference the row's key. No rebuild recorded
 *    yet → nothing is eligible.
 * 2. Ownership pre-check: a key some page currently lives at
 *    (source_pages.r2_doc_key — e.g. an A→B→A round trip) is dequeued without
 *    deleting. The consumer also best-effort cancels the row for its own new
 *    key at write time.
 * 3. Two-phase confirmation: deleting marks the row `swept` instead of
 *    removing it. The NEXT tick confirms: if an owner has appeared (a consumer
 *    write raced the deletion — its D1 upsert can land after our post-check),
 *    the victim page is re-enqueued so its doc is rewritten; otherwise the row
 *    is dropped. A racing job would have to span a full cron interval to
 *    escape, which Workers cannot.
 *
 * Per-key rows: a failure leaves the row for the next tick; a success removes
 * only its own row, so concurrent appends are never lost.
 */
async function sweepStaleDocs(env: Env): Promise<void> {
  const staleRows = await env.DB.prepare(
    `SELECT key, value FROM sync_state
     WHERE key LIKE 'stale_doc:%'
       AND (value = 'swept'
            OR updated_at < (SELECT value FROM sync_state WHERE key = 'manifest_rebuilt_at'))`,
  ).all<{ key: string; value: string }>();

  for (const row of staleRows.results ?? []) {
    if (typeof row.key !== "string" || !row.key.startsWith("stale_doc:")) continue;
    const docKey = row.key.slice("stale_doc:".length);
    try {
      const owner = await env.DB.prepare(
        "SELECT page_id FROM source_pages WHERE r2_doc_key = ?",
      ).bind(docKey).first<{ page_id: string }>();

      if (row.value === "swept") {
        // Phase 2 (a tick after the delete): confirm or heal.
        if (owner) {
          console.warn(`Cron: stale-doc sweep raced a live write on ${docKey}; re-enqueueing ${owner.page_id}`);
          await env.SYNC_QUEUE.send({
            type: "sync_page",
            pageId: owner.page_id,
            sourceId: env.NOTION_DATA_SOURCE_ID || env.NOTION_DATABASE_ID,
          });
        }
        await env.DB.prepare("DELETE FROM sync_state WHERE key = ?").bind(row.key).run();
        continue;
      }

      // Phase 1: current-again keys are dequeued untouched; abandoned keys are
      // deleted and marked for next-tick confirmation.
      if (owner) {
        await env.DB.prepare("DELETE FROM sync_state WHERE key = ?").bind(row.key).run();
        continue;
      }
      await env.CONTENT_BUCKET.delete(docKey);
      await env.DB.prepare(
        "UPDATE sync_state SET value = 'swept', updated_at = datetime('now') WHERE key = ?",
      ).bind(row.key).run();
    } catch (err) {
      console.warn(`Cron: failed to sweep stale doc ${docKey}; will retry next tick:`, err);
    }
  }
}

// ── Helpers ──

/**
 * Adapt an R2 bucket binding to the runtime-agnostic ManifestStorage interface.
 * R2 paginates `list` at 1000 keys per response, so the adapter loops on
 * `cursor` until the response is no longer `truncated`.
 */
function r2ManifestStorage(bucket: R2Bucket): ManifestStorage {
  return {
    async get(key: string): Promise<string | null> {
      const obj = await bucket.get(key);
      return obj ? obj.text() : null;
    },
    async list(prefix: string): Promise<Array<{ key: string; size: number }>> {
      const out: Array<{ key: string; size: number }> = [];
      let cursor: string | undefined;
      do {
        const res = await bucket.list({ prefix, cursor });
        for (const o of res.objects) out.push({ key: o.key, size: o.size });
        cursor = res.truncated ? res.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}

interface RegenResult {
  status: "written" | "clobbered" | "read_errors";
  docsCount: number;
  skippedCount: number;
  readErrorsCount: number;
}

/**
 * Rebuild `manifests/latest.json` (+ a timestamped version) from the per-page
 * R2 metadata blobs. Shared by `/admin/manifest/regenerate` and the cron
 * dirty-flag path. The result is Zod-validated before writing, and a no-clobber
 * guard (mirrors CLI `cmdManifestGenerate`) refuses to overwrite a non-empty
 * manifest with a 0-doc result.
 */
async function regenerateManifest(env: Env): Promise<RegenResult> {
  const storage = r2ManifestStorage(env.CONTENT_BUCKET);
  const { manifest, skipped, readErrors } = await buildManifestFromStorage(storage, {
    databaseId: env.NOTION_DATABASE_ID,
    dataSourceId: env.NOTION_DATA_SOURCE_ID,
  });

  // Transient storage read failures (a `get` threw or returned null): do NOT
  // publish a partial manifest. A consumer running `docs:pull --clean-orphans`
  // against a partial manifest would delete the unread-but-valid docs. Leave the
  // existing manifest intact and let the caller retry next tick.
  if (readErrors.length > 0) {
    return {
      status: "read_errors",
      docsCount: manifest.docs.length,
      skippedCount: skipped.length,
      readErrorsCount: readErrors.length,
    };
  }

  const validated = ContentManifestSchema.parse(manifest);

  // No-clobber guard: never overwrite a non-empty manifest with a 0-doc result.
  if (validated.docs.length === 0) {
    const existing = await env.CONTENT_BUCKET.get(R2_PATHS.manifest);
    if (existing) {
      try {
        const parsed = JSON.parse(await existing.text());
        if (Array.isArray(parsed.docs) && parsed.docs.length > 0) {
          return { status: "clobbered", docsCount: 0, skippedCount: skipped.length, readErrorsCount: 0 };
        }
      } catch { /* unparseable existing manifest — allow overwrite */ }
    }
  }

  const body = JSON.stringify(validated, null, 2);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await Promise.all([
    env.CONTENT_BUCKET.put(R2_PATHS.manifest, body, { httpMetadata: { contentType: "application/json" } }),
    env.CONTENT_BUCKET.put(R2_PATHS.manifestVersion(timestamp), body, { httpMetadata: { contentType: "application/json" } }),
  ]);

  return { status: "written", docsCount: validated.docs.length, skippedCount: skipped.length, readErrorsCount: 0 };
}

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

/**
 * Drop candidates already fully processed at their current Notion edit time
 * (either synced, or hash-skipped via the queue consumer's skip path — both
 * write `notion_last_edited_time`). Keep candidates with no D1 row or a
 * different stored time.
 *
 * Queries D1 in chunks of 50 ids to stay clear of SQLite bind limits.
 */
async function dedupeCandidates(
  db: D1Database,
  candidates: Array<{ id: string; last_edited_time: string }>,
): Promise<{ kept: Array<{ id: string; last_edited_time: string }>; dropped: number }> {
  if (candidates.length === 0) return { kept: [], dropped: 0 };

  // page_id → stored notion_last_edited_time (undefined = no row)
  const stored = new Map<string, string | null>();
  for (let i = 0; i < candidates.length; i += 50) {
    const chunk = candidates.slice(i, i + 50);
    const placeholders = chunk.map(() => "?").join(", ");
    const res = await db.prepare(
      `SELECT page_id, notion_last_edited_time FROM source_pages WHERE page_id IN (${placeholders})`,
    ).bind(...chunk.map((c) => c.id)).all<{ page_id: string; notion_last_edited_time: string | null }>();
    for (const row of res.results) {
      stored.set(row.page_id, row.notion_last_edited_time ?? null);
    }
  }

  let dropped = 0;
  const kept = candidates.filter((c) => {
    const s = stored.get(c.id);
    // Keep if no row, or the stored time differs from the Notion edit time.
    if (s === undefined || s !== c.last_edited_time) return true;
    dropped++;
    return false;
  });

  return { kept, dropped };
}

export async function queryChangedPages(
  env: Env,
  since: string | null,
  limit = 50,
): Promise<Array<{ id: string; last_edited_time: string }>> {
  const client = new NotionClient({
    token: env.NOTION_TOKEN,
    databaseId: env.NOTION_DATABASE_ID,
    dataSourceId: env.NOTION_DATA_SOURCE_ID || env.NOTION_DATABASE_ID,
  });

  // Notion's last_edited_time is minute-granular and the cron filter uses `after`,
  // so a page edited later within the watermark's minute would be permanently
  // skipped. Subtract 60s from the stored watermark so that boundary minute is
  // re-queried; re-enqueued pages are hash-skipped by the consumer, so the cost
  // is bounded (at most one extra minute of pages per tick).
  const effectiveSince = applyLookback(since);

  const result = await client.queryDatabase({
    // statusGuard:false — the cron must see dead-status transitions (Published →
    // Remove/Unplublished) so consumers can retire the page. Downstream already
    // handles dead pages: mapStatus maps Remove→deprecated / Unplublished→archived,
    // the consumer writes the new status to D1 + metadata blob, the manifest is a
    // full catalog, and docs:pull / rag:chunks gate on isPublishableStatus.
    filter: buildQueryFilter({ since: effectiveSince, statusGuard: false }),
    // Oldest-first: lets us advance the watermark to the newest enqueued page
    // (the slice's last element) and is the precondition for the boundary-run
    // cap logic below.
    sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
  });

  // Client-side guard mirrors the API filter as a defence against clock skew.
  const filtered = result.results.filter(
    (p) => !effectiveSince || p.last_edited_time > effectiveSince,
  );

  // Cap at the per-tick limit (MAX_PAGES_PER_CRON). queryDatabase already fetched
  // all matching pages via its internal pagination loop; we slice client-side.
  let end = Math.min(limit, filtered.length);
  if (end > 0 && end < filtered.length) {
    // If the page at the cut boundary shares its last_edited_time with the next
    // page(s), extend the slice through the entire equal-timestamp run. Otherwise
    // advancing the watermark past that minute would permanently skip the
    // equal-timestamp remainder (the original data-loss bug). The slice may
    // therefore slightly exceed `limit`.
    const boundaryTime = filtered[end - 1].last_edited_time;
    while (end < filtered.length && filtered[end].last_edited_time === boundaryTime) {
      end++;
    }
  }

  return filtered.slice(0, end).map((p) => ({ id: p.id, last_edited_time: p.last_edited_time }));
}

/**
 * Subtract 60 seconds from an ISO watermark (or return null for a full query).
 * See {@link queryChangedPages} for why the same-minute lookback is required.
 */
function applyLookback(since: string | null): string | null {
  if (!since) return null;
  return new Date(new Date(since).getTime() - 60_000).toISOString();
}

/**
 * Canonical JSON of a metadata object minus its volatile fields, for the queue
 * consumer's unchanged-skip comparison:
 * - `notion_last_edited_time` bumps on every edit (that's what enqueued us);
 * - `raw_hash` covers the raw page JSON, which embeds signed asset URLs and
 *   the edit timestamp — it changes on every fetch;
 * - `assets[].original_url` is a signed Notion URL whose signature rotates;
 *   the content-addressed `r2_key`/`sha256` are the stable identity.
 * Without these exclusions an asset page would NEVER match the gate and every
 * redelivery would rewrite all artifacts (spec §16.2 requires unchanged pages
 * to skip). Both sides are produced by the same convertPageData shape, so key
 * order is stable; blobs written by an older code shape simply fail the
 * comparison and take the (idempotent) full write path once.
 */
function stableMetadataJson(m: Record<string, unknown>): string {
  const assets = Array.isArray(m.assets)
    ? m.assets.map((a) =>
        a && typeof a === "object" ? { ...(a as Record<string, unknown>), original_url: undefined } : a,
      )
    : m.assets;
  return JSON.stringify({
    ...m,
    notion_last_edited_time: undefined,
    raw_hash: undefined,
    assets,
  });
}

export default {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx as any),
  queue: queueHandler,
  scheduled: scheduledHandler,
};
