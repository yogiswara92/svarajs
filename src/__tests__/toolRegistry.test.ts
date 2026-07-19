import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import type { InternalTool } from '../core/types.js';

function makeTool(name: string): InternalTool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {},
    run: async () => ({ ok: true }),
  };
}

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('a'));
    expect(registry.has('a')).toBe(true);
    expect(registry.get('a')?.name).toBe('a');
    expect(registry.size).toBe(1);
  });

  it('throws when registering a duplicate name', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('a'));
    expect(() => registry.register(makeTool('a'))).toThrow(/already registered/);
  });

  it('update() replaces a tool without throwing', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('a'));
    const replaced = { ...makeTool('a'), description: 'replaced' };
    registry.update(replaced);
    expect(registry.get('a')?.description).toBe('replaced');
    expect(registry.size).toBe(1);
  });

  it('unregister removes a tool', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('a'));
    registry.unregister('a');
    expect(registry.has('a')).toBe(false);
  });

  it('getAll returns every registered tool', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));
    expect(registry.getAll().map((t) => t.name).sort()).toEqual(['a', 'b']);
  });
});
