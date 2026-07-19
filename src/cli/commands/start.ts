/**
 * @module cli/commands/start
 * SvaraJS - `svara start` command
 *
 * Boots the standalone runtime (agent + configured tools/channels/cron +
 * dashboard) from a `svara.config.json` file. See src/runtime/standalone.ts.
 */

import 'dotenv/config';

export async function startCommand(opts: { config: string; port?: number }): Promise<void> {
  const { startStandaloneRuntime } = await import('../../runtime/standalone.js');

  try {
    await startStandaloneRuntime(opts.config, opts.port ? { port: opts.port } : {});
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
