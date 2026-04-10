/**
 * @yesvara/svara — Agentic AI Backend Framework
 *
 * Build production-ready AI agents in minutes, not months.
 *
 * @example The 15-line agent
 * ```ts
 * import { SvaraApp, SvaraAgent } from '@yesvara/svara';
 *
 * const app = new SvaraApp();
 *
 * const agent = new SvaraAgent({
 *   name: 'Support Bot',
 *   model: 'gpt-4o-mini',
 *   knowledge: './docs',
 * });
 *
 * app.route('/chat', agent.handler());
 * app.listen(3000);
 * ```
 *
 * @example With tools and channels
 * ```ts
 * import { SvaraAgent, createTool } from '@yesvara/svara';
 *
 * const agent = new SvaraAgent({ name: 'Aria', model: 'gpt-4o' });
 *
 * agent
 *   .addTool(createTool({
 *     name: 'get_time',
 *     description: 'Get current date and time',
 *     parameters: {},
 *     async run() { return { time: new Date().toISOString() }; },
 *   }))
 *   .connectChannel('telegram', { token: process.env.TG_TOKEN! })
 *   .connectChannel('whatsapp', {
 *     token: process.env.WA_TOKEN!,
 *     phoneId: process.env.WA_PHONE_ID!,
 *     verifyToken: process.env.WA_VERIFY_TOKEN!,
 *   });
 *
 * await agent.start();
 * ```
 */

// ─── Framework Classes ────────────────────────────────────────────────────────

export { SvaraApp } from './app/index.js';
export { SvaraAgent } from './core/agent.js';

// ─── Tool Helpers ─────────────────────────────────────────────────────────────

export { createTool } from './tools/index.js';

// ─── Database ─────────────────────────────────────────────────────────────────

export { SvaraDB } from './database/sqlite.js';

// ─── Advanced: Direct Channel Classes ────────────────────────────────────────
// Most users won't need these — use agent.connectChannel() instead.

export { WebChannel } from './channels/web.js';
export { TelegramChannel } from './channels/telegram.js';
export { WhatsAppChannel } from './channels/whatsapp.js';

// ─── Advanced: RAG Components ─────────────────────────────────────────────────
// For building custom knowledge pipeline integrations.

export { DocumentLoader } from './rag/loader.js';
export { Chunker } from './rag/chunker.js';
export { VectorRetriever } from './rag/retriever.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type {
  // The main types you'll use every day
  AgentConfig,
  Tool,
  ToolParameter,
  AgentContext,
  ProcessResult,
  MemoryOptions,
  AppOptions,
  ChannelName,
} from './types.js';

// Channel-specific configs (for advanced usage)
export type { WebChannelConfig } from './channels/web.js';
export type { TelegramChannelConfig } from './channels/telegram.js';
export type { WhatsAppChannelConfig } from './channels/whatsapp.js';

// ─── Version ──────────────────────────────────────────────────────────────────

export const VERSION = '0.1.0';
