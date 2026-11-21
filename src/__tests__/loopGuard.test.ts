import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'http';
import { SvaraAgent } from '../core/agent.js';
import { pruneToolResults, RepeatGuard } from '../core/loopGuard.js';
import type { LLMMessage } from '../core/types.js';

const tool = (name: string, content: string): LLMMessage => ({ role: 'tool', name, content, toolCallId: name });

describe('pruneToolResults', () => {
  it('keeps recent results whole and cuts old big ones', () => {
    const big = 'x'.repeat(5000);
    const msgs: LLMMessage[] = [tool('file_read', big), ...Array.from({ length: 4 }, (_, i) => tool(`t${i}`, big))];
    pruneToolResults(msgs);
    expect(msgs[0].content.length).toBeLessThan(900);
    expect(msgs[0].content).toContain('dropped to save space');
    expect(msgs.slice(1).every((m) => m.content.length === 5000)).toBe(true);
  });

  it('leaves small results alone', () => {
    const msgs: LLMMessage[] = [tool('a', 'ok'), ...Array.from({ length: 6 }, (_, i) => tool(`t${i}`, 'fine'))];
    pruneToolResults(msgs);
    expect(msgs[0].content).toBe('ok');
  });

  it('keeps only the newest browser page listing whole', () => {
    const page = 'p'.repeat(20000);
    const msgs: LLMMessage[] = [
      tool('mcp__browser__browser_open', page),
      tool('mcp__browser__browser_click', page),
      tool('mcp__browser__browser_snapshot', page),
    ];
    pruneToolResults(msgs);
    expect(msgs[0].content.length).toBeLessThan(700);
    expect(msgs[1].content.length).toBeLessThan(700);
    expect(msgs[2].content.length).toBe(20000);
    // running it again changes nothing
    const again = msgs.map((m) => m.content);
    pruneToolResults(msgs);
    expect(msgs.map((m) => m.content)).toEqual(again);
  });
});

describe('RepeatGuard', () => {
  it('only counts the same call with the same result', () => {
    const g = new RepeatGuard();
    expect(g.record('snapshot', {}, 'page A').verdict).toBe('ok');
    expect(g.record('snapshot', {}, 'page B').verdict).toBe('ok'); // the page changed: not a loop
    expect(g.record('snapshot', {}, 'page B').verdict).toBe('ok');
    expect(g.record('snapshot', {}, 'page B').verdict).toBe('warn');
    expect(g.record('snapshot', {}, 'page B').verdict).toBe('warn');
    expect(g.record('snapshot', {}, 'page B').verdict).toBe('warn');
    expect(g.record('snapshot', {}, 'page B').verdict).toBe('stop');
  });

  it('never calls waiting or looking at the screen a loop', () => {
    const g = new RepeatGuard();
    for (let i = 0; i < 12; i++) {
      expect(g.record('mcp__browser__browser_wait', { seconds: 5 }, 'same page').verdict).toBe('ok');
      expect(g.record('mcp__browser__browser_screenshot', {}, 'Screenshot of https://x').verdict).toBe('ok');
    }
  });

  it('treats different arguments as different calls', () => {
    const g = new RepeatGuard();
    for (let i = 0; i < 8; i++) expect(g.record('open', { url: `https://x/${i}` }, 'same').verdict).toBe('ok');
  });
});

describe('a turn that has to stop early', () => {
  let server: http.Server;
  let baseURL = '';
  let bodies: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = [];
  let next: (n: number) => unknown = () => ({ role: 'assistant', content: 'done' });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        bodies.push(body);
        const message = next(bodies.length);
        const toolCalls = (message as { tool_calls?: unknown[] }).tool_calls;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', model: 'm',
          choices: [{ index: 0, finish_reason: toolCalls ? 'tool_calls' : 'stop', message }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => { server.close(); });

  const call = (name: string, args: unknown) => ({ role: 'assistant', content: '', tool_calls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const make = (extra: Record<string, unknown>, run: (args: unknown) => Promise<unknown>) => new SvaraAgent({
    name: 'guard', model: 'm', memory: false,
    llm: { provider: 'openai', baseURL, apiKey: 'k' },
    tools: [{ name: 'step', description: 'a step', inputSchema: { type: 'object', properties: { n: { type: 'number' } } }, run }],
    ...extra,
  });
  const lastWrap = () => bodies[bodies.length - 1];
  const wrapping = (n: number) => bodies[n - 1].messages.at(-1)?.content.includes('System notice');

  it('writes a progress report when the step limit is reached', async () => {
    bodies = [];
    next = (n) => (wrapping(n) ? { role: 'assistant', content: 'Done so far: 3 pages. Mau saya lanjutkan?' } : call('step', { n }));
    const result = await make({ maxIterations: 3 }, async (a) => ({ got: a })).process('explore', { sessionId: 's1' });
    expect(result.stopped).toBe('steps');
    expect(result.response).toContain('Mau saya lanjutkan?');
    expect(result.iterations).toBe(3);
    expect(lastWrap().tools).toBeUndefined();
    expect(lastWrap().messages.at(-1)?.content).toContain('limit of 3 steps');
  });

  it('stops a tool that keeps returning the same thing, after warning the model', async () => {
    bodies = [];
    next = (n) => (wrapping(n) ? { role: 'assistant', content: 'I was stuck.' } : call('step', { n: 1 }));
    const result = await make({ maxIterations: 30 }, async () => ({ same: true })).process('go', { sessionId: 's2' });
    expect(result.stopped).toBe('loop');
    expect(result.iterations).toBe(6);
    const toolTexts = bodies[bodies.length - 1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolTexts.some((t) => t.includes('Notice: this exact call'))).toBe(true);
  });

  it('stops when the time for one request is used up', async () => {
    bodies = [];
    next = (n) => (wrapping(n) ? { role: 'assistant', content: 'Out of time.' } : call('step', { n }));
    const result = await make({ maxIterations: 50, maxRunMs: 60 }, async (a) => { await new Promise((r) => setTimeout(r, 40)); return { got: a }; }).process('go', { sessionId: 's3' });
    expect(result.stopped).toBe('time');
    expect(result.iterations).toBeLessThan(10);
    expect(result.response).toBe('Out of time.');
  });

  it('falls back to a plain note if the report itself fails', async () => {
    bodies = [];
    let failed = false;
    next = (n) => {
      if (wrapping(n)) { failed = true; return { role: 'assistant', content: '' }; }
      return call('step', { n });
    };
    const result = await make({ maxIterations: 2 }, async (a) => ({ got: a })).process('go', { sessionId: 's4' });
    expect(failed).toBe(true);
    expect(result.response).toContain('limit of 2 steps');
    expect(result.response).toContain('step');
  });

  it('an ordinary turn is not marked as stopped', async () => {
    bodies = [];
    next = (n) => (n === 1 ? call('step', { n: 1 }) : { role: 'assistant', content: 'all done' });
    const result = await make({}, async () => ({ ok: true })).process('go', { sessionId: 's5' });
    expect(result.stopped).toBeUndefined();
    expect(result.response).toBe('all done');
  });
});
