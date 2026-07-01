/**
 * Notion API client wrapper with rate limiting, retry, and pagination.
 *
 * Configurable via environment variables:
 *   NOTION_TOKEN          — API token
 *   NOTION_VERSION        — API version (default: 2026-03-11)
 *   NOTION_DATABASE_ID    — source database ID
 *   NOTION_DATA_SOURCE_ID — data source ID for v5 API
 *   MAX_NOTION_RPS        — requests per second (default: 3)
 */

import { Client } from "@notionhq/client";
import { classifyError, ClassifiedError, ErrorCategory } from "./errors.js";
import { NOTION_API } from "./notion-properties.js";

// Minimal Notion API types used internally
export interface NotionPage {
  id: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NotionBlockResponse {
  object: "list";
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

interface NotionPageResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionConfig {
  token: string;
  databaseId?: string;
  dataSourceId?: string;
  version?: string;
  maxRps?: number;
}

type RetryAfterFn = (retryAfterSeconds: number) => void;

// For testing: allows injection of a retry-after callback
let _retryAfterCallback: RetryAfterFn | null = null;

export function setRetryAfterCallback(fn: RetryAfterFn | null): void {
  _retryAfterCallback = fn;
}

export class NotionClient {
  private token: string;
  private databaseId?: string;
  private dataSourceId?: string;
  private version: string;
  private maxRps: number;
  private lastRequestTime: number = 0;
  private baseUrl = NOTION_API.BASE_URL;
  private inFlightRequests: Map<string, Promise<unknown>> = new Map();
  /** Lazily instantiated SDK client for dataSources.query (DATABASE_VERSION). */
  private _sdkClient: Client | null = null;

  constructor(config: NotionConfig) {
    this.token = config.token;
    this.databaseId = config.databaseId;
    this.dataSourceId = config.dataSourceId;
    this.version = config.version || NOTION_API.SEARCH_VERSION;
    this.maxRps = config.maxRps ?? 3;
  }

  // ── In-flight request deduplication ──

  /**
   * Deduplicate concurrent requests for the same key.
   * If a request for `key` is already in flight, returns the same promise.
   * Otherwise, creates a new promise via `factory`, stores it, and removes
   * it from the map once it settles (success or failure).
   */
  private dedupeRequest<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.inFlightRequests.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = factory().finally(() => {
      this.inFlightRequests.delete(key);
    });
    this.inFlightRequests.set(key, promise);
    return promise;
  }

  // ── Rate limiting ──

  private async throttle(): Promise<void> {
    const now = Date.now();
    const minInterval = 1000 / this.maxRps;
    const elapsed = now - this.lastRequestTime;
    if (elapsed < minInterval) {
      await sleep(minInterval - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  // ── HTTP wrapper with retry ──

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      apiVersion?: string;
    } = {},
    retries = 4,
  ): Promise<T> {
    // Deduplicate by path + method so concurrent callers share one request
    const dedupeKey = `${options.method || "GET"} ${path}`;
    return this.dedupeRequest(dedupeKey, () => this._requestInner<T>(path, options, retries));
  }

  private async _requestInner<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      apiVersion?: string;
    },
    retries: number,
  ): Promise<T> {
    await this.throttle();

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": this.version,
      "Content-Type": "application/json",
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(url, {
          method: options.method || "GET",
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
        });

        if (resp.ok) {
          return (await resp.json()) as T;
        }

        if (resp.status === 429) {
          const retryAfter = resp.headers.get("Retry-After");
          const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 1;
          if (_retryAfterCallback) _retryAfterCallback(waitSeconds);
          await sleep(waitSeconds * 1000);
          continue;
        }

        if (resp.status === 529) {
          // Exponential backoff
          const waitMs = Math.min(1000 * Math.pow(2, attempt), 30000);
          await sleep(waitMs);
          continue;
        }

        // Non-retryable error
        const errorBody = await resp.text().catch(() => "");
        throw classifyError(
          new Error(`Notion API error ${resp.status}: ${resp.statusText} — ${errorBody}`),
          path,
        );
      } catch (err) {
        const classified = classifyError(err, `Notion ${path}`);
        if (attempt >= retries) throw classified;

        // Only retry network / timeout errors
        if (
          classified.category === ErrorCategory.NETWORK ||
          classified.category === ErrorCategory.TIMEOUT
        ) {
          const waitMs = 1000 * Math.pow(2, attempt);
          await sleep(waitMs);
          continue;
        }

        // Non-retryable (HTTP client/server, validation, etc.)
        throw classified;
      }
    }

    throw classifyError(
      new Error(`Max retries exceeded for ${path}`),
      `Notion ${path}`,
    );
  }

  // ── API methods ──

  /**
   * Query Notion pages from the data source using the `@notionhq/client` v5 SDK.
   *
   * Uses `dataSources.query` (POST /v1/data_sources/{id}/query) with
   * `Notion-Version: 2025-09-03`. Paginates through ALL results internally and
   * returns them in a single `NotionPageResponse` (`next_cursor: null`).
   *
   * Pass `filter: buildQueryFilter(...)` from `notion-filters.ts` to exclude
   * dead-status pages at the API level. Default sort is `last_edited_time DESC`
   * to preserve the cron watermark assumption.
   *
   * A MAX_PAGES = 10_000 safety counter prevents runaway pagination loops.
   *
   * @param params.filter   - Notion filter object (undefined = no filter, all rows).
   * @param params.sorts    - Override default sort. Default: last_edited_time DESC.
   * @param params.pageSize - Page size per SDK request (default: NOTION_API.DEFAULT_PAGE_SIZE).
   */
  async queryDatabase(params: {
    filter?: Record<string, unknown>;
    sorts?: Array<Record<string, unknown>>;
    pageSize?: number;
  } = {}): Promise<NotionPageResponse> {
    // Lazy SDK client instantiation (reuses across calls on the same NotionClient instance)
    if (!this._sdkClient) {
      this._sdkClient = new Client({
        auth: this.token,
        notionVersion: NOTION_API.DATABASE_VERSION,
      });
    }
    const sdkClient = this._sdkClient;

    const dataSourceId = this.dataSourceId || this.databaseId;
    if (!dataSourceId) {
      throw new Error("queryDatabase requires dataSourceId or databaseId to be configured");
    }

    const defaultSorts = [
      { timestamp: "last_edited_time" as const, direction: "descending" as const },
    ];

    const all: NotionPage[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pageCount = 0;
    const MAX_PAGES = 10_000; // safety counter (Phase 4.3)

    do {
      if (++pageCount > MAX_PAGES) {
        console.error("queryDatabase: safety page limit exceeded, breaking pagination loop");
        break;
      }

      await this.throttle();

      // The SDK filter type is a strict union; we cast to satisfy TypeScript while the
      // actual shape is validated by Notion's API at runtime.
      const resp = await sdkClient.dataSources.query({
        data_source_id: dataSourceId,
        ...(params.filter ? { filter: params.filter as never } : {}),
        sorts: (params.sorts ?? defaultSorts) as never,
        ...(cursor ? { start_cursor: cursor } : {}),
        page_size: params.pageSize ?? NOTION_API.DEFAULT_PAGE_SIZE,
      });

      for (const item of resp.results) {
        if (item.object === "page") {
          all.push(item as unknown as NotionPage);
        }
      }

      const nextCursor = resp.next_cursor ?? undefined;
      if (nextCursor) {
        if (seenCursors.has(nextCursor)) {
          console.error(
            `  ⚠ Stale cursor detected in queryDatabase pagination: ${nextCursor}. Breaking to prevent infinite loop.`,
          );
          break;
        }
        seenCursors.add(nextCursor);
      }
      cursor = nextCursor;
    } while (cursor);

    return { results: all, next_cursor: null, has_more: false };
  }

  /**
   * @deprecated Use {@link queryDatabase} instead.
   *
   * Query Notion pages from the database, sorted by last_edited_time DESC.
   *
   * Uses /v1/search (the working endpoint with API version 2026-03-11).
   * Results are filtered client-side by parent database_id when configured.
   */
  async queryDataSource(params: {
    filter?: Record<string, unknown>;
    startCursor?: string;
    pageSize?: number;
    /** When true, only fetch top-level pages (exclude sub-items linked via "Sub-item" relation). */
    excludeSubItems?: boolean;
  }): Promise<NotionPageResponse> {
    // Use /v1/search — the working query endpoint
    const body: Record<string, unknown> = {
      query: "",
      filter: { property: "object", value: "page" },
      sort: {
        direction: "descending",
        timestamp: "last_edited_time",
      },
      page_size: params.pageSize ?? NOTION_API.DEFAULT_PAGE_SIZE,
    };

    if (params.startCursor) {
      body.start_cursor = params.startCursor;
    }

    // If a filter with `last_edited_time` is provided, add it (used by Worker cron)
    if (params.filter) {
      body.filter = params.filter;
    }

    const resp = await this.request<NotionPageResponse>(
      "/search",
      { method: "POST", body },
    );

    // Client-side filter by parent database_id when configured.
    // Normalize UUIDs (strip dashes) — Notion API returns dashed UUIDs but
    // env vars may be set without dashes.
    const dbId = this.databaseId;
    if (dbId && resp.results) {
      const normalizedDbId = dbId.replace(/-/g, "");
      resp.results = resp.results.filter((page) => {
        const parent = page as unknown as { parent?: { database_id?: string; page_id?: string } };
        const pageParentDbId = parent?.parent?.database_id?.replace(/-/g, "") ?? "";
        const matchesDb = pageParentDbId === normalizedDbId;

        // When excludeSubItems is true, also exclude pages whose parent is another page
        // (sub-items linked via "Sub-item" relation have page_id parent, not database_id).
        // /v1/search doesn't support compound AND filters so we filter client-side.
        if (params.excludeSubItems && parent?.parent?.page_id) {
          return false;
        }

        return matchesDb;
      });
    }

    return resp;
  }

  /**
   * Get a single page by ID.
   */
  async getPage(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>(`/pages/${pageId}`);
  }

  /**
   * Get block children for a block (paginated).
   */
  async getBlockChildren(
    blockId: string,
    pageSize = 100,
  ): Promise<NotionBlockResponse> {
    return this.request<NotionBlockResponse>(
      `/blocks/${blockId}/children?page_size=${pageSize}`,
    );
  }

  /**
   * Recursively fetch all blocks for a page, including nested children.
   * Uses a configurable max depth (default 10) to prevent infinite recursion.
   */
  async getPageBlocks(
    pageId: string,
    maxDepth: number = 10,
  ): Promise<{
    results: NotionBlock[];
    children: Record<string, NotionBlock[]>;
  }> {
    return this.dedupeRequest(`blocks:${pageId}`, async () => {
      const topLevel = await this.getAllBlockChildren(pageId);
      const children: Record<string, NotionBlock[]> = {};

      const recurse = async (blocks: NotionBlock[], depth: number): Promise<void> => {
        if (depth >= maxDepth) return;
        for (const block of blocks) {
          if (block.has_children) {
            const nested = await this.getAllBlockChildren(block.id);
            if (nested.length > 0) {
              children[block.id] = nested;
              await recurse(nested, depth + 1);
            }
          }
        }
      };

      await recurse(topLevel, 0);

      return { results: topLevel, children };
    });
  }

  private async getAllBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = [];
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("start_cursor", cursor);

      const resp = await this.request<NotionBlockResponse>(
        `/blocks/${blockId}/children?${params.toString()}`,
      );

      all.push(...resp.results);
      cursor = resp.next_cursor;

      // Stale cursor detection to prevent infinite loops
      if (cursor) {
        if (seenCursors.has(cursor)) {
          console.error(`  ⚠ Stale cursor detected in block children pagination: ${cursor}. Breaking to prevent infinite loop.`);
          break;
        }
        seenCursors.add(cursor);
      }
    } while (cursor);

    return all;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
