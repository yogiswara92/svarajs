import { describe, it, expect } from 'vitest';
import { SvaraDB } from '../database/sqlite.js';

describe('SvaraDB message persistence', () => {
  it('round-trips saved messages through getMessages', () => {
    const db = new SvaraDB(':memory:');
    db.saveMessage({ id: '1', sessionId: 's1', role: 'user', content: 'hi' });
    db.saveMessage({ id: '2', sessionId: 's1', role: 'assistant', content: 'hello' });
    db.saveMessage({ id: '3', sessionId: 's2', role: 'user', content: 'other session' });

    const messages = db.getMessages('s1');
    expect(messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    db.close();
  });

  it('round-trips a message\'s metadata (reasoning trace) through getMessages', () => {
    const db = new SvaraDB(':memory:');
    db.saveMessage({ id: '1', sessionId: 's1', role: 'user', content: 'hi' });
    db.saveMessage({
      id: '2',
      sessionId: 's1',
      role: 'assistant',
      content: 'hello',
      metadata: { toolsUsed: ['web_search'], iterations: 3 },
    });

    const messages = db.getMessages('s1');
    expect(messages[0].metadata).toBeUndefined();
    expect(messages[1].metadata).toEqual({ toolsUsed: ['web_search'], iterations: 3 });
    db.close();
  });

  it('clearSession only removes messages for that session', () => {
    const db = new SvaraDB(':memory:');
    db.saveMessage({ id: '1', sessionId: 's1', role: 'user', content: 'a' });
    db.saveMessage({ id: '2', sessionId: 's2', role: 'user', content: 'b' });
    db.clearSession('s1');
    expect(db.getMessages('s1')).toEqual([]);
    expect(db.getMessages('s2')).toHaveLength(1);
    db.close();
  });

  it('kv store supports set/get/has/delete with TTL', () => {
    const db = new SvaraDB(':memory:');
    db.kv.set('foo', { a: 1 });
    expect(db.kv.get('foo')).toEqual({ a: 1 });
    expect(db.kv.has('foo')).toBe(true);
    db.kv.delete('foo');
    expect(db.kv.has('foo')).toBe(false);
    db.close();
  });
});
