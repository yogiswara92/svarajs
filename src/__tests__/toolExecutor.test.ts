import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import type { InternalAgentContext, LLMToolCall } from '../core/types.js';

function ctx(): InternalAgentContext {
  return { sessionId: 's1', userId: 'u1', agentName: 'test', history: [], metadata: {} };
}

describe('ToolExecutor', () => {
  it('executes a tool and returns its result', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echoes input',
      parameters: {},
      run: async (args) => ({ echoed: args.text }),
    });
    const executor = new ToolExecutor(registry);
    const call: LLMToolCall = { id: '1', name: 'echo', arguments: { text: 'hi' } };
    const [result] = await executor.executeAll([call], ctx());
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ echoed: 'hi' });
  });

  it('returns an error result for an unregistered tool instead of throwing', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    const call: LLMToolCall = { id: '1', name: 'missing', arguments: {} };
    const [result] = await executor.executeAll([call], ctx());
    expect(result.error).toMatch(/not registered/);
  });

  it('captures a thrown error from a tool without propagating it', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'boom',
      description: 'always throws',
      parameters: {},
      run: async () => { throw new Error('kaboom'); },
    });
    const executor = new ToolExecutor(registry);
    const call: LLMToolCall = { id: '1', name: 'boom', arguments: {} };
    const [result] = await executor.executeAll([call], ctx());
    expect(result.error).toBe('kaboom');
  });

  it('times out a tool that runs longer than its configured timeout', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow',
      description: 'never resolves in time',
      parameters: {},
      timeout: 20,
      run: () => new Promise((resolve) => setTimeout(resolve, 200)),
    });
    const executor = new ToolExecutor(registry);
    const call: LLMToolCall = { id: '1', name: 'slow', arguments: {} };
    const [result] = await executor.executeAll([call], ctx());
    expect(result.error).toMatch(/timed out/);
  });

  it('executes multiple tool calls concurrently', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'a', description: 'a', parameters: {}, run: async () => 'A' });
    registry.register({ name: 'b', description: 'b', parameters: {}, run: async () => 'B' });
    const executor = new ToolExecutor(registry);
    const calls: LLMToolCall[] = [
      { id: '1', name: 'a', arguments: {} },
      { id: '2', name: 'b', arguments: {} },
    ];
    const results = await executor.executeAll(calls, ctx());
    expect(results.map((r) => r.result)).toEqual(['A', 'B']);
  });
});
