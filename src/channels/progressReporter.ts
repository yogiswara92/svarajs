/**
 * @module channels/progressReporter
 * SvaraJS - live "what's it doing" progress for channels that support
 * editing a message after sending it (Telegram, Discord, Slack).
 *
 * The dashboard's web chat streams `tool:call` events over HTTP as they
 * happen (src/dashboard/serve.ts's /api/chat/stream) - a channel message
 * can't be streamed the same way, but Telegram/Discord/Slack all let a bot
 * edit a message it already sent, so the same effect is approximated by
 * sending one placeholder message and editing it as tools get called,
 * finally replacing it with the real reply. WhatsApp's Cloud API has no
 * edit-message endpoint at all, so it's left out - a reply there still
 * only appears once the whole turn is done, same as before this module.
 *
 * Reuses the exact `tool:call` event every channel's agent already emits
 * during core/agent.ts's tool-calling loop - nothing new on the agent side.
 */

import type { SvaraAgent } from '../core/agent.js';

export interface ProgressReporterOptions {
  agent: SvaraAgent;
  sessionId: string;
  /** Minimum time between edits, so a burst of tool calls doesn't trip the platform's rate limit on message edits. @default 1500 */
  throttleMs?: number;
  /** Send-or-edit, however this specific channel does it - called with the current progress text. Errors are swallowed (best-effort; a failed progress update shouldn't break the actual reply). */
  onUpdate: (text: string) => Promise<void>;
}

export interface ProgressReporter {
  /** True once at least one tool call happened - callers use this to decide whether a placeholder message exists to replace with the final reply, vs. sending it fresh. */
  hasUpdates(): boolean;
  /** Detaches the tool:call listener - always call this once the turn is done, success or not. */
  stop(): void;
  /** Formatted "done" version of the trace, e.g. to finalize the in-progress placeholder into a permanent record instead of overwriting it with the reply. Call after stop(). */
  summary(): string;
}

// Deliberately plain text, no markdown emphasis - tool names routinely
// contain underscores (file_write, svaramind_list_workspaces, ...), and
// every platform here (Telegram's legacy Markdown especially) treats a bare
// underscore as an emphasis marker, so wrapping this in _italics_ risks a
// parse error on the edit call over something a status line doesn't need.
function formatProgress(toolsUsed: string[], done: boolean): string {
  const lines = toolsUsed.map((t) => `• ${t}`);
  const label = done ? 'Done' : 'Working...';
  return `${label} (${toolsUsed.length} step${toolsUsed.length !== 1 ? 's' : ''})\n${lines.join('\n')}`;
}

/** Starts listening for this session's tool:call events and pushes throttled progress updates via `onUpdate`. */
export function attachProgressReporter(opts: ProgressReporterOptions): ProgressReporter {
  const throttleMs = opts.throttleMs ?? 1500;
  const toolsUsed: string[] = [];
  let lastUpdateAt = 0;

  const onToolCall = (evt: { sessionId: string; tools: string[] }) => {
    if (evt.sessionId !== opts.sessionId) return;
    toolsUsed.push(...evt.tools);

    const now = Date.now();
    if (now - lastUpdateAt < throttleMs) return; // leading-edge only - the final reply always lands regardless, so a skipped mid-run frame isn't lost information, just not shown
    lastUpdateAt = now;
    void opts.onUpdate(formatProgress(toolsUsed, false)).catch(() => {});
  };

  opts.agent.on('tool:call', onToolCall);

  return {
    hasUpdates: () => toolsUsed.length > 0,
    stop: () => opts.agent.off('tool:call', onToolCall),
    summary: () => formatProgress(toolsUsed, true),
  };
}
