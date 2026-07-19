import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClientInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => mockClientInstance),
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation((opts) => ({ __kind: 'stdio', opts })),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url, opts) => ({ __kind: 'streamable-http', url, opts })),
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation((url, opts) => ({ __kind: 'sse', url, opts })),
}));

const { McpManager } = await import('../mcp/manager.js');

function fakeAgent() {
  const tools = new Map();
  return {
    addTool: vi.fn((t) => tools.set(t.name, t)),
    removeTool: vi.fn((name) => tools.delete(name)),
    getTool: (name) => tools.get(name),
    _tools: tools,
  };
}

describe('McpManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstance.connect.mockResolvedValue(undefined);
    mockClientInstance.close.mockResolvedValue(undefined);
  });

  it('connects over stdio, registers each tool namespaced mcp__<id>__<toolName>', async () => {
    mockClientInstance.listTools.mockResolvedValue({
      tools: [
        { name: 'search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'query' } }, required: ['query'] } },
      ],
    });

    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    const status = await manager.connect({
      id: 'my-server',
      name: 'My Server',
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp-server'] },
    });

    expect(status.tools).toEqual(['mcp__my-server__search']);
    expect(agent.addTool).toHaveBeenCalledTimes(1);
    const registered = agent._tools.get('mcp__my-server__search');
    expect(registered.parameters).toEqual({ query: { type: 'string', description: 'query', required: true, enum: undefined, default: undefined } });
  });

  it('refuses to connect the same server id twice', async () => {
    mockClientInstance.listTools.mockResolvedValue({ tools: [] });
    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await manager.connect({ id: 'dup', name: 'Dup', transport: { type: 'stdio', command: 'echo' } });
    await expect(manager.connect({ id: 'dup', name: 'Dup', transport: { type: 'stdio', command: 'echo' } }))
      .rejects.toThrow(/already connected/);
  });

  it('wraps a connect() failure with a clear error instead of throwing the SDK error raw', async () => {
    mockClientInstance.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await expect(manager.connect({ id: 'x', name: 'X', transport: { type: 'streamable-http', url: 'https://example.com/mcp' } }))
      .rejects.toThrow(/Could not connect to MCP server "X"/);
  });

  it("a wrapped tool's run() calls the underlying MCP callTool and unwraps text content", async () => {
    mockClientInstance.listTools.mockResolvedValue({
      tools: [{ name: 'echo', description: 'Echoes input' }],
    });
    mockClientInstance.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'hello back' }] });

    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await manager.connect({ id: 's1', name: 'S1', transport: { type: 'stdio', command: 'echo' } });

    const tool = agent._tools.get('mcp__s1__echo');
    const result = await tool.run({ text: 'hi' }, {});
    expect(mockClientInstance.callTool).toHaveBeenCalledWith({ name: 'echo', arguments: { text: 'hi' } });
    expect(result).toBe('hello back');
  });

  it("a wrapped tool's run() throws when the MCP server reports isError", async () => {
    mockClientInstance.listTools.mockResolvedValue({ tools: [{ name: 'fail' }] });
    mockClientInstance.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'boom' }] });

    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await manager.connect({ id: 's2', name: 'S2', transport: { type: 'stdio', command: 'echo' } });

    const tool = agent._tools.get('mcp__s2__fail');
    await expect(tool.run({}, {})).rejects.toThrow('boom');
  });

  it('disconnect removes all of that server\'s tools from the agent and closes the client', async () => {
    mockClientInstance.listTools.mockResolvedValue({
      tools: [{ name: 'a' }, { name: 'b' }],
    });
    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await manager.connect({ id: 's3', name: 'S3', transport: { type: 'stdio', command: 'echo' } });
    expect(manager.isConnected('s3')).toBe(true);

    const deleted = await manager.disconnect('s3');
    expect(deleted).toBe(true);
    expect(agent.removeTool).toHaveBeenCalledWith('mcp__s3__a');
    expect(agent.removeTool).toHaveBeenCalledWith('mcp__s3__b');
    expect(mockClientInstance.close).toHaveBeenCalled();
    expect(manager.isConnected('s3')).toBe(false);
  });

  it('disconnect returns false for an unknown server id', async () => {
    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    expect(await manager.disconnect('nope')).toBe(false);
  });

  it('list() reports every connected server with its tool names', async () => {
    mockClientInstance.listTools.mockResolvedValue({ tools: [{ name: 'x' }] });
    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await manager.connect({ id: 's4', name: 'S4', transport: { type: 'sse', url: 'https://example.com/sse' } });

    const list = manager.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's4', name: 'S4', tools: ['mcp__s4__x'] });
  });

  it('pinParameter() keeps the pinned param visible (as an optional default), not hidden, and auto-injects it only when omitted', async () => {
    mockClientInstance.listTools.mockResolvedValue({
      tools: [{
        name: 'search',
        inputSchema: {
          type: 'object',
          properties: { workspace_id: { type: 'string' }, query: { type: 'string' } },
          required: ['workspace_id', 'query'],
        },
      }],
    });
    mockClientInstance.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'found it' }] });

    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await manager.connect({ id: 'sm', name: 'Svaramind', transport: { type: 'streamable-http', url: 'https://example.com/mcp' } });

    const status = manager.pinParameter('sm', 'workspace_id', 'ws-123');
    expect(status.pinnedParams).toEqual({ workspace_id: 'ws-123' });

    // The LLM-visible schema still mentions workspace_id - just optional now,
    // with the default called out - not silently no longer required, so an
    // omit is a deliberate use-the-default rather than a schema violation.
    const tool = agent._tools.get('mcp__sm__search');
    expect(tool.parameters.workspace_id).toEqual({
      type: 'string',
      description: 'workspace_id (defaults to "ws-123" if omitted - pass a different value to use another one instead)',
      required: false,
      enum: undefined,
      default: 'ws-123',
    });
    expect(tool.parameters.query).toEqual({ type: 'string', description: 'query', required: true, enum: undefined, default: undefined });

    // Omitting workspace_id - the pin is injected automatically.
    await tool.run({ query: 'hello' }, {});
    expect(mockClientInstance.callTool).toHaveBeenCalledWith({ name: 'search', arguments: { workspace_id: 'ws-123', query: 'hello' } });

    // Explicitly passing a different workspace_id - it wins over the pin.
    await tool.run({ query: 'hello', workspace_id: 'ws-other' }, {});
    expect(mockClientInstance.callTool).toHaveBeenLastCalledWith({ name: 'search', arguments: { workspace_id: 'ws-other', query: 'hello' } });
  });

  it('pinParameter() on an unconnected server throws', () => {
    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    expect(() => manager.pinParameter('nope', 'workspace_id', 'x')).toThrow(/not connected/);
  });

  it('callToolDirect() calls the underlying MCP tool by its original name, bypassing the agent entirely', async () => {
    mockClientInstance.listTools.mockResolvedValue({ tools: [{ name: 'list_workspaces' }] });
    mockClientInstance.callTool.mockResolvedValue({ content: [{ type: 'text', text: '[{"id":"ws-1","name":"Personal"}]' }] });

    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await manager.connect({ id: 'sm', name: 'Svaramind', transport: { type: 'streamable-http', url: 'https://example.com/mcp' } });

    const result = await manager.callToolDirect('sm', 'list_workspaces');
    expect(mockClientInstance.callTool).toHaveBeenCalledWith({ name: 'list_workspaces', arguments: {} });
    expect(result).toBe('[{"id":"ws-1","name":"Personal"}]');
    expect(agent.addTool).toHaveBeenCalledTimes(1); // only the initial connect() registration - direct calls don't touch the agent
  });

  it('callToolDirect() throws when the server is not connected', async () => {
    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    await expect(manager.callToolDirect('nope', 'x')).rejects.toThrow(/not connected/);
  });

  it('connect() applies pinnedParams from the config immediately, without a separate pinParameter() call', async () => {
    mockClientInstance.listTools.mockResolvedValue({
      tools: [{ name: 'search', inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' }, query: { type: 'string' } } } }],
    });
    const agent = fakeAgent();
    const manager = new McpManager(agent as never);
    const status = await manager.connect({
      id: 'sm', name: 'Svaramind',
      transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
      pinnedParams: { workspace_id: 'ws-restored' },
    });
    expect(status.pinnedParams).toEqual({ workspace_id: 'ws-restored' });
    const tool = agent._tools.get('mcp__sm__search');
    expect(tool.parameters.workspace_id.default).toBe('ws-restored');
    expect(tool.parameters.workspace_id.required).toBe(false);
  });
});
