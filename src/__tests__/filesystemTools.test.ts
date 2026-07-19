import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createFilesystemTools } from '../tools/builtin/filesystem.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

describe('createFilesystemTools', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-fs-tools-'));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('writes then reads back a file', async () => {
    const [, fileWrite] = createFilesystemTools({ rootDir });
    const [fileRead] = createFilesystemTools({ rootDir });

    const writeResult = await fileWrite.run({ path: 'note.txt', content: 'hello world' }, ctx) as { written: boolean };
    expect(writeResult.written).toBe(true);

    const readResult = await fileRead.run({ path: 'note.txt' }, ctx) as { content: string };
    expect(readResult.content).toBe('hello world');
  });

  it('creates nested directories on write', async () => {
    const [, fileWrite] = createFilesystemTools({ rootDir });
    await fileWrite.run({ path: 'a/b/c.txt', content: 'nested' }, ctx);
    const content = await fs.readFile(path.join(rootDir, 'a/b/c.txt'), 'utf-8');
    expect(content).toBe('nested');
  });

  it('lists files in a directory', async () => {
    const [, fileWrite, listFiles] = createFilesystemTools({ rootDir });
    await fileWrite.run({ path: 'x.txt', content: '1' }, ctx);
    await fileWrite.run({ path: 'y.txt', content: '2' }, ctx);

    const result = await listFiles.run({ path: '.' }, ctx) as { entries: Array<{ name: string; type: string }> };
    expect(result.entries.map((e) => e.name).sort()).toEqual(['x.txt', 'y.txt']);
  });

  it('blocks path traversal on read', async () => {
    const [fileRead] = createFilesystemTools({ rootDir });
    await expect(fileRead.run({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(/outside the allowed root/);
  });

  it('blocks path traversal on write', async () => {
    const [, fileWrite] = createFilesystemTools({ rootDir });
    await expect(fileWrite.run({ path: '../escape.txt', content: 'x' }, ctx)).rejects.toThrow(/outside the allowed root/);
  });

  it('rejects content over the configured size limit', async () => {
    const [, fileWrite] = createFilesystemTools({ rootDir, maxFileSize: 10 });
    const result = await fileWrite.run({ path: 'big.txt', content: 'x'.repeat(100) }, ctx) as { error?: string };
    expect(result.error).toMatch(/larger than the/);
  });
});
