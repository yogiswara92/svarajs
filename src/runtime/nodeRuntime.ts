/**
 * @module runtime/nodeRuntime
 * A private Node.js for this agent, installed from the dashboard - no root, no apt, and nothing
 * else on the server is touched.
 *
 * Some optional features (the Playwright browser tool) need a newer Node than the server has
 * (many VPSes still ship Node 18). Instead of asking the admin to upgrade the system Node (which
 * would affect every other app on the machine), the official Node 20 tarball is downloaded into
 * `<agent folder>/.svara/node`, its SHA-256 is checked against nodejs.org's SHASUMS256.txt, and
 * `svara start` re-launches itself with it when the system Node is too old.
 */

import { spawn, execFile } from 'child_process';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const PRIVATE_NODE_MAJOR = 20;
/** Exit code meaning "restart me": the wrapper / systemd / pm2 / the sibling supervisor all treat non-zero as restart-worthy. */
export const RESTART_EXIT_CODE = 75;
const DEFAULT_BASE_URL = 'https://nodejs.org/dist';
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export function nodeMajor(version: string = process.versions.node): number {
  return Number(version.replace(/^v/, '').split('.')[0]);
}

export function privateNodeDir(configDir: string): string {
  return path.join(configDir, '.svara', 'node');
}

export function privateNodeBin(configDir: string): string {
  return path.join(privateNodeDir(configDir), 'bin', 'node');
}

/** nodejs.org platform/arch slug for the current machine, or null when there is no tarball we can unpack (e.g. Windows). */
export function platformSlug(platform: string = process.platform, arch: string = process.arch): string | null {
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!a) return null;
  if (platform === 'linux') return `linux-${a}`;
  if (platform === 'darwin') return `darwin-${a}`;
  return null;
}

/** Version string of the installed private Node (e.g. "v20.19.5"), or null. */
export async function privateNodeVersion(configDir: string): Promise<string | null> {
  const bin = privateNodeBin(configDir);
  if (!fs.existsSync(bin)) return null;
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10_000 });
    const v = stdout.trim();
    return nodeMajor(v) >= PRIVATE_NODE_MAJOR ? v : null;
  } catch {
    return null;
  }
}

/**
 * Should `svara start` hand over to the private Node? Only when the running Node is too old, a private one
 * exists, and we have not already handed over (SVARA_REEXEC) - so it can never loop.
 */
export function shouldReexec(opts: { configDir: string; env?: NodeJS.ProcessEnv; currentVersion?: string; exists?: (p: string) => boolean }): string | null {
  const env = opts.env ?? process.env;
  if (env.SVARA_REEXEC === '1') return null;
  if (nodeMajor(opts.currentVersion) >= PRIVATE_NODE_MAJOR) return null;
  const bin = privateNodeBin(opts.configDir);
  return (opts.exists ?? fs.existsSync)(bin) ? bin : null;
}

/**
 * Runs the current command line again under `nodeBin` and mirrors its lifetime: signals are forwarded,
 * its exit code becomes ours, and RESTART_EXIT_CODE relaunches it (that is how the dashboard's
 * "Restart runtime" works under this wrapper).
 */
export function runUnder(nodeBin: string, argv: string[] = process.argv.slice(1)): Promise<number> {
  return new Promise((resolve) => {
    let terminating = false; // we were asked to stop (systemd/pm2/Ctrl+C): the child going away is the expected outcome
    const launch = (): void => {
      const child = spawn(nodeBin, argv, { stdio: 'inherit', env: { ...process.env, SVARA_REEXEC: '1' } });
      const forward = (sig: NodeJS.Signals) => () => { terminating = true; try { child.kill(sig); } catch { /* already gone */ } };
      const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => [s, forward(s)] as const);
      for (const [s, h] of handlers) process.on(s, h);
      child.on('exit', (code, signal) => {
        for (const [s, h] of handlers) process.off(s, h);
        if (terminating) { resolve(0); return; } // a clean stop must not look like a failure to the supervisor
        if (code === RESTART_EXIT_CODE) { launch(); return; }
        resolve(code ?? (signal ? 1 : 0));
      });
      child.on('error', () => resolve(1));
    };
    launch();
  });
}

export interface InstallOptions {
  /** Override for tests. Default https://nodejs.org/dist */
  baseUrl?: string;
  platform?: string;
  arch?: string;
  onProgress?: (message: string) => void;
}

async function download(url: string, dest: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error('The Node.js download is larger than expected; aborting.');
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) throw new Error('The Node.js download is larger than expected; aborting.');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  return hash.digest('hex');
}

/** Downloads, verifies and unpacks the latest Node 20.x into `<configDir>/.svara/node`. Resolves with its version. */
export async function installPrivateNode(configDir: string, options: InstallOptions = {}): Promise<string> {
  const say = options.onProgress ?? (() => {});
  const slug = platformSlug(options.platform, options.arch);
  if (!slug) throw new Error(`There is no ready-made Node.js ${PRIVATE_NODE_MAJOR} package for ${options.platform ?? process.platform}/${options.arch ?? process.arch}. Install Node.js ${PRIVATE_NODE_MAJOR}+ manually.`);

  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  say('Looking up the latest Node.js ' + PRIVATE_NODE_MAJOR + '...');
  const sumsRes = await fetch(`${base}/latest-v${PRIVATE_NODE_MAJOR}.x/SHASUMS256.txt`);
  if (!sumsRes.ok) throw new Error(`Could not reach nodejs.org (${sumsRes.status}).`);
  const sums = await sumsRes.text();
  const line = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p.length === 2 && new RegExp(`^node-v${PRIVATE_NODE_MAJOR}\\.\\d+\\.\\d+-${slug}\\.tar\\.gz$`).test(p[1]));
  if (!line) throw new Error(`No Node.js ${PRIVATE_NODE_MAJOR} build found for ${slug}.`);
  const [expected, file] = line;

  const svaraDir = path.join(configDir, '.svara');
  fs.mkdirSync(svaraDir, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(svaraDir, 'node-install-'));
  try {
    const tarball = path.join(work, file);
    say(`Downloading ${file}...`);
    const actual = await download(`${base}/latest-v${PRIVATE_NODE_MAJOR}.x/${file}`, tarball);
    if (actual !== expected.toLowerCase()) throw new Error('The downloaded file did not match its published checksum, so it was discarded.');

    say('Unpacking...');
    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    await execFileAsync('tar', ['-xzf', tarball, '-C', unpacked, '--strip-components=1'], { timeout: 120_000 });
    const bin = path.join(unpacked, 'bin', 'node');
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10_000 });
    const version = stdout.trim();
    if (nodeMajor(version) < PRIVATE_NODE_MAJOR) throw new Error(`The unpacked Node.js reports ${version}, not ${PRIVATE_NODE_MAJOR}+.`);

    // Swap in atomically: a failed install never leaves a half-written node behind.
    const finalDir = privateNodeDir(configDir);
    const old = `${finalDir}.old`;
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(finalDir)) fs.renameSync(finalDir, old);
    fs.renameSync(unpacked, finalDir);
    fs.rmSync(old, { recursive: true, force: true });
    say(`Installed Node.js ${version}.`);
    return version;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** PATH (and friends) that make `npm`/`npx`/`node` resolve to the private Node, for child processes. */
export function envWithPrivateNode(configDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bin = path.dirname(privateNodeBin(configDir));
  return fs.existsSync(path.join(bin, 'node')) ? { ...base, PATH: `${bin}${path.delimiter}${base.PATH ?? ''}` } : base;
}


// ── Native modules ──────────────────────────────────────────────────────────
// better-sqlite3 (and any other addon) is compiled for ONE Node ABI. Running it on another Node does not
// fail politely: it segfaults. So installing a different Node must be followed by a rebuild, with a real smoke test
// and an automatic rollback so a failed attempt can never leave the agent unable to start.

type Runner = (file: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout: number }) => Promise<void>;
const defaultRun: Runner = async (file, args, opts) => { await execFileAsync(file, args, opts); };

/**
 * Directory whose node_modules holds the better-sqlite3 that SvaraJS itself loads, or null when it is not installed.
 * Resolved from where this package lives (not from the config folder), so it is right for a normal install, a global
 * install, or a config folder that has no node_modules of its own. `from` is only overridden in tests.
 */
export function findNativeProject(from: string = typeof __filename !== 'undefined' ? __filename : process.argv[1]): string | null {
  try {
    const dir = fs.statSync(from).isDirectory() ? from : path.dirname(from);
    const pkg = createRequire(path.join(dir, 'noop.js')).resolve('better-sqlite3/package.json');
    return path.resolve(path.dirname(pkg), '..', '..');
  } catch {
    return null;
  }
}

/** Does `nodeBin` actually run SvaraJS's database engine? (A mismatched build segfaults instead of erroring.) */
export async function privateNodeWorks(nodeBin: string, projectDir: string | null = findNativeProject()): Promise<boolean> {
  if (!projectDir) return true; // nothing native to break
  try {
    await execFileAsync(nodeBin, ['-e', SMOKE_SCRIPT], { cwd: projectDir, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const SMOKE_SCRIPT = "const D=require('better-sqlite3');const d=new D(':memory:');process.exit(d.prepare('select 1 as x').get().x===1?0:1)";

/** `build` folders of top-level packages that ship a compiled .node addon. */
function nativeBuildDirs(projectDir: string): string[] {
  const nm = path.join(projectDir, 'node_modules');
  const out: string[] = [];
  const scan = (dir: string): void => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) { scan(path.join(dir, name)); continue; }
      const build = path.join(dir, name, 'build');
      try {
        if (fs.readdirSync(path.join(build, 'Release')).some((f) => f.endsWith('.node'))) out.push(build);
      } catch { /* no compiled addon */ }
    }
  };
  scan(nm);
  return out;
}

/**
 * Rebuilds compiled addons for the private Node and proves better-sqlite3 opens a database with it.
 * On any failure the original binaries are restored and the error is rethrown.
 */
export async function rebuildNativeModules(configDir: string, projectDir: string, say: (m: string) => void = () => {}, run: Runner = defaultRun): Promise<void> {
  const nodeBin = privateNodeBin(configDir);
  const npmCli = path.join(privateNodeDir(configDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const dirs = nativeBuildDirs(projectDir);
  if (!dirs.length) return;

  const backup = path.join(configDir, '.svara', 'native-backup');
  fs.rmSync(backup, { recursive: true, force: true });
  dirs.forEach((d, i) => fs.cpSync(d, path.join(backup, String(i)), { recursive: true }));

  const restore = (): void => {
    dirs.forEach((d, i) => {
      fs.rmSync(d, { recursive: true, force: true });
      fs.cpSync(path.join(backup, String(i)), d, { recursive: true });
    });
  };

  try {
    say('Rebuilding the agent\'s native modules for the new Node.js (can take a minute)...');
    await run(nodeBin, [npmCli, 'rebuild'], { cwd: projectDir, env: envWithPrivateNode(configDir), timeout: 10 * 60 * 1000 });
    say('Testing the database engine on the new Node.js...');
    await run(nodeBin, ['-e', SMOKE_SCRIPT], { cwd: projectDir, timeout: 30_000 });
  } catch (err) {
    restore();
    const detail = (err as { stderr?: string; message: string }).stderr?.trim().split('\n').slice(-3).join(' ') || (err as Error).message;
    throw new Error(`Could not rebuild the native modules for Node.js ${PRIVATE_NODE_MAJOR} (${detail.slice(0, 300)}). Nothing was changed.`);
  } finally {
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

/** Installs the private Node and makes the agent's native modules work with it - or changes nothing. */
export async function installNodeAndRebuild(configDir: string, options: InstallOptions & { projectDir?: string; run?: Runner } = {}): Promise<string> {
  const say = options.onProgress ?? (() => {});
  const hadBefore = fs.existsSync(privateNodeDir(configDir));
  const version = await installPrivateNode(configDir, options);
  const projectDir = options.projectDir ?? findNativeProject();
  if (projectDir) {
    try {
      await rebuildNativeModules(configDir, projectDir, say, options.run);
    } catch (err) {
      if (!hadBefore) fs.rmSync(privateNodeDir(configDir), { recursive: true, force: true });
      throw err;
    }
  }
  return version;
}
