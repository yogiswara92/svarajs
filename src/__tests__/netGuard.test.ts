import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPublicUrl, guardedFetch, isPrivateAddress } from '../security/netGuard.js';
import { createWebTools } from '../tools/builtin/web.js';
import { publicBaseOf } from '../dashboard/serve.js';

const ORIGINAL = process.env.SVARA_BLOCK_PRIVATE_NETWORK;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SVARA_BLOCK_PRIVATE_NETWORK;
  else process.env.SVARA_BLOCK_PRIVATE_NETWORK = ORIGINAL;
});

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local, CGNAT and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it('lets public addresses through', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicUrl', () => {
  it('refuses non-http schemes and private hosts', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(assertPublicUrl('http://127.0.0.1:3020/api/agents')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://localhost/')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private/);
  });
});

describe('web_fetch with the guard', () => {
  async function localServer(): Promise<{ url: string; close: () => void }> {
    const server = http.createServer((_req, res) => res.end('internal secret'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
  }
  const webFetch = () => createWebTools().find((t) => t.name === 'web_fetch')!;

  it('cannot reach a loopback service when SVARA_BLOCK_PRIVATE_NETWORK=1', async () => {
    const srv = await localServer();
    process.env.SVARA_BLOCK_PRIVATE_NETWORK = '1';
    const out = await webFetch().run({ url: srv.url }) as { error?: string; content?: string };
    srv.close();
    expect(out.error).toMatch(/Blocked/);
    expect(out.content).toBeUndefined();
  });

  it('still works normally with the guard off', async () => {
    const srv = await localServer();
    delete process.env.SVARA_BLOCK_PRIVATE_NETWORK;
    const out = await webFetch().run({ url: srv.url }) as { content?: string };
    srv.close();
    expect(out.content).toBe('internal secret');
  });

  it('checks every redirect hop, not just the first URL', async () => {
    process.env.SVARA_BLOCK_PRIVATE_NETWORK = '1';
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3020/api/agents' } });
    }) as typeof fetch;
    try {
      await expect(guardedFetch('http://1.1.1.1/')).rejects.toThrow(/private/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual(['http://1.1.1.1/']); // the private hop was refused before any request went out
  });
});

describe('publicBaseOf', () => {
  const req = (v?: string) => ({ get: (n: string) => (n === 'x-svara-public-base' ? v : undefined) });
  it('accepts an https base with a path prefix', () => {
    expect(publicBaseOf(req('https://be.example.com/api/worker-hooks/abc/'))).toBe('https://be.example.com/api/worker-hooks/abc');
  });
  it('ignores missing, http or query-carrying values', () => {
    expect(publicBaseOf(req())).toBeNull();
    expect(publicBaseOf(req('http://be.example.com'))).toBeNull();
    expect(publicBaseOf(req('https://be.example.com/?x=1'))).toBeNull();
    expect(publicBaseOf(req('not a url'))).toBeNull();
  });
});
