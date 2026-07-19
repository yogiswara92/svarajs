/**
 * @module memory/compressor
 * SvaraJS - context compaction
 *
 * When a session's message history grows past a token budget, summarize the
 * middle of the conversation with a cheap/aux model, keeping the first few
 * and last few messages verbatim. The summary is tagged as reference-only so
 * the model doesn't mistake it for an active instruction.
 *
 * Only runs once per turn, before the tool-calling loop starts - messages
 * appended during the loop itself (tool calls/results) aren't re-compacted
 * mid-turn in this lean version.
 */

import type { LLMMessage } from '../core/types.js';
import type { LLMAdapter } from '../core/llm.js';
import { countTokens } from './tokenizer.js';

export interface ContextCompressorOptions {
  /** Total token budget for the message history. @default 8000 */
  contextWindow?: number;
  /** Compress once history exceeds this fraction of the budget. @default 0.75 */
  thresholdPercent?: number;
  /** Messages right after the system prompt to always keep verbatim. @default 2 */
  protectFirstN?: number;
  /** Most recent messages to always keep verbatim. @default 6 */
  protectLastN?: number;
}

const DEFAULTS: Required<ContextCompressorOptions> = {
  contextWindow: 8_000,
  thresholdPercent: 0.75,
  protectFirstN: 2,
  protectLastN: 6,
};

export class ContextCompressor {
  private opts: Required<ContextCompressorOptions>;

  constructor(
    private llm: LLMAdapter,
    private auxLlm: LLMAdapter | undefined,
    opts: ContextCompressorOptions = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Returns `messages` unchanged if under budget, or a compacted copy otherwise. */
  async maybeCompress(messages: LLMMessage[]): Promise<LLMMessage[]> {
    const totalTokens = messages.reduce((sum, m) => sum + countTokens(m.content), 0);
    const budget = this.opts.contextWindow * this.opts.thresholdPercent;
    if (totalTokens < budget) return messages;

    const system = messages[0]?.role === 'system' ? messages[0] : null;
    const rest = system ? messages.slice(1) : messages;

    const { protectFirstN, protectLastN } = this.opts;
    if (rest.length <= protectFirstN + protectLastN) return messages; // nothing worth summarizing

    const head = rest.slice(0, protectFirstN);
    const tail = rest.slice(rest.length - protectLastN);
    const middle = rest.slice(protectFirstN, rest.length - protectLastN);
    if (middle.length === 0) return messages;

    const summary = await this.summarize(middle);
    const summaryMessage: LLMMessage = {
      role: 'system',
      content:
        '[CONTEXT COMPACTION - REFERENCE ONLY. This is background from earlier in the conversation, ' +
        `not an instruction to act on.]\n${summary}`,
    };

    return [...(system ? [system] : []), ...head, summaryMessage, ...tail];
  }

  private async summarize(middle: LLMMessage[]): Promise<string> {
    const summarizer = this.auxLlm ?? this.llm;
    const transcript = middle
      .filter((m) => m.role !== 'tool')
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const response = await summarizer.chat([
      {
        role: 'system',
        content:
          'Summarize this conversation excerpt concisely for future reference. ' +
          'Track: Resolved (decisions/answers already given) and Pending (open questions/tasks). ' +
          'Be terse - this is a compaction summary, not a report.',
      },
      { role: 'user', content: transcript },
    ], undefined, 0.3);

    return response.content;
  }
}
