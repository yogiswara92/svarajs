/**
 * @module database/sqlite
 * SvaraJS — SQLite adapter
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
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO svara_messages (id, session_id, role, content, tool_call_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      params.id,
      params.sessionId,
      params.role,
      params.content,
      params.toolCallId ?? null
    );
  }

  getMessages(sessionId: string, limit = 50): Array<{
    id: string;
    role: string;
    content: string;
    tool_call_id: string | null;
    created_at: number;
  }> {
    return this.db.prepare(`
      SELECT id, role, content, tool_call_id, created_at
      FROM svara_messages
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<{
      id: string;
      role: string;
      content: string;
      tool_call_id: string | null;
      created_at: number;
    }>;
  }

  clearSession(sessionId: string): void {
    this.db.prepare('DELETE FROM svara_messages WHERE session_id = ?').run(sessionId);
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
