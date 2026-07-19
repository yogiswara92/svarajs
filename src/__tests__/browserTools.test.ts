import { describe, it, expect } from 'vitest';
import { createBrowserTools, closeBrowser } from '../tools/builtin/browser.js';

describe('createBrowserTools', () => {
  it('exposes navigate, get_text, click, and screenshot', () => {
    const tools = createBrowserTools();
    expect(tools.map((t) => t.name)).toEqual([
      'browser_navigate',
      'browser_get_text',
      'browser_click',
      'browser_screenshot',
    ]);
  });

  it('closeBrowser() is a no-op when nothing was ever launched', async () => {
    await expect(closeBrowser()).resolves.toBeUndefined();
  });
});
