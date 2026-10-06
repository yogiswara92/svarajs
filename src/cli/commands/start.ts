/**
 * @module cli/commands/start
 * SvaraJS - `svara start` command
 *
 * Boots the standalone runtime (agent + configured tools/channels/cron +
 * dashboard) from a `svara.config.json` file. See src/runtime/standalone.ts.
 */

import 'dotenv/config';

export async function startCommand(opts: { config: string; port?: number }): Promise<void> {
  // Too-old system Node but the dashboard installed a private Node 20 for this agent: hand over to it.
  const { shouldReexec, runUnder } = await import('../../runtime/nodeRuntime.js');
  const { default: nodePath } = await import('path');
  const candidate = shouldReexec({ configDir: nodePath.dirname(nodePath.resolve(opts.config)) });
  if (candidate) {
    const { privateNodeWorks } = await import('../../runtime/nodeRuntime.js');
    if (await privateNodeWorks(candidate)) {
      console.log(`[@yesvara/svara] Node.js ${process.versions.node} is too old for some features - running on this agent's own Node.js (${candidate}).`);
      process.exit(await runUnder(candidate));
    }
    // Never trade a working agent for a crash: a Node whose native modules do not match would segfault on start.
    console.warn(`[@yesvara/svara] The agent's own Node.js (${candidate}) cannot run the installed native modules, so it was NOT used. Staying on Node.js ${process.versions.node}. Reinstall it from Settings > Capabilities.`);
  }

  const { startStandaloneRuntime } = await import('../../runtime/standalone.js');

  try {
    await startStandaloneRuntime(opts.config, opts.port ? { port: opts.port } : {});
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
