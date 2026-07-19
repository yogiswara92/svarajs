/**
 * @module runtime/config
 * SvaraJS - standalone runtime config (`svara.config.json`)
 *
 * Everything the standalone runtime (`svara start`) needs to boot a full
 * agent - model, tools, skills, memory, channels, cron - from one file
 * instead of hand-wiring `SvaraAgent`/`SvaraApp` in code. Library mode
 * (`new SvaraAgent()` + `.route()`) is unaffected by any of this.
 */

import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { mapSecretFields } from '../security/secretFields.js';
import { getOrCreateKey, encryptSecret, decryptSecret } from '../security/secretsCrypto.js';

const ToolConfigSchema = z.union([z.boolean(), z.record(z.unknown())]);

const RuntimeConfigSchema = z.object({
  name: z.string().default('Svara Assistant'),
  model: z.string(),
  systemPrompt: z.string().optional(),
  auxiliaryModel: z.string().optional(),
  contextWindow: z.number().optional(),
  /**
   * Cap on tool-calling iterations per request before the agent gives up
   * with "reasoning limit reached" (default 10, set in core/agent.ts). Raise
   * this for tasks that legitimately need many tool calls to converge (e.g.
   * multi-step browsing); a higher cap just means a longer-running request
   * before that safety net kicks in, not a different kind of safety.
   */
  maxIterations: z.number().int().positive().optional(),
  knowledge: z.union([z.string(), z.array(z.string())]).optional(),

  /**
   * Override the LLM provider/endpoint instead of relying on `model`'s
   * auto-detected prefix. Set `provider: 'openai'` + `baseURL` to point at
   * any OpenAI-compatible endpoint - OpenRouter (`https://openrouter.ai/api/v1`),
   * a local server (LM Studio, vLLM), or another OpenAI-compatible host.
   * Two ways to supply the key, in priority order: `apiKey` stores the raw
   * key directly (encrypted at rest, see security/secretsCrypto.ts) - set by
   * the dashboard's AI Provider page. `apiKeyEnv` instead names an
   * environment variable holding the key, for users who'd rather manage it
   * via `.env`; used only when `apiKey` is unset. Falls back to the
   * provider's usual env var (`OPENAI_API_KEY`, etc.) if neither is set.
   */
  llm: z.object({
    provider: z.enum(['openai', 'anthropic', 'ollama', 'groq']).optional(),
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
  }).optional(),

  /**
   * Embedding provider for RAG (Knowledge page uploads, `knowledge` docs).
   * Separate from `llm` above - a chat-completions endpoint doesn't
   * necessarily also serve embeddings, so this needs its own provider/key.
   * Defaults to OpenAI if unset, which needs a real `apiKey` here or
   * `OPENAI_API_KEY` in the environment - `provider: 'ollama'` needs
   * neither (a local Ollama server instead). `baseURL` points `openai` at
   * any other OpenAI-compatible embeddings host, or `ollama` at a
   * non-default (remote) Ollama server.
   */
  embeddings: z.object({
    provider: z.enum(['openai', 'ollama']).default('openai'),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    baseURL: z.string().optional(),
  }).optional(),

  tools: z.object({
    terminal: ToolConfigSchema.optional(),
    filesystem: ToolConfigSchema.optional(),
    web: ToolConfigSchema.optional(),
    browser: ToolConfigSchema.optional(),
  }).default({}),

  skillsDir: z.string().optional(),
  /** Route dangerous agent-created skill content through the dashboard's approval queue. @default true */
  skillsGuardAgentCreated: z.boolean().default(true),
  learningMemory: z.union([z.boolean(), z.object({ dir: z.string().optional() })]).optional(),
  /** Let the agent learn (save memory entries / new skills) after a reply, without being asked. Needs learningMemory and/or skillsDir set. */
  backgroundReview: z.boolean().default(false),

  channels: z.object({
    // Tokens are optional here on purpose - if omitted, the standalone runtime
    // falls back to the same env vars `svara new` scaffolds into .env.example
    // (TELEGRAM_BOT_TOKEN, WA_ACCESS_TOKEN, ...), so secrets don't need to
    // live in svara.config.json.
    telegram: z.object({
      token: z.string().optional(),
      /** Restrict the bot to these Telegram user IDs (get one from @userinfobot). Unset means anyone can use it. */
      allowedUserIds: z.array(z.string()).optional(),
    }).optional(),
    whatsapp: z.object({
      token: z.string().optional(),
      phoneId: z.string().optional(),
      verifyToken: z.string().optional(),
    }).optional(),
    slack: z.object({
      botToken: z.string().optional(),
      signingSecret: z.string().optional(),
    }).optional(),
    discord: z.object({ botToken: z.string().optional() }).optional(),
  }).default({}),

  cron: z.array(z.object({
    id: z.string().optional(),
    schedule: z.string(),
    prompt: z.string(),
    name: z.string().optional(),
    skills: z.array(z.string()).optional(),
    /** Push the result to a connected channel when the run finishes, in addition to the server log. `target` is channel-specific: Telegram chat id, Discord channel id, Slack channel id/name, WhatsApp phone number. */
    deliverTo: z.object({
      channel: z.enum(['telegram', 'whatsapp', 'slack', 'discord']),
      target: z.string(),
    }).optional(),
  })).default([]),

  /**
   * MCP (Model Context Protocol) servers to connect on boot - each server's
   * tools are registered on the agent as `mcp__<id>__<toolName>`. `env`/
   * `headers` values (API keys some servers need) are NOT covered by the
   * at-rest encryption applied to channel secrets - a known gap, avoid
   * putting long-lived credentials directly in this file for now.
   */
  mcpServers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    transport: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('stdio'),
        command: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
      }),
      z.object({
        type: z.enum(['streamable-http', 'sse']),
        url: z.string(),
        headers: z.record(z.string()).optional(),
      }),
    ]),
    /** Parameter values fixed across every tool on this server (e.g. a chosen Svaramind workspace_id) - see mcp/manager.ts's pinParameter(). */
    pinnedParams: z.record(z.unknown()).optional(),
    /** OAuth refresh capability - lets the runtime mint a fresh access token on boot instead of failing once the token baked into transport.headers expires. */
    oauth: z.object({
      clientId: z.string(),
      refreshToken: z.string(),
      tokenUrl: z.string(),
      headerName: z.string(),
      expiresAt: z.number().optional(),
    }).optional(),
  })).default([]),

  port: z.number().default(3000),

  /**
   * Protects the public POST /chat endpoint (what channels, an embedded
   * widget, or any external caller hit) with `Authorization: Bearer <apiKey>`.
   * Unset by default for a frictionless first run - but that also means
   * anyone who can reach the port can use the agent for free and trigger
   * any tool it has (terminal, filesystem, browser, ...). Set this before
   * exposing the port beyond localhost. Separate from `dashboard.token`,
   * which only protects the admin dashboard's own /api/* routes.
   */
  apiKey: z.string().optional(),

  dashboard: z.union([z.boolean(), z.object({ token: z.string().optional() })]).default(true),
});

export type SvaraRuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export async function loadRuntimeConfig(configPath: string): Promise<SvaraRuntimeConfig> {
  const resolved = path.resolve(configPath);

  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf-8');
  } catch {
    throw new Error(
      `[SvaraJS] Could not read config file "${resolved}".\n` +
      'Run "svara new my-assistant --standalone" to scaffold one.'
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[SvaraJS] "${resolved}" is not valid JSON: ${(err as Error).message}`);
  }

  const result = RuntimeConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`[SvaraJS] Invalid "${resolved}":\n${issues}`);
  }

  // Secrets are encrypted at rest (see security/secretsCrypto.ts) - decrypt
  // before handing the config to the runtime, which needs real tokens to
  // actually connect channels. A no-op for legacy plaintext values.
  const key = getOrCreateKey(configPath);
  try {
    return mapSecretFields(result.data, (v) => decryptSecret(v, key)) as SvaraRuntimeConfig;
  } catch (err) {
    throw new Error(
      `[SvaraJS] Could not decrypt secrets in "${resolved}": ${(err as Error).message}\n` +
      'The local key file (.svara/secrets.key, next to the config) is missing or does not match ' +
      'the one these secrets were encrypted with - if you moved this config to a new machine, ' +
      'copy .svara/secrets.key along with it, or re-enter the affected secrets.'
    );
  }
}

/** Read the config file as plain JSON (no defaults filled in) - used by the dashboard to merge partial edits. */
export async function readRawConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(path.resolve(configPath), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Validate then persist a raw (pre-default) config object, e.g. from the dashboard's Settings form. */
export async function saveRuntimeConfig(configPath: string, rawConfig: Record<string, unknown>): Promise<SvaraRuntimeConfig> {
  const result = RuntimeConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`[SvaraJS] Invalid config:\n${issues}`);
  }
  // Encrypt a copy for disk - the returned value stays plaintext for the caller's immediate use.
  const key = getOrCreateKey(configPath);
  const toWrite = mapSecretFields(rawConfig, (v) => encryptSecret(v, key));
  await fs.writeFile(path.resolve(configPath), `${JSON.stringify(toWrite, null, 2)}\n`, 'utf-8');
  return result.data;
}
