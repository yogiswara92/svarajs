import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TelegramChannel } from '../../channels/telegram.js';
import type { SvaraAgent } from '../../core/agent.js';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64');

interface Call { method: string; body: any }

/** Telegram stand-in: serves one update, answers getFile, and serves file bytes from /file/bot<token>/<path>. */
function telegramMock(update: unknown, opts: { fileBytes?: Buffer; getFileFails?: boolean; downloadStatus?: number } = {}) {
  const calls: Call[] = [];
  const downloads: string[] = [];
  let served = false;
  const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.includes('/file/bot')) {
      downloads.push(url);
      return { ok: (opts.downloadStatus ?? 200) < 400, status: opts.downloadStatus ?? 200, arrayBuffer: async () => (opts.fileBytes ?? JPEG).buffer.slice((opts.fileBytes ?? JPEG).byteOffset, (opts.fileBytes ?? JPEG).byteOffset + (opts.fileBytes ?? JPEG).byteLength) };
    }
    const method = url.split('/').pop()!;
    if (method !== 'getUpdates') calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
    const ok = (result: unknown) => ({ json: async () => ({ ok: true, result }) });
    if (method === 'getMe') return ok({ username: 'testbot' });
    if (method === 'getUpdates') { const r = served ? [] : [update]; served = true; return ok(r); }
    if (method === 'getFile') return opts.getFileFails ? { json: async () => ({ ok: false, description: 'bad file' }) } : ok({ file_path: 'photos/file_7.jpg' });
    if (method === 'sendMessage') return ok({ message_id: 1 });
    return ok({});
  });
  return { fn, calls, downloads };
}

function agentWith(receive: ReturnType<typeof vi.fn>): SvaraAgent {
  return { receive, on: vi.fn(), off: vi.fn(), name: 'T', model: 'gpt-4o', clearHistory: vi.fn(), listSessions: vi.fn().mockReturnValue([]) } as unknown as SvaraAgent;
}

const update = (message: Record<string, unknown>) => ({ update_id: 1, message: { message_id: 9, from: { id: 111 }, chat: { id: 555 }, date: Math.floor(Date.now() / 1000), ...message } });

describe('TelegramChannel attachments', () => {
  let channel: TelegramChannel | null = null;
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-tg-')); });
  afterEach(async () => { await channel?.stop(); channel = null; vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }); });

  async function run(updateObj: unknown, opts: Parameters<typeof telegramMock>[1] = {}, cfg: Record<string, unknown> = {}) {
    const mock = telegramMock(updateObj, opts);
    vi.stubGlobal('fetch', mock.fn);
    const receive = vi.fn().mockResolvedValue({ response: 'ok' });
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5, downloadDir: dir, ...cfg });
    await channel.mount(agentWith(receive));
    await vi.waitFor(() => expect(mock.calls.some((c) => c.method === 'sendMessage') || receive.mock.calls.length > 0).toBe(true), { timeout: 2000 });
    return { ...mock, receive };
  }

  it('answers a photo: saves it, uses the caption, and hands the image to the agent', async () => {
    const { receive, downloads } = await run(update({ caption: 'apa ini?', photo: [{ file_id: 'small', width: 90, height: 90 }, { file_id: 'big', width: 800, height: 600, file_size: 1000 }] }));
    expect(downloads[0]).toBe('https://api.telegram.org/file/bottok/photos/file_7.jpg');
    const msg = receive.mock.calls[0][0];
    expect(msg.text).toMatch(/^apa ini\?/);
    const saved = /\): (\S+)$/m.exec(msg.text)![1];
    expect(saved.startsWith(path.join(dir, '555'))).toBe(true);
    expect(fs.readFileSync(saved).equals(JPEG)).toBe(true);
    expect(msg.images).toEqual([{ mimeType: 'image/jpeg', base64: JPEG.toString('base64') }]);
  });

  it('asks Telegram for the LARGEST size of the photo', async () => {
    const { calls } = await run(update({ photo: [{ file_id: 'small', width: 90, height: 90 }, { file_id: 'big', width: 800, height: 600 }] }));
    expect(calls.find((c) => c.method === 'getFile')!.body).toEqual({ file_id: 'big' });
  });

  it('saves a document and tells the agent its name, without inlining non-images', async () => {
    const { receive } = await run(update({ caption: 'ringkas ya', document: { file_id: 'd1', file_name: 'Laporan Q3.pdf', mime_type: 'application/pdf', file_size: 2048 } }), { fileBytes: Buffer.from('%PDF-1.4 fake') });
    const msg = receive.mock.calls[0][0];
    expect(msg.text).toContain('ringkas ya');
    expect(msg.text).toContain('- Laporan Q3.pdf (application/pdf,');
    expect(msg.text).toMatch(/Laporan_Q3\.pdf$/m);
    expect(msg.images).toBeUndefined();
  });

  it('never lets a file name escape the download folder', async () => {
    const { receive } = await run(update({ document: { file_id: 'd', file_name: '../../etc/passwd', mime_type: 'text/plain', file_size: 10 } }), { fileBytes: Buffer.from('x') });
    const saved = /\): (\S+)$/m.exec(receive.mock.calls[0][0].text)![1];
    expect(path.dirname(saved)).toBe(path.join(dir, '555'));
    expect(path.basename(saved)).toMatch(/passwd$/);
  });

  it('says so when the agent was sent an image with no message', async () => {
    const { receive } = await run(update({ photo: [{ file_id: 'p', width: 10, height: 10 }] }));
    expect(receive.mock.calls[0][0].text).toMatch(/^The user sent an image without any message\./);
  });

  it('replies (instead of staying silent) to media it cannot read, and does not call the agent', async () => {
    const { calls, receive } = await run(update({ voice: { file_id: 'v', duration: 3 } }));
    expect(receive).not.toHaveBeenCalled();
    expect(calls.find((c) => c.method === 'sendMessage')!.body.text).toMatch(/can't read voice messages yet/);
  });

  it('refuses files over Telegram\'s 20 MB bot limit without downloading', async () => {
    const { calls, receive, downloads } = await run(update({ document: { file_id: 'big', file_name: 'huge.zip', mime_type: 'application/zip', file_size: 30 * 1024 * 1024 } }));
    expect(receive).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
    expect(calls.find((c) => c.method === 'sendMessage')!.body.text).toMatch(/too large.*20 MB/);
  });

  it('apologises when the download fails and does not call the agent', async () => {
    const { calls, receive } = await run(update({ photo: [{ file_id: 'p', width: 1, height: 1 }] }), { downloadStatus: 500 });
    expect(receive).not.toHaveBeenCalled();
    expect(calls.find((c) => c.method === 'sendMessage')!.body.text).toMatch(/couldn't download/);
  });

  it('ignores attachments from users who are not on the allowlist (no download, no reply)', async () => {
    const mock = telegramMock(update({ photo: [{ file_id: 'p', width: 1, height: 1 }] }));
    vi.stubGlobal('fetch', mock.fn);
    const receive = vi.fn();
    channel = new TelegramChannel({ token: 'tok', pollingInterval: 5, downloadDir: dir, allowedUserIds: ['999'] });
    await channel.mount(agentWith(receive));
    await new Promise((r) => setTimeout(r, 120));
    expect(receive).not.toHaveBeenCalled();
    expect(mock.downloads).toHaveLength(0);
    expect(mock.calls.some((c) => c.method === 'sendMessage' || c.method === 'getFile')).toBe(false);
  });
});
