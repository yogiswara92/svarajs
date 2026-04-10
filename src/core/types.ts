/**
 * @internal
 * Internal types for the SvaraJS framework engine.
 * These are NOT exported to users — see src/types.ts for the public API.
 */

// ─── LLM Internals ───────────────────────────────────────────────────────────

export type LLMProviderName = 'openai' | 'anthropic' | 'ollama' | 'groq';

export interface LLMConfig {
  provider: LLMProviderName;
  model: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
  name?: string;
}

export interface LLMResponse {
  content: string;
  toolCalls?: LLMToolCall[];
  usage: TokenUsage;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Tool Internals ───────────────────────────────────────────────────────────

export interface InternalTool {
  name: string;
  description: string;
  parameters: Record<string, InternalToolParam>;
  run: (args: Record<string, unknown>, ctx: InternalAgentContext) => Promise<unknown>;
  category?: string;
  timeout?: number;
}

export interface InternalToolParam {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

export interface ToolExecution {
  toolCallId: string;
  name: string;
  result: unknown;
  error?: string;
  duration: number;
}

// ─── Agent Internals ──────────────────────────────────────────────────────────

export interface InternalAgentContext {
  sessionId: string;
  userId: string;
  agentName: string;
  history: LLMMessage[];
  metadata: Record<string, unknown>;
}

export interface AgentRunOptions {
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  response: string;
  sessionId: string;
  toolsUsed: string[];
  iterations: number;
  usage: TokenUsage;
  duration: number;
}

// ─── Memory Internals ────────────────────────────────────────────────────────

export interface SessionStore {
  messages: LLMMessage[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Channel Internals ───────────────────────────────────────────────────────

export type ChannelName = 'web' | 'whatsapp' | 'telegram' | 'discord' | 'slack';

export interface IncomingMessage {
  id: string;
  sessionId: string;
  userId: string;
  channel: ChannelName;
  text: string;
  timestamp: Date;
  raw?: unknown;
}
