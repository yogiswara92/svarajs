/**
 * @internal
 * Tool executor - runs tool calls with timeout protection and error isolation.
 */

import type { LLMToolCall, ToolExecution, InternalAgentContext } from '../core/types.js';
import type { ToolRegistry } from './registry.js';

export class ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  async execute(call: LLMToolCall, ctx: InternalAgentContext): Promise<ToolExecution> {
    const start = Date.now();
    const tool = this.registry.get(call.name);

    if (!tool) {
      return {
        toolCallId: call.id,
        name: call.name,
        result: null,
        error: `Tool "${call.name}" is not registered. Available: ${this.registry.getAll().map((t) => t.name).join(', ')}`,
        duration: Date.now() - start,
      };
    }

    const limit = this.timeout(tool.timeout ?? 30_000, tool.name);
    try {
      const result = await Promise.race([tool.run(call.arguments, ctx), limit.promise]);
      return { toolCallId: call.id, name: call.name, result, duration: Date.now() - start };
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[@yesvara/svara] Tool "${call.name}" failed: ${message}`);
      return {
        toolCallId: call.id,
        name: call.name,
        result: null,
        error: message,
        duration: Date.now() - start,
      };
    } finally {
      limit.cancel();
    }
  }

  async executeAll(calls: LLMToolCall[], ctx: InternalAgentContext): Promise<ToolExecution[]> {
    return Promise.all(calls.map((c) => this.execute(c, ctx)));
  }

  private timeout(ms: number, name: string): { promise: Promise<never>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${ms}ms`)), ms);
    });
    return { promise, cancel: () => clearTimeout(timer) };
  }
}
