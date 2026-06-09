-- Initial schema: source_pages, sync_jobs, sync_state, emitted_artifacts
-- Per spec §11

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
