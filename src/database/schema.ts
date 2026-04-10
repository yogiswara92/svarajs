/**
 * @module database/schema
 * SvaraJS — SQLite database schema
 *
 * DDL for all internal SvaraJS tables.
 * Users can extend this with their own tables via db.exec().
 */

export const SCHEMA_VERSION = 1;

export const CREATE_TABLES_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS svara_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Conversation history persistence
CREATE TABLE IF NOT EXISTS svara_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content     TEXT NOT NULL,
  tool_call_id TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON svara_messages (session_id, created_at);

-- Session metadata
CREATE TABLE IF NOT EXISTS svara_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  channel     TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT DEFAULT '{}'
);

-- Vector store chunks for RAG
CREATE TABLE IF NOT EXISTS svara_chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  content      TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  embedding    BLOB,          -- stored as binary float32 array
  source       TEXT NOT NULL,
  metadata     TEXT DEFAULT '{}',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_chunks_document
  ON svara_chunks (document_id);

-- Document registry
CREATE TABLE IF NOT EXISTS svara_documents (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  size        INTEGER,
  hash        TEXT,
  indexed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT DEFAULT '{}'
);

-- Key-value store for arbitrary agent state
CREATE TABLE IF NOT EXISTS svara_kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  INTEGER,         -- unix timestamp, NULL = no expiry
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export const INSERT_META_SQL = `
INSERT OR REPLACE INTO svara_meta (key, value)
VALUES ('schema_version', ?), ('created_at', ?);
`;
