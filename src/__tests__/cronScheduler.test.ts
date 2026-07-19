import { describe, it, expect, vi } from 'vitest';
import { CronScheduler, buildCronPrompt } from '../cron/scheduler.js';
import type { SvaraAgent } from '../core/agent.js';
import type { SkillRegistry } from '../skills/registry.js';

function fakeAgent(process: (prompt: string) => Promise<{ response: string }>) {
  return { process: vi.fn(process) } as unknown as SvaraAgent;
}

describe('CronScheduler', () => {
  it('create() registers a job and rejects an invalid cron expression', () => {
    const scheduler = new CronScheduler({ agent: fakeAgent(async () => ({ response: 'ok' })) });
    const record = scheduler.create('0 9 * * *', 'daily report');
    expect(record.expression).toBe('0 9 * * *');
    expect(scheduler.list()).toHaveLength(1);

    expect(() => scheduler.create('not a cron expression', 'x')).toThrow(/Invalid cron expression/);
    scheduler.stopAll();
  });

  it('list() returns all registered jobs', () => {
    const scheduler = new CronScheduler({ agent: fakeAgent(async () => ({ response: 'ok' })) });
    scheduler.create('0 9 * * *', 'a');
    scheduler.create('0 10 * * *', 'b');
    expect(scheduler.list()).toHaveLength(2);
    scheduler.stopAll();
  });

  it('delete() removes a job and returns false for an unknown id', () => {
    const scheduler = new CronScheduler({ agent: fakeAgent(async () => ({ response: 'ok' })) });
    const record = scheduler.create('0 9 * * *', 'a');
    expect(scheduler.delete(record.id)).toBe(true);
    expect(scheduler.list()).toHaveLength(0);
    expect(scheduler.delete('nonexistent')).toBe(false);
  });

  it('stopAll() clears every job', () => {
    const scheduler = new CronScheduler({ agent: fakeAgent(async () => ({ response: 'ok' })) });
    scheduler.create('0 9 * * *', 'a');
    scheduler.create('0 10 * * *', 'b');
    scheduler.stopAll();
    expect(scheduler.list()).toHaveLength(0);
  });

  it('create() stores an optional name and skills list on the record', () => {
    const scheduler = new CronScheduler({ agent: fakeAgent(async () => ({ response: 'ok' })) });
    const record = scheduler.create('0 9 * * *', 'daily report', undefined, { name: 'Daily Summary', skills: ['daily-briefing'] });
    expect(record.name).toBe('Daily Summary');
    expect(record.skills).toEqual(['daily-briefing']);
    scheduler.stopAll();
  });

  it('create() leaves name/skills undefined when not provided, rather than empty values', () => {
    const scheduler = new CronScheduler({ agent: fakeAgent(async () => ({ response: 'ok' })) });
    const record = scheduler.create('0 9 * * *', 'a', undefined, { name: '', skills: [] });
    expect(record.name).toBeUndefined();
    expect(record.skills).toBeUndefined();
    scheduler.stopAll();
  });

  it('create() stores an optional deliverTo (channel + target) on the record', () => {
    const scheduler = new CronScheduler({ agent: fakeAgent(async () => ({ response: 'ok' })) });
    const record = scheduler.create('0 9 * * *', 'daily report', undefined, {
      deliverTo: { channel: 'telegram', target: '123456789' },
    });
    expect(record.deliverTo).toEqual({ channel: 'telegram', target: '123456789' });
    scheduler.stopAll();
  });
});

describe('buildCronPrompt', () => {
  function fakeRegistry(skills: Record<string, { name: string; body: string }>) {
    return {
      get: vi.fn(async (id: string) => skills[id]),
    } as unknown as SkillRegistry;
  }

  it('returns the prompt unchanged when no skills are scoped', async () => {
    const result = await buildCronPrompt('do the thing', undefined, fakeRegistry({}));
    expect(result).toBe('do the thing');
  });

  it('returns the prompt unchanged when there is no skill registry', async () => {
    const result = await buildCronPrompt('do the thing', ['some-skill'], null);
    expect(result).toBe('do the thing');
  });

  it('prepends the full instructions of each scoped skill, in order', async () => {
    const registry = fakeRegistry({
      'skill-a': { name: 'Skill A', body: 'Do A things.' },
      'skill-b': { name: 'Skill B', body: 'Do B things.' },
    });
    const result = await buildCronPrompt('run the job', ['skill-a', 'skill-b'], registry);
    expect(result).toBe(
      '### Skill: Skill A\nDo A things.\n\n### Skill: Skill B\nDo B things.\n\n---\n\nrun the job'
    );
  });

  it('silently skips a scoped skill id that no longer exists', async () => {
    const registry = fakeRegistry({ 'skill-a': { name: 'Skill A', body: 'Do A things.' } });
    const result = await buildCronPrompt('run the job', ['skill-a', 'deleted-skill'], registry);
    expect(result).toBe('### Skill: Skill A\nDo A things.\n\n---\n\nrun the job');
  });

  it('returns the prompt unchanged when every scoped skill id is missing', async () => {
    const registry = fakeRegistry({});
    const result = await buildCronPrompt('run the job', ['gone'], registry);
    expect(result).toBe('run the job');
  });
});
