/**
 * @module channels/whatsapp
 *
 * WhatsApp Business API channel (Meta Cloud API).
 * Used when you call: `agent.connectChannel('whatsapp', { ... })`
 *
 * Requires the 'web' channel to be mounted first (it shares the Express server).
 * Webhook endpoint: POST /whatsapp/webhook
 */

import type { SvaraAgent, SvaraChannel } from '../core/agent.js';
import type { IncomingMessage, ChannelName } from '../core/types.js';
import type express from 'express';

export interface WhatsAppChannelConfig {
  /** WhatsApp Cloud API access token */
  token: string;
  /** Your WhatsApp Phone Number ID */
  phoneId: string;
  /** Token to verify the webhook with Meta */
  verifyToken: string;
  /** API version, default 'v19.0' */
  apiVersion?: string;
}

interface WABody {
  object: string;
  entry: Array<{
    changes: Array<{
      value: {
        messages?: Array<{
          id: string; from: string; timestamp: string;
          type: string; text?: { body: string };
        }>;
      };
    }>;
  }>;
}

export class WhatsAppChannel implements SvaraChannel {
  readonly name: ChannelName = 'whatsapp';

  private agent!: SvaraAgent;
  private readonly apiUrl: string;

  constructor(private config: WhatsAppChannelConfig) {
    if (!config.token || !config.phoneId || !config.verifyToken) {
      throw new Error(
        '[@yesvara/svara] WhatsApp requires: token, phoneId, and verifyToken.'
      );
    }
    const version = config.apiVersion ?? 'v19.0';
    this.apiUrl = `https://graph.facebook.com/${version}/${config.phoneId}`;
  }

  async mount(agent: SvaraAgent): Promise<void> {
    this.agent = agent;

    // Get the web channel's Express app to attach webhook routes
    const webChannel = (agent as unknown as {
      channels: Map<string, { app?: express.Application }>;
    }).channels?.get('web');

    const app = (webChannel as { app?: { post: (...a: unknown[]) => void; get: (...a: unknown[]) => void } })?.app;

    if (!app) {
      console.warn(
        '[@yesvara/svara] WhatsApp: no "web" channel found. ' +
        'Add connectChannel("web", ...) before connectChannel("whatsapp", ...) ' +
        'so the webhook can be mounted.'
      );
      return;
    }

    // Webhook verification
    app.get('/whatsapp/webhook', (req: { query: Record<string, string> }, res: { status: (n: number) => { send: (s: unknown) => void } }) => {
      const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
      if (mode === 'subscribe' && token === this.config.verifyToken) {
        console.log('[@yesvara/svara] WhatsApp webhook verified.');
        res.status(200).send(challenge);
      } else {
        res.status(403).send('Forbidden');
      }
    });

    // Incoming messages
    app.post('/whatsapp/webhook', async (req: { body: WABody }, res: { sendStatus: (n: number) => void }) => {
      res.sendStatus(200); // ack immediately
      if (req.body.object !== 'whatsapp_business_account') return;

      for (const entry of req.body.entry) {
        for (const change of entry.changes) {
          for (const waMsg of change.value.messages ?? []) {
            if (waMsg.type !== 'text' || !waMsg.text?.body) continue;
            await this.handle(waMsg).catch((err: Error) =>
              console.error('[@yesvara/svara] WhatsApp error:', err.message)
            );
          }
        }
      }
    });

    console.log('[@yesvara/svara] WhatsApp webhook mounted at /whatsapp/webhook');
  }

  async send(to: string, text: string): Promise<void> {
    await this.sendMessage(to, text);
  }

  async stop(): Promise<void> { /* HTTP-based, no persistent connection */ }

  private async handle(waMsg: { id: string; from: string; timestamp: string; text?: { body: string } }): Promise<void> {
    const message: IncomingMessage = {
      id: waMsg.id,
      sessionId: waMsg.from,
      userId: waMsg.from,
      channel: 'whatsapp',
      text: waMsg.text?.body ?? '',
      timestamp: new Date(parseInt(waMsg.timestamp) * 1000),
      raw: waMsg,
    };

    try {
      const result = await this.agent.receive(message);
      for (const chunk of this.split(result.response, 4000)) {
        await this.sendMessage(waMsg.from, chunk);
      }
    } catch (err) {
      await this.sendMessage(waMsg.from, 'Sorry, something went wrong. Please try again.');
      throw err;
    }
  }

  private async sendMessage(to: string, text: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    });
    if (!res.ok) {
      const err = await res.json() as { error?: { message: string } };
      throw new Error(`WhatsApp API: ${err.error?.message}`);
    }
  }

  private split(text: string, max: number): string[] {
    if (text.length <= max) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > 0) { chunks.push(rest.slice(0, max)); rest = rest.slice(max); }
    return chunks;
  }
}
