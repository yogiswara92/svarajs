/**
 * @module mcp/registry
 * SvaraJS - search the official MCP Registry (registry.modelcontextprotocol.io),
 * the community-driven directory of publicly listed MCP servers backed by
 * Anthropic, GitHub, and Microsoft.
 *
 * Lean by design: only reads the registry (search + resolve a connectable
 * transport) - installing/publishing servers is out of scope.
 */

import type { McpTransportConfig } from './types.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';

interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  transport?: { type?: string };
  environmentVariables?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean; default?: string }>;
}

interface RegistryRemote {
  type?: string;
  url?: string;
  headers?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
}

interface RegistryServerEntry {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

export interface McpRegistryResult {
  /** The registry's own server name (e.g. "io.github.acme/my-server") - use as the "source" when connecting. */
  registryName: string;
  title: string;
  description: string;
  version: string;
  repositoryUrl?: string;
  /** What connecting would need - environment variables (stdio) or headers (remote) the user may need to fill in. */
  requiredSecrets: string[];
  transportKind: 'stdio' | 'remote' | 'unsupported';
}

function summarize(entry: RegistryServerEntry): McpRegistryResult {
  const remote = entry.remotes?.[0];
  const pkg = entry.packages?.[0];

  const requiredSecrets = [
    ...(pkg?.environmentVariables ?? []).filter((v) => v.isRequired || v.isSecret).map((v) => v.name),
    ...(remote?.headers ?? []).filter((h) => h.isRequired || h.isSecret).map((h) => h.name),
  ];

  return {
    registryName: entry.name,
    title: entry.title || entry.name,
    description: entry.description ?? '',
    version: entry.version ?? 'latest',
    repositoryUrl: entry.repository?.url,
    requiredSecrets,
    transportKind: remote ? 'remote' : pkg ? 'stdio' : 'unsupported',
  };
}

export async function searchMcpRegistry(query: string, limit = 20): Promise<McpRegistryResult[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set('search', query);

  const res = await fetch(`${REGISTRY_BASE}/v0/servers?${params}`);
  if (!res.ok) {
    throw new Error(`[SvaraJS] MCP registry search failed: ${res.status} ${res.statusText}`);
  }
  // Each list item is { server: {...}, _meta: {...} } - the registry API
  // nests the actual server.json under a "server" key (confirmed against
  // the live API; some docs/summaries show it flattened, which is wrong).
  const data = await res.json() as { servers?: Array<RegistryServerEntry | { server: RegistryServerEntry }> };
  return (data.servers ?? []).map((item) => summarize('server' in item ? item.server : item));
}

/** Fetches the full entry for one registry server and resolves it into a connectable transport config (prefers a remote endpoint over a locally-spawned package, since it needs no install). */
export async function resolveRegistryServer(registryName: string): Promise<{ transport: McpTransportConfig; name: string }> {
  const res = await fetch(`${REGISTRY_BASE}/v0/servers/${encodeURIComponent(registryName)}/versions/latest`);
  if (!res.ok) {
    throw new Error(`[SvaraJS] Could not look up MCP server "${registryName}": ${res.status} ${res.statusText}`);
  }
  const entry = await res.json() as RegistryServerEntry & { server?: RegistryServerEntry };
  const server = entry.server ?? entry; // registry API nests some responses under a "server" key

  const remote = server.remotes?.[0];
  if (remote?.url) {
    return {
      name: server.title || server.name,
      transport: {
        type: remote.type === 'sse' ? 'sse' : 'streamable-http',
        url: remote.url,
      },
    };
  }

  const pkg = server.packages?.[0];
  if (pkg?.identifier && pkg.registryType === 'npm') {
    return {
      name: server.title || server.name,
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', `${pkg.identifier}@${pkg.version ?? 'latest'}`],
      },
    };
  }

  throw new Error(
    `[SvaraJS] "${registryName}" has no remote endpoint and no supported package type ` +
    `(only npm-distributed stdio packages are auto-resolved) - connect it manually instead.`
  );
}
