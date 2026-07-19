import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { createTerminalTool } from '../tools/builtin/terminal.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

describe('createTerminalTool', () => {
  it('runs a safe command and returns stdout', async () => {
    const tool = createTerminalTool({
      cwd: os.tmpdir(),
      approval: { allowlistPath: path.join(os.tmpdir(), `svara-term-allowlist-${Date.now()}.json`) },
    });
    const result = await tool.run({ command: 'echo hello-svara' }, ctx) as { stdout: string; exitCode: number };
    expect(result.stdout.trim()).toBe('hello-svara');
    expect(result.exitCode).toBe(0);
  });

  it('blocks a dangerous command instead of running it', async () => {
    const tool = createTerminalTool({
      cwd: os.tmpdir(),
      approval: { allowlistPath: path.join(os.tmpdir(), `svara-term-allowlist-${Date.now()}.json`) },
    });
    const result = await tool.run({ command: 'sudo rm -rf /' }, ctx) as { blocked: boolean; reason: string };
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('throws at creation time when backend is docker without a container', () => {
    expect(() => createTerminalTool({ backend: 'docker' })).toThrow(/dockerContainer/);
  });
});
