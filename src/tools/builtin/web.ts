/**
 * @module tools/builtin/web
 * SvaraJS - built-in web access tools
 *
 * `web_fetch` - fetch a URL and return readable text (HTML is stripped down
 * to plain text using the same logic as the RAG HTML loader).
 * `web_search` - search the web via Tavily (the only backend for now; pass
 * `searchApiKey` or set `TAVILY_API_KEY`). Without a key, the tool reports
 * why it's unavailable instead of throwing.
 *
 * @example
 * agent.addTool(...createWebTools({ searchApiKey: process.env.TAVILY_API_KEY }));
 */

import { stripHtml } from '../../rag/loader.js';
import type { Tool } from '../../types.js';

export interface WebToolsOptions {
  /** Tavily API key for web_search. @default process.env.TAVILY_API_KEY */
  searchApiKey?: string;
  /** Abort fetch/search requests after this many ms. @default 15000 */
  timeout?: number;
  /** Truncate fetched page content to this many characters. @default 8000 */
  maxContentLength?: number;
}

export function createWebTools(opts: WebToolsOptions = {}): Tool[] {
  const timeout = opts.timeout ?? 15_000;
  const maxContentLength = opts.maxContentLength ?? 8_000;
  const searchApiKey = opts.searchApiKey ?? process.env.TAVILY_API_KEY;

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

  const webSearch: Tool = {
    name: 'web_search',
    description: 'Search the web and return a list of relevant results (title, url, snippet).',
    parameters: {
      query: { type: 'string', description: 'The search query', required: true },
      limit: { type: 'number', description: 'Max results to return', default: 5 },
    },
    timeout: timeout + 5_000,
    async run({ query, limit }) {
      if (!searchApiKey) {
        return {
          error:
            'web_search is not configured. Set TAVILY_API_KEY or pass { searchApiKey } to createWebTools().',
        };
      }

      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: searchApiKey,
            query: String(query),
            max_results: Number(limit ?? 5),
          }),
        });

        if (!res.ok) {
          return { error: `Search provider returned ${res.status}: ${await res.text()}` };
        }

        const data = await res.json() as { results?: Array<{ title: string; url: string; content: string }> };
        return {
          results: (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
        };
      } catch (err) {
        return { error: `Search failed: ${(err as Error).message}` };
      } finally {
        clearTimeout(abortTimer);
      }
    },
  };

  return [webFetch, webSearch];
}
