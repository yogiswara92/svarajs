/**
 * @module memory/sessionSearchTool
 * SvaraJS - search across every persisted session, not just the current
 * one's message window. Three modes over SQLite FTS5, no LLM cost:
 * - `search` (DISCOVERY) - full-text keyword search across all history.
 * - `browse` (BROWSE) - most recently active sessions, chronological.
 * - `context` (SCROLL) - a window of messages around a specific one.
 */

import type { Tool } from '../types.js';
import type { SvaraDB } from '../database/sqlite.js';

export function createSessionSearchTool(db: SvaraDB): Tool {
  return {
    name: 'session_search',
    description:
      'Search or browse past conversation sessions. "search" full-text searches every persisted ' +
      'message (not just the current session); "browse" lists recently active sessions; "context" ' +
      'loads the messages around a specific one (use the messageId/sessionId from a search result).',
    parameters: {
      action: { type: 'string', description: 'One of: search, browse, context', required: true, enum: ['search', 'browse', 'context'] },
      query: { type: 'string', description: 'Keywords to search for (required for action=search)' },
      sessionId: { type: 'string', description: 'Session id (required for action=context)' },
      messageId: { type: 'string', description: 'Message id to center the window on (required for action=context)' },
      limit: { type: 'number', description: 'Max results/sessions to return', default: 20 },
    },
    async run({ action, query, sessionId, messageId, limit }) {
      const n = Number(limit) || 20;

      switch (action) {
        case 'search': {
          if (!query) return { error: 'search requires "query".' };
          return { results: db.searchMessages(String(query), n) };
        }
        case 'browse': {
          return { sessions: db.listRecentSessions(n) };
        }
        case 'context': {
          if (!sessionId || !messageId) return { error: 'context requires "sessionId" and "messageId".' };
          const messages = db.getMessageContext(String(sessionId), String(messageId), 5);
          if (messages.length === 0) return { error: `Message "${messageId}" not found in session "${sessionId}".` };
          return { messages };
        }
        default:
          return { error: `Unknown action "${action}". Use search, browse, or context.` };
      }
    },
  };
}
