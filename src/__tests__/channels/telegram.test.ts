import { describe, it, expect, vi, afterEach } from 'vitest';
import { TelegramChannel } from '../../channels/telegram.js';
import type { SvaraAgent } from '../../core/agent.js';

function makeFakeAgent(receive: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}): SvaraAgent {
  return {
    receive,
    on: vi.fn(),
    off: vi.fn(),
    name: 'TestAgent',
    model: 'gpt-4o-mini',
    clearHistory: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockReturnValue([]),
    ...extra,
  } as unknown as SvaraAgent;
}

/** Serves `updates` on the first getUpdates poll, then an empty backlog on every poll after. Records every call made to `method` (path segment after the token) for assertions. */
function fetchMockServing(updates: unknown[], calls: Array<{ method: string; body: unknown }> = []): ReturnType<typeof vi.fn> {
  let served = false;
  return vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
    const method = url.split('/').pop()!;
    if (method !== 'getUpdates') {
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
    }
    if (url.endsWith('/getMe')) return { json: async () => ({ ok: true, result: { username: 'testbot' } }) };
    if (url.endsWith('/getUpdates')) {
      const result = served ? [] : updates;
      served = true;
      return { json: async () => ({ ok: true, result }) };
    }
    if (url.endsWith('/sendMessage')) return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    return { json: async () => ({ ok: true, result: {} }) };
  });
}

function fakeUpdate(fromId: number, text = 'hi') {
  return {
    update_id: 1,
    message: { message_id: 1, from: { id: fromId }, chat: { id: 555 }, date: Math.floor(Date.now() / 1000), text },
  };
}

describe('TelegramChannel', () => {
  let channel: TelegramChannel | null;

  afterEach(async () => {
    await channel?.stop();
    channel = null;
    vi.unstubAllGlobals();
  });

  it('throws when token is missing', () => {
    expect(() => new TelegramChannel({ token: '' })).toThrow(/requires/);
  });

  it('routes an incoming message to agent.receive when no allowlist is configured', async () => {
    vi.stubGlobal('fetch', fetchMockServing([fakeUpdate(111)]));
    const receive = vi.fn().mockResolvedValue({ response: 'pong' });
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5 });
    await channel.mount(makeFakeAgent(receive));

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: '555', userId: '111', text: 'hi', channel: 'telegram' })
    );
  });

  it('drops messages from a user not in allowedUserIds, without calling agent.receive', async () => {
    vi.stubGlobal('fetch', fetchMockServing([fakeUpdate(999)]));
    const receive = vi.fn().mockResolvedValue({ response: 'pong' });
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5, allowedUserIds: ['111'] });
    await channel.mount(makeFakeAgent(receive));

    await new Promise((r) => setTimeout(r, 40));
    expect(receive).not.toHaveBeenCalled();
  });

  it('processes messages from a user in allowedUserIds', async () => {
    vi.stubGlobal('fetch', fetchMockServing([fakeUpdate(111)]));
    const receive = vi.fn().mockResolvedValue({ response: 'pong' });
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5, allowedUserIds: ['111', '222'] });
    await channel.mount(makeFakeAgent(receive));

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
  });

  it('/new clears history and replies without calling agent.receive', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', fetchMockServing([fakeUpdate(111, '/new')], calls));
    const receive = vi.fn().mockResolvedValue({ response: 'pong' });
    const clearHistory = vi.fn().mockResolvedValue(undefined);
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5 });
    await channel.mount(makeFakeAgent(receive, { clearHistory }));

    await vi.waitFor(() => expect(clearHistory).toHaveBeenCalledWith('555'));
    expect(receive).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'sendMessage' && /new conversation/i.test(String((c.body as { text?: string }).text)))).toBe(true);
  });

  it('/status replies with agent/session info without calling agent.receive', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', fetchMockServing([fakeUpdate(111, '/status')], calls));
    const receive = vi.fn().mockResolvedValue({ response: 'pong' });
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5 });
    await channel.mount(makeFakeAgent(receive));

    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'sendMessage' && /TestAgent/.test(String((c.body as { text?: string }).text)))).toBe(true)
    );
    expect(receive).not.toHaveBeenCalled();
  });

  it('/stop with nothing running tells the user there is no active request', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', fetchMockServing([fakeUpdate(111, '/stop')], calls));
    const receive = vi.fn().mockResolvedValue({ response: 'pong' });
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5 });
    await channel.mount(makeFakeAgent(receive));

    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'sendMessage' && /nothing.*running/i.test(String((c.body as { text?: string }).text)))).toBe(true)
    );
    expect(receive).not.toHaveBeenCalled();
  });

  it('delivers the final reply as a new message instead of editing the progress placeholder', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', fetchMockServing([fakeUpdate(111, 'hi')], calls));
    const receive = vi.fn().mockResolvedValue({ response: 'final answer' });
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5 });
    await channel.mount(makeFakeAgent(receive));

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'sendMessage' && (c.body as { text?: string }).text === 'final answer')).toBe(true)
    );
    // The reply must never be delivered via editMessageText - that would overwrite (and hide) the in-progress trace instead of leaving it in the chat.
    expect(calls.some((c) => c.method === 'editMessageText' && (c.body as { text?: string }).text === 'final answer')).toBe(false);
  });
});
