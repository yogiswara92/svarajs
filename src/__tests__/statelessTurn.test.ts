import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { SvaraAgent } from '../core/agent.js';

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string; parameters: unknown } }> };

describe('stateless turns (caller-owned history)', () => {
  let server: http.Server;
  let baseURL = '';
  let bodies: Body[] = [];
  // First call asks for a tool, second call answers.
  let replies: unknown[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        const message = replies.shift() ?? { role: 'assistant', content: 'done' };
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

  it('uses the given history, sends raw JSON Schema, reports call args, and never opens SQLite', async () => {
    bodies = [];
    replies = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"filter":{"city":"Bali"}}' } }] },
      { role: 'assistant', content: 'Bali it is' },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-stateless-'));
    const dbPath = path.join(dir, 'never.db');
    const schema = { type: 'object', properties: { filter: { type: 'object', properties: { city: { type: 'string' } } } }, required: ['filter'] };
    let seenArgs: unknown = null;
    const agent = new SvaraAgent({
      name: 'stateless', model: 'm', memory: false, dbPath,
      llm: { provider: 'openai', baseURL, apiKey: 'k' },
      tools: [{ name: 'lookup', description: 'Look up', inputSchema: schema, run: async (args) => { seenArgs = args; return { ok: true }; } }],
    });
    const calls: unknown[] = [];
    agent.on('tool:call', (e: { calls: unknown[] }) => calls.push(...e.calls));

    const result = await agent.process('which city?', {
      sessionId: 'conv-1',
      history: [{ role: 'user', content: 'I like islands' }, { role: 'assistant', content: 'Noted' }],
    });

    expect(result.response).toBe('Bali it is');
    expect(result.toolsUsed).toEqual(['lookup']);
    expect(result.usage.totalTokens).toBe(10);
    expect(seenArgs).toEqual({ filter: { city: 'Bali' } });
    expect(calls).toEqual([{ id: 'c1', name: 'lookup', arguments: { filter: { city: 'Bali' } } }]);
    expect(bodies[0].tools?.[0].function.parameters).toEqual(schema);
    const firstMessages = bodies[0].messages.map((m) => [m.role, m.content]);
    expect(firstMessages.slice(1)).toEqual([['user', 'I like islands'], ['assistant', 'Noted'], ['user', 'which city?']]);
    expect(fs.existsSync(dbPath)).toBe(false);

    // A second turn with fresh history does not see the first turn: nothing was remembered in-process.
    bodies = [];
    await agent.process('again', { sessionId: 'conv-1', history: [] });
    expect(bodies[0].messages.map((m) => m.role)).toEqual(['system', 'user']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
