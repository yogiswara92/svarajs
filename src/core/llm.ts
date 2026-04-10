/**
 * @internal
 * LLM abstraction layer with automatic provider detection.
 *
 * Users never touch this directly — they just pass a model name:
 *   'gpt-4o'               → OpenAI (auto)
 *   'claude-opus-4-6'     → Anthropic (auto)
 *   'llama3'               → Ollama (auto, local)
 *   'llama-3.1-70b-...'  → Groq (auto, if GROQ_API_KEY set)
 */

import type {
  LLMConfig,
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  InternalTool,
  LLMProviderName,
} from './types.js';

// ─── Model → Provider Auto-Detection ─────────────────────────────────────────

const OPENAI_PREFIXES = ['gpt-', 'o1', 'o3', 'text-davinci', 'chatgpt'];
const ANTHROPIC_PREFIXES = ['claude-'];
const GROQ_MODELS = [
  'llama-3.1-405b', 'llama-3.1-70b', 'llama-3.1-8b',
  'mixtral-8x7b', 'gemma-7b', 'gemma2-9b',
];

/**
 * Auto-detect the LLM provider from a model name string.
 * Priority: OpenAI → Anthropic → Groq (if key present) → Ollama
 */
export function detectProvider(model: string): LLMProviderName {
  const m = model.toLowerCase();

  if (OPENAI_PREFIXES.some((p) => m.startsWith(p))) return 'openai';
  if (ANTHROPIC_PREFIXES.some((p) => m.startsWith(p))) return 'anthropic';

  // Groq uses Llama/Mixtral model names — differentiate by env key
  if (GROQ_MODELS.some((gm) => m.includes(gm)) && process.env.GROQ_API_KEY) {
    return 'groq';
  }

  // Anything else → Ollama (local self-hosted)
  return 'ollama';
}

/**
 * Build an LLMConfig from just a model name string.
 * This is what enables the magic: `model: 'gpt-4o'` just works.
 */
export function resolveConfig(model: string, overrides: Partial<LLMConfig> = {}): LLMConfig {
  const provider = overrides.provider ?? detectProvider(model);
  return {
    provider,
    model,
    temperature: 0.7,
    timeout: 60_000,
    ...overrides,
  };
}

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface LLMAdapter {
  chat(messages: LLMMessage[], tools?: InternalTool[], temperature?: number): Promise<LLMResponse>;
  countTokens(text: string): number;
}

// ─── OpenAI Adapter ──────────────────────────────────────────────────────────

class OpenAIAdapter implements LLMAdapter {
  private client: unknown;

  constructor(private config: LLMConfig) {
    this.client = this.init();
  }

  private init(): unknown {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: OpenAI } = require('openai');
      return new OpenAI({
        apiKey: this.config.apiKey ?? process.env.OPENAI_API_KEY,
        baseURL: this.config.baseURL,
        timeout: this.config.timeout,
      });
    } catch {
      throw new SvaraLLMError(
        'openai',
        'Package not found. Run: npm install openai'
      );
    }
  }

  async chat(messages: LLMMessage[], tools?: InternalTool[], temperature?: number): Promise<LLMResponse> {
    const client = this.client as {
      chat: { completions: { create: (p: unknown) => Promise<unknown> } };
    };

    const response = await client.chat.completions.create({
      model: this.config.model,
      messages: messages.map(toOpenAIMessage),
      tools: tools?.length ? tools.map(toOpenAITool) : undefined,
      tool_choice: tools?.length ? 'auto' : undefined,
      temperature: temperature ?? this.config.temperature ?? 0.7,
      max_tokens: this.config.maxTokens,
    }) as OpenAIResponse;

    const choice = response.choices[0];
    const toolCalls = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseJSON(tc.function.arguments),
    }));

    return {
      content: choice.message.content ?? '',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
      model: response.model,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
    };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ─── Anthropic Adapter ───────────────────────────────────────────────────────

class AnthropicAdapter implements LLMAdapter {
  private client: unknown;

  constructor(private config: LLMConfig) {
    this.client = this.init();
  }

  private init(): unknown {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: Anthropic } = require('@anthropic-ai/sdk');
      return new Anthropic({
        apiKey: this.config.apiKey ?? process.env.ANTHROPIC_API_KEY,
        baseURL: this.config.baseURL,
        timeout: this.config.timeout,
      });
    } catch {
      throw new SvaraLLMError(
        'anthropic',
        'Package not found. Run: npm install @anthropic-ai/sdk'
      );
    }
  }

  async chat(messages: LLMMessage[], tools?: InternalTool[], temperature?: number): Promise<LLMResponse> {
    const client = this.client as {
      messages: { create: (p: unknown) => Promise<unknown> };
    };

    const systemMsg = messages.find((m) => m.role === 'system')?.content;
    const chatMsgs = messages.filter((m) => m.role !== 'system').map(toAnthropicMessage);

    const response = await client.messages.create({
      model: this.config.model,
      system: systemMsg,
      messages: chatMsgs,
      tools: tools?.length ? tools.map(toAnthropicTool) : undefined,
      max_tokens: this.config.maxTokens ?? 4096,
      temperature: temperature ?? this.config.temperature ?? 0.7,
    }) as AnthropicResponse;

    const textParts = response.content.filter((c) => c.type === 'text');
    const toolParts = response.content.filter((c) => c.type === 'tool_use');

    const toolCalls: LLMToolCall[] = toolParts.map((c) => ({
      id: (c as { id: string; name: string; input: Record<string, unknown> }).id,
      name: (c as { id: string; name: string; input: Record<string, unknown> }).name,
      arguments: (c as { id: string; name: string; input: Record<string, unknown> }).input,
    }));

    return {
      content: textParts.map((c) => (c as { text: string }).text).join(''),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model: response.model,
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ─── Ollama Adapter (local) ──────────────────────────────────────────────────

class OllamaAdapter implements LLMAdapter {
  private baseURL: string;

  constructor(private config: LLMConfig) {
    this.baseURL = config.baseURL ?? 'http://localhost:11434';
  }

  async chat(messages: LLMMessage[], _tools?: InternalTool[], temperature?: number): Promise<LLMResponse> {
    const response = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        options: { temperature: temperature ?? this.config.temperature ?? 0.7 },
        stream: false,
      }),
      signal: AbortSignal.timeout(this.config.timeout ?? 60_000),
    });

    if (!response.ok) {
      throw new SvaraLLMError('ollama', `Request failed: ${response.statusText}. Is Ollama running?`);
    }

    const data = await response.json() as OllamaResponse;

    return {
      content: data.message.content,
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      model: data.model ?? this.config.model,
      finishReason: 'stop',
    };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ─── Groq Adapter (OpenAI-compatible) ───────────────────────────────────────

class GroqAdapter extends OpenAIAdapter {
  constructor(config: LLMConfig) {
    super({
      ...config,
      baseURL: config.baseURL ?? 'https://api.groq.com/openai/v1',
      apiKey: config.apiKey ?? process.env.GROQ_API_KEY,
    });
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an LLM adapter from a resolved config.
 * @internal — use resolveConfig() to build the config from a model name.
 */
export function createAdapter(config: LLMConfig): LLMAdapter {
  switch (config.provider) {
    case 'openai': return new OpenAIAdapter(config);
    case 'anthropic': return new AnthropicAdapter(config);
    case 'ollama': return new OllamaAdapter(config);
    case 'groq': return new GroqAdapter(config);
    default:
      throw new Error(
        `[@yesvara/svara] Unknown LLM provider: "${config.provider as string}".\n` +
        'Auto-supported: openai, anthropic, ollama, groq'
      );
  }
}

// ─── Format Converters ────────────────────────────────────────────────────────

function toOpenAIMessage(msg: LLMMessage): Record<string, unknown> {
  if (msg.role === 'tool') {
    return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
  }
  if (msg.toolCalls?.length) {
    return {
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: msg.role, content: msg.content };
}

function toOpenAITool(tool: InternalTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([k, p]) => [
            k,
            { type: p.type, description: p.description, enum: p.enum },
          ])
        ),
        required: Object.entries(tool.parameters)
          .filter(([, p]) => p.required)
          .map(([k]) => k),
      },
    },
  };
}

function toAnthropicMessage(msg: LLMMessage): Record<string, unknown> {
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content }],
    };
  }
  if (msg.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
        ...msg.toolCalls.map((tc) => ({
          type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments,
        })),
      ],
    };
  }
  return { role: msg.role, content: msg.content };
}

function toAnthropicTool(tool: InternalTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([k, p]) => [
          k,
          { type: p.type, description: p.description, enum: p.enum },
        ])
      ),
      required: Object.entries(tool.parameters)
        .filter(([, p]) => p.required)
        .map(([k]) => k),
    },
  };
}

// ─── Error Class ──────────────────────────────────────────────────────────────

export class SvaraLLMError extends Error {
  constructor(public provider: string, message: string) {
    super(`[@yesvara/svara] LLM error (${provider}): ${message}`);
    this.name = 'SvaraLLMError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParseJSON(str: string): Record<string, unknown> {
  try { return JSON.parse(str); } catch { return {}; }
}

// ─── Private Response Types ───────────────────────────────────────────────────

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

interface OllamaResponse {
  message: { content: string };
  prompt_eval_count?: number;
  eval_count?: number;
  model?: string;
}
