/**
 * @module security/secretsCrypto
 * SvaraJS - at-rest encryption for secrets written to svara.config.json
 * (channel tokens, signing secrets, the dashboard bearer token, ...).
 *
 * Threat model, stated plainly (see also SECURITY.md): this protects against
 * the config file being read, committed, backed up, or displayed on its own
 * (e.g. an accidental `git add -f`, a support screenshot, a config-only
 * backup tool). It does NOT protect against an attacker with full
 * filesystem access on the same machine - the key lives right next to the
 * file it encrypts (`.svara/secrets.key`, gitignored, 0600). That's the
 * honest ceiling for a local single-tenant tool with no external KMS.
 *
 * Values are prefixed `enc:v1:` so encrypt/decrypt can tell an already-
 * encrypted value from a plaintext one and never double-encrypt - and so
 * existing plaintext configs (written before this feature existed, or by
 * hand) keep loading unchanged until the next save re-writes them.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import fs from 'fs';
import path from 'path';

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedKey: { path: string; key: Buffer } | null = null;

function keyPathFor(configPath: string): string {
  return path.join(path.dirname(path.resolve(configPath)), '.svara', 'secrets.key');
}

/** Reads the project's local encryption key, generating one on first use. */
export function getOrCreateKey(configPath: string): Buffer {
  const resolvedKeyPath = keyPathFor(configPath);
  if (cachedKey?.path === resolvedKeyPath) return cachedKey.key;

  let key: Buffer;
  try {
    key = Buffer.from(fs.readFileSync(resolvedKeyPath, 'utf-8').trim(), 'hex');
    if (key.length !== KEY_BYTES) throw new Error('bad length');
  } catch {
    key = randomBytes(KEY_BYTES);
    fs.mkdirSync(path.dirname(resolvedKeyPath), { recursive: true });
    fs.writeFileSync(resolvedKeyPath, key.toString('hex'), { mode: 0o600 });
  }

  cachedKey = { path: resolvedKeyPath, key };
  return key;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (isEncryptedSecret(plaintext)) return plaintext; // already encrypted - never double-encrypt
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Decrypts an `enc:v1:`-prefixed value; returns non-prefixed (legacy plaintext) values unchanged. */
export function decryptSecret(value: string, key: Buffer): string {
  if (!isEncryptedSecret(value)) return value;
  const [ivB64, authTagB64, ciphertextB64] = value.slice(PREFIX.length).split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('[SvaraJS] Malformed encrypted secret in config file.');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf-8');
}
