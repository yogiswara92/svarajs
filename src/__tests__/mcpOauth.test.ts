import { describe, it, expect, vi, afterEach } from 'vitest';
import { oauthServerConfig, refreshOAuthConfig, needsRefresh } from '../mcp/oauth.js';

afterEach(() => vi.unstubAllGlobals());

const base = { id: 'notion', name: 'Notion', clientId: 'c1', tokenUrl: 'https://auth.example/token', resource: 'https://mcp.example/mcp' };

describe('MCP OAuth connections', () => {
  it('builds an SSE or streamable connection with the bearer token', () => {
    const sse = oauthServerConfig({ ...base, url: 'https://mcp.asana.com/sse', tokens: { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 } });
    const http = oauthServerConfig({ ...base, url: 'https://mcp.notion.com/mcp', tokens: { accessToken: 'a1' } });
    expect(sse.transport).toMatchObject({ type: 'sse', headers: { Authorization: 'Bearer a1' } });
    expect(http.transport.type).toBe('streamable-http');
    expect(sse.oauth).toMatchObject({ standard: true, refreshToken: 'r1', resource: 'https://mcp.example/mcp' });
  });

  it('renews an expiring token with a form-encoded request and keeps the rotated refresh token', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
      expect(init.body.get('grant_type')).toBe('refresh_token');
      expect(init.body.get('resource')).toBe('https://mcp.example/mcp');
      return new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const expiring = oauthServerConfig({ ...base, url: 'https://mcp.notion.com/mcp', tokens: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 1000 } });
    expect(needsRefresh(expiring)).toBe(true);
    const renewed = await refreshOAuthConfig(expiring);
    expect(renewed).not.toBe(expiring);
    expect(renewed.transport).toMatchObject({ headers: { Authorization: 'Bearer a2' } });
    expect(renewed.oauth).toMatchObject({ refreshToken: 'r2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a fresh token alone', async () => {
    const fresh = oauthServerConfig({ ...base, url: 'https://mcp.notion.com/mcp', tokens: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 } });
    expect(await refreshOAuthConfig(fresh)).toBe(fresh);
  });
});
