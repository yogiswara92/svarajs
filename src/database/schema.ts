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

-- User registry
CREATE TABLE IF NOT EXISTS svara_users (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  display_name TEXT,
  first_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_users_email
  ON svara_users (email);

-- Session metadata
CREATE TABLE IF NOT EXISTS svara_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT DEFAULT '{}',
  FOREIGN KEY (user_id) REFERENCES svara_users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON svara_sessions (user_id);

-- Vector store chunks for RAG (per agent)
CREATE TABLE IF NOT EXISTS svara_chunks (
  id           TEXT PRIMARY KEY,
  agent_name   TEXT NOT NULL,   -- Separate RAG per agent
  document_id  TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,   -- MD5 hash of content for deduplication
  chunk_index  INTEGER NOT NULL,
  embedding    TEXT,            -- stored as JSON string of float array
  source       TEXT NOT NULL,
  metadata     TEXT DEFAULT '{}',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_chunks_agent
  ON svara_chunks (agent_name);

CREATE INDEX IF NOT EXISTS idx_chunks_agent_document
  ON svara_chunks (agent_name, document_id);

CREATE INDEX IF NOT EXISTS idx_chunks_content_hash
  ON svara_chunks (content_hash);

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
