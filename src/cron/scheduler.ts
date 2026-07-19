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
}

export interface CronJobExtra {
  name?: string;
  skills?: string[];
  deliverTo?: CronDeliverTo;
}

export interface CronSchedulerOptions {
  agent: SvaraAgent;
  /** Called with the agent's response text after each successful run. */
  onResult?: (job: CronJobRecord, response: string) => void | Promise<void>;
  /** Called if a scheduled run throws. */
  onError?: (job: CronJobRecord, error: Error) => void | Promise<void>;
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

  /** Register a new job. Throws if `expression` isn't a valid cron expression. */
  create(expression: string, prompt: string, id: string = crypto.randomUUID(), extra?: CronJobExtra): CronJobRecord {
    if (!validate(expression)) {
      throw new Error(`[SvaraJS] Invalid cron expression: "${expression}"`);
    }

    const record: CronJobRecord = {
      id, expression, prompt, createdAt: new Date().toISOString(),
      name: extra?.name || undefined,
      skills: extra?.skills?.length ? extra.skills : undefined,
      deliverTo: extra?.deliverTo,
    };

    const task = schedule(expression, async () => {
      try {
        const effectivePrompt = await buildCronPrompt(record.prompt, record.skills, this.opts.agent.getSkillRegistry());
        const result = await this.opts.agent.process(effectivePrompt, { sessionId: `cron:${id}` });
        await this.opts.onResult?.(record, result.response);
      } catch (err) {
        await this.opts.onError?.(record, err as Error);
      }
    });

    this.jobs.set(id, { record, task });
    return record;
  }

  list(): CronJobRecord[] {
    return [...this.jobs.values()].map((j) => j.record);
  }

  delete(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    entry.task.stop();
    this.jobs.delete(id);
    return true;
  }

  /** Stop every job - call on agent/runtime shutdown. */
  stopAll(): void {
    for (const { task } of this.jobs.values()) task.stop();
    this.jobs.clear();
  }
}
