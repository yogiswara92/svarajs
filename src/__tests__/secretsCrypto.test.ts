import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getOrCreateKey, encryptSecret, decryptSecret, isEncryptedSecret } from '../security/secretsCrypto.js';

describe('secretsCrypto', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-crypto-'));
    configPath = path.join(dir, 'svara.config.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips a plaintext secret through encrypt/decrypt', () => {
    const key = getOrCreateKey(configPath);
    const ciphertext = encryptSecret('xoxb-real-token', key);
    expect(ciphertext).not.toContain('xoxb-real-token');
    expect(isEncryptedSecret(ciphertext)).toBe(true);
    expect(decryptSecret(ciphertext, key)).toBe('xoxb-real-token');
  });

  it('produces different ciphertext for the same plaintext each time (random IV)', () => {
    const key = getOrCreateKey(configPath);
    const a = encryptSecret('same-value', key);
    const b = encryptSecret('same-value', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('same-value');
    expect(decryptSecret(b, key)).toBe('same-value');
  });

  it('never double-encrypts an already-encrypted value', () => {
    const key = getOrCreateKey(configPath);
    const once = encryptSecret('a-secret', key);
    const twice = encryptSecret(once, key);
    expect(twice).toBe(once);
  });

  it('leaves a plaintext (non-prefixed) value unchanged on decrypt - legacy/back-compat passthrough', () => {
    const key = getOrCreateKey(configPath);
    expect(decryptSecret('plain-legacy-token', key)).toBe('plain-legacy-token');
  });

  it('persists the key to .svara/secrets.key next to the config, reused across calls', async () => {
    const key1 = getOrCreateKey(configPath);
    const keyFile = path.join(dir, '.svara', 'secrets.key');
    await expect(fs.access(keyFile)).resolves.toBeUndefined();

    // A fresh read (simulating a new process) should recover the same key from disk.
    const persisted = await fs.readFile(keyFile, 'utf-8');
    expect(Buffer.from(persisted.trim(), 'hex')).toEqual(key1);
  });

  it('fails to decrypt with a different key (wrong-key / tampered detection via GCM auth tag)', () => {
    const key = getOrCreateKey(configPath);
    const otherConfigPath = path.join(dir, 'other', 'svara.config.json');
    const otherKey = getOrCreateKey(otherConfigPath);
    const ciphertext = encryptSecret('secret-value', key);
    expect(() => decryptSecret(ciphertext, otherKey)).toThrow();
  });
});
