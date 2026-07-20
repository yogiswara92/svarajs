/**
 * @module dashboard/serve
 * SvaraJS - mounts the bundled dashboard SPA + its config API onto a SvaraApp.
 *
 * CLI-internal: only reached via `svara start` (src/runtime/standalone.ts).
 * Not part of the public package API - the dashboard build (`dashboard/dist/`)
 * is a sibling of `dist/` in the published package, resolved relative to this
 * file's own location at runtime.
 *
 * Static assets are served without auth (just JS/HTML/CSS). The `/api/*`
 * routes are bearer-token protected when a token is configured - the SPA
 * asks for it once and keeps it in localStorage.
 *
 * Every async handler goes through `asyncRoute()` - Express 4 does not
 * auto-catch a rejected promise from an async handler, so an unhandled
 * throw (e.g. LearningMemory.setRaw rejecting dangerous content) would
 * otherwise crash the whole process instead of just failing the request.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SvaraApp } from '../app/index.js';
import type { SvaraAgent } from '../core/agent.js';
import type { ChannelName } from '../core/types.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { ApprovalQueue } from '../security/approvalQueue.js';
import type { SkillFrontmatter } from '../skills/types.js';
import { readRawConfig, saveRuntimeConfig } from '../runtime/config.js';
import { mapSecretFields } from '../security/secretFields.js';
import { validateWithinDir } from '../security/pathGuard.js';
import { isPlaywrightInstalled } from '../tools/lazyDeps.js';
import { getRegisteredFile } from '../tools/builtin/sendFile.js';
import type { McpManager } from '../mcp/manager.js';
import { searchMcpRegistry, resolveRegistryServer } from '../mcp/registry.js';
import type { McpServerConfig } from '../mcp/types.js';
import {
  SVARAMIND_SERVER_ID, SVARAMIND_APP_URL,
  registerOAuthClient, generatePkce, generateState, buildAuthorizeUrl, exchangeCodeForTokens,
  buildSvaramindConfig, listSvaramindWorkspaces, setSvaramindWorkspace,
} from '../integrations/svaramind.js';

const KNOWLEDGE_UPLOAD_EXTENSIONS = new Set(['.txt', '.md', '.mdx', '.rst', '.csv', '.log', '.jsonl', '.pdf', '.docx']);

// ── Svaramind OAuth flow state ────────────────────────────────────────────
// The redirect from Svaramind's hosted login page lands on an unauthenticated
// route (a top-level browser navigation can't carry the dashboard's bearer
// token), so the in-flight PKCE verifier/client id have to live somewhere
// keyed by `state` rather than in the (authenticated) request that started
// the flow. In-memory + a short TTL is enough - this is a single-process
// runtime and the flow only needs to survive a few minutes of user login time.

interface PendingSvaramindFlow {
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
}
const pendingSvaramindFlows = new Map<string, PendingSvaramindFlow>();
const SVARAMIND_FLOW_TTL_MS = 10 * 60 * 1000;

function cleanupExpiredSvaramindFlows(): void {
  const cutoff = Date.now() - SVARAMIND_FLOW_TTL_MS;
  for (const [state, flow] of pendingSvaramindFlows) {
    if (flow.createdAt < cutoff) pendingSvaramindFlows.delete(state);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function svaramindResultPage(opts: { ok: boolean; message: string }): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Svaramind</title>
<meta http-equiv="refresh" content="${opts.ok ? '2' : '0'}; url=/dashboard/#/mcp">
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;}
.card{max-width:360px;padding:24px;}h1{font-size:16px;}p{color:#9aa1ac;font-size:14px;}</style>
</head><body><div class="card"><h1>${opts.ok ? 'Connected to Svaramind' : 'Could not connect'}</h1><p>${escapeHtml(opts.message)}</p></div></body></html>`;
}

export interface DashboardOptions {
  agent: SvaraAgent;
  scheduler?: CronScheduler | null;
  approvalQueue?: ApprovalQueue | null;
  mcpManager?: McpManager | null;
  /** Respawns the runtime process and exits this one - powers the dashboard's "Restart runtime" button. Not available in library mode. */
  restart?: () => void;
  token?: string;
  /** Path to svara.config.json - lets the Settings page read/write it directly. */
  configPath?: string;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function mountDashboard(app: SvaraApp, opts: DashboardOptions): void {
  const expressApp = app.getExpressApp();
  // dist/dashboard/serve.js (this file, compiled) -> ../../dashboard/dist (package root/dashboard/dist)
  const dashboardDist = path.resolve(__dirname, '../../dashboard/dist');
  // Where uploaded knowledge documents get written - next to the config file
  // (or cwd if running without one) so they're easy to find and back up.
  const knowledgeDir = path.resolve(opts.configPath ? path.dirname(opts.configPath) : process.cwd(), 'knowledge-uploads');
  // opts.configPath defaults to the relative 'svara.config.json' (see
  // runtime/standalone.ts) - path.dirname() on that yields '.', not an
  // absolute directory, so anything that needs a real parent directory (the
  // Agents page's sibling-folder logic) must resolve it against cwd first,
  // same as knowledgeDir above already (correctly) does via path.resolve().
  const configDir = opts.configPath ? path.resolve(path.dirname(opts.configPath)) : undefined;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      cb(null, KNOWLEDGE_UPLOAD_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()));
    },
  });

  if (fs.existsSync(path.join(dashboardDist, 'index.html'))) {
    expressApp.use('/dashboard', express.static(dashboardDist));
    expressApp.get('/dashboard/*', (_req, res) => res.sendFile(path.join(dashboardDist, 'index.html')));
  } else {
    expressApp.get('/dashboard', (_req, res) => {
      res.status(503).type('text/plain').send(
        'Dashboard not built. Run: npm run build:dashboard (inside the SvaraJS package).'
      );
    });
  }

  // Svaramind's hosted login page redirects the user's browser straight
  // here after sign-in - a top-level navigation, so it can't carry the
  // dashboard's bearer token. Deliberately outside the `api` router below.
  expressApp.get('/svaramind/oauth/callback', asyncRoute(async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      res.status(400).send(svaramindResultPage({ ok: false, message: String(oauthError) }));
      return;
    }
    const flow = typeof state === 'string' ? pendingSvaramindFlows.get(state) : undefined;
    if (!flow) {
      res.status(400).send(svaramindResultPage({
        ok: false,
        message: 'This sign-in link expired or was already used - go back to the dashboard and try connecting again.',
      }));
      return;
    }
    pendingSvaramindFlows.delete(state as string);

    if (!opts.mcpManager) {
      res.status(400).send(svaramindResultPage({ ok: false, message: 'MCP is not enabled on this runtime.' }));
      return;
    }
    if (typeof code !== 'string') {
      res.status(400).send(svaramindResultPage({ ok: false, message: 'Svaramind did not return an authorization code.' }));
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens({ code, redirectUri: flow.redirectUri, codeVerifier: flow.codeVerifier, clientId: flow.clientId });
      const config = buildSvaramindConfig(tokens, flow.clientId);
      if (opts.mcpManager.isConnected(SVARAMIND_SERVER_ID)) await opts.mcpManager.disconnect(SVARAMIND_SERVER_ID);
      await opts.mcpManager.connect(config);
      if (opts.configPath) {
        const current = await readRawConfig(opts.configPath);
        const servers = Array.isArray(current.mcpServers)
          ? (current.mcpServers as Array<{ id?: string }>).filter((s) => s.id !== SVARAMIND_SERVER_ID)
          : [];
        servers.push(config);
        await saveRuntimeConfig(opts.configPath, { ...current, mcpServers: servers });
      }
      res.send(svaramindResultPage({ ok: true, message: 'Redirecting you back to the dashboard...' }));
    } catch (err) {
      res.status(502).send(svaramindResultPage({ ok: false, message: (err as Error).message }));
    }
  }));

  // A file the agent attached via send_file (docx/xlsx/pptx skills, etc.) -
  // deliberately outside the bearer-protected `api` router below, the same
  // way the Svaramind callback is: a plain `<a href>` download link in the
  // chat can't carry an Authorization header. The random UUID token is the
  // security boundary here (unguessable capability URL), not the dashboard
  // bearer token.
  expressApp.get('/api/files/:token', (req, res) => {
    const file = getRegisteredFile(req.params.token);
    if (!file) {
      res.status(404).json({ error: 'File not found or expired.' });
      return;
    }
    res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.sendFile(file.absolutePath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'File not found or expired.' });
    });
  });

  const api = express.Router();

  if (opts.token) {
    api.use((req, res, next) => {
      const provided = req.headers.authorization?.replace('Bearer ', '');
      if (provided !== opts.token) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  api.get('/status', (_req, res) => {
    res.json({
      name: opts.agent.name,
      uptimeSeconds: Math.floor(process.uptime()),
      channels: opts.agent.getChannelNames(),
    });
  });

  api.get('/config', asyncRoute(async (_req, res) => {
    if (!opts.configPath) { res.json({}); return; }
    const raw = await readRawConfig(opts.configPath);
    res.json(redactSecrets(raw));
  }));

  // ── Chat (dashboard's own chat page - kept behind the same bearer auth as
  // the rest of /api/*, unlike the top-level POST /chat the runtime mounts
  // for external API consumers) ─────────────────────────────────────────

  api.post('/chat', express.json(), asyncRoute(async (req, res) => {
    const { message, sessionId } = req.body ?? {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required.' });
      return;
    }
    try {
      const result = await opts.agent.process(message, {
        sessionId: typeof sessionId === 'string' && sessionId ? sessionId : undefined,
        userId: 'dashboard',
      });
      res.json({
        response: result.response,
        sessionId: result.sessionId,
        toolsUsed: result.toolsUsed,
        retrievedDocuments: result.retrievedDocuments ?? [],
        attachments: result.attachments ?? [],
        iterations: result.iterations,
        usage: result.usage,
        duration: result.duration,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  // Same as POST /chat above, but streams each tool call as it happens
  // instead of only returning once the whole agentic loop is done - the
  // dashboard's Chat page uses this so "Process steps" fills in live rather
  // than appearing all at once after a 20-30s wait. NDJSON (one JSON object
  // per line) rather than text/event-stream, since EventSource can't send
  // a POST body - a plain chunked response is simpler for a fetch() reader.
  api.post('/chat/stream', express.json(), asyncRoute(async (req, res) => {
    const { message, sessionId: reqSessionId } = req.body ?? {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required.' });
      return;
    }

    // Resolved here (not left to agent.process()'s own default) so it's
    // known upfront to filter this request's own tool:call events out of
    // every other concurrent session sharing this same agent instance.
    const sessionId = typeof reqSessionId === 'string' && reqSessionId ? reqSessionId : crypto.randomUUID();

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx response buffering, if proxied
    res.flushHeaders();

    const onToolCall = (evt: { sessionId: string; tools: string[] }) => {
      if (evt.sessionId !== sessionId) return;
      res.write(`${JSON.stringify({ type: 'tool_call', tools: evt.tools })}\n`);
    };
    opts.agent.on('tool:call', onToolCall);

    try {
      const result = await opts.agent.process(message, { sessionId, userId: 'dashboard' });
      res.write(`${JSON.stringify({
        type: 'done',
        response: result.response,
        sessionId: result.sessionId,
        toolsUsed: result.toolsUsed,
        retrievedDocuments: result.retrievedDocuments ?? [],
        attachments: result.attachments ?? [],
        iterations: result.iterations,
        usage: result.usage,
        duration: result.duration,
      })}\n`);
    } catch (err) {
      res.write(`${JSON.stringify({ type: 'error', error: (err as Error).message })}\n`);
    } finally {
      opts.agent.off('tool:call', onToolCall);
      res.end();
    }
  }));

  api.get('/chat/sessions', (_req, res) => {
    res.json({ sessions: opts.agent.listSessions(50) });
  });

  api.get('/chat/sessions/:id/messages', (req, res) => {
    res.json({ messages: opts.agent.getSessionMessages(req.params.id) });
  });

  api.delete('/chat/sessions/:id', asyncRoute(async (req, res) => {
    await opts.agent.clearHistory(req.params.id);
    res.json({ deleted: req.params.id });
  }));

  api.put('/config', express.json(), asyncRoute(async (req, res) => {
    if (!opts.configPath) { res.status(400).json({ error: 'No config file available on this runtime.' }); return; }
    try {
      const current = await readRawConfig(opts.configPath);
      const merged = mergeConfigUpdates(current, req.body ?? {});
      await saveRuntimeConfig(opts.configPath, merged);
      res.json({ saved: true, restartRequired: true, config: redactSecrets(merged) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  api.post('/restart', (_req, res) => {
    if (!opts.restart) { res.status(400).json({ error: 'Restart is not available on this runtime.' }); return; }
    res.json({ restarting: true });
    // Only trigger the actual respawn-and-exit once this response has been
    // flushed to the client - restart() closes the very server sending it.
    res.once('finish', () => opts.restart!());
  });

  // ── Sibling agents (Agents page) ───────────────────────────────────────
  // Only meaningful for a real `svara start` invocation - there's no
  // "sibling folder" concept without a config file's directory to anchor to.

  let agentCreateInProgress = false;

  api.get('/agents', asyncRoute(async (_req, res) => {
    if (!configDir) { res.json({ agents: [] }); return; }
    const { listSiblingAgents } = await import('./agents.js');
    res.json({ agents: await listSiblingAgents(configDir) });
  }));

  api.post('/agents', express.json(), asyncRoute(async (req, res) => {
    if (!configDir) { res.status(400).json({ error: 'Not available on this runtime.' }); return; }
    if (agentCreateInProgress) { res.status(409).json({ error: 'Another agent is already being created - wait for it to finish.' }); return; }

    const { name, model, provider } = req.body ?? {};
    if (typeof name !== 'string' || !name) { res.status(400).json({ error: 'name is required.' }); return; }
    const ALLOWED_PROVIDERS = ['openai', 'anthropic', 'ollama'] as const;
    if (provider !== undefined && !ALLOWED_PROVIDERS.includes(provider)) {
      res.status(400).json({ error: `provider must be one of: ${ALLOWED_PROVIDERS.join(', ')}` });
      return;
    }

    agentCreateInProgress = true;
    try {
      const { createSiblingAgent } = await import('./agents.js');
      const result = await createSiblingAgent(configDir, {
        name,
        model: typeof model === 'string' && model ? model : undefined,
        provider,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    } finally {
      agentCreateInProgress = false;
    }
  }));

  api.get('/tools', (_req, res) => {
    res.json({ tools: opts.agent.getTools().map((t) => ({ name: t.name, description: t.description })) });
  });

  // ── Browser tool (playwright) ──────────────────────────────────────────
  // Enabling "Browser" in Capabilities just flips a config flag - the agent
  // registers the tool either way and only discovers `playwright` is missing
  // when it actually tries to use it, mid-conversation. These let the
  // dashboard catch that upfront instead.

  let playwrightInstallInProgress = false;
  const execFileAsync = promisify(execFile);

  api.get('/tools/browser/status', asyncRoute(async (_req, res) => {
    res.json({ installed: await isPlaywrightInstalled(), installing: playwrightInstallInProgress });
  }));

  api.post('/tools/browser/install', asyncRoute(async (_req, res) => {
    if (playwrightInstallInProgress) { res.status(409).json({ error: 'An install is already in progress.' }); return; }
    const cwd = opts.configPath ? path.dirname(opts.configPath) : process.cwd();

    playwrightInstallInProgress = true;
    try {
      await execFileAsync('npm', ['install', 'playwright'], { cwd, timeout: 5 * 60 * 1000 });
      await execFileAsync('npx', ['playwright', 'install', 'chromium'], { cwd, timeout: 5 * 60 * 1000 });
      res.json({ installed: await isPlaywrightInstalled() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    } finally {
      playwrightInstallInProgress = false;
    }
  }));

  // ── Skills ──────────────────────────────────────────────────────────────

  api.get('/skills', asyncRoute(async (_req, res) => {
    const registry = opts.agent.getSkillRegistry();
    if (!registry) { res.json({ enabled: false, skills: [] }); return; }
    res.json({ enabled: true, skills: await registry.list() });
  }));

  api.get('/skills/:id', asyncRoute(async (req, res) => {
    const registry = opts.agent.getSkillRegistry();
    const skill = await registry?.get(req.params.id);
    if (!skill) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(skill);
  }));

  api.post('/skills', express.json(), asyncRoute(async (req, res) => {
    const registry = opts.agent.getSkillRegistry();
    if (!registry) { res.status(400).json({ error: 'Skills are not enabled on this agent.' }); return; }
    try {
      const { id, body, ...rest } = req.body ?? {};
      await registry.create(id, frontmatterFromRequest(rest) as SkillFrontmatter, body ?? '');
      res.status(201).json({ created: id });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  api.put('/skills/:id', express.json(), asyncRoute(async (req, res) => {
    const registry = opts.agent.getSkillRegistry();
    if (!registry) { res.status(400).json({ error: 'Skills are not enabled on this agent.' }); return; }
    try {
      const { body, ...rest } = req.body ?? {};
      await registry.edit(req.params.id, { frontmatter: frontmatterFromRequest(rest), body });
      res.json({ edited: req.params.id });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  api.delete('/skills/:id', asyncRoute(async (req, res) => {
    const registry = opts.agent.getSkillRegistry();
    if (!registry) { res.status(400).json({ error: 'Skills are not enabled on this agent.' }); return; }
    try {
      await registry.delete(req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  // ── Skill resource files (references/templates/scripts/assets) ──────────

  api.get('/skills/:id/resources/:dir/:filename', asyncRoute(async (req, res) => {
    const registry = opts.agent.getSkillRegistry();
    if (!registry) { res.status(400).json({ error: 'Skills are not enabled on this agent.' }); return; }
    try {
      const content = await registry.readResourceFile(req.params.id, req.params.dir as never, req.params.filename);
      res.json({ content });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  api.put('/skills/:id/resources/:dir/:filename', express.json(), asyncRoute(async (req, res) => {
    const registry = opts.agent.getSkillRegistry();
    if (!registry) { res.status(400).json({ error: 'Skills are not enabled on this agent.' }); return; }
    try {
      await registry.writeResourceFile(req.params.id, req.params.dir as never, req.params.filename, String(req.body?.content ?? ''));
      res.json({ written: req.params.filename });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  api.delete('/skills/:id/resources/:dir/:filename', asyncRoute(async (req, res) => {
    const registry = opts.agent.getSkillRegistry();
    if (!registry) { res.status(400).json({ error: 'Skills are not enabled on this agent.' }); return; }
    try {
      await registry.removeResourceFile(req.params.id, req.params.dir as never, req.params.filename);
      res.json({ removed: req.params.filename });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  // ── Memory (MEMORY.md / USER.md) ───────────────────────────────────────

  api.get('/memory', asyncRoute(async (_req, res) => {
    const memory = opts.agent.getLearningMemory();
    if (!memory) { res.json({ enabled: false }); return; }
    res.json({ enabled: true, ...(await memory.load()) });
  }));

  api.put('/memory/:file', express.json(), asyncRoute(async (req, res) => {
    const memory = opts.agent.getLearningMemory();
    if (!memory) { res.status(400).json({ error: 'Learning memory is not enabled on this agent.' }); return; }
    const file = req.params.file === 'user' ? 'USER.md' : req.params.file === 'agent' ? 'MEMORY.md' : null;
    if (!file) { res.status(400).json({ error: 'file must be "agent" or "user".' }); return; }
    try {
      await memory.setRaw(file, String(req.body?.content ?? ''));
      res.json({ saved: file });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  // ── Cron ────────────────────────────────────────────────────────────────
  // Jobs live in two places that have to stay in sync: opts.scheduler (the
  // in-process node-cron tasks actually running) and svara.config.json's
  // "cron" array (so jobs survive a restart). The scheduler is the source of
  // truth for what's running right now; every create/delete also patches the
  // config file, best-effort, when opts.configPath is available.

  api.get('/cron', (_req, res) => {
    res.json({ enabled: !!opts.scheduler, jobs: opts.scheduler?.list() ?? [] });
  });

  api.post('/cron', express.json(), asyncRoute(async (req, res) => {
    if (!opts.scheduler) { res.status(400).json({ error: 'Cron is not enabled on this runtime.' }); return; }
    try {
      const { schedule, prompt, id, name, skills, deliverTo } = req.body ?? {};
      const validDeliverTo = deliverTo && typeof deliverTo === 'object' && deliverTo.channel && deliverTo.target
        ? { channel: String(deliverTo.channel) as ChannelName, target: String(deliverTo.target) }
        : undefined;
      const extra = {
        name: name ? String(name) : undefined,
        skills: Array.isArray(skills) ? skills.map(String) : undefined,
        deliverTo: validDeliverTo,
      };
      const record = opts.scheduler.create(String(schedule), String(prompt), id ? String(id) : undefined, extra);
      if (opts.configPath) {
        const current = await readRawConfig(opts.configPath);
        const cronList = Array.isArray(current.cron) ? [...current.cron as unknown[]] : [];
        cronList.push({ id: record.id, schedule: record.expression, prompt: record.prompt, name: record.name, skills: record.skills, deliverTo: record.deliverTo });
        await saveRuntimeConfig(opts.configPath, { ...current, cron: cronList });
      }
      res.status(201).json(record);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  api.delete('/cron/:id', asyncRoute(async (req, res) => {
    if (!opts.scheduler) { res.status(400).json({ error: 'Cron is not enabled on this runtime.' }); return; }
    const deleted = opts.scheduler.delete(req.params.id);
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return; }
    if (opts.configPath) {
      const current = await readRawConfig(opts.configPath);
      const cronList = Array.isArray(current.cron)
        ? (current.cron as Array<{ id?: string }>).filter((j) => j.id !== req.params.id)
        : [];
      await saveRuntimeConfig(opts.configPath, { ...current, cron: cronList });
    }
    res.json({ deleted: req.params.id });
  }));

  // ── Pending approvals (dangerous terminal_exec commands) ──────────────────

  api.get('/approvals', (_req, res) => {
    res.json({ enabled: !!opts.approvalQueue, pending: opts.approvalQueue?.list() ?? [] });
  });

  api.post('/approvals/:id/respond', express.json(), (req, res) => {
    if (!opts.approvalQueue) { res.status(400).json({ error: 'No approval queue on this runtime.' }); return; }
    const approved = Boolean(req.body?.approved);
    const ok = opts.approvalQueue.respond(req.params.id, approved);
    if (!ok) { res.status(404).json({ error: 'Not found (already resolved or unknown id).' }); return; }
    res.json({ id: req.params.id, approved });
  });

  // ── Knowledge (RAG documents) ──────────────────────────────────────────

  api.get('/knowledge', asyncRoute(async (_req, res) => {
    res.json({ documents: await opts.agent.listKnowledgeDocuments() });
  }));

  api.post('/knowledge', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded, or its extension is not supported (.txt .md .mdx .rst .csv .log .jsonl .pdf .docx).' });
      return;
    }
    await fs.promises.mkdir(knowledgeDir, { recursive: true });
    // Strip any directory components multer left in - only the basename is trusted.
    const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const targetPath = validateWithinDir(safeName, knowledgeDir);
    await fs.promises.writeFile(targetPath, req.file.buffer);

    const before = await opts.agent.listKnowledgeDocuments();
    await opts.agent.addKnowledge(targetPath);
    const documents = await opts.agent.listKnowledgeDocuments();

    // addKnowledge() logs and swallows embedding-provider failures internally
    // (so a broken "knowledge" config at boot doesn't crash the whole agent) -
    // which means a failed embed call looks identical to success from here.
    // Detect it by checking whether anything actually got indexed, and surface
    // a real error instead of a false-positive 201.
    if (documents.length === before.length) {
      await fs.promises.unlink(targetPath).catch(() => {});
      res.status(502).json({
        error: 'Upload saved, but indexing failed (no chunks were added) - check the server log. ' +
          'This usually means the embeddings provider isn\'t configured - go to Settings > AI Provider > ' +
          'Embeddings and set a real API key (OpenAI) or switch to Ollama (needs no key).',
      });
      return;
    }

    res.status(201).json({ documents });
  }));

  api.delete('/knowledge/:documentId', asyncRoute(async (req, res) => {
    const documents = await opts.agent.listKnowledgeDocuments();
    const doc = documents.find((d) => d.documentId === req.params.documentId);
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    await opts.agent.removeKnowledgeDocument(req.params.documentId);
    // Only ever delete the physical file if it's one we manage ourselves
    // (inside knowledgeDir) - never touch a path from an external knowledge folder.
    try {
      const resolved = path.resolve(doc.source);
      if (resolved.startsWith(`${path.resolve(knowledgeDir)}${path.sep}`)) {
        await fs.promises.unlink(resolved);
      }
    } catch {
      // Best-effort - the chunks are already removed either way.
    }
    res.json({ deleted: req.params.documentId });
  }));

  // ── MCP (Model Context Protocol servers) ───────────────────────────────

  api.get('/mcp/registry', asyncRoute(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    try {
      res.json({ results: await searchMcpRegistry(search) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  api.get('/mcp/servers', (_req, res) => {
    res.json({ enabled: !!opts.mcpManager, servers: opts.mcpManager?.list() ?? [] });
  });

  api.post('/mcp/servers', express.json(), asyncRoute(async (req, res) => {
    if (!opts.mcpManager) { res.status(400).json({ error: 'MCP is not enabled on this runtime.' }); return; }

    let config: McpServerConfig;
    try {
      const body = req.body ?? {};
      if (body.source === 'registry') {
        const resolved = await resolveRegistryServer(String(body.registryName));
        // Some registry entries need a secret (an API key env var for a
        // stdio package, an auth header for a remote) to actually work -
        // the marketplace UI collects those and passes them here rather
        // than the registry resolving them (the registry never has them).
        const transport = resolved.transport.type === 'stdio'
          ? { ...resolved.transport, env: { ...resolved.transport.env, ...(body.secrets as Record<string, string> | undefined) } }
          : { ...resolved.transport, headers: { ...resolved.transport.headers, ...(body.secrets as Record<string, string> | undefined) } };
        config = {
          id: String(body.id || body.registryName).replace(/[^a-zA-Z0-9_-]/g, '_'),
          name: String(body.name || resolved.name),
          transport,
        };
      } else {
        if (!body.id || !body.name || !body.transport) {
          res.status(400).json({ error: 'id, name, and transport are required for a manual MCP server.' });
          return;
        }
        config = { id: String(body.id), name: String(body.name), transport: body.transport };
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    try {
      const status = await opts.mcpManager.connect(config);
      if (opts.configPath) {
        const current = await readRawConfig(opts.configPath);
        const servers = Array.isArray(current.mcpServers) ? [...current.mcpServers as unknown[]] : [];
        servers.push(config);
        await saveRuntimeConfig(opts.configPath, { ...current, mcpServers: servers });
      }
      res.status(201).json(status);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  api.delete('/mcp/servers/:id', asyncRoute(async (req, res) => {
    if (!opts.mcpManager) { res.status(400).json({ error: 'MCP is not enabled on this runtime.' }); return; }
    const deleted = await opts.mcpManager.disconnect(req.params.id);
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return; }
    if (opts.configPath) {
      const current = await readRawConfig(opts.configPath);
      const servers = Array.isArray(current.mcpServers)
        ? (current.mcpServers as Array<{ id?: string }>).filter((s) => s.id !== req.params.id)
        : [];
      await saveRuntimeConfig(opts.configPath, { ...current, mcpServers: servers });
    }
    res.json({ deleted: req.params.id });
  }));

  // ── Svaramind (guided connect on top of the generic MCP client above) ────
  // A dedicated flow instead of "Add manually": knows Svaramind's MCP URL,
  // and after connecting lets the user pick a workspace once (pinned via
  // McpManager.pinParameter()) instead of the agent guessing/asking every call.

  // Starts the OAuth dance: register a fresh client, generate PKCE + state,
  // stash them (keyed by state) for the unauthenticated callback above to
  // pick up, and hand the frontend a URL to open - Svaramind's own hosted
  // login page, never anything SvaraJS renders itself.
  api.post('/svaramind/oauth/start', asyncRoute(async (req, res) => {
    if (!opts.mcpManager) { res.status(400).json({ error: 'MCP is not enabled on this runtime.' }); return; }
    try {
      cleanupExpiredSvaramindFlows();
      const redirectUri = `${req.protocol}://${req.get('host')}/svaramind/oauth/callback`;
      const clientId = await registerOAuthClient(redirectUri);
      const { verifier, challenge } = generatePkce();
      const state = generateState();
      pendingSvaramindFlows.set(state, { codeVerifier: verifier, clientId, redirectUri, createdAt: Date.now() });
      res.json({ authorizeUrl: buildAuthorizeUrl({ clientId, redirectUri, codeChallenge: challenge, state }) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  api.get('/svaramind/workspaces', asyncRoute(async (_req, res) => {
    if (!opts.mcpManager?.isConnected(SVARAMIND_SERVER_ID)) { res.status(400).json({ error: 'Svaramind is not connected.' }); return; }
    try {
      const workspaces = await listSvaramindWorkspaces(opts.mcpManager);
      res.json({ workspaces, appUrl: SVARAMIND_APP_URL });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  api.post('/svaramind/workspace', express.json(), asyncRoute(async (req, res) => {
    if (!opts.mcpManager?.isConnected(SVARAMIND_SERVER_ID)) { res.status(400).json({ error: 'Svaramind is not connected.' }); return; }
    const { workspaceId } = req.body ?? {};
    if (!workspaceId || typeof workspaceId !== 'string') { res.status(400).json({ error: 'workspaceId is required.' }); return; }
    try {
      const status = setSvaramindWorkspace(opts.mcpManager, workspaceId);
      if (opts.configPath) {
        const current = await readRawConfig(opts.configPath);
        const servers = Array.isArray(current.mcpServers) ? [...current.mcpServers as Array<Record<string, unknown>>] : [];
        const idx = servers.findIndex((s) => s.id === SVARAMIND_SERVER_ID);
        if (idx >= 0) servers[idx] = { ...servers[idx], pinnedParams: { workspace_id: workspaceId } };
        await saveRuntimeConfig(opts.configPath, { ...current, mcpServers: servers });
      }
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  // Safety net: any handler above that still throws (or a bug in a future one) ends up
  // here instead of crashing the process - see the asyncRoute note at the top of this file.
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal Server Error' });
  });

  expressApp.use('/api', api);
}

/** Never send a real secret value to the dashboard - see security/secretFields.ts for the field list. */
export function redactSecrets(value: unknown): unknown {
  return mapSecretFields(value, () => '[set]');
}

/**
 * Merges a Settings-form submission onto the existing raw config. Tool
 * toggles are booleans from the form - if a tool was already configured as
 * a richer object (e.g. `{ rootDir: "..." }`), re-enabling it with `true`
 * preserves that object instead of downgrading it to a bare boolean.
 */
/**
 * Merges `updates` onto `current` field-by-field, treating an incoming
 * '[set]' as "keep the existing value" rather than overwriting it with the
 * literal placeholder - '[set]' is what GET /api/config sends back in place
 * of a real secret (see redactSecrets), so an untouched secret field
 * round-trips as that string on save unless we special-case it here.
 */
function mergeFieldsPreservingSetPlaceholder(current: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(updates)) {
    merged[field] = value === '[set]' ? current[field] : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeConfigUpdates(current: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...updates };

  if (updates.tools && typeof updates.tools === 'object') {
    const currentTools = (current.tools as Record<string, unknown>) ?? {};
    const updateTools = updates.tools as Record<string, unknown>;
    const mergedTools: Record<string, unknown> = { ...currentTools };
    for (const key of ['terminal', 'filesystem', 'web', 'browser']) {
      if (!(key in updateTools)) continue;
      const newVal = updateTools[key];
      const oldVal = currentTools[key];
      if (newVal === true && oldVal && typeof oldVal === 'object') {
        // Re-toggling on with a bare `true` (the Capabilities page's simple
        // switch) - keep the richer object (e.g. web's searchApiKey) as-is.
        mergedTools[key] = oldVal;
      } else if (isPlainObject(newVal)) {
        // A settings form submitting actual option fields (e.g. web's
        // provider/searchApiKey/googleApiKey) - merge field-by-field so an
        // untouched '[set]' secret round-trips onto the existing encrypted
        // value instead of being written back as the literal placeholder.
        mergedTools[key] = mergeFieldsPreservingSetPlaceholder(
          isPlainObject(oldVal) ? oldVal : {},
          newVal
        );
      } else {
        mergedTools[key] = newVal;
      }
    }
    merged.tools = mergedTools;
  }

  if (updates.llm && typeof updates.llm === 'object') {
    merged.llm = mergeFieldsPreservingSetPlaceholder(
      (current.llm as Record<string, unknown>) ?? {},
      updates.llm as Record<string, unknown>
    );
  }

  if (updates.embeddings && typeof updates.embeddings === 'object') {
    merged.embeddings = mergeFieldsPreservingSetPlaceholder(
      (current.embeddings as Record<string, unknown>) ?? {},
      updates.embeddings as Record<string, unknown>
    );
  }

  if (typeof updates.apiKey === 'string') {
    merged.apiKey = updates.apiKey === '[set]' ? current.apiKey : updates.apiKey;
  }

  if (updates.dashboard && typeof updates.dashboard === 'object') {
    const currentDashboard = typeof current.dashboard === 'object' && current.dashboard !== null
      ? current.dashboard as Record<string, unknown>
      : {};
    merged.dashboard = mergeFieldsPreservingSetPlaceholder(currentDashboard, updates.dashboard as Record<string, unknown>);
  }

  if (updates.channels && typeof updates.channels === 'object') {
    const currentChannels = (current.channels as Record<string, unknown>) ?? {};
    const updateChannels = updates.channels as Record<string, unknown>;
    const mergedChannels: Record<string, unknown> = { ...currentChannels };
    for (const [channelName, channelUpdate] of Object.entries(updateChannels)) {
      // Explicit "disconnect this channel" signal from the dashboard - the
      // schema's channel fields are `.optional()` (undefined), not
      // `.nullable()`, so a channel is cleared by omitting the key
      // entirely, not by writing a literal null into it.
      if (channelUpdate === null) {
        delete mergedChannels[channelName];
        continue;
      }
      if (typeof channelUpdate !== 'object') {
        mergedChannels[channelName] = channelUpdate;
        continue;
      }
      mergedChannels[channelName] = mergeFieldsPreservingSetPlaceholder(
        (currentChannels[channelName] as Record<string, unknown>) ?? {},
        channelUpdate as Record<string, unknown>
      );
    }
    merged.channels = mergedChannels;
  }

  return merged;
}

/** Maps the dashboard's flat skill form fields onto SkillFrontmatter's nested shape. */
function frontmatterFromRequest(body: Record<string, unknown>): Partial<SkillFrontmatter> {
  const { name, description, version, license, platforms, tags, relatedSkills, envVars } = body;
  const hasMetadata = tags !== undefined || relatedSkills !== undefined;
  const hasPrerequisites = envVars !== undefined;
  return {
    name: name as string,
    description: description as string,
    version: version as string | undefined,
    license: license as string | undefined,
    platforms: platforms as SkillFrontmatter['platforms'],
    prerequisites: hasPrerequisites ? { env_vars: envVars as string[] } : undefined,
    metadata: hasMetadata ? { tags: tags as string[] | undefined, related_skills: relatedSkills as string[] | undefined } : undefined,
  };
}
