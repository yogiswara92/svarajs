/**
 * @module channels/web
 *
 * HTTP channel — exposes the agent as a REST API with SSE streaming.
 *
 * Used automatically when you call:
 * ```ts
 * agent.connectChannel('web', { port: 3000 });
 * ```
 *
 * Or mount it on SvaraApp/Express:
 * ```ts
 * app.route('/chat', agent.handler());
 * ```
 *
 * API:
 *   POST /chat       — { message, sessionId? } → { response, sessionId, usage }
 *   GET  /health     — { status: 'ok' }
 */

import express, { type Express } from 'express';
import type { SvaraAgent, SvaraChannel } from '../core/agent.js';
import type { IncomingMessage, ChannelName } from '../core/types.js';

export interface WebChannelConfig {
  port?: number;           // default 3000
  cors?: boolean | string;
  apiKey?: string;
  path?: string;           // base path prefix, default ''
}

export class WebChannel implements SvaraChannel {
  readonly name: ChannelName = 'web';

  private app: Express;
  private server: ReturnType<Express['listen']> | null = null;
  private agent!: SvaraAgent;

  constructor(private config: WebChannelConfig = {}) {
    this.app = this.buildApp();
  }

  async mount(agent: SvaraAgent): Promise<void> {
    this.agent = agent;
    this.attachRoutes();

    const port = this.config.port ?? 3000;
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, () => {
        console.log(`[@yesvara/svara] Web channel running at http://localhost:${port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async send(_sessionId: string, _text: string): Promise<void> {
    // Push-based sending is handled via SSE in the /chat/stream route
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve()) ?? resolve();
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private buildApp(): Express {
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    if (this.config.cors) {
      const origin = this.config.cors === true ? '*' : this.config.cors;
      app.use((_req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', origin as string);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        next();
      });
      app.options('*', (_req, res) => res.sendStatus(204));
    }

    if (this.config.apiKey) {
      app.use((req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token !== this.config.apiKey) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        next();
      });
    }

    return app;
  }

  private attachRoutes(): void {
    const base = this.config.path ?? '';

    this.app.get(`${base}/health`, (_req, res) => {
      res.json({ status: 'ok', agent: this.agent.name, timestamp: new Date().toISOString() });
    });

    this.app.post(`${base}/chat`, this.agent.handler());
  }

  private buildMessage(body: { message: string; sessionId?: string; userId?: string }): IncomingMessage {
    return {
      id: crypto.randomUUID(),
      sessionId: body.sessionId ?? crypto.randomUUID(),
      userId: body.userId ?? 'web-user',
      channel: 'web',
      text: body.message,
      timestamp: new Date(),
    };
  }
}
