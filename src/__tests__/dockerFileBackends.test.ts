import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemTools } from '../tools/builtin/filesystem.js';
import { createSendFileTool, getRegisteredFile, drainPendingTokens } from '../tools/builtin/sendFile.js';

// A fake `docker` on PATH: "docker exec [-i] <container> cmd..." runs cmd locally and records the container name,
// so the tools' docker backend is exercised end to end without a Docker daemon.
let tmp: string;
let work: string;
let log: string;
const ORIGINAL_PATH = process.env.PATH;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-docker-'));
  work = path.join(tmp, 'workspace');
  fs.mkdirSync(work);
  log = path.join(tmp, 'calls.log');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
[ "$1" = exec ] || exit 99
shift
[ "$1" = -i ] && shift
echo "$1" >> "${log}"
shift
exec "$@"
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${ORIGINAL_PATH}`;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tools = () => Object.fromEntries(
  createFilesystemTools({ backend: 'docker', dockerContainer: 'yvw-w-test', rootDir: work, maxFileSize: 1000 }).map((t) => [t.name, t]),
);
const ctx = { sessionId: 's1' } as never;

describe('filesystem tools, docker backend', () => {
  it('writes, reads and lists inside the container', async () => {
    const t = tools();
    expect(await t.file_write.run({ path: 'notes/a.txt', content: 'halo dunia' }, ctx)).toMatchObject({ written: true, bytes: 10 });
    expect(fs.readFileSync(path.join(work, 'notes/a.txt'), 'utf-8')).toBe('halo dunia');
    expect(await t.file_read.run({ path: 'notes/a.txt' }, ctx)).toEqual({ content: 'halo dunia', size: 10 });
    const listed = await t.list_files.run({ path: '.' }, ctx) as { entries: Array<{ name: string; type: string }> };
    expect(listed.entries).toContainEqual({ name: 'notes', type: 'directory' });
    expect(fs.readFileSync(log, 'utf-8')).toMatch(/^yvw-w-test$/m);
  });

  it('refuses paths outside the workspace before running anything', async () => {
    const t = tools();
    await expect(t.file_read.run({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(/outside the allowed root/);
    await expect(t.file_write.run({ path: '/etc/x', content: 'x' }, ctx)).rejects.toThrow(/outside the allowed root/);
  });

  it('reports missing and oversized files', async () => {
    const t = tools();
    expect(await t.file_read.run({ path: 'nope.txt' }, ctx)).toMatchObject({ error: expect.stringMatching(/not found/) });
    fs.writeFileSync(path.join(work, 'big.txt'), 'x'.repeat(2000));
    expect(await t.file_read.run({ path: 'big.txt' }, ctx)).toMatchObject({ error: expect.stringMatching(/exceeds/) });
    expect(await t.file_write.run({ path: 'b.txt', content: 'y'.repeat(2000) }, ctx)).toMatchObject({ error: expect.stringMatching(/larger/) });
  });
});

describe('send_file, docker backend', () => {
  it('copies the file out to a private staging folder and registers that copy', async () => {
    fs.writeFileSync(path.join(work, 'report.csv'), 'a,b\n1,2\n');
    const staging = path.join(tmp, 'outbox');
    const tool = createSendFileTool({ backend: 'docker', dockerContainer: 'yvw-w-test', rootDir: work, stagingDir: staging });
    const out = await tool.run({ path: 'report.csv' }, ctx) as { attached: string; size: number };
    expect(out).toEqual({ attached: 'report.csv', size: 8 });
    const [token] = drainPendingTokens('s1');
    const file = getRegisteredFile(token)!;
    expect(file.absolutePath.startsWith(staging)).toBe(true);
    expect(fs.readFileSync(file.absolutePath, 'utf-8')).toBe('a,b\n1,2\n');
    expect(file.mimeType).toBe('text/csv');
  });

  it('refuses paths outside the workspace', async () => {
    const tool = createSendFileTool({ backend: 'docker', dockerContainer: 'yvw-w-test', rootDir: work, stagingDir: path.join(tmp, 'outbox') });
    await expect(tool.run({ path: '../outside.txt' }, ctx)).rejects.toThrow(/outside the allowed root/);
  });
});
