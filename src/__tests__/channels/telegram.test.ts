import { describe, it, expect, vi, afterEach } from 'vitest';
import { TelegramChannel } from '../../channels/telegram.js';
import type { SvaraAgent } from '../../core/agent.js';

function makeFakeAgent(receive: ReturnType<typeof vi.fn>): SvaraAgent {
  return { receive, on: vi.fn(), off: vi.fn() } as unknown as SvaraAgent;
}

/** Serves `updates` on the first getUpdates poll, then an empty backlog on every poll after. */
function fetchMockServing(updates: unknown[]): ReturnType<typeof vi.fn> {
  let served = false;
  return vi.fn().mockImplementation(async (url: string) => {
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
});
