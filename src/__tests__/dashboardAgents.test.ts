import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

vi.mock('child_process', () => ({
  // Stands in for the real `svara new` child process: writes the same
  // svara.config.json shape the CLI would, so the caller's port/model patch
  // step has something real to read back.
  execFile: vi.fn((_file: string, args: string[], options: { cwd: string }, callback: (err: Error | null, stdout?: string, stderr?: string) => void) => {
    // args = [cliEntry, 'new', name, '--standalone', ...] - see createSiblingAgent()
    const name = args[2];
    const targetDir = path.join(options.cwd, name);
    fsSync.mkdirSync(targetDir, { recursive: true });
    fsSync.writeFileSync(path.join(targetDir, 'svara.config.json'), JSON.stringify({ name, model: 'gpt-4o-mini', port: 3000 }));
    callback(null, '', '');
  }),
}));

const { listSiblingAgents, createSiblingAgent } = await import('../dashboard/agents.js');

async function writeConfig(dir: string, port: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'svara.config.json'), JSON.stringify({ name: path.basename(dir), port }), 'utf-8');
}

describe('listSiblingAgents', () => {
  let parentDir: string;
  let currentDir: string;

  beforeEach(async () => {
    parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-agents-'));
    currentDir = path.join(parentDir, 'current-agent');
    await writeConfig(currentDir, 3000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(async () => {
    await fs.rm(parentDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('lists sibling folders with a svara.config.json, excluding currentDir itself', async () => {
    await writeConfig(path.join(parentDir, 'sibling-one'), 3001);
    const agents = await listSiblingAgents(currentDir);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'sibling-one', port: 3001, running: true });
  });

  it('skips sibling folders without a svara.config.json', async () => {
    await fs.mkdir(path.join(parentDir, 'not-an-agent'), { recursive: true });
    const agents = await listSiblingAgents(currentDir);
    expect(agents).toEqual([]);
  });

  it('skips plain files in the parent directory', async () => {
    await fs.writeFile(path.join(parentDir, 'some-file.txt'), 'hi', 'utf-8');
    const agents = await listSiblingAgents(currentDir);
    expect(agents).toEqual([]);
  });

  it('marks an agent as not running when its health check fails', async () => {
    await writeConfig(path.join(parentDir, 'sibling-down'), 3002);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const agents = await listSiblingAgents(currentDir);
    expect(agents[0].running).toBe(false);
  });
});

describe('createSiblingAgent', () => {
  let parentDir: string;
  let currentDir: string;

  beforeEach(async () => {
    parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-agents-'));
    currentDir = path.join(parentDir, 'current-agent');
    await writeConfig(currentDir, 3000);
  });

  afterEach(async () => {
    await fs.rm(parentDir, { recursive: true, force: true });
  });

  it('rejects a name with invalid characters instead of shelling out', async () => {
    await expect(createSiblingAgent(currentDir, { name: '../evil' })).rejects.toThrow(/lowercase letters/);
    await expect(createSiblingAgent(currentDir, { name: 'has spaces' })).rejects.toThrow(/lowercase letters/);
  });

  it('rejects when a folder with that name already exists', async () => {
    await fs.mkdir(path.join(parentDir, 'taken'), { recursive: true });
    await expect(createSiblingAgent(currentDir, { name: 'taken' })).rejects.toThrow(/already exists/);
  });

  it('scaffolds the agent as a sibling folder and assigns the next free port', async () => {
    await writeConfig(path.join(parentDir, 'sibling-one'), 3001);
    const result = await createSiblingAgent(currentDir, { name: 'new-agent' });
    expect(result.dir).toBe(path.join(parentDir, 'new-agent'));
    expect(result.port).toBe(3002); // 3000 (current) and 3001 (sibling) are taken
    expect(result.pm2Command).toContain('new-agent');

    const written = JSON.parse(await fs.readFile(path.join(result.dir, 'svara.config.json'), 'utf-8'));
    expect(written.port).toBe(3002);
  });

  it('patches the model into the scaffolded config when given', async () => {
    const result = await createSiblingAgent(currentDir, { name: 'new-agent', model: 'claude-opus-4-6' });
    const written = JSON.parse(await fs.readFile(path.join(result.dir, 'svara.config.json'), 'utf-8'));
    expect(written.model).toBe('claude-opus-4-6');
  });
});
