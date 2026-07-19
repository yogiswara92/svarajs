import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WSClient } from 'ws';
import { DiscordChannel } from '../../channels/discord.js';
import type { SvaraAgent } from '../../core/agent.js';

/**
 * Discord's Gateway is a persistent outbound WebSocket, not an inbound
 * webhook - so unlike Slack/WhatsApp there's no Express route to invoke
 * directly. Instead we spin up a tiny in-process `ws` server that plays the
 * part of Discord's gateway (Hello -> expects Identify -> Ready -> can push
 * MESSAGE_CREATE dispatches) and point the channel at it via the
 * `gatewayUrl` test override.
 */
async function startFakeGateway(): Promise<{ url: string; wss: WebSocketServer; nextClient: () => Promise<WSClient> }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const port = (wss.address() as { port: number }).port;

  const pending: Array<(ws: WSClient) => void> = [];
  const queue: WSClient[] = [];
  wss.on('connection', (ws) => {
    const next = pending.shift();
    if (next) next(ws);
    else queue.push(ws);
  });

  const nextClient = () => new Promise<WSClient>((resolve) => {
    const ws = queue.shift();
    if (ws) resolve(ws);
    else pending.push(resolve);
  });

  return { url: `ws://localhost:${port}`, wss, nextClient };
}

function waitForMessage(ws: WSClient): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
  });
}

/** receive() is what these tests care about - on()/off() are the progress reporter's tool:call subscription (see progressReporter.ts), never actually fired by a mocked receive(), but still called. */
function makeFakeAgent(receive: ReturnType<typeof vi.fn> = vi.fn()): SvaraAgent {
  return { receive, on: vi.fn(), off: vi.fn() } as unknown as SvaraAgent;
}

describe('DiscordChannel', () => {
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;
  let channel: DiscordChannel | null;

  beforeEach(async () => {
    gateway = await startFakeGateway();
    channel = null;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(async () => {
    await channel?.stop();
    gateway.wss.close();
    vi.unstubAllGlobals();
  });

  it('throws when botToken is missing', () => {
    expect(() => new DiscordChannel({ botToken: '' })).toThrow(/requires/);
  });

  it('identifies after receiving Hello, and heartbeats on the given interval', async () => {
    channel = new DiscordChannel({ botToken: 'tok', gatewayUrl: gateway.url });
    const fakeAgent = makeFakeAgent();
    await channel.mount(fakeAgent);

    const server = await gateway.nextClient();
    server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }));

    const identify = await waitForMessage(server);
    expect(identify.op).toBe(2);
    expect((identify.d as { token: string }).token).toBe('tok');

    const heartbeat = await waitForMessage(server);
    expect(heartbeat.op).toBe(1);
  });

  it('routes an incoming MESSAGE_CREATE dispatch to agent.receive and posts the reply', async () => {
    channel = new DiscordChannel({ botToken: 'tok', gatewayUrl: gateway.url });
    const receive = vi.fn().mockResolvedValue({ response: 'pong' });
    const fakeAgent = makeFakeAgent(receive);
    await channel.mount(fakeAgent);

    const server = await gateway.nextClient();
    server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
    await waitForMessage(server); // Identify

    server.send(JSON.stringify({
      op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1' },
    }));
    server.send(JSON.stringify({
      op: 0, s: 2, t: 'MESSAGE_CREATE',
      d: { id: 'm1', channel_id: 'chan-1', author: { id: 'u1', bot: false }, content: 'ping', timestamp: new Date().toISOString() },
    }));

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chan-1', text: 'ping', channel: 'discord' }));

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://discord.com/api/v10/channels/chan-1/messages');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ content: 'pong' });
  });

  it('ignores messages authored by bots', async () => {
    channel = new DiscordChannel({ botToken: 'tok', gatewayUrl: gateway.url });
    const receive = vi.fn().mockResolvedValue({ response: 'pong' });
    const fakeAgent = makeFakeAgent(receive);
    await channel.mount(fakeAgent);

    const server = await gateway.nextClient();
    server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
    await waitForMessage(server);
    server.send(JSON.stringify({
      op: 0, s: 1, t: 'MESSAGE_CREATE',
      d: { id: 'm1', channel_id: 'chan-1', author: { id: 'bot1', bot: true }, content: 'ping', timestamp: new Date().toISOString() },
    }));

    await new Promise((r) => setTimeout(r, 30));
    expect(receive).not.toHaveBeenCalled();
  });

  it('send() posts to the REST API with the bot token', async () => {
    channel = new DiscordChannel({ botToken: 'tok', gatewayUrl: gateway.url });
    await channel.send('chan-2', 'hi');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://discord.com/api/v10/channels/chan-2/messages');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bot tok');
  });

  it('send() throws when the REST API responds with an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ message: 'Missing Access' }) }));
    channel = new DiscordChannel({ botToken: 'tok', gatewayUrl: gateway.url });
    await expect(channel.send('chan-2', 'hi')).rejects.toThrow(/Missing Access/);
  });

  it('stop() closes the socket and clears the heartbeat timer without reconnecting', async () => {
    channel = new DiscordChannel({ botToken: 'tok', gatewayUrl: gateway.url });
    const fakeAgent = makeFakeAgent();
    await channel.mount(fakeAgent);

    const server = await gateway.nextClient();
    server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
    await waitForMessage(server);

    await channel.stop();
    const connectionsBefore = gateway.wss.clients.size;
    await new Promise((r) => setTimeout(r, 20));
    expect(gateway.wss.clients.size).toBeLessThanOrEqual(connectionsBefore);
  });
});
