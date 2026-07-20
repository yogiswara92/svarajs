/**
 * @module tools/builtin/web
 * SvaraJS - built-in web access tools
 *
 * `web_fetch` - fetch a URL and return readable text (HTML is stripped down
 * to plain text using the same logic as the RAG HTML loader).
 * `web_search` - search the web. Picks a backend in this order: an explicit
 * `provider`, else Tavily if `searchApiKey`/`TAVILY_API_KEY` is set, else
 * Google Custom Search if `googleApiKey`+`googleSearchEngineId` (or their
 * env vars) are set, else a Playwright fallback that scrapes DuckDuckGo's
 * HTML results page - so search still works with zero API keys configured,
 * as long as the optional "playwright" package is installed (see
 * tools/builtin/browser.ts, which this reuses the shared browser from).
 *
 * @example
 * agent.addTool(...createWebTools({ searchApiKey: process.env.TAVILY_API_KEY }));
 */

import { stripHtml } from '../../rag/loader.js';
import type { Tool } from '../../types.js';
import type { Page } from 'playwright';

export interface WebToolsOptions {
  /** Force a specific search backend instead of auto-picking by which keys are configured. */
  provider?: 'tavily' | 'google';
  /** Tavily API key for web_search. @default process.env.TAVILY_API_KEY */
  searchApiKey?: string;
  /** Google Custom Search JSON API key. @default process.env.GOOGLE_SEARCH_API_KEY */
  googleApiKey?: string;
  /** Google Programmable Search Engine ID ("cx"). @default process.env.GOOGLE_SEARCH_ENGINE_ID */
  googleSearchEngineId?: string;
  /** Abort fetch/search requests after this many ms. @default 15000 */
  timeout?: number;
  /** Truncate fetched page content to this many characters. @default 8000 */
  maxContentLength?: number;
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

type SearchOutcome = { results: SearchHit[] } | { error: string };

/** DuckDuckGo's HTML results wrap the real target in `?uddg=<encoded-url>` (a click-tracking redirect) - unwrap it so the model gets a real, fetchable URL instead of a duckduckgo.com link. */
function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const real = parsed.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : parsed.toString();
  } catch {
    return href;
  }
}

export function createWebTools(opts: WebToolsOptions = {}): Tool[] {
  const timeout = opts.timeout ?? 15_000;
  const maxContentLength = opts.maxContentLength ?? 8_000;
  const searchApiKey = opts.searchApiKey ?? process.env.TAVILY_API_KEY;
  const googleApiKey = opts.googleApiKey ?? process.env.GOOGLE_SEARCH_API_KEY;
  const googleSearchEngineId = opts.googleSearchEngineId ?? process.env.GOOGLE_SEARCH_ENGINE_ID;

  const webFetch: Tool = {
    name: 'web_fetch',
    description: 'Fetch a URL and return its readable text content (HTML is stripped to plain text).',
    parameters: {
      url: { type: 'string', description: 'The URL to fetch (must start with http:// or https://)', required: true },
    },
    timeout: timeout + 5_000,
    async run({ url }) {
      const target = String(url);
      if (!/^https?:\/\//i.test(target)) {
        return { error: 'Only http:// and https:// URLs are supported.' };
      }

      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(target, { signal: controller.signal, redirect: 'follow' });
        const contentType = res.headers.get('content-type') ?? '';
        const raw = await res.text();
        const content = contentType.includes('html') ? stripHtml(raw) : raw;
        return {
          url: target,
          status: res.status,
          contentType,
          content: content.slice(0, maxContentLength),
          truncated: content.length > maxContentLength,
        };
      } catch (err) {
        return { error: `Fetch failed: ${(err as Error).message}` };
      } finally {
        clearTimeout(abortTimer);
      }
    },
  };

  async function tavilySearch(query: string, limit: number, signal: AbortSignal): Promise<SearchOutcome> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: searchApiKey, query, max_results: limit }),
    });
    if (!res.ok) return { error: `Tavily returned ${res.status}: ${await res.text()}` };
    const data = await res.json() as { results?: Array<{ title: string; url: string; content: string }> };
    return { results: (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })) };
  }

  async function googleSearch(query: string, limit: number, signal: AbortSignal): Promise<SearchOutcome> {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', googleApiKey!);
    url.searchParams.set('cx', googleSearchEngineId!);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(Math.min(Math.max(limit, 1), 10))); // Google Custom Search caps at 10/request
    const res = await fetch(url, { signal });
    if (!res.ok) return { error: `Google Custom Search returned ${res.status}: ${await res.text()}` };
    const data = await res.json() as { items?: Array<{ title: string; link: string; snippet: string }> };
    return { results: (data.items ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet })) };
  }

  /** Zero-API-key fallback: scrapes DuckDuckGo's no-JS HTML results page with the shared headless browser (see tools/builtin/browser.ts). Needs the optional "playwright" package - loadPlaywright() throws an actionable message if it's missing, which surfaces here as this tool's error result. */
  async function playwrightSearch(query: string, limit: number): Promise<SearchOutcome> {
    let page: Page | undefined;
    try {
      const { getSharedBrowser } = await import('./browser.js');
      const browser = await getSharedBrowser(true);
      page = await browser.newPage();
      await page.goto(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      const raw = await page.$$eval('.result__body', (nodes: any[]) =>
        nodes.map((n: any) => ({
          title: n.querySelector('.result__title')?.textContent?.trim() ?? '',
          href: n.querySelector('a.result__a')?.getAttribute('href') ?? '',
          snippet: n.querySelector('.result__snippet')?.textContent?.trim() ?? '',
        }))
      );
      const results = raw
        .filter((r) => r.title && r.href)
        .slice(0, limit)
        .map((r) => ({ title: r.title, url: unwrapDuckDuckGoUrl(r.href), snippet: r.snippet }));
      return { results };
    } catch (err) {
      return {
        error: `No search API key is configured (Tavily or Google), and the Playwright fallback failed: ${(err as Error).message}`,
      };
    } finally {
      await page?.close().catch(() => {});
    }
  }

  const webSearch: Tool = {
    name: 'web_search',
    description: 'Search the web and return a list of relevant results (title, url, snippet).',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results to return', default: 5 },
    },
    timeout: timeout + 15_000, // the Playwright fallback needs headroom beyond a plain API call - launching/loading a page can itself take several seconds
    async run({ query, limit }) {
      const q = String(query);
      const n = Number(limit ?? 5);
      const provider = opts.provider
        ?? (searchApiKey ? 'tavily' : googleApiKey && googleSearchEngineId ? 'google' : 'playwright');

      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), timeout);
      try {
        if (provider === 'tavily') {
          if (!searchApiKey) return { error: 'web_search provider is set to "tavily" but no Tavily API key is configured.' };
          return await tavilySearch(q, n, controller.signal);
        }
        if (provider === 'google') {
          if (!googleApiKey || !googleSearchEngineId) {
            return { error: 'web_search provider is set to "google" but googleApiKey/googleSearchEngineId is missing.' };
          }
          return await googleSearch(q, n, controller.signal);
        }
        return await playwrightSearch(q, n);
      } catch (err) {
        return { error: `Search failed: ${(err as Error).message}` };
      } finally {
        clearTimeout(abortTimer);
      }
    },
  };

  return [webFetch, webSearch];
}
