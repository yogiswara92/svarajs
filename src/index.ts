/**
 * @yesvara/svara - Agentic AI Backend Framework
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

// ─── Built-in Tools ───────────────────────────────────────────────────────────
// Opt-in tools - not registered by default. See docs/SECURITY.md before
// enabling terminal_exec/file_write in an untrusted or multi-tenant setting.

export { createTerminalTool } from './tools/builtin/terminal.js';
export { createFilesystemTools } from './tools/builtin/filesystem.js';
export { createWebTools } from './tools/builtin/web.js';
/**
 * Browser tools require the optional "playwright" peer dependency
 * (`npm install playwright && npx playwright install chromium`).
 */
export { createBrowserTools, closeBrowser } from './tools/builtin/browser.js';
export { createSendFileTool, getRegisteredFile } from './tools/builtin/sendFile.js';

// ─── Security ─────────────────────────────────────────────────────────────────

export { ApprovalGate } from './security/approval.js';
export { validateWithinDir, PathTraversalError } from './security/pathGuard.js';
export { scanForThreats } from './security/threatPatterns.js';

// ─── Skills ───────────────────────────────────────────────────────────────────
// Usually configured via `AgentConfig.skillsDir` - direct SkillRegistry access
// is for advanced cases (e.g. the standalone runtime's dashboard API).

export { SkillRegistry } from './skills/registry.js';
export { createSkillTools } from './skills/tools.js';
export { guardSkillContent } from './skills/guard.js';
export { installSkillFromHub, createSkillHubTool, resolveSkillSourceUrl } from './skills/hub.js';

// ─── Learning Memory ────────────────────────────────────────────────────────
// Usually configured via `AgentConfig.learningMemory` - direct access is for
// advanced cases (e.g. the standalone runtime's dashboard API).

export { LearningMemory, DangerousContentError, DriftDetectedError } from './memory/learningFiles.js';
export { createMemoryTool } from './memory/learningTools.js';
export { createSessionSearchTool } from './memory/sessionSearchTool.js';
export { BackgroundReview } from './memory/backgroundReview.js';

// ─── Delegation ───────────────────────────────────────────────────────────────
// Needs a reference to the already-constructed parent agent, so it's wired up
// after the fact rather than via AgentConfig:
//   agent.addTool(...createDelegateTools(agent));

export { createDelegateTools } from './delegation/delegate.js';

// ─── Cron / Scheduled Tasks ─────────────────────────────────────────────────
// Needs a reference to the already-constructed parent agent, same pattern as
// delegation:
//   const scheduler = new CronScheduler({ agent });
//   agent.addTool(createCronTool(scheduler));

export { CronScheduler } from './cron/scheduler.js';
export { createCronTool } from './cron/tools.js';

// ─── MCP (Model Context Protocol) ──────────────────────────────────────────
// Needs a reference to the already-constructed parent agent, same pattern as
// delegation/cron: `new McpManager(agent)`, then `manager.connect(config)`.

export { McpManager } from './mcp/manager.js';
export { searchMcpRegistry, resolveRegistryServer } from './mcp/registry.js';

// ─── Database ─────────────────────────────────────────────────────────────────

export { SvaraDB } from './database/sqlite.js';

// ─── Advanced: Direct Channel Classes ────────────────────────────────────────
// Most users won't need these - use agent.connectChannel() instead.

export { WebChannel } from './channels/web.js';
export { TelegramChannel } from './channels/telegram.js';
export { WhatsAppChannel } from './channels/whatsapp.js';
export { SlackChannel } from './channels/slack.js';
export { DiscordChannel } from './channels/discord.js';

// ─── Advanced: RAG Components ─────────────────────────────────────────────────
// For building custom knowledge pipeline integrations.

export { DocumentLoader } from './rag/loader.js';
export { Chunker } from './rag/chunker.js';
export { VectorRetriever } from './rag/retriever.js';

// ─── Advanced: Context & Tokens ───────────────────────────────────────────────

export { ContextCompressor } from './memory/compressor.js';
export { countTokens } from './memory/tokenizer.js';

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
  Attachment,
} from './types.js';

// Channel-specific configs (for advanced usage)
export type { WebChannelConfig } from './channels/web.js';
export type { TelegramChannelConfig } from './channels/telegram.js';
export type { WhatsAppChannelConfig } from './channels/whatsapp.js';
export type { SlackChannelConfig } from './channels/slack.js';
export type { DiscordChannelConfig } from './channels/discord.js';

// Built-in tool option types
export type { TerminalToolOptions } from './tools/builtin/terminal.js';
export type { FilesystemToolsOptions } from './tools/builtin/filesystem.js';
export type { WebToolsOptions } from './tools/builtin/web.js';
export type { BrowserToolsOptions } from './tools/builtin/browser.js';
export type { SendFileToolOptions, RegisteredFile } from './tools/builtin/sendFile.js';
export type { ApprovalGateOptions, ApprovalResult } from './security/approval.js';
export type { ContextCompressorOptions } from './memory/compressor.js';
export type {
  Skill, SkillMeta, SkillFrontmatter, SkillTrust, SkillPlatform,
  SkillPrerequisites, SkillMetadata, SkillResources,
} from './skills/types.js';
export type { SkillRegistryOptions } from './skills/registry.js';
export type { SkillHubOptions } from './skills/hub.js';
export type { SkillToolsOptions } from './skills/tools.js';
export type { SkillGuardResult, GuardVerdict } from './skills/guard.js';
export type { ThreatMatch, ThreatCategory } from './security/threatPatterns.js';
export type { LearningMemoryOptions, LearningSnapshot, LearningFile } from './memory/learningFiles.js';
export type { BackgroundReviewOptions, ReviewExchange } from './memory/backgroundReview.js';
export type { DelegateToolsOptions } from './delegation/delegate.js';
export type { CronJobRecord, CronSchedulerOptions, CronJobExtra } from './cron/scheduler.js';
export type { McpServerConfig, McpTransportConfig, McpServerStatus } from './mcp/types.js';
export type { McpRegistryResult } from './mcp/registry.js';

// ─── Version ──────────────────────────────────────────────────────────────────
// Keep in sync with package.json "version" - bumped together at release time
// (see CONTRIBUTING.md → Release Process).

export const VERSION = '1.0.2';
