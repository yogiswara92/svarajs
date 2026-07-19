import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchMcpRegistry, resolveRegistryServer } from '../mcp/registry.js';

describe('searchMcpRegistry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('queries the official registry and summarizes each entry', async () => {
    // Each list item is nested under a "server" key - confirmed against the
    // live API (some docs show it flattened, which does not match reality).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [
          {
            server: {
              name: 'io.github.acme/weather',
              title: 'Weather',
              description: 'Get the weather',
              version: '1.2.0',
              repository: { url: 'https://github.com/acme/weather' },
              remotes: [{ type: 'streamable-http', url: 'https://weather.example.com/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }],
            },
          },
          {
            server: {
              name: 'io.github.acme/files',
              title: 'Files',
              description: 'Local file access',
              version: '0.9.0',
              packages: [{ registryType: 'npm', identifier: '@acme/files-mcp', version: '0.9.0', environmentVariables: [{ name: 'FILES_ROOT', isRequired: true }] }],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchMcpRegistry('weather');

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('search=weather'));
    expect(results).toEqual([
      {
        registryName: 'io.github.acme/weather',
        title: 'Weather',
        description: 'Get the weather',
        version: '1.2.0',
        repositoryUrl: 'https://github.com/acme/weather',
        requiredSecrets: ['Authorization'],
        transportKind: 'remote',
      },
      {
        registryName: 'io.github.acme/files',
        title: 'Files',
        description: 'Local file access',
        version: '0.9.0',
        repositoryUrl: undefined,
        requiredSecrets: ['FILES_ROOT'],
        transportKind: 'stdio',
      },
    ]);
  });

  it('throws a clear error when the registry responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' }));
    await expect(searchMcpRegistry('x')).rejects.toThrow(/503/);
  });

  it('treats a server with neither remotes nor packages as unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ servers: [{ server: { name: 'io.github.acme/empty', title: 'Empty', description: '', version: '1.0.0' } }] }),
    }));
    const [result] = await searchMcpRegistry('');
    expect(result.transportKind).toBe('unsupported');
  });
});

describe('resolveRegistryServer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prefers a remote endpoint over a package when both are present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'io.github.acme/both',
        title: 'Both',
        remotes: [{ type: 'sse', url: 'https://both.example.com/sse' }],
        packages: [{ registryType: 'npm', identifier: '@acme/both-mcp', version: '1.0.0' }],
      }),
    }));

    const resolved = await resolveRegistryServer('io.github.acme/both');
    expect(resolved).toEqual({ name: 'Both', transport: { type: 'sse', url: 'https://both.example.com/sse' } });
  });

  it('builds an npx stdio launch command from an npm package when there is no remote', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'io.github.acme/files',
        title: 'Files',
        packages: [{ registryType: 'npm', identifier: '@acme/files-mcp', version: '2.1.0' }],
      }),
    }));

    const resolved = await resolveRegistryServer('io.github.acme/files');
    expect(resolved).toEqual({
      name: 'Files',
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@acme/files-mcp@2.1.0'] },
    });
  });

  it('throws when the server has no remote and no npm package (unsupported registry type)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'io.github.acme/pip-only',
        title: 'Pip Only',
        packages: [{ registryType: 'pip', identifier: 'acme-mcp', version: '1.0.0' }],
      }),
    }));

    await expect(resolveRegistryServer('io.github.acme/pip-only')).rejects.toThrow(/connect it manually/);
  });

  it('throws a clear error when the lookup itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }));
    await expect(resolveRegistryServer('io.github.acme/missing')).rejects.toThrow(/404/);
  });
});
