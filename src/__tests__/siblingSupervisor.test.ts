import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { SiblingSupervisor, isPortFree } from '../dashboard/supervisor.js';
import { mountDashboard } from '../dashboard/serve.js';
import { hashPassword } from '../dashboard/auth.js';

// A tiny stand-in for `svara start`: serves /health and a few routes, checks the embedded token like the real child.
const FAKE_AGENT = `
const http = require('http');
const args = process.argv;
const port = Number(args[args.indexOf('--port') + 1]);
const token = process.env.SVARA_EMBEDDED_TOKEN;
if (process.env.FAKE_CRASH) process.exit(1);
http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url === '/dashboard') { res.writeHead(301, { Location: '/dashboard/' }); res.end(); return; }
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Unauthorized"}'); return; }
  if (req.url === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"n":1}\\n'); setTimeout(() => { res.write('{"n":2}\\n'); res.end(); }, 50); return;
  }
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, method: req.method, body, cookie: req.headers.cookie || null, host: req.headers.host, host_env: process.env.SVARA_HOST }));
  });
}).listen(port, process.env.SVARA_HOST || '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

let tmp: string;
let cli: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-sup-'));
  cli = path.join(tmp, 'fake-cli.js');
  fs.writeFileSync(cli, FAKE_AGENT);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  for (let p = 41000 + Math.floor(Math.random() * 2000); ; p++) if (await isPortFree(p)) return p;
}
function agentDir(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'svara.config.json'), '{}');
  return d;
}

describe('SiblingSupervisor', () => {
  const sups: SiblingSupervisor[] = [];
  afterEach(async () => { await Promise.all(sups.splice(0).map((s) => s.stopAll())); });
  const make = (extra: object = {}) => { const s = new SiblingSupervisor({ cliEntry: cli, stateDir: path.join(tmp, '.state-' + Math.random()), ...extra }); sups.push(s); return s; };

  it('starts a child, reports running, binds loopback with a private token, and stops it', async () => {
    const sup = make();
    const port = await freePort();
    const st = await sup.start('alpha', agentDir('alpha'), port, { readyTimeoutMs: 10_000 });
    expect(st.status).toBe('running');
    expect(st.pid).toBeGreaterThan(0);
    expect(sup.tokenFor('alpha')).toMatch(/^[0-9a-f]{48}$/);

    const noToken = await fetch(`http://127.0.0.1:${port}/api/x`);
    expect(noToken.status).toBe(401);
    const ok = await (await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { Authorization: `Bearer ${sup.tokenFor('alpha')}` } })).json();
    expect(ok.host_env).toBe('127.0.0.1');

    await sup.stop('alpha');
    expect(sup.state('alpha')?.status).toBe('stopped');
    expect(await isPortFree(port)).toBe(true);
  }, 20_000);

  it('refuses to start the same agent twice', async () => {
    const sup = make();
    const port = await freePort();
    await sup.start('beta', agentDir('beta'), port, { readyTimeoutMs: 10_000 });
    await expect(sup.start('beta', agentDir('beta'), port)).rejects.toThrow(/already running/);
  }, 20_000);

  it('gives up after repeated rapid crashes instead of looping forever', async () => {
    process.env.FAKE_CRASH = '1';
    try {
      const sup = make({ maxCrashes: 2, crashWindowMs: 60_000 });
      await sup.start('crashy', agentDir('crashy'), await freePort(), { readyTimeoutMs: 8_000 });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && sup.state('crashy')?.status !== 'crashed') await new Promise((r) => setTimeout(r, 200));
      expect(sup.state('crashy')?.status).toBe('crashed');
      expect(sup.state('crashy')?.lastExit).toMatch(/exited with code 1/);
      expect(fs.readFileSync(path.join(tmp, 'crashy', '.svara', 'agent.log'), 'utf-8')).toContain('starting on 127.0.0.1');
    } finally {
      delete process.env.FAKE_CRASH;
    }
  }, 30_000);

  it('remembers what should be running across a runtime restart', async () => {
    const stateDir = path.join(tmp, '.state-persist');
    const a = new SiblingSupervisor({ cliEntry: cli, stateDir });
    sups.push(a);
    await a.start('keep', agentDir('keep'), await freePort(), { readyTimeoutMs: 10_000 });
    await a.start('drop', agentDir('drop'), await freePort(), { readyTimeoutMs: 10_000 });
    await a.stop('drop'); // explicit stop: should NOT come back
    await a.stopAll();    // runtime shutting down: 'keep' should come back
    expect(new SiblingSupervisor({ cliEntry: cli, stateDir }).readDesired()).toEqual(['keep']);
  }, 30_000);
});

describe('dashboard proxy to managed siblings', () => {
  let server: Server;
  let base = '';
  let sup: SiblingSupervisor;
  let cookie = '';
  const EMAIL = 'o@x.co';
  const PASSWORD = 'a-good-long-password';

  beforeAll(async () => {
    const dir = path.join(tmp, 'main');
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'svara.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'Main', model: 'gpt-4o', port: 3999, dashboard: { users: [{ email: EMAIL, passwordHash: hashPassword(PASSWORD) }] } }));
    // a managed sibling folder next to "main"
    const sibDir = path.join(tmp, 'sib');
    fs.mkdirSync(path.join(sibDir, '.svara'), { recursive: true });
    const sibPort = await freePort();
    fs.writeFileSync(path.join(sibDir, 'svara.config.json'), JSON.stringify({ name: 'sib', port: sibPort }));
    fs.writeFileSync(path.join(sibDir, '.svara', 'managed'), 'x');

    sup = new SiblingSupervisor({ cliEntry: cli, stateDir: path.join(dir, '.svara') });
    await sup.start('sib', sibDir, sibPort, { readyTimeoutMs: 10_000 });

    const app = express();
    mountDashboard({ getExpressApp: () => app } as never, {
      agent: { name: 'Main', getChannelNames: () => [], getChannel: () => undefined } as never,
      configPath, supervisor: sup,
    });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': '7.7.7.7' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  }, 30_000);

  afterAll(async () => { server?.close(); await sup?.stopAll(); });

  it('rejects the proxy without a login (and never reaches the child)', async () => {
    const res = await fetch(`${base}/a/sib/api/status`);
    expect(res.status).toBe(401);
  });

  it('forwards authenticated requests, rewriting the path, injecting the token and dropping the session cookie', async () => {
    const res = await fetch(`${base}/a/sib/api/status?x=1`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('/api/status?x=1');
    expect(body.cookie).toBeNull();
    expect(body.host).toMatch(/^127\.0\.0\.1:/);
  });

  it('forwards request bodies and streams responses', async () => {
    const post = await (await fetch(`${base}/a/sib/api/chat`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"message":"hi"}' })).json();
    expect(post).toMatchObject({ method: 'POST', body: '{"message":"hi"}' });
    const stream = await (await fetch(`${base}/a/sib/api/stream`, { headers: { cookie } })).text();
    expect(stream.trim().split('\n')).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('keeps redirects under /a/<name>', async () => {
    const res = await fetch(`${base}/a/sib/dashboard`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/a/sib/dashboard/');
  });

  it('blocks cross-site writes even with a valid cookie', async () => {
    const res = await fetch(`${base}/a/sib/api/chat`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('answers 502 for an agent that is not running', async () => {
    const res = await fetch(`${base}/a/ghost/api/status`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });

  it('lists agents with their status and an Open url, and exposes the log', async () => {
    const list = await (await fetch(`${base}/api/agents`, { headers: { cookie } })).json();
    const sib = list.agents.find((a: { name: string }) => a.name === 'sib');
    expect(sib).toMatchObject({ status: 'running', managed: true, url: '/a/sib/dashboard/', orchestration: true });
    const log = await (await fetch(`${base}/api/agents/sib/logs`, { headers: { cookie } })).json();
    expect(log.log).toContain('starting on 127.0.0.1');
  });

  it('lets the owner switch main-agent calls to an agent off and on, and lists recent calls', async () => {
    const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const get = async () => (await (await fetch(`${base}/api/agents`, { headers: { cookie } })).json()).agents.find((a: { name: string }) => a.name === 'sib');
    expect((await post('/api/agents/sib/orchestration', { allowed: 'yes' })).status).toBe(400);
    expect((await post('/api/agents/sib/orchestration', { allowed: false })).status).toBe(200);
    expect((await get()).orchestration).toBe(false);
    expect((await post('/api/agents/sib/orchestration', { allowed: true })).status).toBe(200);
    expect((await get()).orchestration).toBe(true);
    expect((await post('/api/agents/ghost/orchestration', { allowed: true })).status).toBe(404);
    expect((await (await fetch(`${base}/api/agents/calls`, { headers: { cookie } })).json())).toEqual({ calls: [] });
    expect((await fetch(`${base}/api/agents/calls`)).status).toBe(401);
  });

  it('stop and start work from the API, and deletion needs the typed name', async () => {
    const post = (p: string, body?: unknown, method = 'POST') => fetch(`${base}${p}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    expect((await post('/api/agents/sib/stop')).status).toBe(200);
    expect((await (await fetch(`${base}/api/agents`, { headers: { cookie } })).json()).agents.find((a: { name: string }) => a.name === 'sib').status).toBe('stopped');
    expect((await fetch(`${base}/a/sib/api/status`, { headers: { cookie } })).status).toBe(502);
    expect((await post('/api/agents/sib/start')).status).toBe(200);
    expect((await post('/api/agents/sib', { confirm: 'wrong' }, 'DELETE')).status).toBe(400);
    expect(fs.existsSync(path.join(tmp, 'sib'))).toBe(true);
    expect((await post('/api/agents/sib', { confirm: 'sib' }, 'DELETE')).status).toBe(200);
    expect(fs.existsSync(path.join(tmp, 'sib'))).toBe(false);
  }, 30_000);
});

describe('a managed sibling (embedded) only trusts the parent token', () => {
  it('accepts only the embedded bearer token and cannot manage agents', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-emb-'));
    fs.writeFileSync(path.join(dir, 'svara.config.json'), JSON.stringify({ name: 'Child', model: 'gpt-4o', port: 3999 }));
    const app = express();
    mountDashboard({ getExpressApp: () => app } as never, {
      agent: { name: 'Child', getChannelNames: () => [], getChannel: () => undefined } as never,
      configPath: path.join(dir, 'svara.config.json'), embeddedToken: 'sekret-embedded-token',
    });
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const b = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect((await fetch(`${b}/api/status`)).status).toBe(401);
      const ok = await fetch(`${b}/api/status`, { headers: { Authorization: 'Bearer sekret-embedded-token' } });
      expect(ok.status).toBe(200);
      expect(await (await fetch(`${b}/api/auth/config`)).json()).toMatchObject({ mode: 'none', canSetup: false, embedded: true });
      const agents = await fetch(`${b}/api/agents`, { headers: { Authorization: 'Bearer sekret-embedded-token' } });
      expect(agents.status).toBe(400);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
