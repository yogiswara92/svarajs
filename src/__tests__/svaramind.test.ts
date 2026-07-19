import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseWorkspaces, buildSvaramindConfig, listSvaramindWorkspaces, setSvaramindWorkspace,
  generatePkce, generateState, registerOAuthClient, buildAuthorizeUrl, exchangeCodeForTokens,
  refreshTokens, refreshSvaramindConfig, SVARAMIND_MCP_URL,
} from '../integrations/svaramind.js';
import type { McpManager } from '../mcp/manager.js';

describe('parseWorkspaces', () => {
  it('parses a JSON string containing a bare array', () => {
    const result = parseWorkspaces('[{"id":"ws-1","name":"Personal"},{"id":"ws-2","name":"Team"}]');
    expect(result).toEqual([{ id: 'ws-1', name: 'Personal' }, { id: 'ws-2', name: 'Team' }]);
  });

  it('parses a JSON string containing { workspaces: [...] }', () => {
    const result = parseWorkspaces('{"workspaces":[{"id":"ws-1","name":"Personal"}]}');
    expect(result).toEqual([{ id: 'ws-1', name: 'Personal' }]);
  });

  it('accepts an already-parsed array (not just a JSON string)', () => {
    const result = parseWorkspaces([{ id: 'ws-1', name: 'Personal' }]);
    expect(result).toEqual([{ id: 'ws-1', name: 'Personal' }]);
  });

  it('falls back through alternate id/name field names', () => {
    const result = parseWorkspaces([{ workspace_id: 'ws-1', title: 'Personal' }, { uuid: 'ws-2', label: 'Team' }]);
    expect(result).toEqual([{ id: 'ws-1', name: 'Personal' }, { id: 'ws-2', name: 'Team' }]);
  });

  it('uses the id as the name when nothing name-like is present', () => {
    const result = parseWorkspaces([{ id: 'ws-1' }]);
    expect(result).toEqual([{ id: 'ws-1', name: 'ws-1' }]);
  });

  it('drops entries with no usable id', () => {
    const result = parseWorkspaces([{ name: 'No id here' }, { id: 'ws-1', name: 'Has id' }]);
    expect(result).toEqual([{ id: 'ws-1', name: 'Has id' }]);
  });

  it('returns an empty list for unparseable input instead of throwing', () => {
    expect(parseWorkspaces('not json')).toEqual([]);
    expect(parseWorkspaces(null)).toEqual([]);
    expect(parseWorkspaces(42)).toEqual([]);
    expect(parseWorkspaces('{"unrelated":true}')).toEqual([]);
  });
});

describe('generatePkce / generateState', () => {
  it('generates a code_verifier and its S256 code_challenge per RFC 7636', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('generates a different verifier/state on every call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
    expect(generateState()).not.toBe(generateState());
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds the /oauth/authorize URL with PKCE S256 and the svaramind scope', () => {
    const url = new URL(buildAuthorizeUrl({
      clientId: 'client-1', redirectUri: 'http://localhost:3000/svaramind/oauth/callback',
      codeChallenge: 'chal', state: 'st-1',
    }));
    expect(url.origin + url.pathname).toBe('https://api-be-svaramind.yesvara.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/svaramind/oauth/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('svaramind');
    expect(url.searchParams.get('state')).toBe('st-1');
  });
});

describe('registerOAuthClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to /oauth/register as a public client (no client secret) and returns the issued client_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ client_id: 'new-client-id' }) });
    vi.stubGlobal('fetch', fetchMock);

    const clientId = await registerOAuthClient('http://localhost:3000/svaramind/oauth/callback');

    expect(clientId).toBe('new-client-id');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-be-svaramind.yesvara.com/oauth/register');
    const body = JSON.parse(init.body);
    expect(body.redirect_uris).toEqual(['http://localhost:3000/svaramind/oauth/callback']);
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('throws a clear error when registration fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":"invalid_redirect_uri"}' }));
    await expect(registerOAuthClient('http://localhost:3000/svaramind/oauth/callback')).rejects.toThrow(/400/);
  });
});

describe('exchangeCodeForTokens / refreshTokens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exchangeCodeForTokens POSTs the authorization_code grant with the PKCE verifier', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const tokens = await exchangeCodeForTokens({ code: 'code-1', redirectUri: 'http://localhost:3000/svaramind/oauth/callback', codeVerifier: 'verifier-1', clientId: 'client-1' });

    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-be-svaramind.yesvara.com/oauth/token');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'http://localhost:3000/svaramind/oauth/callback', code_verifier: 'verifier-1', client_id: 'client-1' });
  });

  it('exchangeCodeForTokens throws a clear error on failure (e.g. PKCE mismatch)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }));
    await expect(exchangeCodeForTokens({ code: 'x', redirectUri: 'r', codeVerifier: 'v', clientId: 'c' })).rejects.toThrow(/400/);
  });

  it('refreshTokens POSTs the refresh_token grant', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await refreshTokens('old-refresh-token');

    expect(tokens.accessToken).toBe('at-2');
    expect(tokens.refreshToken).toBe('rt-2');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh-token' });
  });
});

describe('buildSvaramindConfig', () => {
  it('builds a streamable-http config with a Bearer access token and stores the refresh token + expiry for later reuse', () => {
    const config = buildSvaramindConfig({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1_800_000_000_000 }, 'client-1');
    expect(config.id).toBe('svaramind');
    expect(config.transport).toEqual({
      type: 'streamable-http',
      url: SVARAMIND_MCP_URL,
      headers: { Authorization: 'Bearer at-1' },
    });
    expect(config.oauth).toEqual({
      clientId: 'client-1',
      refreshToken: 'rt-1',
      tokenUrl: 'https://api-be-svaramind.yesvara.com/oauth/token',
      headerName: 'Authorization',
      expiresAt: 1_800_000_000_000,
    });
  });
});

describe('refreshSvaramindConfig', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints a fresh access token from the stored refresh token and rebuilds the transport headers when the current one is expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ access_token: 'fresh-at', refresh_token: 'rotated-rt', expires_in: 3600 }),
    }));

    const stale = buildSvaramindConfig({ accessToken: 'stale-at', refreshToken: 'old-rt', expiresAt: Date.now() - 1000 }, 'client-1');
    const refreshed = await refreshSvaramindConfig(stale);

    expect(refreshed.transport.type === 'streamable-http' && refreshed.transport.headers?.Authorization).toBe('Bearer fresh-at');
    expect(refreshed.oauth?.refreshToken).toBe('rotated-rt'); // the rotated token - the old one is now revoked server-side
  });

  it('refreshes when expiresAt is missing (a config saved before this field existed) rather than assuming it is still valid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ access_token: 'fresh-at', refresh_token: 'rotated-rt', expires_in: 3600 }),
    }));

    const legacy = buildSvaramindConfig({ accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: 0 }, 'client-1');
    delete (legacy.oauth as { expiresAt?: number }).expiresAt;
    const refreshed = await refreshSvaramindConfig(legacy);

    expect(refreshed).not.toBe(legacy);
    expect(refreshed.oauth?.refreshToken).toBe('rotated-rt');
  });

  it('skips the refresh (no network call, same object) when the current access token still has plenty of life left', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const fresh = buildSvaramindConfig({ accessToken: 'still-good-at', refreshToken: 'rt-1', expiresAt: Date.now() + 55 * 60 * 1000 }, 'client-1');
    const result = await refreshSvaramindConfig(fresh);

    expect(result).toBe(fresh); // same object reference - no refresh happened
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes when the current token is inside the 5-minute skew buffer, even though technically not expired yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ access_token: 'fresh-at', refresh_token: 'rotated-rt', expires_in: 3600 }),
    }));

    const almostExpired = buildSvaramindConfig({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60 * 1000 }, 'client-1');
    const result = await refreshSvaramindConfig(almostExpired);

    expect(result).not.toBe(almostExpired);
    expect(result.oauth?.refreshToken).toBe('rotated-rt');
  });

  it('returns the config unchanged when it has no oauth block (e.g. a manually-added server)', async () => {
    const config = { id: 'x', name: 'X', transport: { type: 'stdio' as const, command: 'echo' } };
    const result = await refreshSvaramindConfig(config);
    expect(result).toBe(config);
  });

  it('carries the pinned workspace over across a refresh, instead of silently dropping it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ access_token: 'fresh-at', refresh_token: 'rotated-rt', expires_in: 3600 }),
    }));

    const withWorkspace: ReturnType<typeof buildSvaramindConfig> = {
      ...buildSvaramindConfig({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() - 1000 }, 'client-1'),
      pinnedParams: { workspace_id: 'ws-123' },
    };
    const refreshed = await refreshSvaramindConfig(withWorkspace);

    expect(refreshed.pinnedParams).toEqual({ workspace_id: 'ws-123' });
    expect(refreshed.oauth?.refreshToken).toBe('rotated-rt');
  });
});

describe('listSvaramindWorkspaces / setSvaramindWorkspace', () => {
  it('listSvaramindWorkspaces calls svaramind_list_workspaces on the svaramind server id and parses the result', async () => {
    const mcpManager = { callToolDirect: vi.fn().mockResolvedValue('[{"id":"ws-1","name":"Personal"}]') } as unknown as McpManager;
    const result = await listSvaramindWorkspaces(mcpManager);
    expect(mcpManager.callToolDirect).toHaveBeenCalledWith('svaramind', 'svaramind_list_workspaces');
    expect(result).toEqual([{ id: 'ws-1', name: 'Personal' }]);
  });

  it('setSvaramindWorkspace pins workspace_id on the svaramind server', () => {
    const pinParameter = vi.fn().mockReturnValue({ id: 'svaramind', pinnedParams: { workspace_id: 'ws-1' } });
    const mcpManager = { pinParameter } as unknown as McpManager;
    const status = setSvaramindWorkspace(mcpManager, 'ws-1');
    expect(pinParameter).toHaveBeenCalledWith('svaramind', 'workspace_id', 'ws-1');
    expect(status.pinnedParams).toEqual({ workspace_id: 'ws-1' });
  });
});
