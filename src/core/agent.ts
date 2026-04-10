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
 * @example Minimal — works in 5 lines
 * ```ts
 * const agent = new SvaraAgent({ name: 'Aria', model: 'gpt-4o' });
 * const reply = await agent.chat('What is the capital of France?');
 * console.log(reply); // "Paris"
 * ```
 *
 * @example Full — production-ready bot
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
import type { RequestHandler } from 'express';
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
} from './types.js';
import { ConversationMemory } from '../memory/conversation.js';
import { ContextBuilder } from '../memory/context.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import type { Tool } from '../types.js';

// ─── Channel Interface (implemented in channels/) ─────────────────────────────

export interface SvaraChannel {
  readonly name: ChannelName;
  mount(agent: SvaraAgent): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
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
   * @example 'gpt-4o'             — OpenAI (needs OPENAI_API_KEY)
   * @example 'claude-opus-4-6'   — Anthropic (needs ANTHROPIC_API_KEY)
   * @example 'llama3'             — Ollama (local, needs Ollama running)
   * @example 'gpt-4o-mini'        — OpenAI (cheaper, faster)
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
   * Conversation memory configuration.
   * - `true` — enable with defaults (20 message window)
   * - `false` — disable (stateless, every call is fresh)
   * - object — custom configuration
   *
   * @default true
   */
  memory?: boolean | { window?: number };

  /**
   * Tools (function calls) the agent can use.
   * Can also add tools later with `agent.addTool()`.
   */
  tools?: Tool[];

  /**
   * LLM temperature — controls creativity vs. precision.
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
   * Usually not needed — `model` auto-detects the provider.
   */
  llm?: Partial<LLMConfig>;

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
  private readonly maxIterations: number;
  private readonly verbose: boolean;

  private channels: Map<ChannelName, SvaraChannel> = new Map();
  private knowledgeBase: KnowledgeBase | null = null;
  private knowledgePaths: string[] = [];
  private isStarted = false;

  constructor(config: AgentConfig) {
    super();

    this.name = config.name;
    this.maxIterations = config.maxIterations ?? 10;
    this.verbose = config.verbose ?? false;

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

    this.context = new ContextBuilder(this.llm);
    this.tools = new ToolRegistry();
    this.executor = new ToolExecutor(this.tools);

    // Register initial tools
    config.tools?.forEach((t) => this.addTool(t));

    // Store knowledge paths for lazy initialization
    if (config.knowledge) {
      this.knowledgePaths = Array.isArray(config.knowledge)
        ? config.knowledge
        : [config.knowledge];
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Send a message and get a reply. The simplest way to use an agent.
   *
   * @example
   * const reply = await agent.chat('What is the weather in Tokyo?');
   * console.log(reply); // "Currently 28°C and sunny in Tokyo."
   *
   * @param message  The user's message.
   * @param sessionId  Optional session ID for multi-turn conversations.
   *                   Defaults to 'default' — all calls share one history.
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

  /**
   * Clear conversation history for a session.
   *
   * @example
   * agent.on('user:leave', (userId) => agent.clearHistory(userId));
   */
  async clearHistory(sessionId: string): Promise<void> {
    await this.memory.clear(sessionId);
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

  // ─── Internal: Agentic Loop ───────────────────────────────────────────────

  /**
   * Receives a raw incoming message from a channel and processes it.
   * Called by channel handlers — not typically used directly.
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

    this.emit('message:received', { message, sessionId, userId: options.userId });

    // Build LLM message history
    const history = await this.memory.getHistory(sessionId);

    // RAG retrieval
    let ragContext = '';
    if (this.knowledgeBase) {
      ragContext = await this.knowledgeBase.retrieve(message);
    }

    const messages = this.context.buildMessages(
      this.systemPrompt,
      history,
      message,
      ragContext
    );

    const internalCtx: InternalAgentContext = {
      sessionId,
      userId: options.userId ?? 'unknown',
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

      // No tool calls — agent has a final answer
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

    // Persist to memory
    await this.memory.append(sessionId, [
      { role: 'user', content: message },
      { role: 'assistant', content: finalResponse },
    ]);

    const result: AgentRunResult = {
      response: finalResponse,
      sessionId,
      toolsUsed: [...new Set(toolsUsed)],
      iterations,
      usage: totalUsage,
      duration: Date.now() - startTime,
    };

    this.emit('message:sent', { response: finalResponse, sessionId });
    return result;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async initKnowledge(paths: string[]): Promise<void> {
    try {
      const { glob } = await import('glob');
      const { VectorRetriever } = await import('../rag/retriever.js');

      const retriever = new VectorRetriever();
      await retriever.init({ embeddings: { provider: 'openai' } });

      const files: string[] = [];
      for (const pattern of paths) {
        const matches = await glob(pattern);
        files.push(...matches);
      }

      if (files.length === 0) {
        console.warn(`[@yesvara/svara] No files found matching: ${paths.join(', ')}`);
        return;
      }

      await retriever.addDocuments(files);
      this.knowledgeBase = {
        load: async (p) => {
          const newFiles: string[] = [];
          for (const pattern of (Array.isArray(p) ? p : [p])) {
            newFiles.push(...await glob(pattern));
          }
          await retriever.addDocuments(newFiles);
        },
        retrieve: (query, topK) => retriever.retrieve(query, topK),
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
