/**
 * D1 database schema, migrations, and query helpers.
 *
 * Tables per spec §11:
 *   source_pages, sync_jobs, sync_state, emitted_artifacts
 */

// ── SQL Statements ──

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source_pages (
  page_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT,
  notion_last_edited_time TEXT,
  content_hash TEXT,
  raw_hash TEXT,
  status TEXT NOT NULL,
  locale TEXT,
  section TEXT,
  section_order INTEGER,
  slug TEXT,
  docusaurus_path TEXT,
  r2_metadata_key TEXT,
  r2_doc_key TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS emitted_artifacts (
  key TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  page_id TEXT,
  content_hash TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_source_pages_status ON source_pages(status);
CREATE INDEX IF NOT EXISTS idx_source_pages_locale ON source_pages(locale);
CREATE INDEX IF NOT EXISTS idx_source_pages_last_edited ON source_pages(notion_last_edited_time);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status);
`;

// ── Row types ──

export interface SourcePageRow {
  page_id: string;
  title: string;
  source_url: string | null;
  notion_last_edited_time: string | null;
  content_hash: string | null;
  raw_hash: string | null;
  status: string;
  locale: string | null;
  section: string | null;
  section_order: number | null;
  slug: string | null;
  docusaurus_path: string | null;
  r2_metadata_key: string | null;
  r2_doc_key: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncJobRow {
  id: string;
  source_type: string;
  source_id: string;
  job_type: string;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  attempts: number;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EmittedArtifactRow {
  key: string;
  artifact_type: "doc" | "metadata" | "raw_page" | "raw_blocks" | "chunk" | "manifest";
  page_id: string | null;
  content_hash: string | null;
  size_bytes: number | null;
  created_at: string;
}

// ── Query builders (parameterized, no ORM dependency) ──

/**
 * Upsert a source page row.
 */
export function upsertSourcePageSQL(): string {
  return `
INSERT OR REPLACE INTO source_pages
  (page_id, title, source_url, notion_last_edited_time, content_hash, raw_hash,
   status, locale, section, section_order, slug, docusaurus_path,
   r2_metadata_key, r2_doc_key, last_synced_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`;
}

/**
 * Get a source page by ID.
 */
export function getSourcePageSQL(): string {
  return "SELECT * FROM source_pages WHERE page_id = ?";
}

/**
 * Get recent source pages ordered by last_edited_time.
 */
export function getRecentPagesSQL(limit: number = 50): string {
  return `SELECT * FROM source_pages ORDER BY notion_last_edited_time DESC LIMIT ${limit}`;
}

/**
 * Insert a sync job.
 */
export function insertSyncJobSQL(): string {
  return `
INSERT INTO sync_jobs (id, source_type, source_id, job_type, status)
VALUES (?, ?, ?, ?, 'queued')
`;
}

/**
 * Update sync job status.
 */
export function updateSyncJobSQL(): string {
  return `
UPDATE sync_jobs
SET status = ?, attempts = ?, error = ?, started_at = COALESCE(started_at, datetime('now')),
    finished_at = CASE WHEN ? IN ('completed', 'failed', 'skipped') THEN datetime('now') ELSE finished_at END
WHERE id = ?
`;
}

/**
 * Get sync state by key.
 */
export function getSyncStateSQL(): string {
  return "SELECT value FROM sync_state WHERE key = ?";
}

/**
 * Upsert sync state.
 */
export function upsertSyncStateSQL(): string {
  return `
INSERT OR REPLACE INTO sync_state (key, value, updated_at)
VALUES (?, ?, datetime('now'))
`;
}

/**
 * Insert emitted artifact record.
 */
export function insertArtifactSQL(): string {
  return `
INSERT OR REPLACE INTO emitted_artifacts (key, artifact_type, page_id, content_hash, size_bytes)
VALUES (?, ?, ?, ?, ?)
`;
}
