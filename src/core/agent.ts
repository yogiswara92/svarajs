/**
 * @module SvaraAgent
 *
 * The heart of the framework. One class. Infinite possibilities.
 *
 * A SvaraAgent is a stateful AI agent that:
 * - Holds a conversation across multiple turns (memory)
 * - Can search your documents to answer questions (RAG)
 * - Can call functions you define (tools)
 * - Can receive messages from any channel (WhatsApp, Telegram, Web, etc.)
 *
 * @example Minimal - works in 5 lines
 * ```ts
 * const agent = new SvaraAgent({ name: 'Aria', model: 'gpt-4o' });
 * const reply = await agent.chat('What is the capital of France?');
 * console.log(reply); // "Paris"
 * ```
 *
 * @example Full - production-ready bot
 * ```ts
 * const agent = new SvaraAgent({
 *   name: 'Support Bot',
 *   model: 'gpt-4o-mini',
 *   systemPrompt: 'You are a helpful support agent.',
 *   knowledge: './docs',
 *   memory: { window: 20 },
 * });
 *
 * agent
 *   .addTool(emailTool)
 *   .addTool(databaseTool)
 *   .connectChannel('telegram', { token: process.env.TG_TOKEN });
 *
 * await agent.start();
 * ```
 */

import EventEmitter from 'events';
import type { RequestHandler, Express } from 'express';
import { createAdapter, resolveConfig, type LLMAdapter } from './llm.js';
import type {
  LLMConfig,
  LLMMessage,
  InternalTool,
  InternalAgentContext,
  AgentRunResult,
  AgentRunOptions,
  IncomingMessage,
  ChannelName,
  TokenUsage,
  RAGRetriever,
  KnowledgeDocument,
  Attachment,
  RAGConfig,
} from './types.js';
import { ConversationMemory } from '../memory/conversation.js';
import { ContextBuilder } from '../memory/context.js';
import { ContextCompressor } from '../memory/compressor.js';
import { ToolRegistry } from '../tools/registry.js';
import { SkillRegistry } from '../skills/registry.js';
import { createSkillTools } from '../skills/tools.js';
import { createSkillHubTool } from '../skills/hub.js';
import { LearningMemory } from '../memory/learningFiles.js';
import { createMemoryTool } from '../memory/learningTools.js';
import { createSessionSearchTool } from '../memory/sessionSearchTool.js';
import { BackgroundReview } from '../memory/backgroundReview.js';
import { SvaraDB } from '../database/sqlite.js';
import { ToolExecutor } from '../tools/executor.js';
import { drainPendingTokens, getRegisteredFile } from '../tools/builtin/sendFile.js';
import type { Tool } from '../types.js';

// ─── Channel Interface (implemented in channels/) ─────────────────────────────

export interface SvaraChannel {
  readonly name: ChannelName;
  mount(agent: SvaraAgent): Promise<void>;
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>;
  stop(): Promise<void>;
}

// ─── RAG Interface (implemented in rag/) ─────────────────────────────────────

export interface KnowledgeBase {
  load(paths: string | string[]): Promise<void>;
  retrieve(query: string, topK?: number): Promise<string>;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface AgentConfig {
  /**
   * Display name for this agent.
   * Used in logs, system prompts, and the CLI.
   */
  name: string;

  /**
   * LLM model to use. Provider is auto-detected from the name.
   *
   * @example 'gpt-4o'             - OpenAI (needs OPENAI_API_KEY)
   * @example 'claude-opus-4-6'   - Anthropic (needs ANTHROPIC_API_KEY)
   * @example 'llama3'             - Ollama (local, needs Ollama running)
   * @example 'gpt-4o-mini'        - OpenAI (cheaper, faster)
   */
  model: string;

  /**
   * Instruction that shapes the agent's personality and behavior.
   * If omitted, a sensible default is used based on `name`.
   */
  systemPrompt?: string;

  /**
   * Path(s) to your documents for RAG (Retrieval Augmented Generation).
   * Supports PDF, Markdown, TXT, DOCX, HTML, JSON. Glob patterns welcome.
   *
   * @example './docs'
   * @example ['./faqs.pdf', './policies/*.md']
   */
  knowledge?: string | string[];

  /**
   * Embedding provider used to index `knowledge` documents and RAG uploads.
   * Separate from `llm`/`model` above - an OpenAI-compatible chat endpoint
   * (OpenRouter, etc.) doesn't necessarily also serve embeddings, so this
   * needs its own provider/key. `provider: 'ollama'` needs no API key at
   * all (a local Ollama server, model `nomic-embed-text` by default).
   * @default { provider: 'openai' } - needs OPENAI_API_KEY or `apiKey` here
   */
  embeddings?: RAGConfig['embeddings'];

  /**
   * Conversation memory configuration.
   * - `true` - enable with defaults (20 message window, persisted to SQLite)
   * - `false` - disable (stateless, every call is fresh)
   * - object - custom configuration
   *
   * @default true
   */
  memory?: boolean | { window?: number; persist?: boolean };

  /**
   * Tools (function calls) the agent can use.
   * Can also add tools later with `agent.addTool()`.
   */
  tools?: Tool[];

  /**
   * LLM temperature - controls creativity vs. precision.
   * 0 = deterministic, 2 = very creative. Default: 0.7
   */
  temperature?: number;

  /**
   * Max output tokens per LLM call. Default: provider-dependent.
   */
  maxTokens?: number;

  /**
   * Maximum agentic loop iterations (tool calls) per message.
   * Prevents infinite loops. Default: 10
   */
  maxIterations?: number;

  /**
   * Advanced: override LLM provider or add custom endpoint.
   * Usually not needed - `model` auto-detects the provider.
   */
  llm?: Partial<LLMConfig>;

  /**
   * Token budget for a session's message history. Once history crosses
   * ~75% of this, older turns are summarized (context compaction) instead
   * of being sent verbatim. @default 8000
   */
  contextWindow?: number;

  /**
   * Cheaper/faster model used for context-compaction summaries (and, later,
   * skill/memory background review). Falls back to the main `model` if omitted.
   *
   * @example 'gpt-4o-mini'
   */
  auxiliaryModel?: string;

  /**
   * Directory of skills (`<id>/SKILL.md`) this agent can discover, read, and
   * - via the `skill_manage` tool - create/edit/delete for itself. Omit to
   * disable the skill system entirely (default).
   *
   * @example './skills'
   */
  skillsDir?: string;

  /**
   * Content guard for agent-created skills (skills the agent writes itself
   * via `skill_manage`, as opposed to ones already on disk). When set, skill
   * content matching a dangerous pattern (destructive/exfiltration) routes
   * through `onDangerousContent` instead of writing silently - return
   * `false` to block. Omit to leave agent-created skills unguarded (default).
   */
  skillsGuard?: {
    onDangerousContent?: (skillId: string, findings: Array<{ category: string; description: string }>) => Promise<boolean>;
  };

  /**
   * Registers the `skill_install` tool, letting the agent install a skill
   * from a public GitHub repo (`owner/repo[@ref][/path]` or a raw SKILL.md
   * URL). Hub-installed skills go through the strictest guard tier -
   * `onApprovalNeeded` decides caution/dangerous content; omit it to always
   * decline. Requires `skillsDir`. @default false (not registered)
   */
  skillsHub?: {
    onApprovalNeeded?: (skillId: string, verdict: 'ask' | 'block', findings: Array<{ category: string; description: string }>) => Promise<boolean>;
  };

  /**
   * Persistent "learning" memory - MEMORY.md (agent's own notes) and USER.md
   * (what it's learned about the user), injected into the system prompt.
   * - `true` - enable with defaults (`./memory`)
   * - object - custom directory
   * @default false
   */
  learningMemory?: boolean | { dir?: string };

  /**
   * After each turn, silently replay the exchange through the model (using
   * `auxiliaryModel` if set, otherwise the main model) with only the
   * `memory`/`skill_manage` tools available, letting it decide on its own
   * whether anything is worth remembering - no explicit "remember this"
   * needed from the user. Runs after the response is already sent, never
   * blocks or fails a turn. Requires `learningMemory` and/or `skillsDir` to
   * be configured (nothing to review otherwise). @default false
   */
  backgroundReview?: boolean;

  /**
   * Print detailed logs of every LLM call, tool execution, and memory operation.
   * Useful during development. Default: false
   */
  verbose?: boolean;
}

// ─── SvaraAgent ──────────────────────────────────────────────────────────────

export class SvaraAgent extends EventEmitter {
  readonly name: string;

  private readonly llmConfig: LLMConfig;
  private readonly llm: LLMAdapter;
  private readonly systemPrompt: string;
  private readonly tools: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly memory: ConversationMemory;
  private readonly context: ContextBuilder;
  private readonly compressor: ContextCompressor;
  private readonly maxIterations: number;
  private readonly verbose: boolean;
  private readonly persistMemory: boolean;

  private readonly skillRegistry: SkillRegistry | null = null;
  private readonly learningMemory: LearningMemory | null = null;
  private readonly backgroundReview: BackgroundReview | null = null;
  private childCounter = 0;
  private channels: Map<ChannelName, SvaraChannel> = new Map();
  private knowledgeBase: KnowledgeBase | null = null;
  private retriever: any = null; // Store VectorRetriever for retrieveChunks access
  private knowledgePaths: string[] = [];
  private readonly embeddingsConfig: RAGConfig['embeddings'];
  private isStarted = false;
  private isKnowledgeInitialized = false;
  private db: SvaraDB;

  constructor(config: AgentConfig) {
    super();
    // Each concurrent streaming chat request (dashboard's /api/chat/stream)
    // adds a temporary 'tool:call' listener for its duration - the default
    // cap of 10 would print noisy MaxListenersExceededWarnings well within
    // normal multi-tab/multi-session usage.
    this.setMaxListeners(50);

    this.name = config.name;
    this.maxIterations = config.maxIterations ?? 10;
    this.verbose = config.verbose ?? false;
    this.db = new SvaraDB(`./data/${config.name}.db`);

    this.systemPrompt = config.systemPrompt
      ?? `You are ${config.name}, a helpful and friendly AI assistant. Be concise and accurate.`;

    // Resolve LLM config from model name
    this.llmConfig = resolveConfig(config.model, {
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      ...config.llm,
    });
    this.llm = createAdapter(this.llmConfig);

    // Memory
    const memCfg = config.memory ?? true;
    const window = memCfg === false ? 0 : (typeof memCfg === 'object' ? (memCfg.window ?? 20) : 20);
    this.memory = new ConversationMemory({ type: 'conversation', maxMessages: window });
    this.persistMemory = memCfg !== false && (typeof memCfg === 'object' ? (memCfg.persist ?? true) : true);

    this.context = new ContextBuilder(this.llm);

    const auxAdapter = config.auxiliaryModel
      ? createAdapter(resolveConfig(config.auxiliaryModel))
      : undefined;
    this.compressor = new ContextCompressor(this.llm, auxAdapter, { contextWindow: config.contextWindow });

    this.tools = new ToolRegistry();
    this.executor = new ToolExecutor(this.tools);

    // Full-text search across all persisted sessions - only meaningful once messages are actually persisted.
    if (this.persistMemory) {
      this.addTool(createSessionSearchTool(this.db));
    }

    // Register initial tools
    config.tools?.forEach((t) => this.addTool(t));

    // Skill system - opt-in via skillsDir
    if (config.skillsDir) {
      this.skillRegistry = new SkillRegistry({ skillsDir: config.skillsDir });
      createSkillTools(this.skillRegistry, {
        guardAgentCreated: !!config.skillsGuard,
        onDangerousContent: config.skillsGuard?.onDangerousContent,
      }).forEach((t) => this.addTool(t));

      if (config.skillsHub) {
        this.addTool(createSkillHubTool(this.skillRegistry, {
          onApprovalNeeded: config.skillsHub.onApprovalNeeded,
        }));
      }
    }

    // Learning memory (MEMORY.md/USER.md) - opt-in via learningMemory
    if (config.learningMemory) {
      const dir = typeof config.learningMemory === 'object' ? config.learningMemory.dir : undefined;
      this.learningMemory = new LearningMemory({ dir });
      this.addTool(createMemoryTool(this.learningMemory));
    }

    // Background review - opt-in, needs something to review into
    if (config.backgroundReview && (this.skillRegistry || this.learningMemory)) {
      this.backgroundReview = new BackgroundReview({
        adapter: auxAdapter ?? this.llm,
        memory: this.learningMemory,
        skillRegistry: this.skillRegistry,
        skillsGuard: config.skillsGuard
          ? { guardAgentCreated: true, onDangerousContent: config.skillsGuard.onDangerousContent }
          : undefined,
      });
    }

    // Store knowledge paths for lazy initialization
    if (config.knowledge) {
      this.knowledgePaths = Array.isArray(config.knowledge)
        ? config.knowledge
        : [config.knowledge];
    }

    this.embeddingsConfig = config.embeddings ?? { provider: 'openai' };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Tools currently registered on this agent. Used for introspection -
   * delegation (to build a child's toolset) and dashboards.
   */
  getTools(): Tool[] {
    return this.tools.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      run: t.run,
      category: t.category,
      timeout: t.timeout,
    }));
  }

  /** The skill registry, if `skillsDir` was configured. Used by dashboards/tooling - null if skills are disabled. */
  getSkillRegistry(): SkillRegistry | null {
    return this.skillRegistry;
  }

  /** The learning-memory store, if `learningMemory` was configured. Used by dashboards/tooling - null if disabled. */
  getLearningMemory(): LearningMemory | null {
    return this.learningMemory;
  }

  /** Names of currently-connected channels. */
  getChannelNames(): ChannelName[] {
    return [...this.channels.keys()];
  }

  /** The connected channel instance by name (e.g. to push a cron job's result to it directly) - undefined if that channel isn't connected. */
  getChannel(name: ChannelName): SvaraChannel | undefined {
    return this.channels.get(name);
  }

  /**
   * Create a new, independent SvaraAgent that inherits this agent's LLM
   * provider/model by default - a fresh conversation, no shared state.
   * Used by `delegate_task` (see src/delegation/) to spawn sub-agents; also
   * useful directly for manual multi-agent orchestration.
   *
   * @example
   * const child = agent.spawnChild({ tools: agent.getTools().filter(t => t.name !== 'delegate_task') });
   * const result = await child.process('Summarize this document...');
   */
  spawnChild(overrides: Partial<AgentConfig> = {}): SvaraAgent {
    this.childCounter++;
    return new SvaraAgent({
      name: `${this.name}-sub-${this.childCounter}`,
      model: this.llmConfig.model,
      llm: this.llmConfig,
      maxIterations: this.maxIterations,
      memory: false,
      ...overrides,
    });
  }

  /**
   * Send a message and get a reply. The simplest way to use an agent.
   *
   * @example
   * const reply = await agent.chat('What is the weather in Tokyo?');
   * console.log(reply); // "Currently 28°C and sunny in Tokyo."
   *
   * @param message  The user's message.
   * @param sessionId  Optional session ID for multi-turn conversations.
   *                   Defaults to 'default' - all calls share one history.
   */
  async chat(message: string, sessionId = 'default'): Promise<string> {
    const result = await this.run(message, { sessionId });
    return result.response;
  }

  /**
   * Process a message and get the full result with metadata.
   * Use this when you need usage stats, tool info, or session details.
   *
   * @example
   * const result = await agent.process('Summarize my report', {
   *   sessionId: 'user-42',
   *   userId: 'alice@example.com',
   * });
   * console.log(result.response);    // The agent's reply
   * console.log(result.toolsUsed);   // ['read_file', 'summarize']
   * console.log(result.usage);       // { totalTokens: 1234, ... }
   */
  async process(message: string, options?: AgentRunOptions): Promise<AgentRunResult> {
    return this.run(message, options ?? {});
  }

  /**
   * Register a tool the agent can call during a conversation.
   * Returns `this` for chaining.
   *
   * @example
   * agent
   *   .addTool(weatherTool)
   *   .addTool(emailTool)
   *   .addTool(databaseTool);
   */
  addTool(tool: Tool): this {
    // Map public Tool to internal format
    const internal: InternalTool = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {},
      run: tool.run,
      category: tool.category,
      timeout: tool.timeout,
    };
    this.tools.register(internal);
    return this;
  }

  /**
   * Remove a previously-added tool by name. No-op if it isn't registered -
   * used by MCP disconnects and other dynamic tool sources that need to
   * clean up after themselves.
   */
  removeTool(name: string): this {
    this.tools.unregister(name);
    return this;
  }

  /**
   * Connect a messaging channel. The agent will receive and respond to
   * messages from this channel automatically.
   *
   * @example
   * agent.connectChannel('telegram', { token: process.env.TG_TOKEN });
   * agent.connectChannel('whatsapp', {
   *   token: process.env.WA_TOKEN,
   *   phoneId: process.env.WA_PHONE_ID,
   *   verifyToken: process.env.WA_VERIFY_TOKEN,
   * });
   */
  connectChannel(name: ChannelName, config: Record<string, unknown>): this {
    const channel = this.loadChannel(name, config);
    this.channels.set(name, channel);
    return this;
  }

  /**
   * Registers an already-running Express app as this agent's 'web' channel,
   * so webhook-based channels (WhatsApp, Slack) that expect to mount their
   * routes onto `channels.get('web').app` find one - without spinning up a
   * second HTTP server the way `connectChannel('web', { port })` would.
   * Used by the standalone runtime, which owns its own SvaraApp/Express
   * instance and server lifecycle. Call before connecting webhook channels.
   */
  attachWebApp(app: Express): void {
    this.channels.set('web', {
      name: 'web',
      mount: async () => {},
      send: async () => {},
      stop: async () => {},
      app,
    } as unknown as SvaraChannel);
  }

  /**
   * Returns an Express request handler for mounting on any HTTP server.
   * POST body: `{ message: string, sessionId?: string, userId?: string }`
   *
   * @example With SvaraApp
   * app.route('/chat', agent.handler());
   *
   * @example With existing Express app
   * expressApp.post('/api/chat', agent.handler());
   */
  handler(): RequestHandler {
    return async (req, res) => {
      // Auto-initialize knowledge on first request (lazy loading)
      if (this.knowledgePaths.length > 0 && !this.isKnowledgeInitialized) {
        try {
          await this.initKnowledge(this.knowledgePaths);
          this.isKnowledgeInitialized = true;
        } catch (err) {
          const error = err as Error;
          this.log('error', `Failed to initialize knowledge: ${error.message}`);
        }
      }

      const { message, sessionId, userId } = req.body as {
        message?: string;
        sessionId?: string;
        userId?: string;
      };

      if (!message?.trim()) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Request body must include a non-empty "message" field.',
        });
        return;
      }

      try {
        const result = await this.run(message, {
          sessionId: sessionId ?? req.headers['x-session-id'] as string,
          userId,
        });

        res.json({
          response: result.response,
          sessionId: result.sessionId,
          usage: result.usage,
          toolsUsed: result.toolsUsed,
          retrievedDocuments: result.retrievedDocuments || [],
        });
      } catch (err) {
        const error = err as Error;
        this.log('error', error.message);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
      }
    };
  }

  /**
   * Initialize all channels and knowledge base, then start listening.
   * Call this once after you've configured the agent.
   *
   * @example
   * agent.connectChannel('web', { port: 3000 });
   * await agent.start(); // "Web channel running at http://localhost:3000"
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      console.warn(`[@yesvara/svara] ${this.name} is already running.`);
      return;
    }

    // Init knowledge base
    if (this.knowledgePaths.length) {
      await this.initKnowledge(this.knowledgePaths);
    }

    // Mount all channels
    for (const [name, channel] of this.channels) {
      await channel.mount(this);
      this.log('info', `Channel "${name}" connected.`);
      this.emit('channel:ready', { channel: name });
    }

    this.isStarted = true;

    if (this.channels.size === 0) {
      console.warn(
        `[@yesvara/svara] ${this.name} has no channels configured.\n` +
        `  Add one: agent.connectChannel('web', { port: 3000 })`
      );
    }
  }

  /**
   * Gracefully shut down all channels.
   */
  async stop(): Promise<void> {
    for (const [, channel] of this.channels) {
      await channel.stop();
    }
    this.isStarted = false;
    this.emit('stopped');
  }

  /** Model name currently in use (auto-detected provider). */
  get model(): string {
    return this.llmConfig.model;
  }

  /**
   * Clear conversation history for a session.
   *
   * @example
   * agent.on('user:leave', (userId) => agent.clearHistory(userId));
   */
  async clearHistory(sessionId: string): Promise<void> {
    await this.memory.clear(sessionId);
    if (this.persistMemory) {
      this.db.clearSession(sessionId);
    }
  }

  /** Recently active sessions (most recent first), each with a preview of its last message. Empty if persistent memory is off. */
  listSessions(limit = 20): Array<{ sessionId: string; lastMessageAt: number; messageCount: number; preview: string }> {
    return this.persistMemory ? this.db.listRecentSessions(limit) : [];
  }

  /** Full message history for one session, oldest first. Empty if persistent memory is off. */
  getSessionMessages(sessionId: string, limit = 500): Array<{ id: string; role: string; content: string; metadata?: Record<string, unknown>; created_at: number }> {
    return this.persistMemory ? this.db.getMessages(sessionId, limit) : [];
  }

  /**
   * Add documents to the knowledge base at runtime (no restart needed).
   *
   * @example
   * agent.addKnowledge('./new-policies.pdf');
   */
  async addKnowledge(paths: string | string[]): Promise<void> {
    const arr = Array.isArray(paths) ? paths : [paths];
    if (!this.knowledgeBase) {
      await this.initKnowledge(arr);
    } else {
      await this.knowledgeBase.load(arr);
    }
  }

  /** List indexed knowledge documents (one entry per source file, with its chunk count). Empty if RAG isn't initialized. */
  async listKnowledgeDocuments(): Promise<KnowledgeDocument[]> {
    return (await this.retriever?.listDocuments?.()) ?? [];
  }

  /** Remove a knowledge document (and all its chunks) by the id returned from listKnowledgeDocuments(). */
  async removeKnowledgeDocument(documentId: string): Promise<void> {
    await this.retriever?.removeDocument?.(documentId);
  }

  // ─── Internal: User & Session Tracking ───────────────────────────────────────

  private async trackUserAndSession(userId: string, sessionId: string, channel = 'api'): Promise<void> {
    try {
      // Track user
      const existingUser = this.db.query(
        'SELECT id FROM svara_users WHERE id = ?',
        [userId]
      ) as Array<{ id: string }>;

      if (existingUser.length === 0) {
        // New user
        this.db.run(
          `INSERT INTO svara_users (id, display_name, first_seen, last_seen)
           VALUES (?, ?, unixepoch(), unixepoch())`,
          [userId, userId]
        );
      } else {
        // Update last_seen
        this.db.run(
          'UPDATE svara_users SET last_seen = unixepoch() WHERE id = ?',
          [userId]
        );
      }

      // Track session
      const existingSession = this.db.query(
        'SELECT id FROM svara_sessions WHERE id = ?',
        [sessionId]
      ) as Array<{ id: string }>;

      if (existingSession.length === 0) {
        // New session
        this.db.run(
          `INSERT INTO svara_sessions (id, user_id, channel, created_at, updated_at)
           VALUES (?, ?, ?, unixepoch(), unixepoch())`,
          [sessionId, userId, channel]
        );
      } else {
        // Update updated_at
        this.db.run(
          'UPDATE svara_sessions SET updated_at = unixepoch() WHERE id = ?',
          [sessionId]
        );
      }

      this.log('debug', `Tracked user ${userId} with session ${sessionId}`);
    } catch (error) {
      this.log('error', `Failed to track user: ${(error as Error).message}`);
    }
  }

  // ─── Internal: Agentic Loop ───────────────────────────────────────────────

  /**
   * Receives a raw incoming message from a channel and processes it.
   * Called by channel handlers - not typically used directly.
   */
  async receive(msg: IncomingMessage): Promise<AgentRunResult> {
    return this.run(msg.text, {
      sessionId: msg.sessionId,
      userId: msg.userId,
    });
  }

  private async run(message: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const startTime = Date.now();
    const sessionId = options.sessionId ?? crypto.randomUUID();
    const userId = options.userId ?? 'unknown';

    // Track user and session
    await this.trackUserAndSession(userId, sessionId);

    this.emit('message:received', { message, sessionId, userId });

    // Hydrate in-process cache from SQLite on first touch of this session in this process
    // (survives restarts - the in-memory Map alone would not).
    if (this.persistMemory && !this.memory.hasSession(sessionId)) {
      const stored = this.db.getMessages(sessionId, 200);
      if (stored.length > 0) {
        await this.memory.hydrate(sessionId, stored.map((m) => ({
          role: m.role as LLMMessage['role'],
          content: m.content,
          toolCallId: m.tool_call_id ?? undefined,
        })));
      }
    }

    // Build LLM message history
    const history = await this.memory.getHistory(sessionId);

    // RAG retrieval
    let ragContext = '';
    let retrievedDocuments: Array<{ source: string; score: number; excerpt: string }> = [];
    if (this.knowledgeBase && this.retriever) {
      ragContext = await this.knowledgeBase.retrieve(message);
      // Also retrieve chunks to get document metadata and scores
      try {
        const context = await this.retriever.retrieveChunks(message, 3);
        retrievedDocuments = context.chunks.map((item: any) => ({
          source: item.chunk?.source || 'unknown',
          score: Math.round(item.score * 100) / 100,
          excerpt: item.chunk?.content?.substring(0, 150) || '',
        }));
      } catch (e) {
        this.log('error', `RAG retrieval failed: ${(e as Error).message}`);
      }
    }

    let systemPrompt = this.systemPrompt;
    systemPrompt += `\n\nCurrent date/time: ${new Date().toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    })}`;
    if (this.learningMemory) {
      const { agent: agentNotes, user: userNotes } = await this.learningMemory.load();
      if (agentNotes) systemPrompt += `\n\n--- Your notes (MEMORY.md) ---\n${agentNotes}`;
      if (userNotes) systemPrompt += `\n\n--- What you know about this user (USER.md) ---\n${userNotes}`;
    }
    if (this.skillRegistry) {
      const skills = await this.skillRegistry.list();
      if (skills.length > 0) {
        systemPrompt += '\n\nAvailable skills (call skill_view with an id for full instructions):\n'
          + skills.map((s) => `- ${s.id}: ${s.description}`).join('\n');
      }
    }

    let messages = this.context.buildMessages(
      systemPrompt,
      history,
      message,
      ragContext
    );
    messages = await this.compressor.maybeCompress(messages);

    const internalCtx: InternalAgentContext = {
      sessionId,
      userId,
      agentName: this.name,
      history,
      metadata: options.metadata ?? {},
    };

    // ── Agentic Loop ──────────────────────────────────────────────────────
    const toolsUsed: string[] = [];
    const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let iterations = 0;
    let finalResponse = '';

    while (iterations < this.maxIterations) {
      iterations++;
      this.log('debug', `Iteration ${iterations}`);

      const allTools = this.tools.getAll();
      const llmResponse = await this.llm.chat(messages, allTools, this.llmConfig.temperature);

      totalUsage.promptTokens += llmResponse.usage.promptTokens;
      totalUsage.completionTokens += llmResponse.usage.completionTokens;
      totalUsage.totalTokens += llmResponse.usage.totalTokens;

      // No tool calls - agent has a final answer
      if (!llmResponse.toolCalls?.length) {
        finalResponse = llmResponse.content;
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

      // Append assistant message (with tool calls) to context
      messages.push({
        role: 'assistant',
        content: llmResponse.content,
        toolCalls: llmResponse.toolCalls,
      });

      this.emit('tool:call', {
        sessionId,
        tools: llmResponse.toolCalls.map((tc) => tc.name),
      });

      // Execute all tool calls concurrently
      const results = await this.executor.executeAll(llmResponse.toolCalls, internalCtx);

      for (const result of results) {
        toolsUsed.push(result.name);
        const content = result.error
          ? `Error executing ${result.name}: ${result.error}`
          : JSON.stringify(result.result, null, 2);

        messages.push({
          role: 'tool',
          content,
          toolCallId: result.toolCallId,
          name: result.name,
        });

        this.emit('tool:result', { sessionId, name: result.name, result: result.result });
      }
    }

    if (!finalResponse) {
      finalResponse = `I've reached the reasoning limit for this request. Please try a simpler question.`;
    }

    // Any files the send_file tool queued this turn - resolved to their
    // registry record now, once, so both the returned result and the
    // persisted metadata use the exact same list.
    const attachments: Attachment[] = [];
    for (const token of drainPendingTokens(sessionId)) {
      const file = getRegisteredFile(token);
      if (!file) continue;
      const attachment: Attachment = { token, filename: file.filename, size: file.size, url: `/api/files/${token}` };
      if (file.mimeType) attachment.mimeType = file.mimeType;
      attachments.push(attachment);
    }

    // Persist to memory (in-process cache, always) and SQLite (survives restarts)
    await this.memory.append(sessionId, [
      { role: 'user', content: message },
      { role: 'assistant', content: finalResponse },
    ]);
    if (this.persistMemory) {
      const dedupedToolsUsed = [...new Set(toolsUsed)];
      const assistantMetadata: Record<string, unknown> = {};
      if (dedupedToolsUsed.length > 0) {
        assistantMetadata.toolsUsed = dedupedToolsUsed;
        assistantMetadata.iterations = iterations;
      }
      if (retrievedDocuments.length > 0) assistantMetadata.retrievedDocuments = retrievedDocuments;
      if (attachments.length > 0) assistantMetadata.attachments = attachments;

      this.db.saveMessage({ id: crypto.randomUUID(), sessionId, role: 'user', content: message });
      this.db.saveMessage({
        id: crypto.randomUUID(),
        sessionId,
        role: 'assistant',
        content: finalResponse,
        metadata: Object.keys(assistantMetadata).length > 0 ? assistantMetadata : undefined,
      });
    }

    const result: AgentRunResult = {
      response: finalResponse,
      sessionId,
      toolsUsed: [...new Set(toolsUsed)],
      iterations,
      usage: totalUsage,
      duration: Date.now() - startTime,
      attachments: attachments.length > 0 ? attachments : undefined,
      retrievedDocuments: retrievedDocuments.length > 0 ? retrievedDocuments : undefined,
    };

    this.emit('message:sent', { response: finalResponse, sessionId });

    // Fire-and-forget - runs after the response is already on its way back, never blocks a turn.
    this.backgroundReview?.reviewAsync({ sessionId, userMessage: message, assistantResponse: finalResponse });

    return result;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async initKnowledge(paths: string[]): Promise<void> {
    try {
      const { glob } = await import('glob');
      const { VectorRetriever } = await import('../rag/retriever.js');

      // Create retriever with agent name for isolated RAG per agent
      this.retriever = new VectorRetriever(this.name, this.db);
      await this.retriever.init({ embeddings: this.embeddingsConfig });

      const files: string[] = [];
      for (const pattern of paths) {
        const matches = await glob(pattern);
        files.push(...matches);
      }

      if (files.length === 0) {
        console.warn(`[@yesvara/svara] No files found matching: ${paths.join(', ')}`);
        return;
      }

      await this.retriever.addDocuments(files);
      this.knowledgeBase = {
        load: async (p) => {
          const newFiles: string[] = [];
          for (const pattern of (Array.isArray(p) ? p : [p])) {
            newFiles.push(...await glob(pattern));
          }
          await this.retriever.addDocuments(newFiles);
        },
        retrieve: (query, topK) => this.retriever.retrieve(query, topK),
      };

      this.log('info', `Knowledge base loaded: ${files.length} file(s).`);
    } catch (err) {
      console.warn(`[@yesvara/svara] Knowledge base init failed: ${(err as Error).message}`);
    }
  }

  private loadChannel(name: ChannelName, config: Record<string, unknown>): SvaraChannel {
    try {
      switch (name) {
        case 'web': {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { WebChannel } = require('../channels/web.js') as { WebChannel: new (c: unknown) => SvaraChannel };
          return new WebChannel(config);
        }
        case 'telegram': {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { TelegramChannel } = require('../channels/telegram.js') as { TelegramChannel: new (c: unknown) => SvaraChannel };
          return new TelegramChannel(config);
        }
        case 'whatsapp': {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { WhatsAppChannel } = require('../channels/whatsapp.js') as { WhatsAppChannel: new (c: unknown) => SvaraChannel };
          return new WhatsAppChannel(config);
        }
        case 'slack': {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { SlackChannel } = require('../channels/slack.js') as { SlackChannel: new (c: unknown) => SvaraChannel };
          return new SlackChannel(config);
        }
        case 'discord': {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { DiscordChannel } = require('../channels/discord.js') as { DiscordChannel: new (c: unknown) => SvaraChannel };
          return new DiscordChannel(config);
        }
        default:
          throw new Error(`Unknown channel: "${name as string}"`);
      }
    } catch (err) {
      const error = err as Error;
      if (error.message.startsWith('[@yesvara') || error.message.startsWith('Unknown')) throw error;
      throw new Error(`[@yesvara/svara] Failed to load channel "${name}": ${error.message}`);
    }
  }

  private log(level: 'info' | 'debug' | 'error', msg: string): void {
    if (level === 'error') {
      console.error(`[@yesvara/svara] ${this.name}: ${msg}`);
    } else if (this.verbose) {
      console.log(`[@yesvara/svara] ${this.name}: ${msg}`);
    }
  }
}

// Export RAGRetriever interface
export type { RAGRetriever };
