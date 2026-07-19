import { describe, it, expect } from 'vitest';
import { ConversationMemory } from '../memory/conversation.js';

describe('ConversationMemory', () => {
  it('returns an empty history for an unseen session', async () => {
    const memory = new ConversationMemory({ type: 'conversation', maxMessages: 20 });
    expect(await memory.getHistory('none')).toEqual([]);
  });

  it('appends and retrieves messages for a session', async () => {
    const memory = new ConversationMemory({ type: 'conversation', maxMessages: 20 });
    await memory.append('s1', [{ role: 'user', content: 'hi' }]);
    await memory.append('s1', [{ role: 'assistant', content: 'hello' }]);
    const history = await memory.getHistory('s1');
    expect(history.map((m) => m.content)).toEqual(['hi', 'hello']);
  });

  it('does not persist messages when type is "none"', async () => {
    const memory = new ConversationMemory({ type: 'none', maxMessages: 20 });
    await memory.append('s1', [{ role: 'user', content: 'hi' }]);
    expect(await memory.getHistory('s1')).toEqual([]);
  });

  it('trims to the configured window while always keeping system messages', async () => {
    const memory = new ConversationMemory({ type: 'conversation', maxMessages: 2 });
    await memory.append('s1', [{ role: 'system', content: 'sys' }]);
    await memory.append('s1', [{ role: 'user', content: '1' }]);
    await memory.append('s1', [{ role: 'assistant', content: '2' }]);
    await memory.append('s1', [{ role: 'user', content: '3' }]);
    const history = await memory.getHistory('s1');
    expect(history.map((m) => m.content)).toEqual(['sys', '2', '3']);
  });

  it('clear() removes a session', async () => {
    const memory = new ConversationMemory({ type: 'conversation', maxMessages: 20 });
    await memory.append('s1', [{ role: 'user', content: 'hi' }]);
    await memory.clear('s1');
    expect(await memory.getHistory('s1')).toEqual([]);
    expect(memory.hasSession('s1')).toBe(false);
  });

  describe('hydrate()', () => {
    it('seeds an unseen session from external messages', async () => {
      const memory = new ConversationMemory({ type: 'conversation', maxMessages: 20 });
      expect(memory.hasSession('s1')).toBe(false);
      await memory.hydrate('s1', [{ role: 'user', content: 'from db' }]);
      expect(memory.hasSession('s1')).toBe(true);
      expect(await memory.getHistory('s1')).toEqual([{ role: 'user', content: 'from db' }]);
    });

    it('does not overwrite a session that already has in-process history', async () => {
      const memory = new ConversationMemory({ type: 'conversation', maxMessages: 20 });
      await memory.append('s1', [{ role: 'user', content: 'live' }]);
      await memory.hydrate('s1', [{ role: 'user', content: 'stale from db' }]);
      expect(await memory.getHistory('s1')).toEqual([{ role: 'user', content: 'live' }]);
    });
  });
});
