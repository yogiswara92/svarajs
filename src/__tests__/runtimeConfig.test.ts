import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadRuntimeConfig, readRawConfig, saveRuntimeConfig } from '../runtime/config.js';

describe('loadRuntimeConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-runtime-config-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(content: unknown): Promise<string> {
    const file = path.join(dir, 'svara.config.json');
    await fs.writeFile(file, JSON.stringify(content), 'utf-8');
    return file;
  }

  it('loads a minimal valid config and fills in defaults', async () => {
    const file = await writeConfig({ model: 'gpt-4o-mini' });
    const config = await loadRuntimeConfig(file);
    expect(config.model).toBe('gpt-4o-mini');
    expect(config.name).toBe('Svara Assistant');
    expect(config.port).toBe(3000);
    expect(config.dashboard).toBe(true);
    expect(config.tools).toEqual({});
    expect(config.cron).toEqual([]);
  });

  it('rejects a config missing the required "model" field', async () => {
    const file = await writeConfig({ name: 'no model here' });
    await expect(loadRuntimeConfig(file)).rejects.toThrow(/model/);
  });

  it('rejects invalid JSON with a clear error', async () => {
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, '{ not json', 'utf-8');
    await expect(loadRuntimeConfig(file)).rejects.toThrow(/not valid JSON/);
  });

  it('reports a clear error when the file does not exist', async () => {
    await expect(loadRuntimeConfig(path.join(dir, 'missing.json'))).rejects.toThrow(/Could not read config file/);
  });

  it('preserves explicit tool/channel/cron configuration', async () => {
    const file = await writeConfig({
      model: 'gpt-4o-mini',
      tools: { terminal: true, filesystem: { rootDir: './workspace' } },
      channels: {
        telegram: { token: 'abc' },
        slack: { botToken: 'xoxb-abc', signingSecret: 'sec' },
        discord: { botToken: 'discord-tok' },
      },
      cron: [{ schedule: '0 9 * * *', prompt: 'daily report' }],
    });
    const config = await loadRuntimeConfig(file);
    expect(config.tools.terminal).toBe(true);
    expect(config.tools.filesystem).toEqual({ rootDir: './workspace' });
    expect(config.channels.telegram).toEqual({ token: 'abc' });
    expect(config.channels.slack).toEqual({ botToken: 'xoxb-abc', signingSecret: 'sec' });
    expect(config.channels.discord).toEqual({ botToken: 'discord-tok' });
    expect(config.cron).toHaveLength(1);
  });

  it('accepts an llm override for a custom OpenAI-compatible endpoint (e.g. OpenRouter)', async () => {
    const file = await writeConfig({
      model: 'openrouter/some-model',
      llm: { provider: 'openai', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
    });
    const config = await loadRuntimeConfig(file);
    expect(config.llm).toEqual({ provider: 'openai', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' });
  });

  it('rejects an unknown llm.provider value', async () => {
    const file = await writeConfig({ model: 'gpt-4o-mini', llm: { provider: 'bogus' } });
    await expect(loadRuntimeConfig(file)).rejects.toThrow();
  });
});

describe('readRawConfig / saveRuntimeConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-runtime-config-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('readRawConfig returns {} when the file does not exist, instead of throwing', async () => {
    const raw = await readRawConfig(path.join(dir, 'missing.json'));
    expect(raw).toEqual({});
  });

  it('saveRuntimeConfig validates before writing and rejects an invalid config', async () => {
    const file = path.join(dir, 'svara.config.json');
    await expect(saveRuntimeConfig(file, { name: 'no model' })).rejects.toThrow();
    await expect(fs.access(file)).rejects.toThrow(); // nothing was written
  });

  it('saveRuntimeConfig writes the raw object as-is (no defaults injected) and readRawConfig reads it back', async () => {
    const file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, { model: 'gpt-4o-mini', name: 'My Bot' });
    const raw = await readRawConfig(file);
    expect(raw).toEqual({ model: 'gpt-4o-mini', name: 'My Bot' });
    expect(raw.port).toBeUndefined(); // no default port injected into the file
  });

  it('round-trips through loadRuntimeConfig after a save', async () => {
    const file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, { model: 'gpt-4o-mini', tools: { terminal: true } });
    const loaded = await loadRuntimeConfig(file);
    expect(loaded.model).toBe('gpt-4o-mini');
    expect(loaded.tools.terminal).toBe(true);
    expect(loaded.port).toBe(3000); // defaults still apply on load, just not written to disk
  });

  it('encrypts secret fields at rest, but loadRuntimeConfig decrypts them back to plaintext', async () => {
    const file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, {
      model: 'gpt-4o-mini',
      channels: { slack: { botToken: 'xoxb-real-secret', signingSecret: 'real-signing-secret' } },
    });

    const onDisk = await fs.readFile(file, 'utf-8');
    expect(onDisk).not.toContain('xoxb-real-secret');
    expect(onDisk).not.toContain('real-signing-secret');
    expect(onDisk).toContain('enc:v1:');

    const loaded = await loadRuntimeConfig(file);
    expect(loaded.channels.slack).toEqual({ botToken: 'xoxb-real-secret', signingSecret: 'real-signing-secret' });
  });

  it('encrypts llm.apiKeyEnv at rest when it looks like a real key pasted by mistake instead of a variable name', async () => {
    const file = path.join(dir, 'svara.config.json');
    const pastedKey = 'this-looks-like-a-pasted-secret-not-an-env-var-name-1234567890';
    await saveRuntimeConfig(file, { model: 'gpt-4o-mini', llm: { provider: 'openai', apiKeyEnv: pastedKey } });

    const onDisk = await fs.readFile(file, 'utf-8');
    expect(onDisk).not.toContain(pastedKey);
    expect(onDisk).toContain('enc:v1:');

    const loaded = await loadRuntimeConfig(file);
    expect(loaded.llm?.apiKeyEnv).toBe(pastedKey);
  });

  it('encrypts an MCP server\'s transport.headers values at rest (e.g. a Svaramind/remote server\'s Authorization header)', async () => {
    const file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, {
      model: 'gpt-4o-mini',
      mcpServers: [{
        id: 'svaramind', name: 'Svaramind',
        transport: { type: 'streamable-http', url: 'https://api-be-svaramind.yesvara.com/mcp', headers: { Authorization: 'Bearer real-svaramind-key' } },
      }],
    });

    const onDisk = await fs.readFile(file, 'utf-8');
    expect(onDisk).not.toContain('real-svaramind-key');
    expect(onDisk).toContain('enc:v1:');

    const loaded = await loadRuntimeConfig(file);
    const server = loaded.mcpServers[0];
    expect(server.transport.type === 'streamable-http' && server.transport.headers?.Authorization).toBe('Bearer real-svaramind-key');
  });

  it('encrypts llm.apiKey at rest when set directly (the AI Provider page\'s "API key" field)', async () => {
    const file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, { model: 'gpt-4o-mini', llm: { provider: 'openai', apiKey: 'sk-real-direct-key' } });

    const onDisk = await fs.readFile(file, 'utf-8');
    expect(onDisk).not.toContain('sk-real-direct-key');
    expect(onDisk).toContain('enc:v1:');

    const loaded = await loadRuntimeConfig(file);
    expect(loaded.llm?.apiKey).toBe('sk-real-direct-key');
  });

  it('does not encrypt a valid-looking env var name in llm.apiKeyEnv', async () => {
    const file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, { model: 'gpt-4o-mini', llm: { apiKeyEnv: 'OPENROUTER_API_KEY' } });
    const onDisk = await fs.readFile(file, 'utf-8');
    expect(onDisk).toContain('OPENROUTER_API_KEY');
    expect(onDisk).not.toContain('enc:v1:');
  });

  it('readRawConfig returns the raw (still-encrypted) value - decryption is loadRuntimeConfig-only', async () => {
    const file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, { model: 'gpt-4o-mini', channels: { discord: { botToken: 'discord-real-token' } } });
    const raw = await readRawConfig(file);
    const rawToken = (raw.channels as { discord: { botToken: string } }).discord.botToken;
    expect(rawToken).not.toBe('discord-real-token');
    expect(rawToken).toMatch(/^enc:v1:/);
  });

  it('does not re-encrypt (or corrupt) an already-encrypted value on a second save', async () => {
    const file = path.join(dir, 'svara.config.json');
    await saveRuntimeConfig(file, { model: 'gpt-4o-mini', channels: { discord: { botToken: 'discord-token' } } });
    const raw1 = await readRawConfig(file);

    // Simulate the dashboard's save flow: re-save with the same (already-encrypted) value untouched.
    await saveRuntimeConfig(file, raw1);
    const raw2 = await readRawConfig(file);
    expect(raw2.channels).toEqual(raw1.channels);

    const loaded = await loadRuntimeConfig(file);
    expect(loaded.channels.discord).toEqual({ botToken: 'discord-token' });
  });

  it('still loads a legacy plaintext config unchanged (secrets were never encrypted before this feature)', async () => {
    const file = path.join(dir, 'svara.config.json');
    await fs.writeFile(file, JSON.stringify({ model: 'gpt-4o-mini', channels: { telegram: { token: 'plain-legacy-token' } } }), 'utf-8');
    const loaded = await loadRuntimeConfig(file);
    expect(loaded.channels.telegram).toEqual({ token: 'plain-legacy-token' });
  });
});
