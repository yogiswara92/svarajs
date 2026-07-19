import { describe, it, expect, beforeEach } from 'vitest';
import { createWebTools } from '../tools/builtin/web.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

describe('createWebTools', () => {
  beforeEach(() => {
    delete process.env.TAVILY_API_KEY;
  });

  it('web_fetch rejects non-http(s) URLs', async () => {
    const [webFetch] = createWebTools();
    const result = await webFetch.run({ url: 'file:///etc/passwd' }, ctx) as { error?: string };
    expect(result.error).toMatch(/http:\/\/ and https:\/\//);
  });

  it('web_search reports it is unconfigured without an API key', async () => {
    const [, webSearch] = createWebTools();
    const result = await webSearch.run({ query: 'svarajs' }, ctx) as { error?: string };
    expect(result.error).toMatch(/not configured/);
  });

  it('exposes exactly web_fetch and web_search', () => {
    const tools = createWebTools();
    expect(tools.map((t) => t.name)).toEqual(['web_fetch', 'web_search']);
  });
});
