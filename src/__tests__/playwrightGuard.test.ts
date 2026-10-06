import { describe, it, expect, vi, beforeEach } from 'vitest';

// If this mock factory runs, `playwright` was actually imported. On Node < 20 that call terminates the whole
// process ("Playwright requires Node.js 20 or higher"), which is what took a Node 18 VPS down when the
// dashboard's Capabilities page opened. So on an old Node it must never run.
vi.mock('playwright', () => {
  (globalThis as { __pwLoaded?: boolean }).__pwLoaded = true;
  return { chromium: {} };
});

const { playwrightUnsupportedReason, isPlaywrightInstalled, loadPlaywright } = await import('../tools/lazyDeps.js');

function withNode(version: string, fn: () => Promise<void>): Promise<void> {
  const real = process.versions;
  Object.defineProperty(process, 'versions', { value: { ...real, node: version }, configurable: true });
  return fn().finally(() => Object.defineProperty(process, 'versions', { value: real, configurable: true }));
}

describe('playwright on an unsupported Node', () => {
  beforeEach(() => { (globalThis as { __pwLoaded?: boolean }).__pwLoaded = false; });

  it('explains the requirement', () => {
    expect(playwrightUnsupportedReason('18.19.1')).toMatch(/Node\.js 20 or newer.*18\.19\.1/);
    expect(playwrightUnsupportedReason('20.0.0')).toBeNull();
    expect(playwrightUnsupportedReason('22.4.0')).toBeNull();
  });

  it('reports "not installed" without importing playwright', async () => {
    await withNode('18.19.1', async () => {
      expect(await isPlaywrightInstalled()).toBe(false);
    });
    expect((globalThis as { __pwLoaded?: boolean }).__pwLoaded).toBe(false);
  });

  it('refuses to load it with a clear message, without importing playwright', async () => {
    await withNode('18.19.1', async () => {
      await expect(loadPlaywright()).rejects.toThrow(/Node\.js 20 or newer/);
    });
    expect((globalThis as { __pwLoaded?: boolean }).__pwLoaded).toBe(false);
  });

  it('still loads it on a supported Node (control)', async () => {
    await withNode('22.0.0', async () => {
      expect(await isPlaywrightInstalled()).toBe(true);
    });
    expect((globalThis as { __pwLoaded?: boolean }).__pwLoaded).toBe(true);
  });
});
