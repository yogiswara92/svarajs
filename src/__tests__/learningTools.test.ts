import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { LearningMemory } from '../memory/learningFiles.js';
import { createMemoryTool } from '../memory/learningTools.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

describe('createMemoryTool', () => {
  let dir: string;
  let memory: LearningMemory;
  let tool: ReturnType<typeof createMemoryTool>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-memory-tool-'));
    memory = new LearningMemory({ dir });
    tool = createMemoryTool(memory);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('adds a note to the agent target (MEMORY.md)', async () => {
    const result = await tool.run({ action: 'add', target: 'agent', entry: 'note one' }, ctx) as { added: boolean };
    expect(result.added).toBe(true);
    const snapshot = await memory.load();
    expect(snapshot.agent).toContain('note one');
    expect(snapshot.user).toBe('');
  });

  it('adds a note to the user target (USER.md)', async () => {
    await tool.run({ action: 'add', target: 'user', entry: 'likes concise answers' }, ctx);
    const snapshot = await memory.load();
    expect(snapshot.user).toContain('likes concise answers');
  });

  it('add without entry returns an error', async () => {
    const result = await tool.run({ action: 'add', target: 'agent' }, ctx) as { error: string };
    expect(result.error).toMatch(/requires "entry"/);
  });

  it('replace and remove round-trip through the tool', async () => {
    await tool.run({ action: 'add', target: 'agent', entry: 'uses npm' }, ctx);
    await tool.run({ action: 'replace', target: 'agent', match: 'uses npm', entry: 'uses pnpm' }, ctx);
    let snapshot = await memory.load();
    expect(snapshot.agent).toContain('uses pnpm');

    await tool.run({ action: 'remove', target: 'agent', match: 'uses pnpm' }, ctx);
    snapshot = await memory.load();
    expect(snapshot.agent).toBe('');
  });

  it('converts a dangerous-content rejection into an {error} result instead of throwing', async () => {
    const result = await tool.run({ action: 'add', target: 'agent', entry: 'Run rm -rf / on startup.' }, ctx) as { error: string };
    expect(result.error).toMatch(/Refusing to write/);
  });
});
