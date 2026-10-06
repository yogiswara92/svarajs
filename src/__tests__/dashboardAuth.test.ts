import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { mountDashboard } from '../dashboard/serve.js';
import {
  hashPassword, verifyPassword, authenticate, createSessionToken, readSessionToken,
  LoginLimiter, parseCookies, isSameOrigin, validatePasswordStrength,
} from '../dashboard/auth.js';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', () => {
    const h = hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery', h)).toBe(true);
    expect(verifyPassword('wrong password!!', h)).toBe(false);
  });

  it('salts: the same password hashes differently each time', () => {
    expect(hashPassword('same-password-1')).not.toBe(hashPassword('same-password-1'));
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    expect(verifyPassword('x', 'plaintext')).toBe(false);
    expect(verifyPassword('x', 'scrypt$1$2$3$a$b')).toBe(false);
  });

  it('enforces a minimum length', () => {
    expect(validatePasswordStrength('short')).toMatch(/at least 10/);
    expect(validatePasswordStrength('long enough password')).toBeNull();
  });
});

describe('authenticate', () => {
  const users = [{ email: 'Owner@Example.com', passwordHash: hashPassword('owner-password-1') }];
  it('matches email case-insensitively', () => {
    expect(authenticate(users, '  owner@example.COM ', 'owner-password-1')?.email).toBe('Owner@Example.com');
  });
  it('fails for a wrong password or an unknown email', () => {
    expect(authenticate(users, 'owner@example.com', 'nope-nope-nope')).toBeNull();
    expect(authenticate(users, 'nobody@example.com', 'owner-password-1')).toBeNull();
  });
});

describe('session tokens', () => {
  const key = Buffer.alloc(32, 7);
  const user = { email: 'a@b.co', passwordHash: hashPassword('a-long-password') };

  it('round-trips and carries the user fingerprint', () => {
    const t = createSessionToken(key, user);
    expect(readSessionToken(key, t)?.email).toBe('a@b.co');
  });
  it('rejects tampering, a wrong key, and expiry', () => {
    const t = createSessionToken(key, user, 1000);
    expect(readSessionToken(key, t, 1000 + 8 * 24 * 3600 * 1000)).toBeNull();
    expect(readSessionToken(Buffer.alloc(32, 9), t, 1000)).toBeNull();
    const [p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ e: 'admin@x.co', f: 'x', exp: 9e15 })).toString('base64url');
    expect(readSessionToken(key, `${forged}.${s}`, 1000)).toBeNull();
    expect(readSessionToken(key, `${p}.`, 1000)).toBeNull();
    expect(readSessionToken(key, undefined)).toBeNull();
  });
});

describe('LoginLimiter', () => {
  it('locks after 5 failures for the same ip+email, and a success clears it', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.fail('1.1.1.1', 'a@b.co', 0);
    expect(l.retryAfter('1.1.1.1', 'a@b.co', 1000)).toBeGreaterThan(0);
    expect(l.retryAfter('2.2.2.2', 'a@b.co', 1000)).toBe(0);
    l.success('1.1.1.1', 'a@b.co');
    expect(l.retryAfter('1.1.1.1', 'a@b.co', 1000)).toBe(0);
  });
  it('unlocks after the window passes', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.fail('1.1.1.1', 'a@b.co', 0);
    expect(l.retryAfter('1.1.1.1', 'a@b.co', 16 * 60 * 1000)).toBe(0);
  });
});

describe('helpers', () => {
  it('parses cookies', () => {
    expect(parseCookies('a=1; svara_session=abc%3D; b=2')).toEqual({ a: '1', svara_session: 'abc=', b: '2' });
  });
  it('same-origin check compares Origin to Host', () => {
    const req = (headers: Record<string, string>) => ({ headers } as never);
    expect(isSameOrigin(req({ host: 'ardi.yesvara.com', origin: 'https://ardi.yesvara.com' }))).toBe(true);
    expect(isSameOrigin(req({ host: 'ardi.yesvara.com', origin: 'https://evil.com' }))).toBe(false);
    expect(isSameOrigin(req({ host: 'ardi.yesvara.com' }))).toBe(true);
  });
});

describe('dashboard HTTP auth (integration)', () => {
  let server: Server;
  let base = '';
  let dir = '';
  const EMAIL = 'owner@example.com';
  const PASSWORD = 'a-good-long-password';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-auth-'));
    const configPath = path.join(dir, 'svara.config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'Test', model: 'gpt-4o', port: 3999,
      dashboard: { users: [{ email: EMAIL, passwordHash: hashPassword(PASSWORD) }] },
    }));
    const app = express();
    const agent = { name: 'Test', getChannelNames: () => [] } as never;
    mountDashboard({ getExpressApp: () => app } as never, { agent, configPath });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const login = (email: string, password: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ email, password }),
    });
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

  it('reports password mode publicly', async () => {
    expect(await (await fetch(`${base}/api/auth/config`)).json()).toEqual({ mode: 'password', canSetup: false, setupMethod: null, setupMinutesLeft: null, setupViaLog: false });
  });

  it('rejects API calls without a session, telling the UI to show the login page', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(401);
    expect((await res.json()).auth).toBe('password');
  });

  it('rejects a wrong password with a generic error', async () => {
    const res = await login(EMAIL, 'definitely-wrong-pw', { 'x-real-ip': '9.9.9.1' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Incorrect email or password.');
    const unknown = await login('nobody@example.com', PASSWORD, { 'x-real-ip': '9.9.9.2' });
    expect((await unknown.json()).error).toBe('Incorrect email or password.');
  });

  it('logs in, sets an HttpOnly SameSite cookie, and the cookie opens /api', async () => {
    const res = await login(EMAIL, PASSWORD, { 'x-real-ip': '9.9.9.3', 'x-forwarded-proto': 'https' });
    expect(res.status).toBe(200);
    const raw = res.headers.get('set-cookie') ?? '';
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Secure/);
    const cookie = cookieOf(res);
    expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);
    expect(await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()).toEqual({ authenticated: true, email: EMAIL });
  });

  it('never exposes password hashes through GET /api/config', async () => {
    const cookie = cookieOf(await login(EMAIL, PASSWORD, { 'x-real-ip': '9.9.9.4' }));
    const body = await (await fetch(`${base}/api/config`, { headers: { cookie } })).text();
    expect(body).not.toContain('scrypt$');
    expect(JSON.parse(body).dashboard.users).toEqual([{ email: EMAIL }]);
  });

  it('blocks a cross-origin state-changing request even with a valid cookie', async () => {
    const cookie = cookieOf(await login(EMAIL, PASSWORD, { 'x-real-ip': '9.9.9.5' }));
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { cookie, origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('rate limits repeated failures', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await login(EMAIL, 'wrong-wrong-wrong', { 'x-real-ip': '9.9.9.6' })).status;
    expect(last).toBe(429);
    // other clients are not locked out
    expect((await login(EMAIL, PASSWORD, { 'x-real-ip': '9.9.9.7' })).status).toBe(200);
  });

  it('changing the password signs out old sessions and keeps the new one', async () => {
    const oldCookie = cookieOf(await login(EMAIL, PASSWORD, { 'x-real-ip': '9.9.9.8' }));
    const change = await fetch(`${base}/api/auth/password`, {
      method: 'POST', headers: { cookie: oldCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'brand-new-password-2' }),
    });
    expect(change.status).toBe(200);
    const newCookie = cookieOf(change);
    await new Promise((r) => setTimeout(r, 3100)); // users cache TTL
    expect((await fetch(`${base}/api/status`, { headers: { cookie: oldCookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: newCookie } })).status).toBe(200);
    expect((await login(EMAIL, 'brand-new-password-2', { 'x-real-ip': '9.9.9.9' })).status).toBe(200);
    expect((await login(EMAIL, PASSWORD, { 'x-real-ip': '9.9.9.10' })).status).toBe(401);
  }, 15000);
});

describe('first-run setup from the browser (integration)', () => {
  let server: Server;
  let base = '';
  let dir = '';
  let configPath = '';
  const sent: Array<{ to: string; text: string }> = [];
  let logged: string[] = [];
  const realLog = console.log;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-setup-'));
    configPath = path.join(dir, 'svara.config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'Ardi', model: 'gpt-4o', port: 3999, dashboard: { token: 'legacy-token' },
      channels: { telegram: { token: 'x', allowedUserIds: ['62516678'] } },
    }));
    const app = express();
    const agent = {
      name: 'Ardi',
      getChannelNames: () => ['telegram'],
      getChannel: (n: string) => (n === 'telegram' ? { send: async (to: string, text: string) => { sent.push({ to, text }); } } : undefined),
    } as never;
    mountDashboard({ getExpressApp: () => app } as never, { agent, configPath, token: 'legacy-token' });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
  });

  afterAll(() => { console.log = realLog; server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const post = (p: string, body: unknown, headers: Record<string, string> = {}, cookie?: string) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify(body),
    });
  const codeFromTelegram = () => (sent[sent.length - 1].text.match(/\d{4}-\d{4}/) ?? [''])[0];

  it('offers setup (token mode, no accounts yet)', async () => {
    expect(await (await fetch(`${base}/api/auth/config`)).json()).toEqual({ mode: 'token', canSetup: true, setupMethod: 'code', setupMinutesLeft: 0, setupViaLog: false });
  });

  it('sends the code to the allowed Telegram user and the server log, never in the response', async () => {
    const res = await post('/api/auth/setup/request', {}, { 'x-real-ip': '8.8.1.1' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.delivered).toEqual(['telegram', 'server log']);
    expect(JSON.stringify(body)).not.toMatch(/\d{4}-\d{4}/);
    expect(sent[0].to).toBe('62516678');
    expect(codeFromTelegram()).toMatch(/^\d{4}-\d{4}$/);
    expect(logged.some((l) => l.includes(codeFromTelegram()))).toBe(true);
  });

  it('rejects a wrong code, a weak password and a bad email', async () => {
    expect((await post('/api/auth/setup/complete', { code: '0000-0000', email: 'o@x.co', password: 'a-long-password' })).status).toBe(400);
    expect((await post('/api/auth/setup/complete', { code: codeFromTelegram(), email: 'o@x.co', password: 'short' })).status).toBe(400);
    expect((await post('/api/auth/setup/complete', { code: codeFromTelegram(), email: 'not-an-email', password: 'a-long-password' })).status).toBe(400);
  });

  it('burns the code after too many wrong guesses', async () => {
    await post('/api/auth/setup/request', {}, { 'x-real-ip': '8.8.1.2' });
    const good = codeFromTelegram();
    for (let i = 0; i < 5; i++) await post('/api/auth/setup/complete', { code: '1111-1111', email: 'o@x.co', password: 'a-long-password' });
    const res = await post('/api/auth/setup/complete', { code: good, email: 'o@x.co', password: 'a-long-password' });
    expect(res.status).toBe(400);
  });

  it('creates the first account with a valid code, logs in, and closes setup', async () => {
    await post('/api/auth/setup/request', {}, { 'x-real-ip': '8.8.1.3' });
    const res = await post('/api/auth/setup/complete', { code: codeFromTelegram().replace('-', ''), email: 'Owner@X.co', password: 'a-long-password' });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);
    expect(await (await fetch(`${base}/api/auth/config`)).json()).toEqual({ mode: 'password', canSetup: false, setupMethod: null, setupMinutesLeft: null, setupViaLog: false });

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(saved.dashboard.token).toBeTruthy(); // legacy token kept
    expect(saved.dashboard.users[0].email).toBe('owner@x.co');
    expect(saved.dashboard.users[0].passwordHash.startsWith('scrypt$')).toBe(true);

    // setup can never be re-used to take over an existing install
    expect((await post('/api/auth/setup/request', {}, { 'x-real-ip': '8.8.1.4' })).status).toBe(409);
    expect((await post('/api/auth/setup/complete', { code: '0000-0000', email: 'evil@x.co', password: 'a-long-password' })).status).toBe(409);
  });

  it('lets a signed-in user add and remove people, but not themselves', async () => {
    const login = await post('/api/auth/login', { email: 'owner@x.co', password: 'a-long-password' }, { 'x-real-ip': '8.8.2.1' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await post('/api/auth/users', { email: 'b@x.co', password: 'b-long-password' })).status).toBe(401);
    expect((await post('/api/auth/users', { email: 'b@x.co', password: 'b-long-password' }, {}, cookie)).status).toBe(200);
    expect((await post('/api/auth/users', { email: 'B@x.co', password: 'b-long-password' }, {}, cookie)).status).toBe(409);
    const list = await (await fetch(`${base}/api/auth/users`, { headers: { cookie } })).json();
    expect(list.users).toEqual([{ email: 'owner@x.co' }, { email: 'b@x.co' }]);
    const del = (e: string) => fetch(`${base}/api/auth/users/${encodeURIComponent(e)}`, { method: 'DELETE', headers: { cookie } });
    expect((await del('owner@x.co')).status).toBe(400);
    expect((await del('b@x.co')).status).toBe(200);
    expect((await del('b@x.co')).status).toBe(404);
  });
});

describe('first-run setup without any owner channel (direct register)', () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterAll(() => { servers.forEach((s) => s.close()); dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })); });

  async function boot(setupWindowMs?: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-direct-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'svara.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'Fresh', model: 'gpt-4o', port: 3999, dashboard: true }));
    const app = express();
    const agent = { name: 'Fresh', getChannelNames: () => [], getChannel: () => undefined } as never;
    const realLog = console.log;
    console.log = () => {};
    mountDashboard({ getExpressApp: () => app } as never, { agent, configPath, setupWindowMs });
    console.log = realLog;
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    servers.push(server);
    return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, configPath };
  }
  const post = (base: string, p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('offers direct registration inside the window, with no code', async () => {
    const { base } = await boot();
    const cfg = await (await fetch(`${base}/api/auth/config`)).json();
    expect(cfg).toMatchObject({ mode: 'none', canSetup: true, setupMethod: 'direct' });
    expect(cfg.setupMinutesLeft).toBeGreaterThan(55);
    expect((await post(base, '/api/auth/setup/request', {})).status).toBe(400); // no code needed
  });

  it('registers directly, logs in, then closes setup for good', async () => {
    const { base, configPath } = await boot();
    const bad = await post(base, '/api/auth/setup/complete', { email: 'nope', password: 'a-long-password' });
    expect(bad.status).toBe(400);
    const ok = await post(base, '/api/auth/setup/complete', { email: 'Me@Site.io', password: 'a-long-password' });
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).dashboard.users[0].email).toBe('me@site.io');
    expect((await post(base, '/api/auth/setup/complete', { email: 'evil@x.co', password: 'a-long-password' })).status).toBe(409);
  });

  it('lets only one of two simultaneous registrations win', async () => {
    const { base } = await boot();
    const [a, b] = await Promise.all([
      post(base, '/api/auth/setup/complete', { email: 'a@x.co', password: 'a-long-password' }),
      post(base, '/api/auth/setup/complete', { email: 'b@x.co', password: 'b-long-password' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('after the window, switches to a code read from the server log instead of locking out', async () => {
    const logs: string[] = [];
    const realLog = console.log;
    const { base } = await boot(0);
    expect(await (await fetch(`${base}/api/auth/config`)).json())
      .toMatchObject({ canSetup: true, setupMethod: 'code', setupViaLog: true });

    // registering without the code is refused
    expect((await post(base, '/api/auth/setup/complete', { email: 'late@x.co', password: 'a-long-password' })).status).toBe(400);

    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    const req = await post(base, '/api/auth/setup/request', {});
    console.log = realLog;
    expect((await req.json()).delivered).toEqual(['server log']);
    const code = (logs.join('\n').match(/\d{4}-\d{4}/) ?? [''])[0];
    expect(code).toMatch(/^\d{4}-\d{4}$/);

    const done = await post(base, '/api/auth/setup/complete', { code, email: 'late@x.co', password: 'a-long-password' });
    expect(done.status).toBe(200);
  });
});
