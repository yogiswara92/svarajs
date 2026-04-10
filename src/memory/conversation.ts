/**
 * @internal
 * Per-session conversation history store.
 */

import type { LLMMessage, SessionStore } from '../core/types.js';

export interface MemoryConfig {
  type: 'conversation' | 'none';
  maxMessages: number;
}

export class ConversationMemory {
  private sessions: Map<string, SessionStore> = new Map();

  constructor(private config: MemoryConfig) {}

  async getHistory(sessionId: string): Promise<LLMMessage[]> {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  async append(sessionId: string, messages: LLMMessage[]): Promise<void> {
    if (this.config.type === 'none') return;

    const store = this.sessions.get(sessionId) ?? {
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    store.messages.push(...messages);
    store.updatedAt = new Date();

    // Trim to window — always keep system messages
    if (store.messages.length > this.config.maxMessages) {
      const system = store.messages.filter((m) => m.role === 'system');
      const rest = store.messages.filter((m) => m.role !== 'system');
      store.messages = [...system, ...rest.slice(-this.config.maxMessages)];
    }

    this.sessions.set(sessionId, store);
  }

  async clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  getSessionIds(): string[] {
    return [...this.sessions.keys()];
  }
}
