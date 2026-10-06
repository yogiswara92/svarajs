import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  nodeMajor, platformSlug, shouldReexec, runUnder, installPrivateNode, privateNodeVersion, privateNodeBin,
  envWithPrivateNode, RESTART_EXIT_CODE, rebuildNativeModules, installNodeAndRebuild, findNativeProject, privateNodeWorks,
} from '../runtime/nodeRuntime.js';

describe('helpers', () => {
  it('reads the major version', () => {
    expect(nodeMajor('18.19.1')).toBe(18);
    expect(nodeMajor('v20.19.5')).toBe(20);
  });

  it('maps platforms to nodejs.org slugs and refuses unsupported ones', () => {
    expect(platformSlug('linux', 'x64')).toBe('linux-x64');
    expect(platformSlug('linux', 'arm64')).toBe('linux-arm64');
    expect(platformSlug('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformSlug('win32', 'x64')).toBeNull();
    expect(platformSlug('linux', 'ia32')).toBeNull();
  });

  it('only hands over to the private Node when the running one is too old, it exists, and we have not already', () => {
    const base = { configDir: '/agent', exists: () => true };
    expect(shouldReexec({ ...base, currentVersion: '18.19.1', env: {} })).toBe(privateNodeBin('/agent'));
    expect(shouldReexec({ ...base, currentVersion: '20.1.0', env: {} })).toBeNull();           // already new enough
    expect(shouldReexec({ ...base, currentVersion: '18.19.1', env: { SVARA_REEXEC: '1' } })).toBeNull(); // no loop
    expect(shouldReexec({ configDir: '/agent', currentVersion: '18.19.1', env: {}, exists: () => false })).toBeNull(); // not installed
  });
});

describe('runUnder (the Node wrapper)', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-wrap-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('mirrors the child exit code and marks it as handed over', async () => {
    const script = path.join(dir, 'exit3.sh');
    fs.writeFileSync(script, '#!/bin/sh\n[ "$SVARA_REEXEC" = "1" ] || exit 9\nexit 3\n');
    expect(await runUnder('/bin/sh', [script])).toBe(3);
  });

  it('relaunches the child when it asks for a restart', async () => {
    const counter = path.join(dir, 'runs');
    const script = path.join(dir, 'restart.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho x >> "${counter}"\n[ "$(wc -l < "${counter}" | tr -d ' ')" -ge 2 ] && exit 0\nexit ${RESTART_EXIT_CODE}\n`);
    expect(await runUnder('/bin/sh', [script])).toBe(0);
    expect(fs.readFileSync(counter, 'utf-8').trim().split('\n')).toHaveLength(2);
  });
});

describe('installPrivateNode', () => {
  let server: http.Server;
  let baseUrl = '';
  let tarball: Buffer;
  let goodSha = '';
  let serveBadChecksum = false;
  const FILE = 'node-v20.99.0-linux-x64.tar.gz';

  beforeAll(async () => {
    // A real .tar.gz laid out like nodejs.org's (top-level folder, bin/node), with a fake `node` that prints its version.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-tar-'));
    const top = path.join(work, 'node-v20.99.0-linux-x64');
    fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(top, 'bin', 'node'), '#!/bin/sh\necho v20.99.0\n', { mode: 0o755 });
    execFileSync('tar', ['-czf', path.join(work, FILE), '-C', work, 'node-v20.99.0-linux-x64']);
    tarball = fs.readFileSync(path.join(work, FILE));
    goodSha = crypto.createHash('sha256').update(tarball).digest('hex');
    fs.rmSync(work, { recursive: true, force: true });

    server = http.createServer((req, res) => {
      if (req.url === '/latest-v20.x/SHASUMS256.txt') {
        res.end(`${serveBadChecksum ? 'a'.repeat(64) : goodSha}  ${FILE}\n${'b'.repeat(64)}  node-v20.99.0-win-x64.zip\n`);
      } else if (req.url === `/latest-v20.x/${FILE}`) {
        res.setHeader('Content-Length', String(tarball.length));
        res.end(tarball);
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  function agentDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'svara-agent-')); }

  it('downloads, verifies the checksum, unpacks into .svara/node, and the result runs', async () => {
    const dir = agentDir();
    const steps: string[] = [];
    const version = await installPrivateNode(dir, { baseUrl, platform: 'linux', arch: 'x64', onProgress: (m) => steps.push(m) });
    expect(version).toBe('v20.99.0');
    expect(await privateNodeVersion(dir)).toBe('v20.99.0');
    expect(steps.join(' | ')).toMatch(/Downloading.*Unpacking.*Installed/);
    // leftovers are cleaned up
    expect(fs.readdirSync(path.join(dir, '.svara')).filter((n) => n.startsWith('node-install-') || n.endsWith('.old'))).toEqual([]);
    // npm/npx/node for child processes resolve to the private bin
    expect(envWithPrivateNode(dir, { PATH: '/usr/bin' }).PATH?.startsWith(path.join(dir, '.svara', 'node', 'bin'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a download whose checksum does not match and installs nothing', async () => {
    serveBadChecksum = true;
    const dir = agentDir();
    try {
      await expect(installPrivateNode(dir, { baseUrl, platform: 'linux', arch: 'x64' })).rejects.toThrow(/checksum/);
      expect(fs.existsSync(path.join(dir, '.svara', 'node'))).toBe(false);
      expect(await privateNodeVersion(dir)).toBeNull();
    } finally {
      serveBadChecksum = false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an existing install if a later install fails', async () => {
    const dir = agentDir();
    await installPrivateNode(dir, { baseUrl, platform: 'linux', arch: 'x64' });
    serveBadChecksum = true;
    try {
      await expect(installPrivateNode(dir, { baseUrl, platform: 'linux', arch: 'x64' })).rejects.toThrow();
      expect(await privateNodeVersion(dir)).toBe('v20.99.0');
    } finally {
      serveBadChecksum = false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explains when there is no package for the platform', async () => {
    const dir = agentDir();
    await expect(installPrivateNode(dir, { baseUrl, platform: 'win32', arch: 'x64' })).rejects.toThrow(/Install Node\.js 20\+ manually/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── native module rebuild (better-sqlite3 segfaults when run on a Node it was not built for) ──
  function projectWithAddon(): { project: string; addon: string } {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-proj-'));
    const rel = path.join('node_modules', 'better-sqlite3', 'build', 'Release');
    fs.mkdirSync(path.join(project, rel), { recursive: true });
    fs.writeFileSync(path.join(project, 'node_modules', 'better-sqlite3', 'package.json'), '{"name":"better-sqlite3","version":"0.0.0"}');
    const addon = path.join(project, rel, 'better_sqlite3.node');
    fs.writeFileSync(addon, 'built-for-node18');
    return { project, addon };
  }

  it('finds the project that holds better-sqlite3', () => {
    const { project } = projectWithAddon();
    expect(fs.realpathSync(findNativeProject(project)!)).toBe(fs.realpathSync(project)); // macOS /tmp is a symlink
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('rebuilds the addons for the new Node, tests them, and removes its backup', async () => {
    const { project, addon } = projectWithAddon();
    const agent = agentDir();
    const calls: string[][] = [];
    await rebuildNativeModules(agent, project, () => {}, async (_file, args) => {
      calls.push(args);
      if (args.includes('rebuild')) fs.writeFileSync(addon, 'built-for-node20'); // what npm rebuild would do
    });
    expect(fs.readFileSync(addon, 'utf-8')).toBe('built-for-node20');
    expect(calls[0].some((a) => a.endsWith('npm-cli.js'))).toBe(true);
    expect(calls[1].join(' ')).toMatch(/better-sqlite3/); // the smoke test
    expect(fs.existsSync(path.join(agent, '.svara', 'native-backup'))).toBe(false);
    fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
  });

  it('restores the original binaries if the smoke test fails', async () => {
    const { project, addon } = projectWithAddon();
    const agent = agentDir();
    await expect(rebuildNativeModules(agent, project, () => {}, async (_file, args) => {
      if (args.includes('rebuild')) { fs.writeFileSync(addon, 'half-built'); return; }
      throw new Error('segfault');
    })).rejects.toThrow(/Nothing was changed/);
    expect(fs.readFileSync(addon, 'utf-8')).toBe('built-for-node18');
    fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
  });

  it('removes the freshly installed Node when the rebuild fails, so the agent keeps running on its own Node', async () => {
    const { project, addon } = projectWithAddon();
    const agent = agentDir();
    await expect(installNodeAndRebuild(agent, {
      baseUrl, platform: 'linux', arch: 'x64', projectDir: project,
      run: async () => { fs.writeFileSync(addon, 'half-built'); throw new Error('compiler missing'); },
    })).rejects.toThrow(/Nothing was changed/);
    expect(fs.existsSync(path.join(agent, '.svara', 'node'))).toBe(false);
    expect(fs.readFileSync(addon, 'utf-8')).toBe('built-for-node18');
    fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
  });

  it('keeps the new Node when the rebuild succeeds', async () => {
    const { project } = projectWithAddon();
    const agent = agentDir();
    expect(await installNodeAndRebuild(agent, { baseUrl, platform: 'linux', arch: 'x64', projectDir: project, run: async () => {} })).toBe('v20.99.0');
    expect(await privateNodeVersion(agent)).toBe('v20.99.0');
    fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
  });

  it('privateNodeWorks: true for a node that runs the smoke test, false for one that crashes, true when nothing is native', async () => {
    const dir = agentDir();
    const ok = path.join(dir, 'ok-node'); fs.writeFileSync(ok, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const crash = path.join(dir, 'crash-node'); fs.writeFileSync(crash, '#!/bin/sh\nkill -SEGV $$\n', { mode: 0o755 });
    const { project } = projectWithAddon();
    expect(await privateNodeWorks(ok, project)).toBe(true);
    expect(await privateNodeWorks(crash, project)).toBe(false);
    expect(await privateNodeWorks(crash, null)).toBe(true);
    fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
  });
});
