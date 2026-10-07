import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'http';
import { modelSupportsVision, toOpenAIMessage, toAnthropicMessage } from '../core/llm.js';
import { SvaraAgent } from '../core/agent.js';

const IMG = [{ mimeType: 'image/png', base64: 'AAAA' }];

describe('modelSupportsVision', () => {
  it('recognises common vision models and defaults to no for unknown ones', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'o3', 'claude-sonnet-5-5', 'claude-3-haiku', 'gemini-2.0-flash', 'llava:13b', 'qwen2-vl-72b', 'pixtral-12b', 'llama-3.2-11b-vision']) {
      expect(modelSupportsVision(m), m).toBe(true);
    }
    for (const m of ['deepseek-v4-pro', 'gpt-3.5-turbo', 'llama3', 'mistral-large', 'my-custom-model']) {
      expect(modelSupportsVision(m), m).toBe(false);
    }
  });
  it('lets an explicit setting win either way', () => {
    expect(modelSupportsVision('deepseek-v4-pro', true)).toBe(true);
    expect(modelSupportsVision('gpt-4o', false)).toBe(false);
  });
});

describe('message formats', () => {
  it('OpenAI: text part plus image_url data URL parts; plain string without images', () => {
    expect(toOpenAIMessage({ role: 'user', content: 'lihat ini', images: IMG })).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'lihat ini' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    });
    expect(toOpenAIMessage({ role: 'user', content: 'halo' })).toEqual({ role: 'user', content: 'halo' });
  });
  it('Anthropic: base64 image blocks then text', () => {
    expect(toAnthropicMessage({ role: 'user', content: 'lihat ini', images: IMG })).toEqual({
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'lihat ini' }],
    });
  });
});

describe('agent sends images only to models that can read them', () => {
  let server: http.Server;
  let baseURL = '';
  let bodies: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => { server.close(); });

  async function ask(model: string, vision?: boolean) {
    bodies = [];
    const agent = new SvaraAgent({ name: `v-${Math.random().toString(36).slice(2, 8)}`, model, dbPath: ':memory:', llm: { provider: 'openai', baseURL, apiKey: 'k', vision } });
    await agent.receive({ id: '1', sessionId: 's', userId: 'u', channel: 'telegram', text: 'apa ini?', timestamp: new Date(), images: IMG });
    return bodies[0].messages.filter((m) => m.role === 'user').pop()!;
  }

  it('sends the image to a vision model', async () => {
    const m = await ask('gpt-4o');
    expect(Array.isArray(m.content)).toBe(true);
    expect(JSON.stringify(m.content)).toContain('data:image/png;base64,AAAA');
  });

  it('keeps the request text-only for a model that cannot see images', async () => {
    const m = await ask('deepseek-v4-pro');
    expect(typeof m.content).toBe('string');
    expect(JSON.stringify(m)).not.toContain('base64');
  });

  it('honours an explicit override in both directions', async () => {
    expect(Array.isArray((await ask('deepseek-v4-pro', true)).content)).toBe(true);
    expect(typeof (await ask('gpt-4o', false)).content).toBe('string');
  });
});
