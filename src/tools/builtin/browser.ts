/**
 * @module tools/builtin/browser
 * SvaraJS - built-in browser automation tools (Playwright)
 *
 * `browser_navigate`, `browser_get_text`, `browser_click`, `browser_screenshot`.
 * A single headless Chromium instance + page is shared across calls within a
 * process (lazily launched on first use). Interactive elements are exposed as
 * `@e1`, `@e2`, ... refs from `browser_get_text` - pass a ref to `browser_click`
 * instead of a CSS selector, so a model without vision can still act on the
 * page from a compact text snapshot.
 *
 * Requires the optional "playwright" peer dependency - see lazyDeps.ts.
 *
 * @example
 * agent.addTool(...createBrowserTools());
 * // later, on shutdown:
 * await closeBrowser();
 */

import { loadPlaywright } from '../lazyDeps.js';
import type { Tool } from '../../types.js';
import type { Browser, Page, ElementHandle } from 'playwright';

export interface BrowserToolsOptions {
  /** Launch Chromium headless (default) or headed - useful for local debugging. @default true */
  headless?: boolean;
  /** Navigation/action timeout in ms. @default 30000 */
  timeout?: number;
}

let browserPromise: Promise<Browser> | null = null;
let pagePromise: Promise<Page> | null = null;
let refMap: Map<string, ElementHandle> = new Map();

async function getPage(headless: boolean): Promise<Page> {
  if (!browserPromise) {
    const { chromium } = await loadPlaywright();
    browserPromise = chromium.launch({ headless });
  }
  if (!pagePromise) {
    pagePromise = browserPromise.then((b) => b.newPage());
  }
  return pagePromise;
}

/** Close the shared browser instance, if one was launched. Call on agent/runtime shutdown. */
export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  browserPromise = null;
  pagePromise = null;
  refMap = new Map();
}

export function createBrowserTools(opts: BrowserToolsOptions = {}): Tool[] {
  const headless = opts.headless ?? true;
  const timeout = opts.timeout ?? 30_000;

  const navigate: Tool = {
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL.',
    parameters: {
      url: { type: 'string', description: 'URL to navigate to', required: true },
    },
    timeout: timeout + 5_000,
    async run({ url }) {
      const page = await getPage(headless);
      // 'domcontentloaded' fires on the raw HTML, before a JS SPA has fetched
      // and rendered its actual content - 'networkidle' waits for in-flight
      // requests to settle, so browser_get_text right after this call sees
      // the real page instead of a loading skeleton.
      await page.goto(String(url), { timeout, waitUntil: 'networkidle' });
      return { url: page.url(), title: await page.title() };
    },
  };

  const getText: Tool = {
    name: 'browser_get_text',
    description:
      'Get a compact text snapshot of the current page: visible text plus a numbered list of ' +
      'interactive elements (links, buttons, inputs) as refs like "e1", "e2" - pass a ref to browser_click.',
    parameters: {},
    timeout: timeout + 5_000,
    async run() {
      const page = await getPage(headless);
      const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4_000);

      const handles = await page.$$('a, button, input, textarea, select, [role="button"]');
      refMap = new Map();
      const interactive: Array<{ ref: string; tag: string; text: string }> = [];

      for (let i = 0; i < handles.length && i < 50; i++) {
        const handle = handles[i];
        const ref = `e${i + 1}`;
        refMap.set(ref, handle);
        // No DOM lib in this project's tsconfig (Node-only) - `el` is untyped in-browser here by design.
        const tag = await handle.evaluate((el: any) => el.tagName.toLowerCase());
        const text = (await handle.evaluate((el: any) =>
          el.innerText || el.placeholder || el.value || ''
        )).trim().slice(0, 80);
        interactive.push({ ref, tag, text });
      }

      return { url: page.url(), text: bodyText, interactive };
    },
  };

  const click: Tool = {
    name: 'browser_click',
    description: 'Click an element by ref (from browser_get_text, e.g. "e3").',
    parameters: {
      ref: { type: 'string', description: 'Element ref returned by browser_get_text', required: true },
    },
    timeout: timeout + 5_000,
    async run({ ref }) {
      const handle = refMap.get(String(ref));
      if (!handle) {
        return { error: `Unknown ref "${ref}". Call browser_get_text first to get current refs.` };
      }
      await handle.click({ timeout });
      const page = await getPage(headless);
      return { clicked: ref, url: page.url() };
    },
  };

  const screenshot: Tool = {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page. Returns a base64-encoded PNG.',
    parameters: {},
    timeout: timeout + 5_000,
    async run() {
      const page = await getPage(headless);
      const buffer = await page.screenshot({ type: 'png' });
      return { image: buffer.toString('base64'), format: 'png' };
    },
  };

  return [navigate, getText, click, screenshot];
}
