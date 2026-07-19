/**
 * @module dashboard/agents
 * SvaraJS - sibling-agent discovery and scaffolding for the dashboard's Agents page.
 *
 * A standalone runtime only ever manages the one agent it was booted for.
 * This lets its dashboard also scaffold *new* sibling agents (own folder,
 * own svara.config.json, own port) next to it - `svara new <name>
 * --standalone` run as a child process, not a shelled-out shell string, so
 * there's no injection risk from the name the dashboard user types in.
 *
 * Deliberately does NOT start the new agent's process. Keeping process
 * supervision solely in the user's hands (pm2, systemd, ...) means this
 * never creates a process invisible to whatever already manages the running
 * agent in production - see createSiblingAgent()'s returned `pm2Command`.
 */

import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { validateWithinDir } from '../security/pathGuard.js';

const execFileAsync = promisify(execFile);

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,50}$/;

export interface SiblingAgentConfig {
  name: string;
  dir: string;
  port: number | null;
}

export interface SiblingAgent extends SiblingAgentConfig {
  running: boolean;
}

/** Reads `port` out of each sibling folder's svara.config.json, without probing whether it's actually running (see listSiblingAgents() for that) - used both for the Agents list and for picking a free port when creating a new one. */
async function readSiblingConfigs(currentDir: string): Promise<SiblingAgentConfig[]> {
  const parentDir = path.dirname(currentDir);
  let entries: string[];
  try {
    entries = await fs.readdir(parentDir);
  } catch {
    return [];
  }

  const results: SiblingAgentConfig[] = [];
  for (const entry of entries) {
    const dir = path.join(parentDir, entry);
    if (path.resolve(dir) === path.resolve(currentDir)) continue;
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'svara.config.json'), 'utf-8')) as { port?: unknown };
      results.push({ name: entry, dir, port: typeof raw.port === 'number' ? raw.port : 3000 });
    } catch {
      continue; // not a svara project (no config, unreadable, bad JSON) - skip
    }
  }
  return results;
}

async function pingHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Sibling standalone-agent folders next to `currentDir`, each with a live running/not-running check. */
export async function listSiblingAgents(currentDir: string): Promise<SiblingAgent[]> {
  const configs = await readSiblingConfigs(currentDir);
  return Promise.all(configs.map(async (c) => ({ ...c, running: c.port !== null && await pingHealth(c.port) })));
}

async function nextFreePort(currentDir: string): Promise<number> {
  const used = new Set<number>();
  try {
    const raw = JSON.parse(await fs.readFile(path.join(currentDir, 'svara.config.json'), 'utf-8')) as { port?: unknown };
    if (typeof raw.port === 'number') used.add(raw.port);
  } catch { /* no config at currentDir - ignore */ }
  for (const sibling of await readSiblingConfigs(currentDir)) {
    if (sibling.port !== null) used.add(sibling.port);
  }

  let candidate = 3000;
  while (used.has(candidate)) candidate++;
  return candidate;
}

export interface CreateAgentOptions {
  name: string;
  model?: string;
  provider?: 'openai' | 'anthropic' | 'ollama';
}

export interface CreateAgentResult {
  name: string;
  dir: string;
  port: number;
  /** Ready-to-copy command to bring the new agent under the same process manager as this one. */
  pm2Command: string;
}

/**
 * Scaffolds a new standalone agent as a sibling of `currentDir` and installs
 * its dependencies (via `svara new <name> --standalone`, spawned as a real
 * child process - the name is passed as an argv element, never interpolated
 * into a shell string). Patches the generated config's port to one not
 * already used by `currentDir` or any of its siblings.
 */
export async function createSiblingAgent(currentDir: string, options: CreateAgentOptions): Promise<CreateAgentResult> {
  const { name, model, provider } = options;
  if (!NAME_PATTERN.test(name)) {
    throw new Error('Agent name must be lowercase letters, numbers, and hyphens only, starting with a letter (e.g. "support-bot").');
  }

  const parentDir = path.dirname(currentDir);
  const targetDir = validateWithinDir(name, parentDir);

  try {
    await fs.access(targetDir);
    throw new Error(`A folder named "${name}" already exists in ${parentDir}.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const port = await nextFreePort(currentDir);

  // This file is bundled alongside the CLI into dist/cli/index.js when
  // running via `svara start` - see cli/commands/new.ts's own SVARA_VERSION
  // resolution for the same __dirname-after-bundling reasoning.
  const pkgRoot = path.resolve(__dirname, '../..');
  const cliEntry = path.join(pkgRoot, 'dist/cli/index.js');

  const args = ['new', name, '--standalone'];
  if (provider) args.push('--provider', provider);
  await execFileAsync(process.execPath, [cliEntry, ...args], { cwd: parentDir, timeout: 5 * 60 * 1000 });

  // `svara new` always writes port 3000 into the scaffolded config -
  // override it (and the model, if given) now that a free port is known.
  const configFile = path.join(targetDir, 'svara.config.json');
  const raw = JSON.parse(await fs.readFile(configFile, 'utf-8')) as Record<string, unknown>;
  raw.port = port;
  if (model) raw.model = model;
  await fs.writeFile(configFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');

  return {
    name,
    dir: targetDir,
    port,
    pm2Command: `cd ${targetDir} && pm2 start "npm start" --name ${name}`,
  };
}
