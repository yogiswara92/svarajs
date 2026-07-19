import { describe, it, expect, vi } from 'vitest';
import EventEmitter from 'events';
import { attachProgressReporter } from '../channels/progressReporter.js';
import type { SvaraAgent } from '../core/agent.js';

function fakeAgent(): SvaraAgent {
  return new EventEmitter() as unknown as SvaraAgent;
}

describe('attachProgressReporter', () => {
  it('calls onUpdate with the tool names for this session on the first tool:call event', async () => {
    const agent = fakeAgent();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const reporter = attachProgressReporter({ agent, sessionId: 's1', onUpdate });

    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['web_search'] });
    await Promise.resolve();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toContain('web_search');
    reporter.stop();
  });

  it('ignores tool:call events for a different session', async () => {
    const agent = fakeAgent();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const reporter = attachProgressReporter({ agent, sessionId: 's1', onUpdate });

    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 'other-session', tools: ['web_search'] });
    await Promise.resolve();

    expect(onUpdate).not.toHaveBeenCalled();
    reporter.stop();
  });

  it('throttles rapid events - a second tool:call within throttleMs does not trigger another onUpdate', async () => {
    const agent = fakeAgent();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const reporter = attachProgressReporter({ agent, sessionId: 's1', onUpdate, throttleMs: 10_000 });

    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['a'] });
    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['b'] });
    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['c'] });
    await Promise.resolve();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    reporter.stop();
  });

  it('accumulates tool names across events even while throttled, so the next update that does fire has the full list', async () => {
    const agent = fakeAgent();
    const updates: string[] = [];
    const onUpdate = vi.fn().mockImplementation(async (text: string) => { updates.push(text); });
    const reporter = attachProgressReporter({ agent, sessionId: 's1', onUpdate, throttleMs: 100_000 });

    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['first'] });
    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['second'] });
    await Promise.resolve();

    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('first');
    reporter.stop();
  });

  it('hasUpdates() reflects whether any tool:call has landed for this session', () => {
    const agent = fakeAgent();
    const reporter = attachProgressReporter({ agent, sessionId: 's1', onUpdate: vi.fn().mockResolvedValue(undefined) });

    expect(reporter.hasUpdates()).toBe(false);
    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['x'] });
    expect(reporter.hasUpdates()).toBe(true);
    reporter.stop();
  });

  it('stop() detaches the listener - a later tool:call no longer triggers onUpdate', async () => {
    const agent = fakeAgent();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const reporter = attachProgressReporter({ agent, sessionId: 's1', onUpdate });
    reporter.stop();

    (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['x'] });
    await Promise.resolve();

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does not propagate an onUpdate rejection (best-effort - a failed progress edit should not break the turn)', async () => {
    const agent = fakeAgent();
    const onUpdate = vi.fn().mockRejectedValue(new Error('edit failed'));
    const reporter = attachProgressReporter({ agent, sessionId: 's1', onUpdate });

    expect(() => (agent as unknown as EventEmitter).emit('tool:call', { sessionId: 's1', tools: ['x'] })).not.toThrow();
    await Promise.resolve();
    reporter.stop();
  });
});
