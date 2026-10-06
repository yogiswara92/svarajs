/**
 * @module dashboard/auth
 * Email + password login for the dashboard.
 *
 * - Passwords are hashed with scrypt (Node built-in, no extra dependency).
 * - A successful login sets a signed, HttpOnly cookie (stateless HMAC token
 *   with an expiry) - nothing is stored server-side, so sessions survive
 *   nothing but also need no database. Rotating `.svara/session.key` logs
 *   everyone out.
 * - Failed logins are rate limited per (ip + email) and per email.
 * - Users live in `svara.config.json` under `dashboard.users` and are read
 *   fresh on every login, so `svara user add` takes effect without a restart.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';

export interface DashboardUser {
  email: string;
  passwordHash: string;
}

export const SESSION_COOKIE = 'svara_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 10;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return 'Password is too long.';
  return null;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Verified against when the email is unknown, so a login attempt costs the same
// time whether or not the account exists.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/** Returns the matching user, or null. Always spends one scrypt verification. */
export function authenticate(users: DashboardUser[], email: string, password: string): DashboardUser | null {
  const wanted = normalizeEmail(email);
  const user = users.find((u) => normalizeEmail(u.email) === wanted) ?? null;
  const ok = verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
  return user && ok ? user : null;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Loads (or creates, mode 600) the HMAC key used to sign session cookies. */
export function loadSessionKey(configDir?: string): Buffer {
  if (!configDir) return crypto.randomBytes(32); // library mode: per-process key
  const dir = path.join(configDir, '.svara');
  const file = path.join(dir, 'session.key');
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) return existing;
  } catch {
    // fall through and create
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** Short fingerprint of a user's password hash - changing the password (or deleting the user) invalidates their sessions. */
export function userFingerprint(user: DashboardUser): string {
  return crypto.createHash('sha256').update(user.passwordHash).digest('hex').slice(0, 16);
}

export function createSessionToken(key: Buffer, user: DashboardUser, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ e: normalizeEmail(user.email), f: userFingerprint(user), exp: now + SESSION_TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', key).update(payload).digest());
  return `${payload}.${sig}`;
}

export function readSessionToken(key: Buffer, token: string | undefined, now = Date.now()): { email: string; fingerprint: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { e?: string; f?: string; exp?: number };
    if (!data.e || !data.f || typeof data.exp !== 'number' || data.exp < now) return null;
    return { email: data.e, fingerprint: data.f };
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(idx + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

export function isHttps(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return req.secure || proto === 'https';
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isHttps(req)) flags.push('Secure');
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${flags.join('; ')}`);
}

export function clearSessionCookie(req: Request, res: Response): void {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) flags.push('Secure');
  res.append('Set-Cookie', `${SESSION_COOKIE}=; ${flags.join('; ')}`);
}

/**
 * CSRF guard for cookie-authenticated, state-changing requests: the browser's
 * Origin header must match the host being served. SameSite=Lax already blocks
 * cross-site POSTs; this is the second layer.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) and same-origin GETs send none
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// ── Login rate limiting ─────────────────────────────────────────────────────

interface Bucket { count: number; resetAt: number }

export class LoginLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly rules: Array<{ prefix: string; max: number; windowMs: number }> = [
      { prefix: 'ip', max: 5, windowMs: 15 * 60 * 1000 },
      { prefix: 'email', max: 20, windowMs: 60 * 60 * 1000 },
    ],
  ) {}

  private keys(ip: string, email: string): Array<[string, { max: number; windowMs: number }]> {
    return this.rules.map((r) => [r.prefix === 'ip' ? `ip:${ip}|${email}` : `email:${email}`, r]);
  }

  /** Seconds until the caller may try again, or 0 if allowed. */
  retryAfter(ip: string, email: string, now = Date.now()): number {
    let wait = 0;
    for (const [key, rule] of this.keys(ip, email)) {
      const b = this.buckets.get(key);
      if (b && b.resetAt > now && b.count >= rule.max) wait = Math.max(wait, Math.ceil((b.resetAt - now) / 1000));
    }
    return wait;
  }

  fail(ip: string, email: string, now = Date.now()): void {
    for (const [key, rule] of this.keys(ip, email)) {
      const b = this.buckets.get(key);
      if (!b || b.resetAt <= now) this.buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      else b.count += 1;
    }
    if (this.buckets.size > 5000) this.prune(now);
  }

  success(ip: string, email: string): void {
    this.buckets.delete(`ip:${ip}|${email}`);
  }

  private prune(now: number): void {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}

/** Client IP as seen behind a reverse proxy (nginx sets X-Real-IP / X-Forwarded-For). */
export function clientIp(req: Request): string {
  const real = req.headers['cf-connecting-ip'] ?? req.headers['x-real-ip'];
  if (real) return String(real).split(',')[0].trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

// ── First-run setup codes ───────────────────────────────────────────────────

/**
 * One-time code proving the person creating the first account controls the
 * server or the owner's Telegram (it is delivered out-of-band, never shown in
 * the browser). 8 digits, valid 10 minutes, burned after 5 wrong guesses.
 */
export class SetupCodes {
  private current: { hash: Buffer; expiresAt: number; attempts: number } | null = null;

  static readonly TTL_MS = 10 * 60 * 1000;
  static readonly MAX_ATTEMPTS = 5;

  private static digest(code: string): Buffer {
    return crypto.createHash('sha256').update(code.replace(/\D/g, '')).digest();
  }

  /** Issues a fresh code (replacing any previous one) and returns it as "1234-5678". */
  issue(now = Date.now()): string {
    const raw = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    this.current = { hash: SetupCodes.digest(raw), expiresAt: now + SetupCodes.TTL_MS, attempts: 0 };
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  /** True once, for the right unexpired code. Wrong guesses count; too many burn the code. */
  consume(code: string, now = Date.now()): boolean {
    const c = this.current;
    if (!c || c.expiresAt <= now) { this.current = null; return false; }
    c.attempts += 1;
    if (c.attempts > SetupCodes.MAX_ATTEMPTS) { this.current = null; return false; }
    const given = SetupCodes.digest(String(code ?? ''));
    if (given.length === c.hash.length && crypto.timingSafeEqual(given, c.hash)) {
      this.current = null;
      return true;
    }
    return false;
  }
}
