import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createSendFileTool, getRegisteredFile, drainPendingTokens } from '../tools/builtin/sendFile.js';
import type { AgentContext } from '../types.js';

function ctxFor(sessionId: string): AgentContext {
  return { sessionId, userId: 'u1', agentName: 'test-agent', history: [], metadata: {} } as AgentContext;
}

describe('createSendFileTool', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-send-file-'));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('registers an existing file and queues it for the calling session', async () => {
    await fs.writeFile(path.join(rootDir, 'report.xlsx'), 'fake xlsx bytes');
    const tool = createSendFileTool({ rootDir });

    const result = await tool.run({ path: 'report.xlsx' }, ctxFor('session-1')) as { attached: string; size: number };
    expect(result.attached).toBe('report.xlsx');
    expect(result.size).toBeGreaterThan(0);

    const tokens = drainPendingTokens('session-1');
    expect(tokens).toHaveLength(1);

    const file = getRegisteredFile(tokens[0]);
    expect(file?.filename).toBe('report.xlsx');
    expect(file?.sessionId).toBe('session-1');
    expect(file?.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('uses a custom display filename when provided', async () => {
    await fs.writeFile(path.join(rootDir, 'out.docx'), 'fake docx bytes');
    const tool = createSendFileTool({ rootDir });

    await tool.run({ path: 'out.docx', filename: 'Laporan Bulanan.docx' }, ctxFor('session-2'));
    const [token] = drainPendingTokens('session-2');
    expect(getRegisteredFile(token)?.filename).toBe('Laporan Bulanan.docx');
  });

  it('errors when the file does not exist', async () => {
    const tool = createSendFileTool({ rootDir });
    const result = await tool.run({ path: 'missing.xlsx' }, ctxFor('session-3')) as { error: string };
    expect(result.error).toMatch(/not found/i);
    expect(drainPendingTokens('session-3')).toHaveLength(0);
  });

  it('blocks path traversal outside rootDir', async () => {
    const tool = createSendFileTool({ rootDir });
    await expect(tool.run({ path: '../outside.xlsx' }, ctxFor('session-4'))).rejects.toThrow();
  });

  it('rejects a file larger than maxFileSize', async () => {
    await fs.writeFile(path.join(rootDir, 'big.bin'), Buffer.alloc(200));
    const tool = createSendFileTool({ rootDir, maxFileSize: 100 });
    const result = await tool.run({ path: 'big.bin' }, ctxFor('session-5')) as { error: string };
    expect(result.error).toMatch(/exceeds/i);
  });

  it('drainPendingTokens clears the queue so a second drain is empty', async () => {
    await fs.writeFile(path.join(rootDir, 'a.txt'), 'a');
    const tool = createSendFileTool({ rootDir });
    await tool.run({ path: 'a.txt' }, ctxFor('session-6'));

    expect(drainPendingTokens('session-6')).toHaveLength(1);
    expect(drainPendingTokens('session-6')).toHaveLength(0);
  });

  it('getRegisteredFile returns undefined for an unknown token', () => {
    expect(getRegisteredFile('not-a-real-token')).toBeUndefined();
  });
});
