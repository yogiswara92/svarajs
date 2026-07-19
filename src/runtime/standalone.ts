/**
 * @module runtime/standalone
 * SvaraJS - standalone runtime ("svara start")
 *
 * Boots a full personal-assistant deployment from `svara.config.json`:
 * agent + whichever built-in tools are enabled + skills + learning memory +
 * cron + every configured messaging channel + the dashboard - as opposed to
 * library mode, where a developer wires `SvaraAgent`/`SvaraApp` by hand and
 * embeds `.handler()` in their own server.
 *
 * CLI-internal - invoked by src/cli/commands/start.ts.
 */

import { spawn } from 'child_process';
import { SvaraAgent } from '../core/agent.js';
import { SvaraApp } from '../app/index.js';
import { createTerminalTool } from '../tools/builtin/terminal.js';
import { createFilesystemTools } from '../tools/builtin/filesystem.js';
import { createSendFileTool } from '../tools/builtin/sendFile.js';
import { createWebTools } from '../tools/builtin/web.js';
import { createBrowserTools, closeBrowser } from '../tools/builtin/browser.js';
import { createDelegateTools } from '../delegation/delegate.js';
import { CronScheduler } from '../cron/scheduler.js';
import { createCronTool } from '../cron/tools.js';
import { ApprovalQueue } from '../security/approvalQueue.js';
import { loadRuntimeConfig, readRawConfig, saveRuntimeConfig, type SvaraRuntimeConfig } from './config.js';
import { mountDashboard } from '../dashboard/serve.js';
import { McpManager } from '../mcp/manager.js';
import { SVARAMIND_SERVER_ID, refreshSvaramindConfig } from '../integrations/svaramind.js';

export interface StandaloneRuntime {
  agent: SvaraAgent;
  app: SvaraApp;
  scheduler: CronScheduler;
  mcpManager: McpManager;
  config: SvaraRuntimeConfig;
  shutdown: () => Promise<void>;
  restart: () => void;
}

function toolOpts(cfg: unknown): Record<string, unknown> {
  return typeof cfg === 'object' && cfg !== null ? cfg as Record<string, unknown> : {};
}

export async function startStandaloneRuntime(
  configPath = 'svara.config.json',
  overrides: Partial<SvaraRuntimeConfig> = {}
): Promise<StandaloneRuntime> {
  const config = { ...(await loadRuntimeConfig(configPath)), ...overrides };
  const approvalQueue = new ApprovalQueue();

  const agent = new SvaraAgent({
    name: config.name,
    model: config.model,
    systemPrompt: config.systemPrompt,
    auxiliaryModel: config.auxiliaryModel,
    contextWindow: config.contextWindow,
    maxIterations: config.maxIterations,
    knowledge: config.knowledge,
    llm: config.llm ? {
      provider: config.llm.provider,
      baseURL: config.llm.baseURL,
      apiKey: config.llm.apiKey || (config.llm.apiKeyEnv ? process.env[config.llm.apiKeyEnv] : undefined),
    } : undefined,
    embeddings: config.embeddings,
    skillsDir: config.skillsDir,
    skillsGuard: config.skillsGuardAgentCreated ? {
      onDangerousContent: (skillId, findings) =>
        approvalQueue.request(`skill:${skillId}`, findings.map((f) => f.description).join('; ')),
    } : undefined,
    learningMemory: config.learningMemory,
    backgroundReview: config.backgroundReview,
  });

  if (config.tools.terminal) {
    agent.addTool(createTerminalTool({
      ...toolOpts(config.tools.terminal),
      approval: { onApprovalNeeded: (command, reason) => approvalQueue.request(command, reason) },
    }));
  }
  if (config.tools.filesystem) {
    const filesystemOpts = toolOpts(config.tools.filesystem);
    createFilesystemTools(filesystemOpts).forEach((t) => agent.addTool(t));
    // Shares filesystem's rootDir - a file written there can be attached to
    // a reply and delivered to the user, in any channel, without which it'd
    // just sit invisibly on the server's disk.
    agent.addTool(createSendFileTool({ rootDir: (filesystemOpts as { rootDir?: string }).rootDir }));
  }
  if (config.tools.web) {
    createWebTools(toolOpts(config.tools.web)).forEach((t) => agent.addTool(t));
  }
  if (config.tools.browser) {
    createBrowserTools(toolOpts(config.tools.browser)).forEach((t) => agent.addTool(t));
  }

  // Delegation is always available - the child inherits whatever tools were just wired above.
  createDelegateTools(agent).forEach((t) => agent.addTool(t));

  // Always create the scheduler, even with zero jobs configured - otherwise
  // a fresh project can never add its first cron job from the dashboard
  // (the dashboard's "New job" form only appears when a scheduler exists).
  const scheduler = new CronScheduler({
    agent,
    onResult: async (job, response) => {
      console.log(`[@yesvara/svara] cron:${job.id} -> ${response}`);
      if (!job.deliverTo) return;
      const channel = agent.getChannel(job.deliverTo.channel);
      if (!channel) {
        console.warn(`[@yesvara/svara] cron:${job.id} wants delivery via "${job.deliverTo.channel}", but that channel isn't connected.`);
        return;
      }
      try {
        await channel.send(job.deliverTo.target, response);
      } catch (err) {
        console.error(`[@yesvara/svara] cron:${job.id} delivery to ${job.deliverTo.channel} failed: ${(err as Error).message}`);
      }
    },
    onError: (job, error) => console.error(`[@yesvara/svara] cron:${job.id} failed: ${error.message}`),
  });
  agent.addTool(createCronTool(scheduler));
  for (const job of config.cron) {
    scheduler.create(job.schedule, job.prompt, job.id, { name: job.name, skills: job.skills, deliverTo: job.deliverTo });
  }

  // Connect each configured MCP server best-effort - one unreachable server
  // (a stale stdio command, a down remote endpoint) shouldn't block the rest
  // of the agent from starting, same reasoning as knowledge-base init below.
  const mcpManager = new McpManager(agent);
  for (const server of config.mcpServers) {
    try {
      let toConnect = server;
      // The access token baked into transport.headers by an OAuth flow
      // (Svaramind) is short-lived - mint a fresh one before connecting if
      // the current one is expired (or close to it). refreshSvaramindConfig
      // returns the exact same object when it skips the refresh, so this
      // only persists (and only touches the rotated refresh token at all)
      // when a refresh actually happened - restarting twice in a row no
      // longer burns through refresh tokens for no reason.
      if (server.id === SVARAMIND_SERVER_ID && server.oauth) {
        toConnect = await refreshSvaramindConfig(server);
        // The refresh token just got rotated server-side (the old one is now
        // revoked) - persist the new pair immediately, or the *next* restart
        // would try to refresh with an already-used token and fail outright.
        if (toConnect !== server && configPath) {
          const current = await readRawConfig(configPath);
          const servers = Array.isArray(current.mcpServers)
            ? (current.mcpServers as Array<{ id?: string }>).filter((s) => s.id !== SVARAMIND_SERVER_ID)
            : [];
          servers.push(toConnect);
          await saveRuntimeConfig(configPath, { ...current, mcpServers: servers });
        }
      }
      await mcpManager.connect(toConnect);
    } catch (err) {
      console.warn(`[@yesvara/svara] MCP server "${server.name}" failed to connect: ${(err as Error).message}`);
    }
  }

  const app = new SvaraApp({ cors: true });

  // Scoped to just this route, not SvaraApp's global apiKey option - that
  // would also lock out /health and clash with the dashboard's own,
  // separate bearer-token check on /api/* mounted on this same Express app
  // below.
  if (config.apiKey) {
    const expressApp = app.getExpressApp();
    expressApp.post('/chat', (req, res, next) => {
      const provided = req.headers.authorization?.replace('Bearer ', '');
      if (provided !== config.apiKey) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }
  app.route('/chat', agent.handler());

  // WhatsApp/Slack mount their webhook routes onto a 'web' channel's Express
  // app rather than opening their own server - point them at the SvaraApp
  // instance that's about to `listen()` below.
  agent.attachWebApp(app.getExpressApp());

  if (config.channels.telegram) {
    agent.connectChannel('telegram', {
      token: config.channels.telegram.token ?? process.env.TELEGRAM_BOT_TOKEN,
      allowedUserIds: config.channels.telegram.allowedUserIds,
    });
  }
  if (config.channels.whatsapp) {
    agent.connectChannel('whatsapp', {
      token: config.channels.whatsapp.token ?? process.env.WA_ACCESS_TOKEN,
      phoneId: config.channels.whatsapp.phoneId ?? process.env.WA_PHONE_ID,
      verifyToken: config.channels.whatsapp.verifyToken ?? process.env.WA_VERIFY_TOKEN,
    });
  }
  if (config.channels.slack) {
    agent.connectChannel('slack', {
      botToken: config.channels.slack.botToken ?? process.env.SLACK_BOT_TOKEN,
      signingSecret: config.channels.slack.signingSecret ?? process.env.SLACK_SIGNING_SECRET,
    });
  }
  if (config.channels.discord) {
    agent.connectChannel('discord', {
      botToken: config.channels.discord.botToken ?? process.env.DISCORD_BOT_TOKEN,
    });
  }

  const shutdown = async (): Promise<void> => {
    scheduler?.stopAll();
    await mcpManager.disconnectAll();
    await closeBrowser();
    await agent.stop();
    await app.stop();
  };

  // Respawns the exact same process invocation, then exits - used by the
  // dashboard's "Restart runtime" button after a settings change. Shuts
  // down first (releasing the port) before spawning the replacement, so the
  // new process doesn't race the old one for the port; `detached` + `unref`
  // let the child outlive this process regardless of how it exits.
  const restart = (): void => {
    console.log('[@yesvara/svara] Restarting...');
    void shutdown().then(() => {
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true,
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();
      process.exit(0);
    });
  };

  if (config.dashboard) {
    const dashboardOpts = typeof config.dashboard === 'object' ? config.dashboard : {};
    mountDashboard(app, {
      agent,
      scheduler,
      approvalQueue,
      mcpManager,
      restart,
      token: dashboardOpts.token,
      configPath,
    });
  }

  await agent.start();
  await app.listen(config.port);

  console.log(`[@yesvara/svara] ${config.name} is running as a standalone assistant.`);
  if (config.dashboard) {
    console.log(`[@yesvara/svara] Dashboard: http://localhost:${config.port}/dashboard`);
  }

  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });

  return { agent, app, scheduler, mcpManager, config, shutdown, restart };
}
