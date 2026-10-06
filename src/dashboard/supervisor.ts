/**
 * @module dashboard/supervisor
 * Runs sibling agents as child processes of the main runtime, so any user can
 * create and operate extra agents on their own VPS without root, pm2, systemd
 * units or nginx edits.
 *
 * - Each child is the SAME installed SvaraJS (`svara start --config <dir>`), bound to
 *   127.0.0.1 only, and protected by a per-start random token that only this
 *   process knows (the dashboard proxy injects it).
 * - Children are restarted with backoff when they crash, give up after repeated
 *   rapid crashes, and exit on their own if this process disappears.
 * - Which agents should be running is persisted, so they come back after a restart
 *   of the main runtime or the whole server.
 */

import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

export type SiblingStatus = 'starting' | 'running' | 'stopped' | 'crashed';

export interface SiblingState {
  name: string;
  port: number;
  status: SiblingStatus;
  pid: number | null;
  restarts: number;
  startedAt: number | null;
  lastExit: string | null;
}

interface Entry {
  name: string;
  dir: string;
  port: number;
  token: string;
  child: ChildProcess | null;
  status: SiblingStatus;
  restarts: number;
  recentCrashes: number[];
  startedAt: number | null;
  lastExit: string | null;
  stopping: boolean;
  timer: NodeJS.Timeout | null;
}

export interface SupervisorOptions {
  /** Absolute path to dist/cli/index.js of the running SvaraJS install. */
  cliEntry: string;
  /** Where the "should be running" list is persisted (the parent's `.svara` dir). */
  stateDir?: string;
  spawnFn?: typeof spawn;
  healthCheck?: (port: number) => Promise<boolean>;
  /** Rapid crashes allowed within `crashWindowMs` before giving up. @default 5 */
  maxCrashes?: number;
  crashWindowMs?: number;
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;

export async function pingHealth(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** True when nothing is listening on 127.0.0.1:port (checked by actually binding it). */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * Finds `dist/cli/index.js` of the running SvaraJS install by walking up from this file to
 * its package.json - independent of how the code was bundled (CLI entry, chunk, or library).
 */
export function resolveCliEntry(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    try {
      if ((JSON.parse(fs.readFileSync(pkg, 'utf-8')) as { name?: string }).name === '@yesvara/svara') {
        const entry = path.join(dir, 'dist', 'cli', 'index.js');
        return fs.existsSync(entry) ? entry : null;
      }
    } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }
  return null;
}

export function logPath(dir: string): string {
  return path.join(dir, '.svara', 'agent.log');
}

export function readLogTail(dir: string, lines = 200): string {
  try {
    const text = fs.readFileSync(logPath(dir), 'utf-8');
    return text.split('\n').slice(-Math.max(1, Math.min(lines, 2000))).join('\n');
  } catch {
    return '';
  }
}

export class SiblingSupervisor {
  private entries = new Map<string, Entry>();
  private readonly spawnFn: typeof spawn;
  private readonly health: (port: number) => Promise<boolean>;
  private readonly maxCrashes: number;
  private readonly crashWindowMs: number;

  constructor(private readonly opts: SupervisorOptions) {
    this.spawnFn = opts.spawnFn ?? spawn;
    this.health = opts.healthCheck ?? pingHealth;
    this.maxCrashes = opts.maxCrashes ?? 5;
    this.crashWindowMs = opts.crashWindowMs ?? 2 * 60 * 1000;
  }

  // ── persisted "should be running" list ──
  private statePath(): string | null {
    return this.opts.stateDir ? path.join(this.opts.stateDir, 'siblings.json') : null;
  }

  readDesired(): string[] {
    const p = this.statePath();
    if (!p) return [];
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { running?: unknown };
      return Array.isArray(data.running) ? data.running.filter((n): n is string => typeof n === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeDesired(names: string[]): void {
    const p = this.statePath();
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, JSON.stringify({ running: [...new Set(names)].sort() }, null, 2));
    } catch {
      // best effort: a read-only state dir only costs us autostart after reboot
    }
  }

  private setDesired(name: string, on: boolean): void {
    const cur = new Set(this.readDesired());
    if (on) cur.add(name); else cur.delete(name);
    this.writeDesired([...cur]);
  }

  // ── lifecycle ──
  /** Starts (or restarts) a sibling and resolves when its health check passes or `readyTimeoutMs` elapses. */
  async start(name: string, dir: string, port: number, opts: { persist?: boolean; readyTimeoutMs?: number } = {}): Promise<SiblingState> {
    const existing = this.entries.get(name);
    if (existing?.child && !existing.stopping) throw new Error(`"${name}" is already running.`);
    if (existing?.timer) clearTimeout(existing.timer);

    const entry: Entry = {
      name, dir, port,
      token: crypto.randomBytes(24).toString('hex'),
      child: null, status: 'starting', restarts: existing?.restarts ?? 0, recentCrashes: [],
      startedAt: null, lastExit: null, stopping: false, timer: null,
    };
    this.entries.set(name, entry);
    if (opts.persist !== false) this.setDesired(name, true);
    this.launch(entry);
    await this.waitReady(entry, opts.readyTimeoutMs ?? 30_000);
    return this.snapshot(entry);
  }

  private launch(entry: Entry): void {
    fs.mkdirSync(path.join(entry.dir, '.svara'), { recursive: true });
    const log = logPath(entry.dir);
    try { if (fs.statSync(log).size > LOG_MAX_BYTES) fs.truncateSync(log, 0); } catch { /* no log yet */ }
    const fd = fs.openSync(log, 'a', 0o600);
    fs.writeSync(fd, `\n--- ${new Date().toISOString()} starting on 127.0.0.1:${entry.port} ---\n`);

    const child = this.spawnFn(
      process.execPath,
      [this.opts.cliEntry, 'start', '--config', path.join(entry.dir, 'svara.config.json'), '--port', String(entry.port)],
      {
        cwd: entry.dir,
        stdio: ['ignore', fd, fd],
        env: {
          ...process.env,
          SVARA_HOST: '127.0.0.1',
          SVARA_EMBEDDED_TOKEN: entry.token,
          SVARA_PARENT_PID: String(process.pid),
        },
      },
    );
    fs.closeSync(fd);
    entry.child = child;
    entry.status = 'starting';
    entry.startedAt = Date.now();

    child.on('error', (err) => {
      entry.lastExit = `could not start: ${err.message}`;
    });
    child.on('exit', (code, signal) => {
      entry.child = null;
      entry.lastExit = signal ? `killed by ${signal}` : `exited with code ${code}`;
      if (entry.stopping) { entry.status = 'stopped'; return; }
      const now = Date.now();
      entry.recentCrashes = entry.recentCrashes.filter((t) => now - t < this.crashWindowMs).concat(now);
      if (entry.recentCrashes.length > this.maxCrashes) { entry.status = 'crashed'; return; }
      entry.restarts += 1;
      entry.status = 'starting';
      const delay = Math.min(30_000, 1000 * 2 ** (entry.recentCrashes.length - 1));
      entry.timer = setTimeout(() => { if (!entry.stopping) { this.launch(entry); void this.waitReady(entry, 30_000); } }, delay);
    });
  }

  private async waitReady(entry: Entry, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (entry.stopping || entry.status === 'crashed' || (!entry.child && entry.status !== 'starting')) return;
      if (entry.child && (await this.health(entry.port))) { entry.status = 'running'; return; }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** Stops a sibling. `persist: false` keeps it on the autostart list (used when the main runtime itself shuts down). */
  async stop(name: string, opts: { persist?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(name);
    if (opts.persist !== false) this.setDesired(name, false);
    if (!entry) return;
    entry.stopping = true;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    const child = entry.child;
    if (!child) { entry.status = 'stopped'; return; }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
      child.kill('SIGTERM');
    });
    entry.status = 'stopped';
  }

  async restart(name: string, dir: string, port: number): Promise<SiblingState> {
    await this.stop(name, { persist: false });
    return this.start(name, dir, port);
  }

  /** Called when the main runtime shuts down: stop everything but remember what to bring back. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((n) => this.stop(n, { persist: false })));
  }

  // ── inspection ──
  private snapshot(e: Entry): SiblingState {
    return { name: e.name, port: e.port, status: e.status, pid: e.child?.pid ?? null, restarts: e.restarts, startedAt: e.startedAt, lastExit: e.lastExit };
  }

  state(name: string): SiblingState | null {
    const e = this.entries.get(name);
    return e ? this.snapshot(e) : null;
  }

  /** The per-start secret the dashboard proxy sends to this child (never leaves this process). */
  tokenFor(name: string): string | undefined {
    const e = this.entries.get(name);
    return e && e.status !== 'stopped' ? e.token : undefined;
  }
}
