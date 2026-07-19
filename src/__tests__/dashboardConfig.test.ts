import { describe, it, expect } from 'vitest';
import { redactSecrets, mergeConfigUpdates } from '../dashboard/serve.js';

describe('redactSecrets', () => {
  it('redacts known secret keys but leaves everything else intact', () => {
    const result = redactSecrets({
      name: 'My Bot',
      channels: { telegram: { token: 'abc123' } },
      llm: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    });
    expect(result).toEqual({
      name: 'My Bot',
      channels: { telegram: { token: '[set]' } },
      llm: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }, // apiKeyEnv is a var *name*, not a secret
    });
  });

  it('leaves an unset (empty string) secret field alone rather than marking it "[set]"', () => {
    const result = redactSecrets({ channels: { telegram: { token: '' } } });
    expect(result).toEqual({ channels: { telegram: { token: '' } } });
  });

  it('redacts llm.apiKeyEnv when it looks like a real key pasted by mistake, not a variable name', () => {
    const result = redactSecrets({
      llm: { provider: 'openai', apiKeyEnv: 'this-looks-like-a-pasted-secret-not-an-env-var-name-1234567890' },
    });
    expect(result).toEqual({ llm: { provider: 'openai', apiKeyEnv: '[set]' } });
  });

  it('leaves a valid-looking env var name in apiKeyEnv untouched', () => {
    const result = redactSecrets({ llm: { apiKeyEnv: 'OPENROUTER_API_KEY' } });
    expect(result).toEqual({ llm: { apiKeyEnv: 'OPENROUTER_API_KEY' } });
    const result2 = redactSecrets({ llm: { apiKeyEnv: '_MY_KEY_2' } });
    expect(result2).toEqual({ llm: { apiKeyEnv: '_MY_KEY_2' } });
  });

  it('redacts every value inside an MCP server\'s transport.headers, regardless of the header name', () => {
    const result = redactSecrets({
      mcpServers: [{
        id: 'svaramind',
        name: 'Svaramind',
        transport: { type: 'streamable-http', url: 'https://api-be-svaramind.yesvara.com/mcp', headers: { Authorization: 'Bearer sk-abc', 'X-Custom': 'also-secret' } },
      }],
    });
    expect(result).toEqual({
      mcpServers: [{
        id: 'svaramind',
        name: 'Svaramind',
        transport: { type: 'streamable-http', url: 'https://api-be-svaramind.yesvara.com/mcp', headers: { Authorization: '[set]', 'X-Custom': '[set]' } },
      }],
    });
  });

  it('redacts every value inside an MCP server\'s transport.env', () => {
    const result = redactSecrets({
      mcpServers: [{ id: 'x', name: 'X', transport: { type: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'ghp_abc' } } }],
    });
    expect(result).toEqual({
      mcpServers: [{ id: 'x', name: 'X', transport: { type: 'stdio', command: 'npx', env: { GITHUB_TOKEN: '[set]' } } }],
    });
  });

  it('redacts an MCP server\'s stored OAuth refresh token (e.g. Svaramind) but leaves clientId/tokenUrl alone', () => {
    const result = redactSecrets({
      mcpServers: [{
        id: 'svaramind', name: 'Svaramind',
        transport: { type: 'streamable-http', url: 'https://api-be-svaramind.yesvara.com/mcp', headers: { Authorization: 'Bearer at-1' } },
        oauth: { clientId: 'client-1', refreshToken: 'rt-1', tokenUrl: 'https://api-be-svaramind.yesvara.com/oauth/token', headerName: 'Authorization' },
      }],
    });
    expect(result).toEqual({
      mcpServers: [{
        id: 'svaramind', name: 'Svaramind',
        transport: { type: 'streamable-http', url: 'https://api-be-svaramind.yesvara.com/mcp', headers: { Authorization: '[set]' } },
        oauth: { clientId: 'client-1', refreshToken: '[set]', tokenUrl: 'https://api-be-svaramind.yesvara.com/oauth/token', headerName: 'Authorization' },
      }],
    });
  });

  it('redacts Slack and Discord secret fields', () => {
    const result = redactSecrets({
      channels: {
        slack: { botToken: 'xoxb-abc', signingSecret: 'sec' },
        discord: { botToken: 'discord-tok' },
      },
    });
    expect(result).toEqual({
      channels: {
        slack: { botToken: '[set]', signingSecret: '[set]' },
        discord: { botToken: '[set]' },
      },
    });
  });
});

describe('mergeConfigUpdates', () => {
  it('shallow-merges top-level fields', () => {
    const merged = mergeConfigUpdates({ name: 'Old', port: 3000 }, { name: 'New' });
    expect(merged).toEqual({ name: 'New', port: 3000 });
  });

  it('preserves a rich tool config object when the form just re-enables it with true', () => {
    const current = { tools: { filesystem: { rootDir: './workspace' } } };
    const updates = { tools: { filesystem: true, terminal: true } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.tools).toEqual({ filesystem: { rootDir: './workspace' }, terminal: true });
  });

  it('disables a tool when the form sets it to false, even if it had a rich config', () => {
    const current = { tools: { filesystem: { rootDir: './workspace' } } };
    const updates = { tools: { filesystem: false } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.tools).toEqual({ filesystem: false });
  });

  it('merges llm overrides on top of existing ones instead of replacing the whole object', () => {
    const current = { llm: { provider: 'openai', baseURL: 'https://old.example' } };
    const updates = { llm: { baseURL: 'https://openrouter.ai/api/v1' } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.llm).toEqual({ provider: 'openai', baseURL: 'https://openrouter.ai/api/v1' });
  });

  it('treats a "[set]" embeddings.apiKey as "keep the existing secret" instead of overwriting it with the literal placeholder', () => {
    const current = { embeddings: { provider: 'openai', apiKey: 'sk-real-embeddings-key' } };
    const updates = { embeddings: { provider: 'ollama', apiKey: '[set]', model: 'nomic-embed-text' } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.embeddings).toEqual({ provider: 'ollama', apiKey: 'sk-real-embeddings-key', model: 'nomic-embed-text' });
  });

  it('treats a "[set]" llm.apiKey as "keep the existing secret" instead of overwriting it with the literal placeholder', () => {
    const current = { llm: { provider: 'openai', apiKey: 'sk-real-secret' } };
    const updates = { llm: { provider: 'openai', apiKey: '[set]', baseURL: 'https://openrouter.ai/api/v1' } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.llm).toEqual({ provider: 'openai', apiKey: 'sk-real-secret', baseURL: 'https://openrouter.ai/api/v1' });
  });

  it('still overwrites llm.apiKey when the submitted value is a real (non-placeholder) string', () => {
    const current = { llm: { apiKey: 'old-key' } };
    const updates = { llm: { apiKey: 'new-key' } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.llm).toEqual({ apiKey: 'new-key' });
  });

  it('merges channels updates on top of existing ones', () => {
    const current = { channels: { telegram: { token: 'abc' } } };
    const updates = { channels: { whatsapp: { token: 'xyz' } } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.channels).toEqual({ telegram: { token: 'abc' }, whatsapp: { token: 'xyz' } });
  });

  it('deep-merges an individual channel field instead of replacing the whole channel object', () => {
    const current = { channels: { whatsapp: { token: 'abc', phoneId: 'p1', verifyToken: 'v1' } } };
    const updates = { channels: { whatsapp: { phoneId: 'p2' } } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.channels).toEqual({ whatsapp: { token: 'abc', phoneId: 'p2', verifyToken: 'v1' } });
  });

  it('clears a channel array field (e.g. telegram.allowedUserIds) when the update submits an explicit empty array', () => {
    const current = { channels: { telegram: { token: 'abc', allowedUserIds: ['111', '222'] } } };
    const updates = { channels: { telegram: { token: '[set]', allowedUserIds: [] } } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.channels).toEqual({ telegram: { token: 'abc', allowedUserIds: [] } });
  });

  it('treats a "[set]" field value as "keep the existing secret" instead of overwriting it', () => {
    const current = { channels: { slack: { botToken: 'xoxb-real', signingSecret: 'real-secret' } } };
    const updates = { channels: { slack: { botToken: '[set]', signingSecret: '[set]' } } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.channels).toEqual({ slack: { botToken: 'xoxb-real', signingSecret: 'real-secret' } });
  });

  it('still overwrites a secret field when the submitted value is a real (non-placeholder) string', () => {
    const current = { channels: { discord: { botToken: 'old-token' } } };
    const updates = { channels: { discord: { botToken: 'new-token' } } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.channels).toEqual({ discord: { botToken: 'new-token' } });
  });

  it('treats a "[set]" top-level apiKey as "keep the existing secret" instead of overwriting it', () => {
    const current = { apiKey: 'real-chat-api-key' };
    const updates = { apiKey: '[set]' };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.apiKey).toBe('real-chat-api-key');
  });

  it('still overwrites apiKey when the submitted value is a real (non-placeholder) string', () => {
    const current = { apiKey: 'old-key' };
    const updates = { apiKey: 'new-key' };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.apiKey).toBe('new-key');
  });

  it('treats a "[set]" dashboard.token as "keep the existing secret" instead of overwriting it', () => {
    const current = { dashboard: { token: 'real-dashboard-token' } };
    const updates = { dashboard: { token: '[set]' } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.dashboard).toEqual({ token: 'real-dashboard-token' });
  });

  it('sets dashboard.token from a bare `true` (no prior token) without crashing', () => {
    const current = { dashboard: true };
    const updates = { dashboard: { token: 'new-token' } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.dashboard).toEqual({ token: 'new-token' });
  });

  it('a literal null for a channel disconnects it (omits the key) instead of writing null', () => {
    const current = { channels: { discord: { botToken: 'real-token' }, telegram: { token: 'abc' } } };
    const updates = { channels: { discord: null } };
    const merged = mergeConfigUpdates(current, updates);
    expect(merged.channels).toEqual({ telegram: { token: 'abc' } });
    expect((merged.channels as Record<string, unknown>).discord).toBeUndefined();
    expect('discord' in (merged.channels as Record<string, unknown>)).toBe(false);
  });
});
