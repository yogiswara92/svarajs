/**
 * @module integrations/svaramindContext
 * Searches the user's Svaramind workspaces for every message before the model answers (CENS-RAG: keyword, meaning
 * and knowledge graph), so notes and known facts are used even when the model would not have thought to search.
 * What is found goes into the prompt and shows up as the reply's sources. Short small talk is skipped, and a slow
 * or failing search never holds up the reply for long.
 */

import type { McpManager } from '../mcp/manager.js';
import type { ContextProvider, RetrievedDocument } from '../core/types.js';
import { SVARAMIND_SERVER_ID } from './svaramind.js';

export interface SvaramindContextOptions {
  /** Workspaces to search (at most 4 are searched). Default: the pinned workspace. */
  workspaces?: string[];
  /** Results per workspace. @default 4 */
  limit?: number;
  /** Messages shorter than this are not searched. @default 12 */
  minChars?: number;
  /** Give up on a workspace after this long. @default 12000 */
  timeoutMs?: number;
}

interface SearchResult {
  success?: boolean;
  results?: Array<{ document_id?: string; title?: string; chunk_text?: string; score?: number; link?: string }>;
  knowledge_graph?: string | null;
  weak_match?: boolean;
}

const SMALL_TALK = /^(hi|hai|halo|hello|hey|ok|oke|okay|thanks|thank you|makasih|terima kasih|sip|mantap|yes|ya|no|tidak|good (morning|night)|selamat (pagi|siang|sore|malam))\b[\s!.?]*$/i;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms))]);

export function createSvaramindContextProvider(mcp: McpManager, opts: SvaramindContextOptions = {}): ContextProvider {
  const limit = opts.limit ?? 4;
  const minChars = opts.minChars ?? 12;
  const timeoutMs = opts.timeoutMs ?? 12000;
  return {
    name: 'Svaramind workspace search',
    async run(message) {
      const q = message.trim();
      if (!mcp.isConnected(SVARAMIND_SERVER_ID)) return null;
      if (q.length < minChars || SMALL_TALK.test(q)) return null;
      const pinned = mcp.getPinned(SVARAMIND_SERVER_ID).workspace_id;
      const ids = [...new Set([...(opts.workspaces ?? []), ...(pinned ? [String(pinned)] : [])])].slice(0, 4);
      if (!ids.length) return null;

      const answers = await Promise.all(ids.map(async (workspace_id) => {
        try {
          const raw = await withTimeout(mcp.callToolDirect(SVARAMIND_SERVER_ID, 'svaramind_search', { workspace_id, query: q.slice(0, 1000), limit }), timeoutMs);
          return typeof raw === 'string' ? JSON.parse(raw) as SearchResult : raw as SearchResult;
        } catch {
          return null;
        }
      }));

      const docs: RetrievedDocument[] = [];
      const passages: string[] = [];
      const graph: string[] = [];
      for (const a of answers) {
        if (!a?.success) continue;
        if (a.knowledge_graph) graph.push(String(a.knowledge_graph).slice(0, 2500));
        for (const r of a.results ?? []) {
          if (a.weak_match && (r.score ?? 0) < 0.35) continue;
          const text = String(r.chunk_text ?? '').slice(0, 1200);
          docs.push({ source: r.title || 'Untitled', score: Math.round((r.score ?? 0) * 100) / 100, excerpt: text.slice(0, 200), link: r.link });
          passages.push(`[${r.title || 'Untitled'}${r.document_id ? ` | document_id ${r.document_id}` : ''}${r.link ? ` | ${r.link}` : ''}]\n${text}`);
        }
      }
      docs.sort((a, b) => b.score - a.score);
      if (!docs.length && !graph.length) return { note: answers.some(Boolean) ? 'Nothing relevant found' : 'Search did not answer' };

      const text = [
        '--- Found in the user\'s Svaramind workspace for this message (searched automatically) ---',
        'Use it when it answers the question, name the documents you used, and say so if it does not cover the question. Call svaramind_search or svaramind_read_document for more.',
        ...(graph.length ? ['Knowledge graph:', ...graph] : []),
        ...(passages.length ? ['Notes:', ...passages.slice(0, 10)] : []),
      ].join('\n\n');
      return { text, documents: docs.slice(0, 10), note: `${docs.length} note${docs.length === 1 ? '' : 's'}${graph.length ? ' and knowledge-graph facts' : ''}` };
    },
  };
}
