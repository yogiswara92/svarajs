/**
 * @module database/sqlite
 * SvaraJS - SQLite adapter
 *
 * A clean, ergonomic wrapper around better-sqlite3.
 * Provides typed query helpers, migrations, and a KV store.
 * Used internally by SvaraJS and optionally exposed to users.
 *
 * @example
 * const db = new SvaraDB('./data/agent.db');
 *
 * // Typed queries
 * const users = db.query<{ id: string; name: string }>(
 *   'SELECT id, name FROM users WHERE active = ?', [1]
 * );
 *
 * // KV store
 * db.kv.set('onboarding:done', true);
 * const done = db.kv.get<boolean>('onboarding:done');
 *
 * // Custom tables
 * db.exec(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, ...)`);
 */

import path from 'path';
import fs from 'fs';
import { CREATE_TABLES_SQL, INSERT_META_SQL, SCHEMA_VERSION } from './schema.js';

type Database = {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => void;
  close: () => void;
  pragma: (pragma: string, options?: { simple?: boolean }) => unknown;
  transaction: <T>(fn: () => T) => () => T;
};

type Statement = {
  run: (...args: unknown[]) => { lastInsertRowid: bigint | number; changes: number };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

// ─── KV Store ─────────────────────────────────────────────────────────────────

class KVStore {
  constructor(private db: Database) {}

  /** Set a key-value pair, with optional TTL in seconds. */
  set<T>(key: string, value: T, ttlSeconds?: number): void {
    const expiresAt = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : null;
    this.db.prepare(`
      INSERT OR REPLACE INTO svara_kv (key, value, expires_at, updated_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(key, JSON.stringify(value), expiresAt);
  }

  /** Get a value by key. Returns undefined if not found or expired. */
  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare(`
      SELECT value, expires_at FROM svara_kv
      WHERE key = ? AND (expires_at IS NULL OR expires_at > unixepoch())
    `).get(key) as { value: string; expires_at: number | null } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  /** Delete a key. */
  delete(key: string): void {
    this.db.prepare('DELETE FROM svara_kv WHERE key = ?').run(key);
  }

  /** Check if a key exists and is not expired. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Get all keys matching a prefix. */
  keys(prefix = ''): string[] {
    const rows = this.db.prepare(`
      SELECT key FROM svara_kv
      WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > unixepoch())
    `).all(`${prefix}%`) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }
}

// ─── SvaraDB ──────────────────────────────────────────────────────────────────

export class SvaraDB {
  private db: Database;
  readonly kv: KVStore;

  constructor(dbPath = ':memory:') {
    // Ensure the directory exists
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }

    this.db = this.openDatabase(dbPath);
    this.configure();
    this.migrate();
    this.kv = new KVStore(this.db);
  }

  // ─── Query Helpers ────────────────────────────────────────────────────────

  /**
   * Run a SELECT and return all matching rows.
   */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * Run a SELECT and return the first matching row.
   */
  queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /**
   * Run an INSERT/UPDATE/DELETE. Returns affected row count.
   */
  run(sql: string, params: unknown[] = []): number {
    return this.db.prepare(sql).run(...params).changes;
  }

  /**
   * Execute raw SQL (for DDL, migrations, etc.).
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Run multiple operations in a single transaction.
   *
   * @example
   * db.transaction(() => {
   *   db.run('INSERT INTO orders ...', [...]);
   *   db.run('UPDATE inventory ...', [...]);
   * });
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // ─── Internal Message Storage ─────────────────────────────────────────────

  saveMessage(params: {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    toolCallId?: string;
    /** Reasoning trace for this reply (tools called, iteration count, RAG sources) - shown collapsed in the dashboard chat. */
    metadata?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO svara_messages (id, session_id, role, content, tool_call_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.id,
      params.sessionId,
      params.role,
      params.content,
      params.toolCallId ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null
    );
    this.db.prepare(`
      INSERT INTO svara_messages_fts (content, session_id, message_id, role)
      VALUES (?, ?, ?, ?)
    `).run(params.content, params.sessionId, params.id, params.role);
  }

  /**
   * Full-text search across every persisted session (not just the current
   * one's in-memory window) - the DISCOVERY mode behind the `session_search`
   * tool. Query terms are matched as an implicit AND of literal phrases, so
   * arbitrary user input can't inject FTS5 query operators.
   */
  searchMessages(query: string, limit = 20): Array<{
    sessionId: string;
    messageId: string;
    role: string;
    content: string;
  }> {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');

    return this.db.prepare(`
      SELECT session_id as sessionId, message_id as messageId, role, content
      FROM svara_messages_fts
      WHERE svara_messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{ sessionId: string; messageId: string; role: string; content: string }>;
  }

  /** Chronological browse mode: most recently active sessions first, with a preview of the last message. */
  listRecentSessions(limit = 20): Array<{
    sessionId: string;
    lastMessageAt: number;
    messageCount: number;
    preview: string;
  }> {
    return this.db.prepare(`
      SELECT
        session_id as sessionId,
        MAX(created_at) as lastMessageAt,
        COUNT(*) as messageCount,
        (
          SELECT content FROM svara_messages m2
          WHERE m2.session_id = m.session_id
          ORDER BY created_at DESC LIMIT 1
        ) as preview
      FROM svara_messages m
      GROUP BY session_id
      ORDER BY lastMessageAt DESC
      LIMIT ?
    `).all(limit) as Array<{ sessionId: string; lastMessageAt: number; messageCount: number; preview: string }>;
  }

  /** A window of messages around a specific one, within its session - the SCROLL mode behind `session_search`. */
  getMessageContext(sessionId: string, aroundMessageId: string, windowSize = 5): Array<{
    id: string;
    role: string;
    content: string;
    created_at: number;
  }> {
    // Ordered by rowid (strict insertion order), not created_at (only 1-second
    // resolution - two messages saved in the same second would tie, making
    // "before"/"after" ambiguous).
    const target = this.db.prepare(
      'SELECT rowid FROM svara_messages WHERE id = ? AND session_id = ?'
    ).get(aroundMessageId, sessionId) as { rowid: number } | undefined;
    if (!target) return [];

    const rows = this.db.prepare(`
      SELECT id, role, content, created_at, rowid FROM (
        SELECT id, role, content, created_at, rowid FROM svara_messages
        WHERE session_id = ? AND rowid <= ?
        ORDER BY rowid DESC LIMIT ?
      )
      UNION ALL
      SELECT id, role, content, created_at, rowid FROM (
        SELECT id, role, content, created_at, rowid FROM svara_messages
        WHERE session_id = ? AND rowid > ?
        ORDER BY rowid ASC LIMIT ?
      )
      ORDER BY rowid ASC
    `).all(
      sessionId, target.rowid, windowSize + 1,
      sessionId, target.rowid, windowSize
    ) as Array<{ id: string; role: string; content: string; created_at: number; rowid: number }>;

    return rows.map(({ rowid: _rowid, ...row }) => row);
  }

  getMessages(sessionId: string, limit = 50): Array<{
    id: string;
    role: string;
    content: string;
    tool_call_id: string | null;
    metadata?: Record<string, unknown>;
    created_at: number;
  }> {
    const rows = this.db.prepare(`
      SELECT id, role, content, tool_call_id, metadata, created_at
      FROM svara_messages
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<{
      id: string;
      role: string;
      content: string;
      tool_call_id: string | null;
      metadata: string | null;
      created_at: number;
    }>;
    return rows.map(({ metadata, ...row }) => ({
      ...row,
      metadata: metadata ? (JSON.parse(metadata) as Record<string, unknown>) : undefined,
    }));
  }

  clearSession(sessionId: string): void {
    this.db.prepare('DELETE FROM svara_messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM svara_messages_fts WHERE session_id = ?').run(sessionId);
  }

  // ─── Private Setup ────────────────────────────────────────────────────────

  private openDatabase(dbPath: string): Database {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3') as new (path: string) => Database;
      return new Database(dbPath);
    } catch {
      throw new Error(
        '[SvaraJS] Database requires the "better-sqlite3" package.\n' +
        'Run: npm install better-sqlite3'
      );
    }
  }

  private configure(): void {
    // WAL mode = faster writes, better concurrency
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  private migrate(): void {
    this.db.exec(CREATE_TABLES_SQL);

    // svara_messages predates the `metadata` column (added to persist each
    // reply's tool-call trace) - CREATE TABLE IF NOT EXISTS above is a no-op
    // for a database that already has the table, so add it here instead.
    const messageColumns = this.db.prepare('PRAGMA table_info(svara_messages)').all() as Array<{ name: string }>;
    if (!messageColumns.some((c) => c.name === 'metadata')) {
      this.db.exec('ALTER TABLE svara_messages ADD COLUMN metadata TEXT');
    }

    const meta = this.db.prepare(
      "SELECT value FROM svara_meta WHERE key = 'schema_version'"
    ).get() as { value: string } | undefined;

    if (!meta) {
      this.db.prepare(INSERT_META_SQL).run(
        String(SCHEMA_VERSION),
        new Date().toISOString()
      );
    }
  }
}
