/**
 * @module integrations/svaramind
 * SvaraJS - guided connect flow for Svaramind (Yesvara's knowledge/notes
 * product), on top of the generic MCP client (src/mcp/manager.ts).
 *
 * Svaramind's MCP endpoint requires a real OAuth 2.1 access token - there is
 * no "generate an API key" feature. The flow (confirmed against Svaramind's
 * actual backend, notes-be/src/{routes,controllers,services}/*oauth*):
 *   1. Dynamically register an OAuth client (RFC 7591) - POST /oauth/register.
 *   2. Send the user's browser to /oauth/authorize (Svaramind's own hosted
 *      login+consent page - they sign in with their real Svaramind email/
 *      password there, never anything typed into SvaraJS) with a PKCE
 *      code_challenge.
 *   3. Svaramind redirects back to a local callback URL with `?code=`.
 *   4. Exchange the code + PKCE code_verifier for an access_token (1h TTL)
 *      and a refresh_token (90d TTL, rotates on use) - POST /oauth/token.
 * The access token is what goes in the MCP connection's Authorization
 * header; the refresh token is kept so the runtime can mint a fresh one on
 * the next `svara start` instead of the connection just dying after an hour.
 *
 * Once connected, every `svaramind_*` tool takes a `workspace_id` - rather
 * than make the agent guess or ask, this lists the user's workspaces once
 * and pins the chosen one via `McpManager.pinParameter()`.
 */

import { randomBytes, createHash } from 'crypto';
import type { McpManager } from '../mcp/manager.js';
import type { McpServerConfig, McpServerStatus } from '../mcp/types.js';

export const SVARAMIND_SERVER_ID = 'svaramind';
const ISSUER = 'https://api-be-svaramind.yesvara.com';
export const SVARAMIND_MCP_URL = `${ISSUER}/mcp`;
export const SVARAMIND_APP_URL = 'https://svaramind.yesvara.com';
const OAUTH_REGISTER_URL = `${ISSUER}/oauth/register`;
const OAUTH_AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const OAUTH_TOKEN_URL = `${ISSUER}/oauth/token`;
const OAUTH_SCOPE = 'svaramind';
const AUTH_HEADER = 'Authorization';

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** RFC 7636 PKCE pair - a public client (no client secret) proves it's the one that started the flow without needing to keep anything else confidential. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32)); // 43 chars, within the spec's 43-128 range
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

interface RegisteredClient {
  client_id: string;
}

/** RFC 7591 dynamic client registration - a fresh "client" per connect attempt rather than persisting one, since re-registering is cheap and avoids stale-client-id edge cases across restarts. */
export async function registerOAuthClient(redirectUri: string): Promise<string> {
  const res = await fetch(OAUTH_REGISTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'SvaraJS',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none', // public client + PKCE - nothing to keep secret locally
    }),
  });
  if (!res.ok) {
    throw new Error(`[SvaraJS] Svaramind client registration failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as RegisteredClient;
  return data.client_id;
}

export function buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; codeChallenge: string; state: string }): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('state', opts.state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface SvaramindTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// Refresh a bit before actual expiry - avoids a request landing right at the
// boundary and getting a 401 the token was "supposed" to still be valid for.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

async function requestToken(body: Record<string, string>): Promise<SvaramindTokens> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`[SvaraJS] Svaramind token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export function exchangeCodeForTokens(opts: { code: string; redirectUri: string; codeVerifier: string; clientId: string }): Promise<SvaramindTokens> {
  return requestToken({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
  });
}

export function refreshTokens(refreshToken: string): Promise<SvaramindTokens> {
  return requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

export function buildSvaramindConfig(tokens: SvaramindTokens, clientId: string): McpServerConfig {
  return {
    id: SVARAMIND_SERVER_ID,
    name: 'Svaramind',
    transport: {
      type: 'streamable-http',
      url: SVARAMIND_MCP_URL,
      headers: { [AUTH_HEADER]: `Bearer ${tokens.accessToken}` },
    },
    oauth: {
      clientId, refreshToken: tokens.refreshToken, tokenUrl: OAUTH_TOKEN_URL, headerName: AUTH_HEADER,
      expiresAt: tokens.expiresAt,
    },
  };
}

/**
 * Mints a fresh access token from a stored refresh token and rebuilds the
 * connect config with it - used on `svara start` boot. Skips the network
 * call entirely if the current access token still has enough life left:
 * Svaramind's refresh tokens rotate on use (the old one is immediately
 * revoked), so refreshing unconditionally on every boot burns through them
 * for no reason on a config saved before `expiresAt` existed - meaning a
 * quick double-restart (or a race persisting the rotated token to disk)
 * could refresh with an already-used token and force a full reconnect.
 * Returns the exact same object (by reference) when no refresh happened,
 * so callers can tell "did this actually rotate" via `!==` rather than a
 * separate flag.
 */
export async function refreshSvaramindConfig(config: McpServerConfig): Promise<McpServerConfig> {
  if (!config.oauth) return config;
  if (config.oauth.expiresAt && config.oauth.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return config;
  }
  const tokens = await refreshTokens(config.oauth.refreshToken);
  const refreshed = buildSvaramindConfig(tokens, config.oauth.clientId);
  // buildSvaramindConfig() has no idea about a workspace pinned after the
  // initial connect - carry it over explicitly, or every refresh (which used
  // to happen on every single restart) silently wipes the chosen workspace
  // out of the saved config, and the user has to go pick it again.
  return config.pinnedParams ? { ...refreshed, pinnedParams: config.pinnedParams } : refreshed;
}

export interface SvaramindWorkspace {
  id: string;
  name: string;
}

/**
 * `svaramind_list_workspaces` returns MCP text content - normalize whatever
 * shape it turns out to be (a bare array, or `{ workspaces: [...] }`) into a
 * consistent `{id, name}` list rather than assuming one exact schema.
 */
export function parseWorkspaces(raw: unknown): SvaramindWorkspace[] {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return []; }
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { workspaces?: unknown })?.workspaces)
      ? (data as { workspaces: unknown[] }).workspaces
      : [];

  return list
    .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
    .map((w) => ({
      id: String(w.id ?? w.workspace_id ?? w.uuid ?? ''),
      name: String(w.name ?? w.title ?? w.label ?? w.id ?? 'Untitled'),
    }))
    .filter((w) => w.id);
}

export async function listSvaramindWorkspaces(mcpManager: McpManager): Promise<SvaramindWorkspace[]> {
  const raw = await mcpManager.callToolDirect(SVARAMIND_SERVER_ID, 'svaramind_list_workspaces');
  return parseWorkspaces(raw);
}

export function setSvaramindWorkspace(mcpManager: McpManager, workspaceId: string): McpServerStatus {
  return mcpManager.pinParameter(SVARAMIND_SERVER_ID, 'workspace_id', workspaceId);
}
