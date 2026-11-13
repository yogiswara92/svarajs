import { describe, it, expect, vi } from 'vitest';
import { createSvaramindContextProvider } from '../integrations/svaramindContext.js';
import type { McpManager } from '../mcp/manager.js';

function fakeMcp(answers: Record<string, unknown>, connected = true) {
  return {
    isConnected: () => connected,
    getPinned: () => ({ workspace_id: 'home' }),
    callToolDirect: vi.fn(async (_id: string, tool: string, args: Record<string, unknown>) => tool === 'svaramind_list_workspaces'
      ? JSON.stringify({ workspaces: [{ id: 'home', name: 'Agent' }, { id: 'other', name: 'Telkom' }] })
      : JSON.stringify(answers[String(args.workspace_id)] ?? { success: true, results: [] })),
  } as unknown as McpManager & { callToolDirect: ReturnType<typeof vi.fn> };
}

const ctx = { sessionId: 's', metadata: {} };

describe('Svaramind context provider', () => {
  it('searches the pinned and extra workspaces and returns prompt text and sources, best first', async () => {
    const mcp = fakeMcp({
      home: { success: true, results: [{ document_id: 'd1', title: 'Vendor meeting', chunk_text: 'We picked PT Maju as vendor.', score: 0.62, link: 'https://mind/doc/d1' }], knowledge_graph: 'PT Maju - supplies - Bandung branch' },
      other: { success: true, results: [{ document_id: 'd2', title: 'Budget 2026', chunk_text: 'Budget is 2B.', score: 0.81 }] },
    });
    const p = createSvaramindContextProvider(mcp, { workspaces: ['other'] });
    const out = await p.run('Who is our vendor for the Bandung branch?', ctx);
    expect(mcp.callToolDirect).toHaveBeenCalledTimes(3);
    expect(out?.text).toMatch(/workspace "Agent" \(workspace_id home\)/);
    expect(out?.text).toMatch(/From workspace "Agent"/);
    expect(out?.documents?.map((d) => d.source)).toEqual(['Budget 2026', 'Vendor meeting']);
    expect(out?.documents?.[1].link).toBe('https://mind/doc/d1');
    expect(out?.text).toMatch(/PT Maju - supplies/);
    expect(out?.text).toMatch(/document_id d1/);
  });

  it('skips small talk and does nothing when Svaramind is not connected', async () => {
    const mcp = fakeMcp({});
    const p = createSvaramindContextProvider(mcp);
    expect(await p.run('halo', ctx)).toBeNull();
    expect(mcp.callToolDirect).not.toHaveBeenCalled();
    const off = createSvaramindContextProvider(fakeMcp({}, false));
    expect(await off.run('What did we decide about the vendor?', ctx)).toBeNull();
  });

  it('drops loose matches and survives a failing workspace', async () => {
    const mcp = fakeMcp({ home: { success: true, weak_match: true, results: [{ title: 'Unrelated', chunk_text: 'x', score: 0.2 }] } });
    const real = (mcp.callToolDirect as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (mcp.callToolDirect as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, tool: string, args: Record<string, unknown>) => {
      if (args?.workspace_id === 'broken') throw new Error('down');
      return real(id, tool, args);
    });
    const p = createSvaramindContextProvider(mcp, { workspaces: ['broken'] });
    const out = await p.run('Tell me about the unrelated thing please', ctx);
    expect(out?.documents ?? []).toHaveLength(0);
    expect(out?.text).toBeUndefined();
  });
});
