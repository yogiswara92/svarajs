/**
 * @module delegation/delegate
 * SvaraJS - sub-agent delegation
 *
 * `delegate_task` spawns a fresh `SvaraAgent` (via `parent.spawnChild()`)
 * with a clean conversation and a restricted toolset - no further
 * delegation, no memory writes by default - runs the task, and returns
 * just the final result to the parent (the child's intermediate tool calls
 * stay isolated from the parent's context).
 *
 * Lean by design: background mode is a simple in-process Map of handles,
 * not a durable cross-restart queue.
 */

import type { SvaraAgent } from '../core/agent.js';
import type { Tool } from '../types.js';

export interface DelegateToolsOptions {
  /** Tool names excluded from the child's inherited toolset. @default ['delegate_task', 'memory'] */
  blockedTools?: string[];
  /** Override the child's model (e.g. a cheaper one for routine delegated work). */
  model?: string;
}

const DEFAULT_BLOCKED = ['delegate_task', 'memory'];

type DelegateResult = { response: string } | { error: string };

export function createDelegateTools(parent: SvaraAgent, opts: DelegateToolsOptions = {}): Tool[] {
  const blocked = new Set(opts.blockedTools ?? DEFAULT_BLOCKED);
  const pending = new Map<string, Promise<DelegateResult> | DelegateResult>();

  async function runDelegatedTask(goal: string, context?: string): Promise<DelegateResult> {
    try {
      const childTools = parent.getTools().filter((t) => !blocked.has(t.name));
      const child = parent.spawnChild({
        model: opts.model,
        systemPrompt:
          'You are a focused sub-agent completing exactly one delegated task. ' +
          'Work independently, then report the final result clearly and concisely.',
        tools: childTools,
      });
      const prompt = context ? `${goal}\n\n--- Context ---\n${context}` : goal;
      const result = await child.process(prompt);
      return { response: result.response };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  const delegateTask: Tool = {
    name: 'delegate_task',
    description:
      'Delegate a self-contained task to a fresh sub-agent with a clean context and a restricted ' +
      'toolset (no further delegation, no memory writes). Use for well-scoped sub-tasks you can ' +
      'describe fully upfront.',
    parameters: {
      goal: { type: 'string', description: 'The task for the sub-agent to complete', required: true },
      context: { type: 'string', description: 'Relevant background to pass along, if any' },
      background: { type: 'boolean', description: 'Run in the background and return a handle instead of blocking' },
    },
    timeout: 120_000,
    async run({ goal, context, background }) {
      if (!background) {
        return runDelegatedTask(String(goal), context as string | undefined);
      }

      const handle = crypto.randomUUID();
      pending.set(
        handle,
        runDelegatedTask(String(goal), context as string | undefined).then((r) => {
          pending.set(handle, r);
          return r;
        })
      );
      return { handle, status: 'running' };
    },
  };

  const delegateStatus: Tool = {
    name: 'delegate_status',
    description: 'Check the status/result of a background delegated task by its handle.',
    parameters: {
      handle: { type: 'string', description: 'Handle returned by delegate_task with background=true', required: true },
    },
    async run({ handle }) {
      const entry = pending.get(String(handle));
      if (!entry) return { error: `Unknown handle "${handle}".` };
      if (entry instanceof Promise) return { status: 'running' };
      return { status: 'done', ...entry };
    },
  };

  return [delegateTask, delegateStatus];
}
