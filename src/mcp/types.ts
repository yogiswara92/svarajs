/**
 * @module mcp/types
 * SvaraJS - MCP (Model Context Protocol) client types.
 */

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'streamable-http' | 'sse'; url: string; headers?: Record<string, string> };

export interface McpServerConfig {
  /** Stable identifier - used as the tool namespace prefix (mcp__<id>__<toolName>) and for reconnecting on restart. */
  id: string;
  /** Display name shown in the dashboard. */
  name: string;
  transport: McpTransportConfig;
  /**
   * Parameter values fixed across every tool on this server (e.g. a chosen
   * workspace_id) - dropped from the LLM-visible schema and auto-injected on
   * every call, so the agent doesn't have to ask "which workspace?" or guess.
   */
  pinnedParams?: Record<string, unknown>;
  /**
   * OAuth refresh capability - lets the runtime mint a fresh access token
   * and reconnect on boot instead of failing once the short-lived token
   * baked into transport.headers expires. Currently only used by the
   * Svaramind integration (src/integrations/svaramind.ts).
   */
  oauth?: {
    clientId: string;
    refreshToken: string;
    tokenUrl: string;
    headerName: string;
    /** Unix ms when the access token in transport.headers expires - lets a refresh be skipped if it's still good, instead of unconditionally rotating (and burning) the refresh token on every restart. Optional for back-compat with configs saved before this field existed. */
    expiresAt?: number;
  };
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: McpTransportConfig;
  tools: string[];
  connectedAt: string;
  pinnedParams?: Record<string, unknown>;
}
