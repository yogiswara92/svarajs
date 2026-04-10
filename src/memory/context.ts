/**
 * @internal
 * Builds the messages array sent to the LLM on each call.
 */

import type { LLMMessage } from '../core/types.js';
import type { LLMAdapter } from '../core/llm.js';

export class ContextBuilder {
  constructor(private llm: LLMAdapter) {}

  buildMessages(
    systemPrompt: string,
    history: LLMMessage[],
    userMessage: string,
    ragContext?: string
  ): LLMMessage[] {
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      // Exclude any system messages from history — we prepend our own
      ...history.filter((m) => m.role !== 'system'),
    ];

    const content = ragContext
      ? this.augmentWithRAG(userMessage, ragContext)
      : userMessage;

    messages.push({ role: 'user', content });
    return messages;
  }

  estimateTokens(messages: LLMMessage[]): number {
    const text = messages.map((m) => m.content).join(' ');
    return this.llm.countTokens(text);
  }

  private augmentWithRAG(message: string, context: string): string {
    return [
      'Use the following context to answer the question.',
      "If the answer isn't in the context, say so honestly — don't guess.",
      '',
      '--- Context ---',
      context,
      '--- End Context ---',
      '',
      `Question: ${message}`,
    ].join('\n');
  }
}
