/**
 * @module memory/learningTools
 * The `memory` tool - lets the agent add/replace/remove entries in
 * MEMORY.md (its own notes) or USER.md (what it's learned about the user).
 */

import type { Tool } from '../types.js';
import type { LearningMemory } from './learningFiles.js';

export function createMemoryTool(memory: LearningMemory): Tool {
  return {
    name: 'memory',
    description:
      'Add, replace, or remove a note in persistent memory. Use "agent" for your own notes ' +
      '(environment facts, conventions) and "user" for what you learn about the person you\'re talking to.',
    parameters: {
      action: { type: 'string', description: 'One of: add, replace, remove', required: true, enum: ['add', 'replace', 'remove'] },
      target: { type: 'string', description: 'Which file: "agent" (MEMORY.md) or "user" (USER.md)', required: true, enum: ['agent', 'user'] },
      entry: { type: 'string', description: 'The note text (required for add; the new text for replace)' },
      match: { type: 'string', description: 'Substring identifying an existing entry (required for replace/remove)' },
    },
    async run(args) {
      const file = args.target === 'user' ? 'USER.md' : 'MEMORY.md';
      const action = String(args.action);

      try {
        switch (action) {
          case 'add': {
            if (!args.entry) return { error: 'add requires "entry".' };
            await memory.add(file, String(args.entry));
            return { added: true };
          }
          case 'replace': {
            if (!args.match || !args.entry) return { error: 'replace requires "match" and "entry".' };
            return await memory.replace(file, String(args.match), String(args.entry));
          }
          case 'remove': {
            if (!args.match) return { error: 'remove requires "match".' };
            return await memory.remove(file, String(args.match));
          }
          default:
            return { error: `Unknown action "${action}". Use add, replace, or remove.` };
        }
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}
