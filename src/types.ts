/**
 * @module types
 * Public types for @yesvara/svara
 *
 * These are the types users import and work with directly.
 * Internal implementation types stay in core/types.ts.
 */

import type { InternalAgentContext } from './core/types.js';

// ─── Tool ─────────────────────────────────────────────────────────────────────

/**
 * A function the agent can call during a conversation.
 *
 * @example
 * const weatherTool: Tool = {
 *   name: 'get_weather',
 *   description: 'Get the current weather for a city',
 *   parameters: {
 *     city: { type: 'string', description: 'The city name', required: true },
 *   },
 *   async run({ city }) {
 *     const data = await fetchWeather(city as string);
 *     return { temp: data.temp, condition: data.condition };
 *   },
 * };
 */
export interface Tool {
  /** Unique identifier used by the LLM to call this tool. snake_case recommended. */
  name: string;

  /** What this tool does. The LLM uses this to decide when to call it. Be specific. */
  description: string;

  /**
   * Input parameters the tool accepts.
   * The LLM will fill these in based on the conversation.
   */
  parameters?: Record<string, ToolParameter>;

  /**
   * The function that runs when the LLM calls this tool.
   * Return anything — it gets serialized and sent back to the LLM.
   */
  run(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown>;

  /** Group related tools together. Optional — used for organization. */
  category?: string;

  /** Timeout in milliseconds before the tool is cancelled. @default 30000 */
  timeout?: number;
}

/**
 * A single parameter definition for a tool.
 *
 * @example
 * { type: 'string', description: 'City name', required: true }
 * { type: 'number', description: 'Temperature in Celsius', required: false }
 * { type: 'string', description: 'Status', enum: ['active', 'inactive'] }
 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

// ─── Agent Context ────────────────────────────────────────────────────────────

/**
 * Context passed to tool `run()` functions.
 * Gives tools access to session info and conversation history.
 */
export type AgentContext = InternalAgentContext;

// ─── Agent Run ────────────────────────────────────────────────────────────────

/**
 * The full result of a `agent.process()` call.
 */
export interface ProcessResult {
  /** The agent's response text. */
  response: string;

  /** The session ID used for this conversation. */
  sessionId: string;

  /** Names of tools called during this response. */
  toolsUsed: string[];

  /** Number of LLM iterations (tool call rounds) used. */
  iterations: number;

  /** Token usage for this request. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** Total time in milliseconds. */
  duration: number;
}

// ─── Memory Options ───────────────────────────────────────────────────────────

/**
 * Memory configuration for a SvaraAgent.
 */
export interface MemoryOptions {
  /** Number of previous messages to include in context. @default 20 */
  window?: number;
}

// ─── App Options ──────────────────────────────────────────────────────────────

export type { AppOptions } from './app/index.js';

// ─── Channel Types ────────────────────────────────────────────────────────────

/**
 * Supported channel names for `agent.connectChannel()`.
 */
export type { ChannelName } from './core/types.js';

// ─── Re-exports for convenience ───────────────────────────────────────────────

export type { AgentConfig } from './core/agent.js';
