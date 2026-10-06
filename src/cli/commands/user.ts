/**
 * @module cli/commands/user
 * `svara user add|passwd|remove|list` - manage dashboard login accounts stored
 * (as scrypt hashes, never plaintext) in `dashboard.users` of svara.config.json.
 * The running server reads the file live, so no restart is needed.
 */

import readline from 'readline';
import { readRawConfig, saveRuntimeConfig } from '../../runtime/config.js';
import {
  type DashboardUser, hashPassword, isValidEmail, normalizeEmail, validatePasswordStrength,
} from '../../dashboard/auth.js';

interface UserOpts { config: string; password?: string; force?: boolean }

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

async function load(configPath: string): Promise<{ raw: Record<string, unknown>; dash: Record<string, unknown>; users: DashboardUser[] }> {
  const raw = await readRawConfig(configPath);
  // `dashboard: true` (the default) becomes an object once an account exists.
  const dash = isPlain(raw.dashboard) ? { ...raw.dashboard } : {};
  const users = Array.isArray(dash.users) ? (dash.users as DashboardUser[]) : [];
  return { raw, dash, users };
}

async function save(configPath: string, raw: Record<string, unknown>, dash: Record<string, unknown>, users: DashboardUser[]): Promise<void> {
  const next = { ...dash };
  if (users.length) next.users = users; else delete next.users;
  await saveRuntimeConfig(configPath, { ...raw, dashboard: Object.keys(next).length ? next : true });
}

/** Reads a line without echoing it (falls back to a plain prompt when stdin is not a TTY). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout as NodeJS.WriteStream;
    const origWrite = out.write.bind(out);
    let muted = false;
    (out as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk, ...rest) =>
      muted ? true : (origWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    rl.question(question, (answer) => {
      muted = false;
      out.write = origWrite;
      rl.close();
      origWrite('\n');
      resolve(answer);
    });
    muted = true;
    origWrite(''); // keep the prompt visible: it was written before muting
  });
}

async function askNewPassword(provided?: string): Promise<string> {
  if (provided) {
    const weak = validatePasswordStrength(provided);
    if (weak) throw new Error(weak);
    return provided;
  }
  const first = await promptHidden('New password: ');
  const weak = validatePasswordStrength(first);
  if (weak) throw new Error(weak);
  const second = await promptHidden('Repeat password: ');
  if (first !== second) throw new Error('Passwords do not match.');
  return first;
}

export async function userAdd(email: string, opts: UserOpts): Promise<void> {
  const e = normalizeEmail(email);
  if (!isValidEmail(e)) throw new Error(`"${email}" is not a valid email address.`);
  const { raw, dash, users } = await load(opts.config);
  if (users.some((u) => normalizeEmail(u.email) === e)) throw new Error(`${e} already exists. Use "svara user passwd" to change the password.`);
  const password = await askNewPassword(opts.password);
  await save(opts.config, raw, dash, [...users, { email: e, passwordHash: hashPassword(password) }]);
  console.log(`Added ${e}. Password login is now enabled for the dashboard.`);
}

export async function userPasswd(email: string, opts: UserOpts): Promise<void> {
  const e = normalizeEmail(email);
  const { raw, dash, users } = await load(opts.config);
  if (!users.some((u) => normalizeEmail(u.email) === e)) throw new Error(`No user ${e}.`);
  const password = await askNewPassword(opts.password);
  await save(opts.config, raw, dash, users.map((u) => (normalizeEmail(u.email) === e ? { ...u, passwordHash: hashPassword(password) } : u)));
  console.log(`Password updated for ${e}. Their existing sessions are signed out.`);
}

export async function userRemove(email: string, opts: UserOpts): Promise<void> {
  const e = normalizeEmail(email);
  const { raw, dash, users } = await load(opts.config);
  if (!users.some((u) => normalizeEmail(u.email) === e)) throw new Error(`No user ${e}.`);
  const rest = users.filter((u) => normalizeEmail(u.email) !== e);
  if (!rest.length && !dash.token && !opts.force) {
    throw new Error(`${e} is the last account and no access token is set: removing it would leave the dashboard OPEN to anyone who can reach it. Add another account first, or pass --force.`);
  }
  await save(opts.config, raw, dash, rest);
  console.log(`Removed ${e}.`);
  if (!rest.length) console.log(dash.token ? 'No accounts left: the dashboard falls back to the access token.' : 'WARNING: no accounts and no token - the dashboard is now OPEN.');
}

export async function userList(opts: UserOpts): Promise<void> {
  const { users } = await load(opts.config);
  if (!users.length) { console.log('No dashboard users. Add one with: svara user add <email>'); return; }
  for (const u of users) console.log(u.email);
}
