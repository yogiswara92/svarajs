import { describe, it, expect, vi, afterEach } from 'vitest';
import { CronScheduler } from '../cron/scheduler.js';
import { createCronTool } from '../cron/tools.js';
import type { SvaraAgent } from '../core/agent.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

function fakeAgent() {
  return { process: vi.fn(async () => ({ response: 'ok' })), getSkillRegistry: () => null } as unknown as SvaraAgent;
}

describe('createCronTool', () => {
  let scheduler: CronScheduler;

  afterEach(() => {
    scheduler?.stopAll();
  });

  it('create + list + delete round-trip', async () => {
    scheduler = new CronScheduler({ agent: fakeAgent() });
    const tool = createCronTool(scheduler);

    const created = await tool.run({ action: 'create', schedule: '0 9 * * *', prompt: 'daily report' }, ctx) as { created: { id: string; deliver: string } };
    expect(created.created.id).toBeDefined();
    expect(created.created.deliver).toBe('none');

    const listed = await tool.run({ action: 'list' }, ctx) as { jobs: Array<{ id: string }> };
    expect(listed.jobs).toHaveLength(1);

    const deleted = await tool.run({ action: 'delete', id: created.created.id }, ctx) as { deleted: string };
    expect(deleted.deleted).toBe(created.created.id);

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

  it('a job created from a chat reports back to that chat by default', async () => {
    scheduler = new CronScheduler({ agent: fakeAgent() });
    const tool = createCronTool(scheduler);
    const fromTelegram = { metadata: { channel: 'telegram', target: '12345' } } as unknown as AgentContext;
    const r = await tool.run({ action: 'create', schedule: '0 7 * * *', prompt: 'news', name: 'Morning news' }, fromTelegram) as { created: { id: string; deliver: string } };
    expect(r.created.deliver).toBe('telegram:12345');
    expect(scheduler.get(r.created.id)?.deliverTo).toEqual({ channel: 'telegram', target: '12345' });

    const none = await tool.run({ action: 'create', schedule: '0 7 * * *', prompt: 'quiet', deliver: 'none' }, fromTelegram) as { created: { deliver: string } };
    expect(none.created.deliver).toBe('none');
  });

  it('"here" without a chat origin is refused with a readable error', async () => {
    scheduler = new CronScheduler({ agent: fakeAgent() });
    const tool = createCronTool(scheduler);
    const r = await tool.run({ action: 'create', schedule: '0 7 * * *', prompt: 'x', deliver: 'here' }, ctx) as { error: string };
    expect(r.error).toMatch(/only possible/);
  });

  it('update, pause, resume and run a job', async () => {
    const agent = fakeAgent();
    scheduler = new CronScheduler({ agent });
    const tool = createCronTool(scheduler);
    const { created } = await tool.run({ action: 'create', schedule: '0 9 * * *', prompt: 'report' }, ctx) as { created: { id: string } };

    const up = await tool.run({ action: 'update', id: created.id, schedule: '30 8 * * 1-5', name: 'Weekday report' }, ctx) as { updated: { schedule: string; name: string; prompt: string } };
    expect(up.updated).toMatchObject({ schedule: '30 8 * * 1-5', name: 'Weekday report', prompt: 'report' });

    const paused = await tool.run({ action: 'pause', id: created.id }, ctx) as { paused: { status: string } };
    expect(paused.paused.status).toBe('paused');
    const resumed = await tool.run({ action: 'resume', id: created.id }, ctx) as { resumed: { status: string } };
    expect(resumed.resumed.status).toBe('active');

    const ran = await tool.run({ action: 'run', id: created.id }, ctx) as { result: string };
    expect(ran.result).toBe('ok');
    expect(agent.process).toHaveBeenCalledTimes(1);
    expect(scheduler.get(created.id)?.lastRunAt).toBeDefined();
  });

  it('reports every change to onChange (so the host can persist), but not jobs loaded at startup', async () => {
    const onChange = vi.fn();
    scheduler = new CronScheduler({ agent: fakeAgent(), onChange });
    scheduler.load('0 9 * * *', 'saved', 'saved-1');
    expect(onChange).not.toHaveBeenCalled();
    const tool = createCronTool(scheduler);
    const { created } = await tool.run({ action: 'create', schedule: '0 9 * * *', prompt: 'new' }, ctx) as { created: { id: string } };
    await tool.run({ action: 'pause', id: created.id }, ctx);
    await tool.run({ action: 'delete', id: 'saved-1' }, ctx);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls[2][0]).toEqual([expect.objectContaining({ id: created.id, paused: true })]);
  });

  it('describes its time zone to the model', () => {
    scheduler = new CronScheduler({ agent: fakeAgent(), timezone: 'Asia/Jakarta' });
    expect(createCronTool(scheduler).description).toMatch(/Asia\/Jakarta/);
  });
});
