import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWebTools } from '../tools/builtin/web.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

vi.mock('../tools/builtin/browser.js', () => ({
  getSharedBrowser: vi.fn(),
}));

describe('createWebTools', () => {
  beforeEach(() => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.GOOGLE_SEARCH_API_KEY;
    delete process.env.GOOGLE_SEARCH_ENGINE_ID;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('web_fetch rejects non-http(s) URLs', async () => {
    const [webFetch] = createWebTools();
    const result = await webFetch.run({ url: 'file:///etc/passwd' }, ctx) as { error?: string };
    expect(result.error).toMatch(/http:\/\/ and https:\/\//);
  });

  it('exposes exactly web_fetch and web_search', () => {
    const tools = createWebTools();
    expect(tools.map((t) => t.name)).toEqual(['web_fetch', 'web_search']);
  });

  it('web_search uses Tavily when a key is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ title: 'T', url: 'https://t.example', content: 'snippet' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const [, webSearch] = createWebTools({ searchApiKey: 'tvly-test' });
    const result = await webSearch.run({ query: 'svarajs' }, ctx) as { results: unknown[] };
    expect(fetchMock).toHaveBeenCalledWith('https://api.tavily.com/search', expect.objectContaining({ method: 'POST' }));
    expect(result.results).toEqual([{ title: 'T', url: 'https://t.example', snippet: 'snippet' }]);
  });

  it('web_search uses Google Custom Search when tavily is unset but google keys are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ title: 'G', link: 'https://g.example', snippet: 'snippet' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const [, webSearch] = createWebTools({ googleApiKey: 'gk', googleSearchEngineId: 'cx123' });
    const result = await webSearch.run({ query: 'svarajs' }, ctx) as { results: unknown[] };
    expect(fetchMock.mock.calls[0][0].toString()).toContain('googleapis.com/customsearch/v1');
    expect(result.results).toEqual([{ title: 'G', url: 'https://g.example', snippet: 'snippet' }]);
  });

  it('web_search falls back to Playwright when no API key is configured', async () => {
    const { getSharedBrowser } = await import('../tools/builtin/browser.js');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      $$eval: vi.fn().mockResolvedValue([
        { title: 'DDG result', href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F', snippet: 'a snippet' },
      ]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    (getSharedBrowser as ReturnType<typeof vi.fn>).mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(page),
    });

    const [, webSearch] = createWebTools();
    const result = await webSearch.run({ query: 'svarajs' }, ctx) as { results: Array<{ url: string }> };
    expect(result.results).toEqual([{ title: 'DDG result', url: 'https://example.com/', snippet: 'a snippet' }]);
    expect(page.close).toHaveBeenCalled();
  });

  it('web_search reports both the missing key and the Playwright failure when the fallback also fails', async () => {
    const { getSharedBrowser } = await import('../tools/builtin/browser.js');
    (getSharedBrowser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('playwright not installed'));

    const [, webSearch] = createWebTools();
    const result = await webSearch.run({ query: 'svarajs' }, ctx) as { error?: string };
    expect(result.error).toMatch(/No search API key/);
    expect(result.error).toMatch(/playwright not installed/);
  });

  it('an explicit provider that has no key configured reports why, without trying Playwright', async () => {
    const [, webSearch] = createWebTools({ provider: 'google' });
    const result = await webSearch.run({ query: 'svarajs' }, ctx) as { error?: string };
    expect(result.error).toMatch(/googleApiKey\/googleSearchEngineId is missing/);
  });
});
