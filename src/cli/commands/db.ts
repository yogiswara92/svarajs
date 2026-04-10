/**
 * @module cli/commands/db
 * SvaraJS — Database inspection commands
 *
 * Usage:
 *   svara db:list-chunks [--agent <name>]
 *   svara db:search <query> [--agent <name>] [--limit 5]
 *   svara db:stats [--agent <name>]
 *   svara db:users
 *   svara db:sessions [--user <email>]
 */

import { SvaraDB } from '../../database/sqlite.js';
import type { DocumentChunk } from '../../core/types.js';

interface DBCommandOptions {
  agent?: string;
  limit?: number;
  user?: string;
}

const db = new SvaraDB('./data/svara.db');

// ── List Chunks ───────────────────────────────────────────────────────────────

export async function listChunks(options: DBCommandOptions): Promise<void> {
  try {
    let query = 'SELECT id, agent_name, document_id, content, source FROM svara_chunks';
    const params: (string | number)[] = [];

    if (options.agent) {
      query += ' WHERE agent_name = ?';
      params.push(options.agent);
    }

    query += ' LIMIT 20';

    const chunks = db.query(query, params) as Array<{
      id: string;
      agent_name: string;
      document_id: string;
      content: string;
      source: string;
    }>;

    if (!chunks.length) {
      console.log('ℹ️  No chunks found.');
      return;
    }

    console.log(`\n📚 Chunks (showing ${chunks.length}):\n`);
    chunks.forEach((chunk, i) => {
      const preview = chunk.content.substring(0, 80).replace(/\n/g, ' ');
      console.log(`${i + 1}. [${chunk.agent_name}] ${chunk.source}`);
      console.log(`   ID: ${chunk.id}`);
      console.log(`   Preview: ${preview}...`);
      console.log('');
    });
  } catch (error) {
    console.error('❌ Error listing chunks:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ── Search Chunks ─────────────────────────────────────────────────────────────

export async function searchChunks(query: string, options: DBCommandOptions): Promise<void> {
  try {
    const limit = options.limit || 5;
    let sql = `SELECT id, agent_name, source, content FROM svara_chunks
               WHERE content LIKE ?`;
    const params: (string | number)[] = [`%${query}%`];

    if (options.agent) {
      sql += ' AND agent_name = ?';
      params.push(options.agent);
    }

    sql += ` LIMIT ${limit}`;

    const results = db.query(sql, params) as Array<{
      id: string;
      agent_name: string;
      source: string;
      content: string;
    }>;

    if (!results.length) {
      console.log(`ℹ️  No chunks found matching "${query}".`);
      return;
    }

    console.log(`\n🔍 Search Results for "${query}" (${results.length} found):\n`);
    results.forEach((result, i) => {
      const preview = result.content.substring(0, 100).replace(/\n/g, ' ');
      console.log(`${i + 1}. [${result.agent_name}] ${result.source}`);
      console.log(`   ${preview}...`);
      console.log('');
    });
  } catch (error) {
    console.error('❌ Error searching chunks:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ── Database Stats ────────────────────────────────────────────────────────────

export async function dbStats(options: DBCommandOptions): Promise<void> {
  try {
    const totalChunks = db.query('SELECT COUNT(*) as count FROM svara_chunks') as Array<{
      count: number;
    }>;
    const totalUsers = db.query('SELECT COUNT(*) as count FROM svara_users') as Array<{
      count: number;
    }>;
    const totalSessions = db.query('SELECT COUNT(*) as count FROM svara_sessions') as Array<{
      count: number;
    }>;
    const totalMessages = db.query('SELECT COUNT(*) as count FROM svara_messages') as Array<{
      count: number;
    }>;

    const agents = db.query(
      'SELECT DISTINCT agent_name, COUNT(*) as chunk_count FROM svara_chunks GROUP BY agent_name'
    ) as Array<{
      agent_name: string;
      chunk_count: number;
    }>;

    console.log('\n📊 Database Statistics:\n');
    console.log(`  Total Chunks:   ${totalChunks[0]?.count ?? 0}`);
    console.log(`  Total Users:    ${totalUsers[0]?.count ?? 0}`);
    console.log(`  Total Sessions: ${totalSessions[0]?.count ?? 0}`);
    console.log(`  Total Messages: ${totalMessages[0]?.count ?? 0}`);
    console.log('\n  Chunks by Agent:');

    if (agents.length === 0) {
      console.log('    (none)');
    } else {
      agents.forEach((agent) => {
        console.log(`    - ${agent.agent_name}: ${agent.chunk_count} chunks`);
      });
    }

    console.log('');
  } catch (error) {
    console.error('❌ Error getting stats:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ── List Users ────────────────────────────────────────────────────────────────

export async function listUsers(): Promise<void> {
  try {
    const users = db.query(
      'SELECT id, email, display_name, first_seen, last_seen FROM svara_users LIMIT 50'
    ) as Array<{
      id: string;
      email: string;
      display_name: string;
      first_seen: string;
      last_seen: string;
    }>;

    if (!users.length) {
      console.log('ℹ️  No users found.');
      return;
    }

    console.log(`\n👥 Users (${users.length}):\n`);
    users.forEach((user) => {
      console.log(`  ${user.email}`);
      console.log(`    Name: ${user.display_name || '(none)'}`);
      console.log(`    First seen: ${user.first_seen}`);
      console.log(`    Last seen:  ${user.last_seen}`);
      console.log('');
    });
  } catch (error) {
    console.error('❌ Error listing users:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ── List Sessions ─────────────────────────────────────────────────────────────

export async function listSessions(options: DBCommandOptions): Promise<void> {
  try {
    let query = `SELECT s.id, s.user_id, s.agent_name, s.created_at, COUNT(m.id) as message_count
                 FROM svara_sessions s
                 LEFT JOIN svara_messages m ON s.id = m.session_id`;
    const params: string[] = [];

    if (options.user) {
      query += ` WHERE s.user_id = (SELECT id FROM svara_users WHERE email = ?)`;
      params.push(options.user);
    }

    query += ' GROUP BY s.id LIMIT 50';

    const sessions = db.query(query, params) as Array<{
      id: string;
      user_id: string;
      agent_name: string;
      created_at: string;
      message_count: number;
    }>;

    if (!sessions.length) {
      console.log('ℹ️  No sessions found.');
      return;
    }

    console.log(`\n💬 Sessions (${sessions.length}):\n`);
    sessions.forEach((session) => {
      console.log(`  ID: ${session.id}`);
      console.log(`    Agent: ${session.agent_name}`);
      console.log(`    Messages: ${session.message_count}`);
      console.log(`    Created: ${session.created_at}`);
      console.log('');
    });
  } catch (error) {
    console.error('❌ Error listing sessions:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ── Clear Chunks ──────────────────────────────────────────────────────────────

export async function clearChunks(agentName: string): Promise<void> {
  try {
    if (!agentName) {
      console.error('❌ Agent name required. Usage: svara db:clear-chunks <agent-name>');
      process.exit(1);
    }

    const result = db.query('SELECT COUNT(*) as count FROM svara_chunks WHERE agent_name = ?', [
      agentName,
    ]) as Array<{
      count: number;
    }>;
    const count = result[0]?.count ?? 0;

    if (count === 0) {
      console.log(`ℹ️  No chunks found for agent "${agentName}".`);
      return;
    }

    console.log(`\n⚠️  About to delete ${count} chunks for agent "${agentName}".`);
    console.log('Use --yes flag to confirm: svara db:clear-chunks <agent> --yes\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing chunks:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export async function clearChunksConfirmed(agentName: string): Promise<void> {
  try {
    db.run('DELETE FROM svara_chunks WHERE agent_name = ?', [agentName]);
    console.log(`✅ Deleted all chunks for agent "${agentName}".`);
  } catch (error) {
    console.error('❌ Error deleting chunks:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
