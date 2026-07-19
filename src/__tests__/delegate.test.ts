import { describe, it, expect, vi } from 'vitest';
import { createDelegateTools } from '../delegation/delegate.js';
import type { SvaraAgent } from '../core/agent.js';
import type { Tool, AgentContext } from '../types.js';

const ctx = {} as AgentContext;

function fakeParent(opts: {
  tools?: Tool[];
  process: (prompt: string) => Promise<{ response: string }>;
}) {
  const spawnChild = vi.fn((_overrides: unknown) => ({ process: opts.process }));
  const getTools = vi.fn(() => opts.tools ?? []);
  return { fake: { getTools, spawnChild } as unknown as SvaraAgent, spawnChild, getTools };
}

describe('createDelegateTools', () => {
  it('runs a task synchronously by default and returns the child response', async () => {
    const { fake } = fakeParent({ process: async (prompt) => ({ response: `handled: ${prompt}` }) });
    const [delegateTask] = createDelegateTools(fake);
    const result = await delegateTask.run({ goal: 'do the thing' }, ctx) as { response: string };
    expect(result.response).toBe('handled: do the thing');
  });

  it('includes context in the prompt passed to the child', async () => {
    let capturedPrompt = '';
    const { fake } = fakeParent({
      process: async (prompt) => { capturedPrompt = prompt; return { response: 'ok' }; },
    });
    const [delegateTask] = createDelegateTools(fake);
    await delegateTask.run({ goal: 'goal text', context: 'context text' }, ctx);
    expect(capturedPrompt).toContain('goal text');
    expect(capturedPrompt).toContain('context text');
  });

  it('excludes blocked tools (delegate_task, memory by default) from the child toolset', async () => {
    const tools: Tool[] = [
      { name: 'search', description: 'd', parameters: {}, run: async () => ({}) },
      { name: 'delegate_task', description: 'd', parameters: {}, run: async () => ({}) },
      { name: 'memory', description: 'd', parameters: {}, run: async () => ({}) },
    ];
    const { fake, spawnChild } = fakeParent({ tools, process: async () => ({ response: 'ok' }) });
    const [delegateTask] = createDelegateTools(fake);
    await delegateTask.run({ goal: 'x' }, ctx);

    const overrides = spawnChild.mock.calls[0][0] as { tools: Tool[] };
    expect(overrides.tools.map((t) => t.name)).toEqual(['search']);
  });

  it('catches a child failure and returns an error instead of throwing', async () => {
    const { fake } = fakeParent({ process: async () => { throw new Error('child blew up'); } });
    const [delegateTask] = createDelegateTools(fake);
    const result = await delegateTask.run({ goal: 'x' }, ctx) as { error: string };
    expect(result.error).toBe('child blew up');
  });

  it('background=true returns a handle immediately, resolvable via delegate_status', async () => {
    let resolveChild!: (v: { response: string }) => void;
    const { fake } = fakeParent({
      process: () => new Promise((resolve) => { resolveChild = resolve; }),
    });
    const [delegateTask, delegateStatus] = createDelegateTools(fake);

    const started = await delegateTask.run({ goal: 'x', background: true }, ctx) as { handle: string; status: string };
    expect(started.status).toBe('running');

    const whileRunning = await delegateStatus.run({ handle: started.handle }, ctx) as { status: string };
    expect(whileRunning.status).toBe('running');

    resolveChild({ response: 'finished' });
    await new Promise((r) => setTimeout(r, 0)); // let the .then() microtask settle

    const afterDone = await delegateStatus.run({ handle: started.handle }, ctx) as { status: string; response: string };
    expect(afterDone.status).toBe('done');
    expect(afterDone.response).toBe('finished');
  });

  it('delegate_status reports an error for an unknown handle', async () => {
    const { fake } = fakeParent({ process: async () => ({ response: 'ok' }) });
    const [, delegateStatus] = createDelegateTools(fake);
    const result = await delegateStatus.run({ handle: 'nonexistent' }, ctx) as { error: string };
    expect(result.error).toMatch(/Unknown handle/);
  });
});
