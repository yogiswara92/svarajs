/**
 * @module cron/scheduler
 * SvaraJS - scheduled/autonomous tasks
 *
 * Wraps `node-cron`: each job re-invokes the agent with a fixed prompt on a
 * cron schedule. Delivery (sending the result somewhere - a channel, a
 * webhook) is left to `onResult`, so this stays decoupled from any specific
 * channel implementation. Needs a constructed agent, so it's wired up after
 * the fact (like delegation) rather than via AgentConfig:
 *
 * @example
 * const scheduler = new CronScheduler({ agent, onResult: (job, text) => agent.emit('cron:result', { job, text }) });
 * agent.addTool(createCronTool(scheduler));
 * scheduler.create('0 9 * * *', 'Summarize overnight activity and report it.');
 */

import crypto from 'crypto';
import { schedule, validate, type ScheduledTask } from 'node-cron';
import type { SvaraAgent } from '../core/agent.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ChannelName } from '../core/types.js';

/** Where a cron job's result goes once a run finishes - beyond just the server log. `target` is channel-specific: a Telegram chat id, a Discord channel id, a Slack channel id/name, a WhatsApp phone number. */
export interface CronDeliverTo {
  channel: ChannelName;
  target: string;
}

export interface CronJobRecord {
  id: string;
  expression: string;
  prompt: string;
  createdAt: string;
  /** Optional display label - purely for the dashboard's job list, never sent to the LLM. */
  name?: string;
  /** Skill ids whose full instructions get prepended to the prompt on every run, scoping the job to just that playbook instead of the agent's whole skill set. */
  skills?: string[];
  /** Push the result to a connected channel in addition to the server log - undefined means local-only (the original, still-default behavior). */
  deliverTo?: CronDeliverTo;
  /** A paused job keeps its settings but does not fire until resumed. */
  paused?: boolean;
  /** When the job last ran, and whether that run worked. */
  lastRunAt?: string;
  lastError?: string;
}

export interface CronJobExtra {
  name?: string;
  skills?: string[];
  deliverTo?: CronDeliverTo;
  paused?: boolean;
}

/** What `update()` may change on an existing job. `deliverTo: null` stops delivery. */
export interface CronJobPatch {
  schedule?: string;
  prompt?: string;
  name?: string;
  skills?: string[];
  deliverTo?: CronDeliverTo | null;
  paused?: boolean;
}

export interface CronSchedulerOptions {
  agent: SvaraAgent;
  /** Called with the agent's response text after each successful run. */
  onResult?: (job: CronJobRecord, response: string) => void | Promise<void>;
  /** Called if a scheduled run throws. */
  onError?: (job: CronJobRecord, error: Error) => void | Promise<void>;
  /** IANA time zone the cron expressions are read in (e.g. "Asia/Jakarta"). Defaults to the server's zone. */
  timezone?: string;
  /**
   * Called after every change made through create/update/delete/pause (not while loading saved jobs with
   * `load()`), so the host can persist the list and jobs survive a restart.
   */
  onChange?: (jobs: CronJobRecord[]) => void | Promise<void>;
}

/** Prepends the full instructions of each scoped skill to the prompt - a cron run is a single fixed task, so this skips the usual skills_list -> skill_view discovery round trip. Exported standalone (rather than a private method) so it's testable without needing an actual cron tick to fire. */
export async function buildCronPrompt(prompt: string, skillIds: string[] | undefined, registry: SkillRegistry | null): Promise<string> {
  if (!skillIds?.length || !registry) return prompt;

  const sections: string[] = [];
  for (const skillId of skillIds) {
    const skill = await registry.get(skillId);
    if (skill) sections.push(`### Skill: ${skill.name}\n${skill.body}`);
  }
  if (!sections.length) return prompt;
  return `${sections.join('\n\n')}\n\n---\n\n${prompt}`;
}

export class CronScheduler {
  private jobs: Map<string, { record: CronJobRecord; task: ScheduledTask }> = new Map();

  constructor(private opts: CronSchedulerOptions) {}

  get timezone(): string | undefined {
    return this.opts.timezone;
  }

  /** True when the host persists changes itself (onChange is set). */
  get persists(): boolean {
    return !!this.opts.onChange;
  }

  /** Register a new job. Throws if `expression` isn't a valid cron expression. */
  create(expression: string, prompt: string, id: string = crypto.randomUUID(), extra?: CronJobExtra): CronJobRecord {
    const record = this.register(expression, prompt, id, extra);
    this.changed();
    return record;
  }

  /** Register a saved job at startup without reporting it as a change. */
  load(expression: string, prompt: string, id?: string, extra?: CronJobExtra): CronJobRecord {
    return this.register(expression, prompt, id ?? crypto.randomUUID(), extra);
  }

  private register(expression: string, prompt: string, id: string, extra?: CronJobExtra): CronJobRecord {
    if (!validate(expression)) {
      throw new Error(`[SvaraJS] Invalid cron expression: "${expression}"`);
    }
    if (!prompt.trim()) throw new Error('[SvaraJS] A scheduled task needs a prompt.');
    this.jobs.get(id)?.task.stop();

    const record: CronJobRecord = {
      id, expression, prompt, createdAt: new Date().toISOString(),
      name: extra?.name || undefined,
      skills: extra?.skills?.length ? extra.skills : undefined,
      deliverTo: extra?.deliverTo,
      paused: extra?.paused || undefined,
    };
    const task = this.schedule(record);
    this.jobs.set(id, { record, task });
    return record;
  }

  private schedule(record: CronJobRecord): ScheduledTask {
    const task = schedule(record.expression, () => { void this.fire(record); }, this.opts.timezone ? { timezone: this.opts.timezone } : undefined);
    if (record.paused) task.stop();
    return task;
  }

  private async fire(record: CronJobRecord): Promise<string | null> {
    record.lastRunAt = new Date().toISOString();
    try {
      const effectivePrompt = await buildCronPrompt(record.prompt, record.skills, this.opts.agent.getSkillRegistry());
      const result = await this.opts.agent.process(effectivePrompt, { sessionId: `cron:${record.id}` });
      record.lastError = undefined;
      await this.opts.onResult?.(record, result.response);
      return result.response;
    } catch (err) {
      record.lastError = (err as Error).message;
      await this.opts.onError?.(record, err as Error);
      return null;
    }
  }

  list(): CronJobRecord[] {
    return [...this.jobs.values()].map((j) => j.record);
  }

  get(id: string): CronJobRecord | undefined {
    return this.jobs.get(id)?.record;
  }

  /** Change an existing job in place (keeps its id and creation time). Throws on an unknown id or a bad expression. */
  update(id: string, patch: CronJobPatch): CronJobRecord {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error(`Job "${id}" not found.`);
    const next = { ...entry.record };
    if (patch.schedule !== undefined) {
      if (!validate(patch.schedule)) throw new Error(`[SvaraJS] Invalid cron expression: "${patch.schedule}"`);
      next.expression = patch.schedule;
    }
    if (patch.prompt !== undefined) {
      if (!patch.prompt.trim()) throw new Error('[SvaraJS] A scheduled task needs a prompt.');
      next.prompt = patch.prompt;
    }
    if (patch.name !== undefined) next.name = patch.name || undefined;
    if (patch.skills !== undefined) next.skills = patch.skills.length ? patch.skills : undefined;
    if (patch.deliverTo !== undefined) next.deliverTo = patch.deliverTo || undefined;
    if (patch.paused !== undefined) next.paused = patch.paused || undefined;
    entry.task.stop();
    this.jobs.set(id, { record: next, task: this.schedule(next) });
    this.changed();
    return next;
  }

  /** Run a job right away, outside its schedule. Resolves with the response (null if the run failed). */
  runNow(id: string): Promise<string | null> {
    const entry = this.jobs.get(id);
    if (!entry) return Promise.reject(new Error(`Job "${id}" not found.`));
    return this.fire(entry.record);
  }

  delete(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    entry.task.stop();
    this.jobs.delete(id);
    this.changed();
    return true;
  }

  private changed(): void {
    if (!this.opts.onChange) return;
    Promise.resolve(this.opts.onChange(this.list())).catch((err) => {
      console.error(`[@yesvara/svara] saving scheduled tasks failed: ${(err as Error).message}`);
    });
  }

  /** Stop every job - call on agent/runtime shutdown. */
  stopAll(): void {
    for (const { task } of this.jobs.values()) task.stop();
    this.jobs.clear();
  }
}
