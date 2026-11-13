/**
 * @module mcp/oauth
 * One-click sign-in for any remote MCP server that follows the MCP authorization spec (Notion, Linear, Atlassian,
 * Asana, Canva, Figma, Stripe, Zapier, ...): the user signs in on the app's own page, nothing is typed into SvaraJS.
 *
 *   1. Discovery: the server's 401 names its protected-resource metadata (RFC 9728), which names the authorization
 *      server, whose metadata (RFC 8414 or OpenID) gives the authorize, token and registration endpoints.
 *   2. Dynamic client registration (RFC 7591): a public client with PKCE, so there is no secret to keep.
 *   3. Authorization code + PKCE, with `resource` (RFC 8707) so the token is bound to that server.
 *   4. Tokens go into the connection's Authorization header; the refresh token is kept in `oauth` so the runtime
 *      renews the access token before it expires (see refreshOAuthConfig).
 */

import { createHash, randomBytes } from 'crypto';
import type { McpServerConfig } from './types.js';

export interface OAuthServerInfo {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
  resource: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

const TIMEOUT_MS = 15000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const b64url = (buf: Buffer) => buf.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export const newState = () => b64url(randomBytes(16));

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `https://host/path` -> `https://host/.well-known/<name>/path` (path-aware well-known URLs, RFC 8414 section 3). */
function wellKnown(base: string, name: string): string[] {
  const u = new URL(base);
  const path = u.pathname.replace(/\/$/, '');
  const out = [`${u.origin}/.well-known/${name}${path}`];
  if (path) out.push(`${u.origin}/.well-known/${name}`);
  return out;
}

/** Finds where to sign in for an MCP server. Throws a readable error when the server does not support OAuth. */
export async function discoverOAuth(serverUrl: string): Promise<OAuthServerInfo> {
  let metadataUrl: string | undefined;
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'svarajs', version: '1' } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const challenge = res.headers.get('www-authenticate') || '';
    metadataUrl = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
    await res.body?.cancel().catch(() => {});
    if (res.ok) throw new Error('This app does not ask for a sign-in, so it can be connected without OAuth.');
  } catch (err) {
    if ((err as Error).message.startsWith('This app')) throw err;
  }

  let prm: Record<string, unknown> | null = null;
  for (const url of [...(metadataUrl ? [metadataUrl] : []), ...wellKnown(serverUrl, 'oauth-protected-resource')]) {
    prm = await getJson(url);
    if (prm) break;
  }
  const authServer = String((prm?.authorization_servers as string[] | undefined)?.[0] || new URL(serverUrl).origin);

  let meta: Record<string, unknown> | null = null;
  for (const url of [...wellKnown(authServer, 'oauth-authorization-server'), ...wellKnown(authServer, 'openid-configuration')]) {
    meta = await getJson(url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
    meta = null;
  }
  if (!meta) throw new Error('This app does not offer a sign-in for AI tools (no OAuth metadata found). Connect it with an API key instead.');

  const scopes = (prm?.scopes_supported as string[] | undefined) ?? undefined;
  return {
    authorizationEndpoint: String(meta.authorization_endpoint),
    tokenEndpoint: String(meta.token_endpoint),
    registrationEndpoint: meta.registration_endpoint ? String(meta.registration_endpoint) : undefined,
    scopes: scopes?.length ? scopes : undefined,
    resource: String(prm?.resource || serverUrl),
  };
}

/** Registers this runtime as a public client (PKCE, no secret). Some servers still hand out a secret: it is kept. */
export async function registerClient(info: OAuthServerInfo, redirectUri: string, clientName = 'SvaraJS'): Promise<{ clientId: string; clientSecret?: string }> {
  if (!info.registrationEndpoint) {
    throw new Error('This app needs an OAuth app registered by hand (no automatic client registration). Connect it with an API key instead.');
  }
  const res = await fetch(info.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(info.scopes ? { scope: info.scopes.join(' ') } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`The app refused the registration (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { client_id: string; client_secret?: string };
  return { clientId: data.client_id, clientSecret: data.client_secret || undefined };
}

export function authorizeUrl(info: OAuthServerInfo, opts: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(info.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('resource', info.resource);
  if (info.scopes) url.searchParams.set('scope', info.scopes.join(' '));
  return url.toString();
}

async function tokenRequest(tokenUrl: string, params: Record<string, string | undefined>): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) body.set(k, v);
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${text.slice(0, 200)}`);
  const data = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('The app did not return an access token.');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || undefined,
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
  };
}

export function exchangeCode(info: { tokenEndpoint: string; resource: string }, opts: { code: string; redirectUri: string; verifier: string; clientId: string; clientSecret?: string }): Promise<OAuthTokens> {
  return tokenRequest(info.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    resource: info.resource,
  });
}

/** The connection config for a signed-in server. */
export function oauthServerConfig(opts: { id: string; name: string; url: string; tokens: OAuthTokens; clientId: string; clientSecret?: string; tokenUrl: string; resource: string }): McpServerConfig {
  return {
    id: opts.id,
    name: opts.name,
    transport: {
      type: /\/sse\/?$/.test(new URL(opts.url).pathname) ? 'sse' : 'streamable-http',
      url: opts.url,
      headers: { Authorization: `Bearer ${opts.tokens.accessToken}` },
    },
    oauth: {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      refreshToken: opts.tokens.refreshToken ?? '',
      tokenUrl: opts.tokenUrl,
      headerName: 'Authorization',
      expiresAt: opts.tokens.expiresAt,
      resource: opts.resource,
      standard: true,
    },
  };
}

/** Whether a signed-in connection's access token is (nearly) expired and can be renewed. */
export function needsRefresh(config: McpServerConfig, skewMs = REFRESH_SKEW_MS): boolean {
  const o = config.oauth;
  return !!o?.standard && !!o.refreshToken && !!o.expiresAt && o.expiresAt - skewMs <= Date.now();
}

/**
 * Renews the access token of a standard OAuth connection. Returns the same object when nothing was due, so a caller
 * can tell with `!==` whether to save it (refresh tokens often rotate: the new one must be kept).
 */
export async function refreshOAuthConfig(config: McpServerConfig, skewMs = REFRESH_SKEW_MS): Promise<McpServerConfig> {
  if (!needsRefresh(config, skewMs)) return config;
  const o = config.oauth!;
  const tokens = await tokenRequest(o.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
    client_id: o.clientId,
    client_secret: o.clientSecret,
    resource: o.resource,
  });
  const transport = config.transport.type === 'stdio' ? config.transport : { ...config.transport, headers: { ...(config.transport.headers ?? {}), [o.headerName]: `Bearer ${tokens.accessToken}` } };
  return {
    ...config,
    transport,
    oauth: { ...o, refreshToken: tokens.refreshToken ?? o.refreshToken, expiresAt: tokens.expiresAt },
  };
}
