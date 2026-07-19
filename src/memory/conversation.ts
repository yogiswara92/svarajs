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

  /** True if this session already has an in-process history (no DB hydration needed). */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Seed the in-process cache from externally-loaded messages (e.g. SQLite), without re-persisting them. */
  async hydrate(sessionId: string, messages: LLMMessage[]): Promise<void> {
    if (this.sessions.has(sessionId) || messages.length === 0) return;
    this.sessions.set(sessionId, {
      messages,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
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

    // Trim to window - always keep system messages
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
