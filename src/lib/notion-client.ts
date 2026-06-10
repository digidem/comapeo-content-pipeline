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
  private baseUrl = "https://api.notion.com/v1";

  constructor(config: NotionConfig) {
    this.token = config.token;
    this.databaseId = config.databaseId;
    this.dataSourceId = config.dataSourceId;
    this.version = config.version || "2026-03-11";
    this.maxRps = config.maxRps ?? 3;
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
        throw new Error(
          `Notion API error ${resp.status}: ${resp.statusText} — ${errorBody}`,
        );
      } catch (err) {
        if (attempt >= retries) throw err;
        if (err instanceof Error && err.message.startsWith("Notion API error")) {
          throw err; // Don't retry non-rate-limit errors
        }
        // Network error — retry
        const waitMs = 1000 * Math.pow(2, attempt);
        await sleep(waitMs);
      }
    }

    throw new Error(`Max retries exceeded for ${path}`);
  }

  // ── API methods ──

  /**
   * Query Notion pages from the database, sorted by last_edited_time DESC.
   *
   * Uses /v1/search (the working endpoint with API version 2026-03-11).
   * Results are filtered client-side by parent database_id when configured.
   */
  async queryDataSource(params: {
    dataSourceId?: string;
    filter?: Record<string, unknown>;
    startCursor?: string;
    pageSize?: number;
  }): Promise<NotionPageResponse> {
    // Use /v1/search — the working query endpoint
    const body: Record<string, unknown> = {
      query: "",
      filter: { property: "object", value: "page" },
      sort: {
        direction: "descending",
        timestamp: "last_edited_time",
      },
      page_size: params.pageSize ?? 100,
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
        const parent = page as unknown as { parent?: { database_id?: string } };
        const pageDbId = parent?.parent?.database_id?.replace(/-/g, "") ?? "";
        return pageDbId === normalizedDbId;
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
  }

  private async getAllBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = [];
    let cursor: string | null | undefined;

    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("start_cursor", cursor);

      const resp = await this.request<NotionBlockResponse>(
        `/blocks/${blockId}/children?${params.toString()}`,
      );

      all.push(...resp.results);
      cursor = resp.next_cursor;
    } while (cursor);

    return all;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
