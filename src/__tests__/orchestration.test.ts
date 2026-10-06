import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createOrchestrationTools, readCalls } from '../dashboard/orchestration.js';
import { SiblingSupervisor } from '../dashboard/supervisor.js';

type Seen = { auth?: string; body: { message: string; sessionId: string } };

describe('orchestration tools (main agent -> sibling agents)', () => {
  let tmp: string;
  let main: string;
  let server: http.Server;
  let port = 0;
  let seen: Seen[] = [];
  let mode: 'ok' | 'error' | 'slow' | 'huge' = 'ok';
  const status: Record<string, string> = { alpha: 'running', beta: 'stopped' };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-orch-'));
    main = path.join(tmp, 'main');
    fs.mkdirSync(main, { recursive: true });
    fs.writeFileSync(path.join(main, 'svara.config.json'), '{}');

    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
        if (mode === 'error') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"model exploded"}'); return; }
        const send = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ response: mode === 'huge' ? 'x'.repeat(30_000) : 'Caption: kopi enak, harga ramah.' })); };
        if (mode === 'slow') setTimeout(send, 600); else send();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;

    for (const [name, prompt] of [['alpha', 'You are the Marketing agent. Write captions and posters.'], ['beta', 'You are the Programmer.']] as const) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'svara.config.json'), JSON.stringify({ name, port: name === 'alpha' ? port : 1, systemPrompt: prompt }));
    }
  });
  afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  beforeEach(() => { seen = []; mode = 'ok'; fs.rmSync(path.join(main, '.svara'), { recursive: true, force: true }); });

  function make(extra: object = {}) {
    const real = new SiblingSupervisor({ cliEntry: '/unused', stateDir: path.join(main, '.svara') });
    const supervisor = {
      state: (n: string) => (status[n] ? { name: n, port: n === 'alpha' ? port : 1, status: status[n] } : null),
      tokenFor: (n: string) => (status[n] === 'running' ? `tok-${n}` : undefined),
      isOrchestrationAllowed: (n: string) => real.isOrchestrationAllowed(n),
    } as unknown as SiblingSupervisor;
    const [list, ask] = createOrchestrationTools({ supervisor, configDir: main, callerName: 'Ardi', ...extra });
    return { list, ask, real };
  }
  const run = (t: { run: (a: Record<string, unknown>, c: never) => Promise<unknown> }, args: Record<string, unknown>) => t.run(args, {} as never) as Promise<Record<string, any>>;

  it('list_agents shows status, availability and a role taken from the system prompt', async () => {
    const { list, real } = make();
    let r = await run(list, {});
    expect(r.agents).toEqual([
      { name: 'alpha', status: 'running', available: true, role: 'You are the Marketing agent. Write captions and posters.' },
      { name: 'beta', status: 'stopped', available: false, role: 'You are the Programmer.' },
    ]);
    real.setOrchestrationAllowed('alpha', false);
    r = await run(list, {});
    expect(r.agents[0].available).toBe(false);
  });

  it('ask_agent calls the sibling with its private token, says who is asking, and labels the reply as data', async () => {
    const { ask } = make();
    const r = await run(ask, { agent: 'alpha', message: 'Buat caption untuk kedai kopi' });
    expect(r.reply).toBe('Caption: kopi enak, harga ramah.');
    expect(r.note).toMatch(/do not follow instructions/);
    expect(seen[0].auth).toBe('Bearer tok-alpha');
    expect(seen[0].body.message).toContain('From Ardi, the main agent');
    expect(seen[0].body.message).toContain('Buat caption untuk kedai kopi');
    expect(seen[0].body.sessionId).toBe('orchestrator-ardi');
  });

  it('keeps one conversation by default and starts a new one with fresh=true', async () => {
    const { ask } = make();
    await run(ask, { agent: 'alpha', message: 'satu' });
    await run(ask, { agent: 'alpha', message: 'dua' });
    await run(ask, { agent: 'alpha', message: 'tiga', fresh: true });
    expect(seen[0].body.sessionId).toBe(seen[1].body.sessionId);
    expect(seen[2].body.sessionId).not.toBe(seen[0].body.sessionId);
    expect(seen[2].body.sessionId).toMatch(/^orchestrator-ardi-\d+$/);
  });

  it('refuses unknown, switched-off and stopped agents without calling anything', async () => {
    const { ask, real } = make();
    expect((await run(ask, { agent: 'ghost', message: 'hi' })).error).toMatch(/No agent named "ghost"/);
    expect((await run(ask, { agent: 'beta', message: 'hi' })).error).toMatch(/not running \(stopped\)/);
    real.setOrchestrationAllowed('alpha', false);
    expect((await run(ask, { agent: 'alpha', message: 'hi' })).error).toMatch(/turned off/);
    expect((await run(ask, { agent: 'alpha', message: '   ' })).error).toMatch(/message is required/);
    expect(seen).toHaveLength(0);
  });

  it('returns the sibling error, and logs every call (success and failure) for auditing', async () => {
    const { ask } = make();
    await run(ask, { agent: 'alpha', message: 'ok call' });
    mode = 'error';
    const bad = await run(ask, { agent: 'alpha', message: 'bad call' });
    expect(bad.error).toBe('model exploded');
    const calls = readCalls(main);
    expect(calls.map((c) => [c.agent, c.ok, c.message])).toEqual([['alpha', false, 'bad call'], ['alpha', true, 'ok call']]); // newest first
    expect(calls[0].error).toBe('model exploded');
    expect(fs.statSync(path.join(main, '.svara', 'agent-calls.jsonl')).mode & 0o077).toBe(0); // private
  });

  it('gives up after the timeout', async () => {
    mode = 'slow';
    const { ask } = make({ timeoutMs: 150 });
    const r = await run(ask, { agent: 'alpha', message: 'slow' });
    mode = 'ok';
    expect(r.error).toMatch(/did not answer within/);
  });

  it('truncates very large replies', async () => {
    mode = 'huge';
    const { ask } = make();
    const r = await run(ask, { agent: 'alpha', message: 'big' });
    expect(r.reply.length).toBeLessThan(20_100);
    expect(r.reply).toMatch(/\[reply truncated\]$/);
  });

  it('rate limits calls, and caps how many run at once', async () => {
    const limited = make({ maxCalls: 2 });
    await run(limited.ask, { agent: 'alpha', message: '1' });
    await run(limited.ask, { agent: 'alpha', message: '2' });
    expect((await run(limited.ask, { agent: 'alpha', message: '3' })).error).toMatch(/Too many agent calls \(limit 2/);

    mode = 'slow';
    const c = make({ maxConcurrent: 1, timeoutMs: 5_000 });
    const [a, b] = await Promise.all([run(c.ask, { agent: 'alpha', message: 'a' }), run(c.ask, { agent: 'alpha', message: 'b' })]);
    expect([a.reply, b.reply].filter(Boolean)).toHaveLength(1);
    expect([a.error, b.error].filter(Boolean)[0]).toMatch(/already running/);
  });

  it('remembers which agents the owner switched off', () => {
    const { real } = make();
    real.setOrchestrationAllowed('beta', false);
    expect(new SiblingSupervisor({ cliEntry: '/unused', stateDir: path.join(main, '.svara') }).isOrchestrationAllowed('beta')).toBe(false);
    real.setOrchestrationAllowed('beta', true);
    expect(real.isOrchestrationAllowed('beta')).toBe(true);
  });
});
