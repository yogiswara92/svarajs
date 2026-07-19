/**
 * @module cron/tools
 * The `cronjob` tool - lets the agent create/list/delete its own scheduled tasks.
 */

import type { Tool } from '../types.js';
import type { CronScheduler } from './scheduler.js';

export function createCronTool(scheduler: CronScheduler): Tool {
  return {
    name: 'cronjob',
    description:
      'Create, list, or delete a scheduled task. Schedules use standard 5-field cron expressions ' +
      '(e.g. "0 9 * * *" = daily at 9am, "*/30 * * * *" = every 30 minutes).',
    parameters: {
      action: { type: 'string', description: 'One of: create, list, delete', required: true, enum: ['create', 'list', 'delete'] },
      schedule: { type: 'string', description: 'Cron expression (required for create)' },
      prompt: { type: 'string', description: 'Message to send the agent when this job fires (required for create)' },
      id: { type: 'string', description: 'Job id (required for delete)' },
    },
    async run(args) {
      const action = String(args.action);
      try {
        switch (action) {
          case 'create': {
            if (!args.schedule || !args.prompt) {
              return { error: 'create requires "schedule" and "prompt".' };
            }
            const record = scheduler.create(String(args.schedule), String(args.prompt));
            return { created: record.id, schedule: record.expression };
          }
          case 'list':
            return { jobs: scheduler.list() };
          case 'delete': {
            if (!args.id) return { error: 'delete requires "id".' };
            const deleted = scheduler.delete(String(args.id));
            return deleted ? { deleted: args.id } : { error: `Job "${args.id}" not found.` };
          }
          default:
            return { error: `Unknown action "${action}". Use create, list, or delete.` };
        }
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}
