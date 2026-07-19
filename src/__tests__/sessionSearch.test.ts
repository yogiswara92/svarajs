import { describe, it, expect } from 'vitest';
import { SvaraDB } from '../database/sqlite.js';
import { createSessionSearchTool } from '../memory/sessionSearchTool.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

function seed(db: SvaraDB): void {
  db.saveMessage({ id: 'm1', sessionId: 's1', role: 'user', content: 'What is the refund policy for orders?' });
  db.saveMessage({ id: 'm2', sessionId: 's1', role: 'assistant', content: 'Refunds are allowed within 30 days.' });
  db.saveMessage({ id: 'm3', sessionId: 's2', role: 'user', content: 'How do I reset my password?' });
  db.saveMessage({ id: 'm4', sessionId: 's2', role: 'assistant', content: 'Click "forgot password" on the login page.' });
}

describe('SvaraDB.searchMessages', () => {
  it('finds messages across every session by keyword', () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    const results = db.searchMessages('refund');
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe('s1');
    db.close();
  });

  it('matches multiple terms as an implicit AND, not OR', () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    // m3 has both "reset" and "password"; m4 has "password" but not "reset" - AND excludes it.
    const results = db.searchMessages('reset password');
    expect(results).toHaveLength(1);
    expect(results[0].messageId).toBe('m3');
    db.close();
  });

  it('does not throw on input containing FTS5 special characters', () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    expect(() => db.searchMessages('refund" OR content:*')).not.toThrow();
    db.close();
  });

  it('returns an empty array for a blank query', () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    expect(db.searchMessages('   ')).toEqual([]);
    db.close();
  });

  it('clearSession() also removes the session from the FTS index', () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    db.clearSession('s1');
    expect(db.searchMessages('refund')).toEqual([]);
    db.close();
  });
});

describe('SvaraDB.listRecentSessions', () => {
  it('groups by session with a count and preview of the last message', () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    const sessions = db.listRecentSessions();
    expect(sessions).toHaveLength(2);
    const s1 = sessions.find((s) => s.sessionId === 's1');
    expect(s1?.messageCount).toBe(2);
    expect(s1?.preview).toBe('Refunds are allowed within 30 days.');
    db.close();
  });
});

describe('SvaraDB.getMessageContext', () => {
  it('returns a window of messages around the target within its session', () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    const context = db.getMessageContext('s1', 'm1', 5);
    expect(context.map((m) => m.id)).toEqual(['m1', 'm2']);
    db.close();
  });

  it('returns an empty array for an unknown message id', () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    expect(db.getMessageContext('s1', 'nonexistent', 5)).toEqual([]);
    db.close();
  });
});

describe('createSessionSearchTool', () => {
  it('search action returns matching results', async () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    const tool = createSessionSearchTool(db);
    const result = await tool.run({ action: 'search', query: 'password' }, ctx) as { results: unknown[] };
    expect(result.results).toHaveLength(2);
    db.close();
  });

  it('search without a query returns an error', async () => {
    const db = new SvaraDB(':memory:');
    const tool = createSessionSearchTool(db);
    const result = await tool.run({ action: 'search' }, ctx) as { error: string };
    expect(result.error).toMatch(/requires "query"/);
    db.close();
  });

  it('browse action lists recent sessions', async () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    const tool = createSessionSearchTool(db);
    const result = await tool.run({ action: 'browse' }, ctx) as { sessions: unknown[] };
    expect(result.sessions).toHaveLength(2);
    db.close();
  });

  it('context action returns the message window', async () => {
    const db = new SvaraDB(':memory:');
    seed(db);
    const tool = createSessionSearchTool(db);
    const result = await tool.run({ action: 'context', sessionId: 's1', messageId: 'm1' }, ctx) as { messages: Array<{ id: string }> };
    expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    db.close();
  });

  it('context without sessionId/messageId returns an error', async () => {
    const db = new SvaraDB(':memory:');
    const tool = createSessionSearchTool(db);
    const result = await tool.run({ action: 'context' }, ctx) as { error: string };
    expect(result.error).toMatch(/requires "sessionId"/);
    db.close();
  });
});
