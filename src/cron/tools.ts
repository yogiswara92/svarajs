/**
 * @module cron/tools
 * The `cronjob` tool - lets the agent manage its own scheduled tasks from any chat ("every Monday at 8, send me
 * the industry news here"): create, list, change, pause, resume, run now and delete.
 */

import type { Tool } from '../types.js';
import type { ChannelName } from '../core/types.js';
import type { CronScheduler, CronDeliverTo, CronJobRecord } from './scheduler.js';

const CHANNELS: ChannelName[] = ['web', 'telegram', 'whatsapp', 'slack', 'discord'];

/** "here" = the chat this message came from; "none" = no delivery; or an explicit "<channel>:<target>". */
function resolveDelivery(value: unknown, metadata: Record<string, unknown>): CronDeliverTo | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const v = String(value).trim();
  if (v === 'none') return null;
  if (v === 'here') {
    const channel = metadata.channel as ChannelName | undefined;
    const target = metadata.target as string | undefined;
    if (!channel || !target || !CHANNELS.includes(channel)) {
      throw new Error('"here" is only possible when the request came in through a chat channel. Use "none" or "<channel>:<target>".');
    }
    return { channel, target: String(target) };
  }
  const [channel, ...rest] = v.split(':');
  if (!CHANNELS.includes(channel as ChannelName) || !rest.length) {
    throw new Error('deliver must be "here", "none", or "<channel>:<target>" (channel: web, telegram, whatsapp, slack, discord).');
  }
  return { channel: channel as ChannelName, target: rest.join(':') };
}

function view(job: CronJobRecord) {
  return {
    id: job.id,
    name: job.name,
    schedule: job.expression,
    prompt: job.prompt,
    status: job.paused ? 'paused' : 'active',
    deliver: job.deliverTo ? `${job.deliverTo.channel}:${job.deliverTo.target}` : 'none',
    last_run: job.lastRunAt,
    last_error: job.lastError,
  };
}

export function createCronTool(scheduler: CronScheduler): Tool {
  const tz = scheduler.timezone;
  return {
    name: 'cronjob',
    description:
      'Manage your own scheduled tasks (recurring work you do by yourself). Use it whenever the user asks for something ' +
      'to happen regularly or at a set time ("every morning", "each Monday at 8", "remind me at 5pm"), or asks to see, ' +
      'change, pause, resume, test or stop a schedule. Schedules are 5-field cron expressions read in ' +
      (tz ? `the ${tz} time zone` : 'the server time zone') + ' (e.g. "0 7 * * *" = daily 07:00, "0 8 * * 1" = Mondays 08:00, ' +
      '"*/30 * * * *" = every 30 minutes). Write the prompt as a complete instruction to your future self, including where ' +
      'to save results (e.g. your Svaramind folder). For a one-off reminder, create it and delete it after it has run. ' +
      'After creating or changing a task, confirm it to the user in plain words (when it runs and what it does), not as a cron expression.',
    parameters: {
      action: {
        type: 'string', required: true,
        description: 'create, list, update, pause, resume, run (run it now as a test) or delete',
        enum: ['create', 'list', 'update', 'pause', 'resume', 'run', 'delete'],
      },
      id: { type: 'string', description: 'Job id (for update, pause, resume, run, delete). Use list to find it.' },
      schedule: { type: 'string', description: 'Cron expression (create; optional for update)' },
      prompt: { type: 'string', description: 'What to do on each run, as a full instruction (create; optional for update)' },
      name: { type: 'string', description: 'Short label the user will recognise, e.g. "Morning news summary"' },
      deliver: {
        type: 'string',
        description: 'Where each result is sent: "here" (this same chat, the default when the request came from a chat), ' +
          '"none" (only kept in the log and wherever the prompt saves it), or "<channel>:<target>".',
      },
    },
    async run(args, ctx) {
      const action = String(args.action);
      const metadata = (ctx?.metadata ?? {}) as Record<string, unknown>;
      try {
        switch (action) {
          case 'create': {
            if (!args.schedule || !args.prompt) return { error: 'create requires "schedule" and "prompt".' };
            let deliverTo = resolveDelivery(args.deliver, metadata);
            if (deliverTo === undefined && metadata.channel) deliverTo = resolveDelivery('here', metadata);
            const record = scheduler.create(String(args.schedule), String(args.prompt), undefined, {
              name: args.name ? String(args.name) : undefined,
              deliverTo: deliverTo || undefined,
            });
            return { created: view(record), timezone: tz };
          }
          case 'list':
            return { jobs: scheduler.list().map(view), timezone: tz };
          case 'update': {
            if (!args.id) return { error: 'update requires "id".' };
            const deliverTo = resolveDelivery(args.deliver, metadata);
            const record = scheduler.update(String(args.id), {
              schedule: args.schedule ? String(args.schedule) : undefined,
              prompt: args.prompt ? String(args.prompt) : undefined,
              name: args.name !== undefined ? String(args.name) : undefined,
              deliverTo,
            });
            return { updated: view(record), timezone: tz };
          }
          case 'pause':
          case 'resume': {
            if (!args.id) return { error: `${action} requires "id".` };
            return { [action === 'pause' ? 'paused' : 'resumed']: view(scheduler.update(String(args.id), { paused: action === 'pause' })) };
          }
          case 'run': {
            if (!args.id) return { error: 'run requires "id".' };
            const response = await scheduler.runNow(String(args.id));
            const job = scheduler.get(String(args.id));
            return response === null
              ? { error: `The test run failed: ${job?.lastError || 'unknown error'}` }
              : { ran: String(args.id), result: response, delivered: job?.deliverTo ? `${job.deliverTo.channel}:${job.deliverTo.target}` : 'none' };
          }
          case 'delete': {
            if (!args.id) return { error: 'delete requires "id".' };
            return scheduler.delete(String(args.id)) ? { deleted: args.id } : { error: `Job "${args.id}" not found.` };
          }
          default:
            return { error: `Unknown action "${action}". Use create, list, update, pause, resume, run or delete.` };
        }
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}
