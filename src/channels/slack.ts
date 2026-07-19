/**
 * @module channels/slack
 *
 * Slack channel (Events API, HTTP webhook - not Socket Mode).
 * Used when you call: `agent.connectChannel('slack', { ... })`
 *
 * Requires the 'web' channel to be mounted first (it shares the Express server).
 * Webhook endpoint: POST /slack/events
 */

import { createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import type { SvaraAgent, SvaraChannel } from '../core/agent.js';
import type { IncomingMessage, ChannelName, Attachment } from '../core/types.js';
import { getRegisteredFile } from '../tools/builtin/sendFile.js';
import { attachProgressReporter } from './progressReporter.js';
import type express from 'express';

export interface SlackChannelConfig {
  /** Bot User OAuth Token (starts with "xoxb-") */
  botToken: string;
  /** Signing Secret from the Slack app's "Basic Information" page - verifies webhook requests came from Slack */
  signingSecret: string;
}

interface SlackEventBody {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    subtype?: string;
    bot_id?: string;
    channel: string;
    user?: string;
    text?: string;
    ts: string;
  };
}

type SlackRequest = express.Request & { rawBody?: Buffer };

export class SlackChannel implements SvaraChannel {
  readonly name: ChannelName = 'slack';

  private agent!: SvaraAgent;
  private readonly seenEvents = new Set<string>();

  constructor(private config: SlackChannelConfig) {
    if (!config.botToken || !config.signingSecret) {
      throw new Error('[@yesvara/svara] Slack requires: botToken and signingSecret.');
    }
  }

  async mount(agent: SvaraAgent): Promise<void> {
    this.agent = agent;

    const webChannel = (agent as unknown as {
      channels: Map<string, { app?: express.Application }>;
    }).channels?.get('web');

    const app = (webChannel as { app?: express.Application })?.app;

    if (!app) {
      console.warn(
        '[@yesvara/svara] Slack: no "web" channel found. ' +
        'Add connectChannel("web", ...) before connectChannel("slack", ...) ' +
        'so the webhook can be mounted.'
      );
      return;
    }

    app.post('/slack/events', async (req: SlackRequest, res: express.Response) => {
      if (!this.verifySignature(req)) {
        res.sendStatus(401);
        return;
      }

      const body = req.body as SlackEventBody;

      // One-time URL verification handshake when the webhook is first configured.
      if (body.type === 'url_verification') {
        res.status(200).json({ challenge: body.challenge });
        return;
      }

      res.sendStatus(200); // ack immediately, process async

      const event = body.event;
      if (!event || event.type !== 'message' || event.subtype || event.bot_id || !event.text) return;

      // Slack retries undelivered events and resends on reconnect; dedup by event ts.
      const eventKey = `${event.channel}:${event.ts}`;
      if (this.seenEvents.has(eventKey)) return;
      this.seenEvents.add(eventKey);
      if (this.seenEvents.size > 1000) {
        const oldest = this.seenEvents.values().next().value;
        if (oldest) this.seenEvents.delete(oldest);
      }

      await this.handle(event as Required<Pick<NonNullable<SlackEventBody['event']>, 'channel' | 'ts'>> & { text: string; user?: string })
        .catch((err: Error) => console.error('[@yesvara/svara] Slack error:', err.message));
    });

    console.log('[@yesvara/svara] Slack webhook mounted at /slack/events');
  }

  async send(channel: string, text: string, attachments?: Attachment[]): Promise<void> {
    await this.deliver(channel, null, text, attachments);
  }

  /** Delivers a reply, editing an in-progress placeholder into the final text if one exists (see handle()) instead of posting it as a brand new message. */
  private async deliver(channel: string, progressTs: string | null, text: string, attachments?: Attachment[]): Promise<void> {
    const [firstChunk, ...restChunks] = this.split(text, 4000);
    if (progressTs) {
      try {
        await this.updateMessage(channel, progressTs, firstChunk);
      } catch {
        await this.postMessage(channel, firstChunk);
      }
    } else {
      await this.postMessage(channel, firstChunk);
    }
    for (const chunk of restChunks) await this.postMessage(channel, chunk);

    for (const attachment of attachments ?? []) {
      await this.sendAttachment(channel, attachment).catch((err: Error) =>
        console.error('[@yesvara/svara] Slack file upload failed:', err.message)
      );
    }
  }

  async stop(): Promise<void> { /* HTTP-based, no persistent connection */ }

  private verifySignature(req: SlackRequest): boolean {
    const signature = req.headers['x-slack-signature'] as string | undefined;
    const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
    if (!signature || !timestamp || !req.rawBody) return false;

    // Reject requests older than 5 minutes to guard against replay attacks.
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

    const base = `v0:${timestamp}:${req.rawBody.toString()}`;
    const expected = `v0=${createHmac('sha256', this.config.signingSecret).update(base).digest('hex')}`;

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(event: { channel: string; user?: string; text: string; ts: string }): Promise<void> {
    const message: IncomingMessage = {
      id: event.ts,
      sessionId: event.channel,
      userId: event.user ?? event.channel,
      channel: 'slack',
      text: event.text,
      timestamp: new Date(Number(event.ts.split('.')[0]) * 1000),
      raw: event,
    };

    // See telegram.ts's handleUpdate() for why this exists - no live-stream
    // API for a Slack message, so a placeholder gets edited in place as
    // tool:call events land instead of the reply just appearing 20-30s later
    // with no sign anything was happening.
    let progressTs: string | null = null;
    const reporter = attachProgressReporter({
      agent: this.agent,
      sessionId: message.sessionId,
      onUpdate: async (text) => {
        if (!progressTs) {
          progressTs = await this.postMessage(event.channel, text);
        } else {
          await this.updateMessage(event.channel, progressTs, text);
        }
      },
    });

    try {
      const result = await this.agent.receive(message);
      reporter.stop();
      await this.deliver(event.channel, progressTs, result.response, result.attachments);
    } catch (err) {
      reporter.stop();
      await this.postMessage(event.channel, 'Sorry, something went wrong. Please try again.');
      throw err;
    }
  }

  // files.upload is deprecated - the current flow is: reserve an upload URL,
  // PUT the bytes to it, then finalize + share it into the channel.
  private async sendAttachment(channel: string, attachment: Attachment): Promise<void> {
    const file = getRegisteredFile(attachment.token);
    if (!file) return;
    const buffer = await fs.readFile(file.absolutePath);

    const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ filename: file.filename, length: String(file.size) }),
    });
    const urlData = await urlRes.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      throw new Error(`Slack API: ${urlData.error ?? 'failed to reserve an upload URL'}`);
    }

    const uploadRes = await fetch(urlData.upload_url, { method: 'POST', body: new Blob([buffer]) });
    if (!uploadRes.ok) throw new Error(`Slack upload failed: HTTP ${uploadRes.status}`);

    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ files: [{ id: urlData.file_id, title: file.filename }], channel_id: channel }),
    });
    const completeData = await completeRes.json() as { ok: boolean; error?: string };
    if (!completeData.ok) throw new Error(`Slack API: ${completeData.error}`);
  }

  /** Posts a new message, returning its `ts` (Slack's message identifier) so it can be edited later via updateMessage() (see progressReporter.ts). */
  private async postMessage(channel: string, text: string): Promise<string> {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text }),
    });
    const data = await res.json() as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) {
      throw new Error(`Slack API: ${data.error}`);
    }
    // ts should always be present alongside ok: true - tolerated as empty
    // rather than thrown on, since the message itself did send successfully;
    // it just can't be edited later (updateMessage() would no-op on '').
    return data.ts ?? '';
  }

  private async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, ts, text }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`Slack API: ${data.error}`);
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
