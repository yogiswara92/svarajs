import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { mountDashboard } from '../dashboard/serve.js';
import { splitAttachmentNote } from '../channels/attachments.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

describe('dashboard chat with attachments', () => {
  let server: Server;
  let base = '';
  let dir = '';
  let model = 'gpt-4o';
  const process_ = vi.fn();
  const agent = {
    name: 'Test', get model() { return model; }, getChannelNames: () => [], getChannel: () => undefined,
    on: vi.fn(), off: vi.fn(),
    process: process_,
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-chatup-'));
    fs.writeFileSync(path.join(dir, 'svara.config.json'), JSON.stringify({ name: 'Test', model: 'gpt-4o', port: 3999, dashboard: true }));
    const app = express();
    mountDashboard({ getExpressApp: () => app } as never, { agent: agent as never, configPath: path.join(dir, 'svara.config.json') });
    await new Promise<void>((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { process_.mockReset(); process_.mockResolvedValue({ response: 'ok', sessionId: 's1', toolsUsed: [], iterations: 1, usage: {}, duration: 1 }); model = 'gpt-4o'; });

  function form(fields: Record<string, string>, files: Array<{ name: string; type: string; data: Buffer }> = []): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    for (const file of files) f.append('files', new Blob([file.data], { type: file.type }), file.name);
    return f;
  }

  it('keeps plain JSON chat working (no attachments)', async () => {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'halo', sessionId: 'abc' }) });
    expect(res.status).toBe(200);
    expect(process_).toHaveBeenCalledWith('halo', { sessionId: 'abc', userId: 'dashboard', images: undefined });
  });

  it('saves an uploaded image, tells the agent where it is, and passes it inline', async () => {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', body: form({ message: 'apa ini?', sessionId: 'sess-1' }, [{ name: 'foto kedai.png', type: 'image/png', data: PNG }]) });
    expect(res.status).toBe(200);
    const [message, opts] = process_.mock.calls[0];
    const { text, files } = splitAttachmentNote(message);
    expect(text).toBe('apa ini?');
    expect(files).toHaveLength(1);
    expect(files[0].path.startsWith(path.join(dir, 'uploads', 'web', 'sess-1'))).toBe(true);
    expect(fs.readFileSync(files[0].path).equals(PNG)).toBe(true);
    expect(opts.images).toEqual([{ mimeType: 'image/png', base64: PNG.toString('base64') }]);
  });

  it('accepts a file with no text, keeps non-images out of the inline images, and handles UTF-8 names', async () => {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', body: form({ sessionId: 's2' }, [{ name: 'Laporan Anggaran é.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4') }]) });
    expect(res.status).toBe(200);
    const [message, opts] = process_.mock.calls[0];
    expect(message).toMatch(/^The user sent a file without any message\./);
    expect(splitAttachmentNote(message).files[0].name).toBe('Laporan Anggaran é.pdf');
    expect(opts.images).toBeUndefined();
  });

  it('rejects an empty request, too many files, and oversized files', async () => {
    expect((await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await fetch(`${base}/api/chat`, { method: 'POST', body: form({ message: 'x' }, Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', data: Buffer.from('a') }))) })).status).toBe(400);
    const big = await fetch(`${base}/api/chat`, { method: 'POST', body: form({ message: 'x' }, [{ name: 'big.bin', type: 'application/octet-stream', data: Buffer.alloc(21 * 1024 * 1024) }]) });
    expect(big.status).toBe(400);
    expect((await big.json()).error).toMatch(/larger than 20 MB/);
    expect(process_).not.toHaveBeenCalled();
  });

  it('rejects attachments that together exceed the per-message total', async () => {
    const chunk = Buffer.alloc(13 * 1024 * 1024);
    const res = await fetch(`${base}/api/chat`, { method: 'POST', body: form({ message: 'x' }, [{ name: 'a.bin', type: 'application/octet-stream', data: chunk }, { name: 'b.bin', type: 'application/octet-stream', data: chunk }]) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/add up to more than 24 MB/);
    expect(process_).not.toHaveBeenCalled();
  });

  it('streams too: the stream endpoint takes the same multipart input', async () => {
    const res = await fetch(`${base}/api/chat/stream`, { method: 'POST', body: form({ message: 'lihat', sessionId: 's3' }, [{ name: 'a.png', type: 'image/png', data: PNG }]) });
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ type: 'done', response: 'ok' });
    expect(process_.mock.calls[0][1].images).toHaveLength(1);
    expect((await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
  });

  it('reports whether the model can read images (so the page can warn)', async () => {
    expect(await (await fetch(`${base}/api/chat/capabilities`)).json()).toEqual({ vision: true, maxFiles: 5, maxFileMB: 20, maxTotalMB: 24 });
    model = 'deepseek-v4-pro';
    expect((await (await fetch(`${base}/api/chat/capabilities`)).json()).vision).toBe(false);
    fs.writeFileSync(path.join(dir, 'svara.config.json'), JSON.stringify({ name: 'Test', model, port: 3999, dashboard: true, llm: { vision: true } }));
    expect((await (await fetch(`${base}/api/chat/capabilities`)).json()).vision).toBe(true);
  });
});
