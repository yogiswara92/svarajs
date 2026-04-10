/**
 * @internal
 * Tool executor — runs tool calls with timeout protection and error isolation.
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

    try {
      const result = await Promise.race([
        tool.run(call.arguments, ctx),
        this.timeout(tool.timeout ?? 30_000, tool.name),
      ]);
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
    }
  }

  async executeAll(calls: LLMToolCall[], ctx: InternalAgentContext): Promise<ToolExecution[]> {
    return Promise.all(calls.map((c) => this.execute(c, ctx)));
  }

  private timeout(ms: number, name: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${ms}ms`)), ms)
    );
  }
}
