import { describe, it, expect, vi, afterEach } from 'vitest';
import { CronScheduler } from '../cron/scheduler.js';
import { createCronTool } from '../cron/tools.js';
import type { SvaraAgent } from '../core/agent.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

function fakeAgent() {
  return { process: vi.fn(async () => ({ response: 'ok' })) } as unknown as SvaraAgent;
}

describe('createCronTool', () => {
  let scheduler: CronScheduler;

  afterEach(() => {
    scheduler?.stopAll();
  });

  it('create + list + delete round-trip', async () => {
    scheduler = new CronScheduler({ agent: fakeAgent() });
    const tool = createCronTool(scheduler);

    const created = await tool.run({ action: 'create', schedule: '0 9 * * *', prompt: 'daily report' }, ctx) as { created: string };
    expect(created.created).toBeDefined();

    const listed = await tool.run({ action: 'list' }, ctx) as { jobs: Array<{ id: string }> };
    expect(listed.jobs).toHaveLength(1);

    const deleted = await tool.run({ action: 'delete', id: created.created }, ctx) as { deleted: string };
    expect(deleted.deleted).toBe(created.created);

    const listedAfter = await tool.run({ action: 'list' }, ctx) as { jobs: unknown[] };
    expect(listedAfter.jobs).toHaveLength(0);
  });

  it('create without required fields returns an error', async () => {
    scheduler = new CronScheduler({ agent: fakeAgent() });
    const tool = createCronTool(scheduler);
    const result = await tool.run({ action: 'create', schedule: '0 9 * * *' }, ctx) as { error: string };
    expect(result.error).toMatch(/requires/);
  });

  it('create with an invalid cron expression returns an error instead of throwing', async () => {
    scheduler = new CronScheduler({ agent: fakeAgent() });
    const tool = createCronTool(scheduler);
    const result = await tool.run({ action: 'create', schedule: 'garbage', prompt: 'x' }, ctx) as { error: string };
    expect(result.error).toMatch(/Invalid cron expression/);
  });

  it('delete on an unknown id returns an error', async () => {
    scheduler = new CronScheduler({ agent: fakeAgent() });
    const tool = createCronTool(scheduler);
    const result = await tool.run({ action: 'delete', id: 'nonexistent' }, ctx) as { error: string };
    expect(result.error).toMatch(/not found/);
  });
});
