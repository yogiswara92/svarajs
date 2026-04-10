/**
 * @module SvaraApp
 *
 * The framework entry point. Wraps Express to give you a clean,
 * AI-first HTTP server that works with zero configuration.
 *
 * @example
 * ```ts
 * import { SvaraApp, SvaraAgent } from '@yesvara/svara';
 *
 * const app = new SvaraApp();
 *
 * const agent = new SvaraAgent({
 *   name: 'Support Bot',
 *   model: 'gpt-4o-mini',
 *   knowledge: './docs',
 * });
 *
 * app.route('/chat', agent.handler());
 * app.listen(3000);
 * // → Server running at http://localhost:3000
 * // → POST /chat accepts { message, sessionId }
 * // → GET  /health returns { status: 'ok' }
 * ```
 *
 * @example With your own Express app
 * ```ts
 * import express from 'express';
 * const expressApp = express();
 *
 * // Mount as middleware on any path
 * expressApp.post('/api/chat', agent.handler());
 * ```
 */

import express, { type Express, type RequestHandler, type Request, type Response } from 'express';
import { createServer, type Server } from 'http';

export interface AppOptions {
  /**
   * Enable CORS. Pass `true` for wildcard (*), or a specific origin string.
   * @default false
   */
  cors?: boolean | string;

  /**
   * Require an API key in the `Authorization: Bearer <key>` header.
   * Useful for protecting your agent endpoint.
   */
  apiKey?: string;

  /**
   * Request body size limit. @default '10mb'
   */
  bodyLimit?: string;
}

export class SvaraApp {
  private readonly express: Express;
  private server: Server | null = null;

  constructor(options: AppOptions = {}) {
    this.express = express();
    this.setup(options);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Mount an agent (or any Express handler) on a route.
   * Returns `this` for chaining.
   *
   * @example
   * app
   *   .route('/chat', supportAgent.handler())
   *   .route('/sales', salesAgent.handler());
   */
  route(path: string, handler: RequestHandler): this {
    this.express.post(path, handler);
    return this;
  }

  /**
   * Add Express middleware (logging, auth, rate limiting, etc.)
   *
   * @example
   * import rateLimit from 'express-rate-limit';
   * app.use(rateLimit({ windowMs: 60_000, max: 100 }));
   */
  use(middleware: RequestHandler): this {
    this.express.use(middleware);
    return this;
  }

  /**
   * Start listening on the given port.
   *
   * @example
   * await app.listen(3000);
   * // → [@yesvara/svara] Listening at http://localhost:3000
   */
  listen(port = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.express);
      this.server.listen(port, () => {
        console.log(`[@yesvara/svara] Server running at http://localhost:${port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  /**
   * Stop the server gracefully.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Access the underlying Express app for advanced configuration.
   *
   * @example
   * const expressApp = app.express();
   * expressApp.set('trust proxy', 1);
   */
  getExpressApp(): Express {
    return this.express;
  }

  // ─── Private Setup ────────────────────────────────────────────────────────

  private setup(options: AppOptions): void {
    // Parse JSON bodies
    this.express.use(express.json({ limit: options.bodyLimit ?? '10mb' }));

    // CORS
    if (options.cors) {
      this.express.use((_req, res, next) => {
        const origin = options.cors === true ? '*' : options.cors as string;
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        next();
      });
      this.express.options('*', (_req, res) => res.sendStatus(204));
    }

    // API key auth
    if (options.apiKey) {
      this.express.use((req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token !== options.apiKey) {
          res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key.' });
          return;
        }
        next();
      });
    }

    // Health check — always available, no auth
    this.express.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        framework: '@yesvara/svara',
        timestamp: new Date().toISOString(),
      });
    });
  }
}
