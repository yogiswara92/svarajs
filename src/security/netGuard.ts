/**
 * @module security/netGuard
 * SvaraJS - keep web tools off the host's private network
 *
 * When several people's agents share one server (a hosting provider running
 * SvaraJS for its users), web_fetch and the browser must not become a way to
 * reach that server's internal services (loopback ports, the Docker bridge,
 * cloud metadata at 169.254.169.254, the LAN). Off by default - a personal
 * agent legitimately talks to a local Ollama or a NAS - and switched on with
 * SVARA_BLOCK_PRIVATE_NETWORK=1 by whoever runs the shared host.
 */

import dns from 'dns';
import net from 'net';

export function networkGuardEnabled(): boolean {
  return process.env.SVARA_BLOCK_PRIVATE_NETWORK === '1';
}

/** Loopback, private, link-local, CGNAT, multicast and other non-public ranges, IPv4 and IPv6. */
export function isPrivateAddress(ip: string): boolean {
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) addr = mapped[1];

  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(addr)) {
    return addr === '::' || addr === '::1' || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr) || addr.startsWith('ff');
  }
  return true; // not an IP at all: refuse rather than guess
}

/**
 * Throws if `url` is not plain http(s) to a public address. Resolves the
 * host name so a public-looking name pointing at 127.0.0.1 is refused too.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed.');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error(`Blocked: ${host} is a private address on this server.`);
  }
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.promises.lookup(host, { all: true, verbatim: true })).map((r) => r.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`Blocked: ${host} points to a private address on this server.`);
  }
}

/**
 * fetch() that checks the target, and every redirect hop, with assertPublicUrl
 * when the guard is on. With the guard off it is plain fetch().
 */
export async function guardedFetch(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  if (!networkGuardEnabled()) return fetch(url, { ...init, redirect: 'follow' });
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects.');
}
