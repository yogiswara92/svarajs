/**
 * @internal
 * Tool registry — stores and validates InternalTool definitions.
 */

import type { InternalTool } from '../core/types.js';

export class ToolRegistry {
  private tools: Map<string, InternalTool> = new Map();

  register(tool: InternalTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(
        `[@yesvara/svara] Tool "${tool.name}" is already registered. ` +
        'Use a different name or call registry.update() to replace it.'
      );
    }
    this.tools.set(tool.name, tool);
  }

  update(tool: InternalTool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): InternalTool | undefined {
    return this.tools.get(name);
  }

  getAll(): InternalTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }
}
