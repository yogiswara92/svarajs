import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { SlackChannel } from '../../channels/slack.js';
import type { SvaraAgent } from '../../core/agent.js';

const SIGNING_SECRET = 'test-signing-secret';
const BOT_TOKEN = 'xoxb-test-token';

function sign(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')}`;
}

interface FakeReq {
  headers: Record<string, string>;
  body: unknown;
  rawBody?: Buffer;
}
interface FakeRes {
  statusCode?: number;
  jsonBody?: unknown;
  status: (n: number) => FakeRes;
  json: (b: unknown) => FakeRes;
  sendStatus: (n: number) => void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    status(n) { res.statusCode = n; return res; },
    json(b) { res.jsonBody = b; return res; },
    sendStatus(n) { res.statusCode = n; },
  };
  return res;
}

function buildReq(payload: object, opts: { skipSig?: boolean; timestamp?: string } = {}): FakeReq {
  const bodyStr = JSON.stringify(payload);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {};
  if (!opts.skipSig) {
    headers['x-slack-signature'] = sign(bodyStr, timestamp);
    headers['x-slack-request-timestamp'] = timestamp;
  }
  return { headers, body: payload, rawBody: Buffer.from(bodyStr) };
}

type SlackHandler = (req: FakeReq, res: FakeRes) => Promise<void> | void;

/** Mounts the channel on a fake app and returns the captured POST /slack/events handler, plus the fake agent's receive mock. */
async function mountAndCapture(
  channel: SlackChannel,
  receiveImpl: () => Promise<{ response: string }> = () => Promise.resolve({ response: 'hello back' })
): Promise<{ handler: SlackHandler; receive: ReturnType<typeof vi.fn> }> {
  let handler: SlackHandler | undefined;
  const fakeApp = {
    post: (path: string, h: SlackHandler) => {
      if (path === '/slack/events') handler = h;
    },
  };
  const receive = vi.fn().mockImplementation(receiveImpl);
  const fakeAgent = {
    channels: new Map([['web', { app: fakeApp }]]),
    receive,
    // on()/off() are the progress reporter's tool:call subscription (see
    // progressReporter.ts) - never actually fired by a mocked receive(),
    // but still called.
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as SvaraAgent;
  await channel.mount(fakeAgent);
  if (!handler) throw new Error('handler not mounted');
  return { handler, receive };
}

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when botToken or signingSecret is missing', () => {
    expect(() => new SlackChannel({ botToken: '', signingSecret: SIGNING_SECRET })).toThrow(/requires/);
    expect(() => new SlackChannel({ botToken: BOT_TOKEN, signingSecret: '' })).toThrow(/requires/);
  });

  it('rejects requests with a missing or invalid signature', async () => {
    const channel = new SlackChannel({ botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET });
    const { handler } = await mountAndCapture(channel);

    const res1 = fakeRes();
    await handler(buildReq({ type: 'event_callback' }, { skipSig: true }), res1);
    expect(res1.statusCode).toBe(401);

    const req2 = buildReq({ type: 'event_callback' });
    req2.headers['x-slack-signature'] = 'v0=deadbeef';
    const res2 = fakeRes();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(401);
  });

  it('rejects requests with a stale timestamp (replay protection)', async () => {
    const channel = new SlackChannel({ botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET });
    const { handler } = await mountAndCapture(channel);

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const req = buildReq({ type: 'event_callback' }, { timestamp: staleTimestamp });
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('answers the url_verification handshake with the challenge', async () => {
    const channel = new SlackChannel({ botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET });
    const { handler } = await mountAndCapture(channel);

    const req = buildReq({ type: 'url_verification', challenge: 'abc123' });
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ challenge: 'abc123' });
  });

  it('ignores bot messages and subtype events (no agent.receive call)', async () => {
    const channel = new SlackChannel({ botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET });
    const { handler, receive } = await mountAndCapture(channel);

    const botReq = buildReq({
      type: 'event_callback',
      event: { type: 'message', bot_id: 'B1', channel: 'C1', text: 'hi', ts: '1.1' },
    });
    await handler(botReq, fakeRes());

    const subtypeReq = buildReq({
      type: 'event_callback',
      event: { type: 'message', subtype: 'message_changed', channel: 'C1', text: 'hi', ts: '1.2' },
    });
    await handler(subtypeReq, fakeRes());

    await new Promise((r) => setTimeout(r, 10));
    expect(receive).not.toHaveBeenCalled();
  });

  it('processes a real message and replies via chat.postMessage', async () => {
    const channel = new SlackChannel({ botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET });
    const { handler } = await mountAndCapture(channel);

    const req = buildReq({
      type: 'event_callback',
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi there', ts: '1700000000.001' },
    });
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 10));
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({ method: 'POST' })
    );
    const call = fetchMock.mock.calls[0];
    const sentBody = JSON.parse((call[1] as { body: string }).body);
    expect(sentBody).toEqual({ channel: 'C1', text: 'hello back' });
  });

  it('dedups the same event (channel + ts) instead of replying twice', async () => {
    const channel = new SlackChannel({ botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET });
    const { handler } = await mountAndCapture(channel);

    const payload = {
      type: 'event_callback',
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1700000000.002' },
    };
    await handler(buildReq(payload), fakeRes());
    await handler(buildReq(payload), fakeRes());
    await new Promise((r) => setTimeout(r, 10));

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('send() posts a message to the given channel', async () => {
    const channel = new SlackChannel({ botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET });
    await channel.send('C9', 'ping');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${BOT_TOKEN}` }),
      })
    );
  });

  it('send() throws when the Slack API responds with an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ ok: false, error: 'channel_not_found' }) }));
    const channel = new SlackChannel({ botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET });
    await expect(channel.send('C9', 'ping')).rejects.toThrow(/channel_not_found/);
  });
});
