/**
 * @module mcp/manager
 * SvaraJS - MCP (Model Context Protocol) client manager.
 *
 * Connects to MCP servers (local, spawned over stdio, or remote over
 * streamable-http/SSE) using the official `@modelcontextprotocol/sdk`, and
 * registers each of their tools onto a SvaraAgent - namespaced
 * `mcp__<serverId>__<toolName>` so two servers can't collide on a tool name.
 * Needs a reference to the already-constructed agent, same pattern as
 * delegation/cron: `new McpManager(agent)`, then `manager.connect(config)`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { SvaraAgent } from '../core/agent.js';
import type { Tool, ToolParameter } from '../types.js';
import type { McpServerConfig, McpServerStatus, McpTransportConfig } from './types.js';

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, JsonSchemaProp>; required?: string[] };
}

interface JsonSchemaProp {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

function buildTransport(config: McpTransportConfig): Transport {
  switch (config.type) {
    case 'stdio':
      return new StdioClientTransport({ command: config.command, args: config.args, env: config.env });
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    case 'sse':
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    default: {
      const exhaustive: never = config;
      throw new Error(`[SvaraJS] Unknown MCP transport type: "${(exhaustive as McpTransportConfig).type}"`);
    }
  }
}

/**
 * Best-effort mapping from JSON Schema (MCP's inputSchema) to SvaraJS's flat
 * ToolParameter shape - the whole framework uses this same flat format
 * everywhere, so nested schemas can't be represented losslessly.
 *
 * `pinnedDefaults` are NOT dropped from what the LLM sees (a pinned param
 * used to be hidden entirely, forcing every call onto that one fixed value -
 * e.g. a Svaramind workspace_id - which also blocked ever asking about a
 * *different* workspace). Instead they're left visible, marked optional, and
 * their description notes the default - the LLM can still just omit it and
 * get the pinned value (registerTools() injects it when missing), but can
 * also pass a different one explicitly when that's actually what's needed.
 */
function jsonSchemaToParameters(schema: McpToolSchema['inputSchema'] | undefined, pinnedDefaults: Record<string, unknown>): Record<string, ToolParameter> {
  if (!schema?.properties) return {};
  const required = new Set(schema.required ?? []);
  const params: Record<string, ToolParameter> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const type = prop.type === 'integer' ? 'number' : prop.type;
    const isPinned = key in pinnedDefaults;
    params[key] = {
      type: (['string', 'number', 'boolean', 'object', 'array'] as const).includes(type as never) ? (type as ToolParameter['type']) : 'string',
      description: isPinned
        ? `${prop.description ?? key} (defaults to "${pinnedDefaults[key]}" if omitted - pass a different value to use another one instead)`
        : prop.description ?? key,
      required: isPinned ? false : required.has(key),
      enum: prop.enum,
      default: isPinned ? pinnedDefaults[key] : prop.default,
    };
  }
  return params;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function toToolName(serverId: string, mcpToolName: string): string {
  // Hyphens are kept (valid in OpenAI/Anthropic function names, and common in
  // registry server ids like "my-mcp-server") - only characters outside
  // that allowed set get replaced.
  return `mcp__${serverId}__${mcpToolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

interface Connection {
  config: McpServerConfig;
  client: Client;
  mcpTools: McpToolSchema[];
  toolNames: string[];
  pinnedParams: Record<string, unknown>;
  connectedAt: string;
}

export class McpManager {
  private connections = new Map<string, Connection>();

  constructor(private agent: SvaraAgent) {}

  async connect(config: McpServerConfig): Promise<McpServerStatus> {
    if (this.connections.has(config.id)) {
      throw new Error(`[SvaraJS] MCP server "${config.id}" is already connected.`);
    }

    const client = new Client({ name: 'svarajs', version: '1.0.0' }, { capabilities: {} });
    const transport = buildTransport(config.transport);

    try {
      await client.connect(transport);
    } catch (err) {
      throw new Error(`[SvaraJS] Could not connect to MCP server "${config.name}": ${(err as Error).message}`);
    }

    const { tools: mcpTools } = await client.listTools();
    const connection: Connection = {
      config, client,
      mcpTools: mcpTools as McpToolSchema[],
      toolNames: [],
      pinnedParams: config.pinnedParams ?? {},
      connectedAt: new Date().toISOString(),
    };
    this.connections.set(config.id, connection);
    this.registerTools(connection);

    return this.toStatus(connection);
  }

  /** (Re-)registers every tool for a connection, honoring its current pinnedParams (as visible-but-optional defaults, not hidden overrides) - used on connect() and whenever pinParameter() changes them. */
  private registerTools(conn: Connection): void {
    for (const name of conn.toolNames) this.agent.removeTool(name);
    conn.toolNames = [];

    const { client, config, pinnedParams } = conn;

    for (const mcpTool of conn.mcpTools) {
      const toolName = toToolName(config.id, mcpTool.name);
      const tool: Tool = {
        name: toolName,
        description: `[MCP:${config.name}] ${mcpTool.description ?? mcpTool.name}`,
        parameters: jsonSchemaToParameters(mcpTool.inputSchema, pinnedParams),
        async run(args) {
          // pinnedParams first, args after - a value the LLM actually passed
          // always wins; the pin only fills in when it's left out.
          const result = await client.callTool({ name: mcpTool.name, arguments: { ...pinnedParams, ...args } });
          if (result.isError) {
            throw new Error(extractText(result.content) || `MCP tool "${mcpTool.name}" reported an error.`);
          }
          return extractText(result.content) || result.content;
        },
      };
      this.agent.addTool(tool);
      conn.toolNames.push(toolName);
    }
  }

  /**
   * Sets a default value for a parameter across every one of this server's
   * tools - the LLM still sees it and can pass a different value on any
   * given call, but gets this one for free when it doesn't bother. Used for
   * things like a Svaramind workspace_id: pick a sensible default once in
   * the dashboard, without permanently locking every call to it.
   */
  pinParameter(id: string, paramName: string, value: unknown): McpServerStatus {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`[SvaraJS] MCP server "${id}" is not connected.`);
    conn.pinnedParams = { ...conn.pinnedParams, [paramName]: value };
    conn.config = { ...conn.config, pinnedParams: conn.pinnedParams };
    this.registerTools(conn);
    return this.toStatus(conn);
  }

  /** Calls a tool directly by its original MCP name, bypassing the agent's tool-calling loop entirely - for the dashboard's own setup flows (e.g. listing Svaramind workspaces before the agent ever gets involved). */
  async callToolDirect(id: string, mcpToolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`[SvaraJS] MCP server "${id}" is not connected.`);
    const result = await conn.client.callTool({ name: mcpToolName, arguments: args });
    if (result.isError) {
      throw new Error(extractText(result.content) || `MCP tool "${mcpToolName}" reported an error.`);
    }
    return extractText(result.content) || result.content;
  }

  async disconnect(id: string): Promise<boolean> {
    const conn = this.connections.get(id);
    if (!conn) return false;
    for (const name of conn.toolNames) this.agent.removeTool(name);
    await conn.client.close().catch(() => {});
    this.connections.delete(id);
    return true;
  }

  async disconnectAll(): Promise<void> {
    for (const id of [...this.connections.keys()]) await this.disconnect(id);
  }

  list(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => this.toStatus(c));
  }

  isConnected(id: string): boolean {
    return this.connections.has(id);
  }

  private toStatus(conn: Connection): McpServerStatus {
    return {
      id: conn.config.id,
      name: conn.config.name,
      transport: conn.config.transport,
      tools: conn.toolNames,
      connectedAt: conn.connectedAt,
      pinnedParams: Object.keys(conn.pinnedParams).length ? conn.pinnedParams : undefined,
    };
  }
}
