import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { addProfile, updateProfile, deleteProfile, setDefault, viewOf, ensureProfiles, slugify } from '../dashboard/llmProfiles.js';
import { applyDefaultLlm, loadRuntimeConfig, saveRuntimeConfig, readRawConfig } from '../runtime/config.js';
import { mountDashboard } from '../dashboard/serve.js';
import { SvaraAgent } from '../core/agent.js';

describe('profiles (pure)', () => {
  const legacy = { name: 'A', model: 'Kimi-K2.6', llm: { provider: 'openai', baseURL: 'https://gw.example/v1', apiKey: 'enc:v1:xxx', vision: true } };

  it('shows a config written before profiles as one Default profile, without changing it', () => {
    const v = viewOf(legacy);
    expect(v.legacy).toBe(true);
    expect(v.defaultId).toBe('default');
    expect(v.profiles).toEqual([{ id: 'default', name: 'Default', model: 'Kimi-K2.6', provider: 'openai', baseURL: 'https://gw.example/v1', hasKey: true, apiKeyEnv: undefined, vision: true, isDefault: true }]);
    expect((legacy as Record<string, unknown>).llmProfiles).toBeUndefined();
  });

  it('migrates the legacy settings into the first profile when something is added', () => {
    const r = addProfile(legacy, { name: 'GPT-4o (OpenAI)', model: 'gpt-4o', provider: 'openai', apiKey: 'sk-new' });
    if ('error' in r) throw new Error(r.error);
    const profiles = (r.raw.llmProfiles as Array<Record<string, unknown>>);
    expect(profiles.map((p) => p.id)).toEqual(['default', 'gpt-4o-openai']);
    expect(profiles[0]).toMatchObject({ model: 'Kimi-K2.6', baseURL: 'https://gw.example/v1', apiKey: 'enc:v1:xxx' });
    expect(r.raw.defaultLlm).toBe('default');                 // adding never changes the default
    expect(viewOf(r.raw).legacy).toBe(false);
  });

  it('validates input and names ids uniquely', () => {
    expect(addProfile({}, { name: '', model: 'x' })).toEqual({ error: 'Give this model a name.' });
    expect(addProfile({}, { name: 'a', model: '' })).toEqual({ error: 'Enter the model name your provider expects.' });
    expect((addProfile({}, { name: 'a', model: 'm', provider: 'cohere' }) as { error: string }).error).toMatch(/Provider must be/);
    expect((addProfile({}, { name: 'a', model: 'm', baseURL: 'ftp://x' }) as { error: string }).error).toMatch(/valid http/);
    expect((addProfile({}, { name: 'a', model: 'm', apiKeyEnv: 'sk-abc-123' }) as { error: string }).error).toMatch(/looks like a key/);
    expect(slugify('GPT 4o!!', new Set(['gpt-4o']))).toBe('gpt-4o-2');
    let raw: Record<string, unknown> = {};
    for (const n of ['Same', 'Same', 'Same']) { const r = addProfile(raw, { name: n, model: 'm' }); if ('error' in r) throw new Error(r.error); raw = r.raw; }
    expect((raw.llmProfiles as Array<{ id: string }>).map((p) => p.id)).toEqual(['default', 'same', 'same-2', 'same-3']);
  });

  it('keeps the saved key unless a new one is given or it is cleared', () => {
    const base = addProfile({ model: 'm' }, { name: 'X', model: 'm1', apiKey: 'sk-1' }) as { raw: Record<string, unknown>; id: string };
    const kept = updateProfile(base.raw, base.id, { model: 'm2' }) as { raw: Record<string, unknown> };
    expect((kept.raw.llmProfiles as Array<Record<string, unknown>>)[1]).toMatchObject({ model: 'm2', apiKey: 'sk-1' });
    const replaced = updateProfile(kept.raw, base.id, { apiKey: 'sk-2' }) as { raw: Record<string, unknown> };
    expect((replaced.raw.llmProfiles as Array<Record<string, unknown>>)[1].apiKey).toBe('sk-2');
    const cleared = updateProfile(replaced.raw, base.id, { clearKey: true }) as { raw: Record<string, unknown> };
    expect((cleared.raw.llmProfiles as Array<Record<string, unknown>>)[1].apiKey).toBeUndefined();
    expect(updateProfile(base.raw, 'ghost', { model: 'x' })).toEqual({ error: 'No such model.' });
  });

  it('vision: true / false / automatic', () => {
    const base = addProfile({}, { name: 'V', model: 'm', vision: true }) as { raw: Record<string, unknown>; id: string };
    expect(viewOf(base.raw).profiles[1].vision).toBe(true);
    const auto = updateProfile(base.raw, base.id, { vision: 'auto' }) as { raw: Record<string, unknown> };
    expect(viewOf(auto.raw).profiles[1].vision).toBeUndefined();
  });

  it('refuses to delete the default, and can switch the default', () => {
    const a = addProfile({ model: 'm0' }, { name: 'Second', model: 'm2' }) as { raw: Record<string, unknown>; id: string };
    expect(deleteProfile(a.raw, 'default')).toEqual({ error: expect.stringMatching(/default model/) });
    expect(setDefault(a.raw, 'ghost')).toEqual({ error: 'No such model.' });
    const sw = setDefault(a.raw, a.id) as { raw: Record<string, unknown> };
    expect(sw.raw.defaultLlm).toBe(a.id);
    const del = deleteProfile(sw.raw, 'default') as { raw: Record<string, unknown> };
    expect(viewOf(del.raw).profiles.map((p) => p.id)).toEqual([a.id]);
  });

  it('ensureProfiles does nothing when profiles already exist', () => {
    const raw = ensureProfiles(legacy);
    expect(ensureProfiles(raw)).toBe(raw);
  });
});

describe('effective model from the default profile', () => {
  it('lets the default profile override model and llm; unknown or missing ids fall back to the top level', () => {
    const cfg = { model: 'top', llm: { provider: 'openai' as const }, llmProfiles: [{ id: 'a', name: 'A', model: 'from-a', baseURL: 'http://a', vision: false }], defaultLlm: 'a' };
    expect(applyDefaultLlm(cfg)).toMatchObject({ model: 'from-a', llm: { baseURL: 'http://a', vision: false } });
    expect(applyDefaultLlm({ ...cfg, defaultLlm: 'ghost' }).model).toBe('top');
    expect(applyDefaultLlm({ ...cfg, defaultLlm: undefined }).model).toBe('top');
  });

  it('is applied when the config is loaded, with keys encrypted on disk and decrypted in memory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-prof-'));
    const file = path.join(dir, 'svara.config.json');
    try {
      await saveRuntimeConfig(file, { name: 'T', model: 'top', llmProfiles: [{ id: 'a', name: 'A', model: 'm-a', apiKey: 'sk-secret-AAA' }, { id: 'b', name: 'B', model: 'm-b', apiKey: 'sk-secret-BBB' }], defaultLlm: 'b' });
      const onDisk = fs.readFileSync(file, 'utf-8');
      expect(onDisk).not.toContain('sk-secret');
      expect(onDisk).toContain('enc:');
      const loaded = await loadRuntimeConfig(file);
      expect(loaded.model).toBe('m-b');
      expect(loaded.llm?.apiKey).toBe('sk-secret-BBB');
      expect(loaded.llmProfiles?.[0].apiKey).toBe('sk-secret-AAA');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('agent.useModel (hot swap)', () => {
  const servers: http.Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function llm(tag: string): Promise<{ url: string; hits: string[] }> {
    const hits: string[] = [];
    const s = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.push(`${JSON.parse(raw).model}|${req.headers.authorization}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `from ${tag}` } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`, hits };
  }

  it('sends the next message to the new model and connection, without recreating the agent', async () => {
    const a = await llm('A'); const b = await llm('B');
    const agent = new SvaraAgent({ name: `sw-${Math.random().toString(36).slice(2, 7)}`, model: 'model-a', dbPath: ':memory:', llm: { provider: 'openai', baseURL: a.url, apiKey: 'key-a' } });
    expect((await agent.process('one')).response).toBe('from A');
    expect(agent.model).toBe('model-a');

    agent.useModel('model-b', { provider: 'openai', baseURL: b.url, apiKey: 'key-b' });
    expect(agent.model).toBe('model-b');
    expect((await agent.process('two')).response).toBe('from B');
    expect(a.hits).toEqual(['model-a|Bearer key-a']);
    expect(b.hits).toEqual(['model-b|Bearer key-b']);
  });
});

describe('dashboard endpoints for saved models', () => {
  let server: Server;
  let base = '';
  let dir = '';
  let file = '';
  const useModel = vi.fn();
  const agent = { name: 'T', get model() { return 'active-model'; }, getChannelNames: () => [], getChannel: () => undefined, on: vi.fn(), off: vi.fn(), useModel };
  let llmServer: http.Server;
  let llmHits: Array<{ model: string; auth?: string }> = [];
  let llmBase = '';

  beforeAll(async () => {
    llmServer = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        llmHits.push({ model: body.model, auth: req.headers.authorization });
        if (req.headers.authorization === 'Bearer bad-key') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Incorrect API key provided: bad-key"}}'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>((r) => llmServer.listen(0, '127.0.0.1', r));
    llmBase = `http://127.0.0.1:${(llmServer.address() as { port: number }).port}/v1`;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-llmapi-'));
    file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, { name: 'T', model: 'legacy-model', port: 3999, dashboard: true, llm: { provider: 'openai', baseURL: llmBase, apiKey: 'sk-legacy' } });
    const app = express();
    mountDashboard({ getExpressApp: () => app } as never, { agent: agent as never, configPath: file });
    await new Promise<void>((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); llmServer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { useModel.mockReset(); llmHits = []; });

  const send = (method: string, p: string, body?: unknown) => fetch(`${base}/api${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  it('lists the legacy settings as the Default profile, never returning a key', async () => {
    const r = await (await send('GET', '/llm')).json();
    expect(r).toMatchObject({ legacy: true, defaultId: 'default', activeModel: 'active-model', canSwitch: true });
    expect(r.profiles[0]).toMatchObject({ id: 'default', model: 'legacy-model', hasKey: true, isDefault: true });
    expect(JSON.stringify(r)).not.toContain('sk-legacy');
  });

  it('adds models (key encrypted on disk), keeps the default, and does not touch the running agent', async () => {
    const r = await (await send('POST', '/llm/profiles', { name: 'Kimi', model: 'Kimi-K2.6', provider: 'openai', baseURL: llmBase, apiKey: 'sk-kimi', vision: true })).json();
    expect(r.id).toBe('kimi');
    expect(r.defaultId).toBe('default');
    expect(r.profiles.map((p: { id: string }) => p.id)).toEqual(['default', 'kimi']);
    expect(JSON.stringify(r)).not.toContain('sk-kimi');
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('sk-kimi');
    expect(useModel).not.toHaveBeenCalled();
    // the key that lived in the old top-level settings moved into the Default profile and still decrypts
    const stillDefault = await loadRuntimeConfig(file);
    expect(stillDefault.model).toBe('legacy-model');
    expect(stillDefault.llm?.apiKey).toBe('sk-legacy');
    expect((await send('POST', '/llm/profiles', { name: '', model: 'x' })).status).toBe(400);
  });

  it('switching the default applies it to the running agent immediately, with the decrypted key', async () => {
    const r = await (await send('POST', '/llm/default', { id: 'kimi' })).json();
    expect(r).toMatchObject({ defaultId: 'kimi', applied: true });
    expect(useModel).toHaveBeenCalledWith('Kimi-K2.6', { provider: 'openai', baseURL: llmBase, apiKey: 'sk-kimi', vision: true });
    expect((await loadRuntimeConfig(file)).model).toBe('Kimi-K2.6');
    expect((await send('POST', '/llm/default', { id: 'ghost' })).status).toBe(400);
  });

  it('re-applies when the ACTIVE model is edited, but not when another one is', async () => {
    await send('POST', '/llm/profiles', { name: 'Other', model: 'other-model' });
    await send('PUT', '/llm/profiles/other', { model: 'other-2' });
    expect(useModel).not.toHaveBeenCalled();
    const r = await (await send('PUT', '/llm/profiles/kimi', { model: 'Kimi-K2.7' })).json();
    expect(r.applied).toBe(true);
    expect(useModel).toHaveBeenCalledWith('Kimi-K2.7', expect.objectContaining({ apiKey: 'sk-kimi' })); // key kept when not resent
  });

  it('refuses to delete the default; deletes others', async () => {
    expect((await send('DELETE', '/llm/profiles/kimi')).status).toBe(400);
    const r = await (await send('DELETE', '/llm/profiles/other')).json();
    expect(r.profiles.map((p: { id: string }) => p.id)).toEqual(['default', 'kimi']);
  });

  it('tests a saved model through its own connection, and reports wrong keys without leaking them', async () => {
    const ok = await (await send('POST', '/llm/profiles/kimi/test')).json();
    expect(ok).toMatchObject({ ok: true, reply: 'OK' });
    expect(llmHits[0]).toEqual({ model: 'Kimi-K2.7', auth: 'Bearer sk-kimi' });

    await send('POST', '/llm/profiles', { name: 'Broken', model: 'm', provider: 'openai', baseURL: llmBase, apiKey: 'bad-key' });
    const bad = await (await send('POST', '/llm/profiles/broken/test')).json();
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('bad-key');
    expect((await send('POST', '/llm/profiles/ghost/test')).status).toBe(404);
  });

  it('chat capabilities follow the default profile (vision override)', async () => {
    expect((await (await send('GET', '/chat/capabilities')).json()).vision).toBe(true); // kimi: vision true
  });
});
