/**
 * @module channels/discord
 *
 * Discord channel (Gateway WebSocket - not a webhook, Discord has no
 * outbound-events-over-HTTP option for regular bots). Used when you call:
 * `agent.connectChannel('discord', { botToken: '...' })`
 *
 * Does not require the 'web' channel - Discord bots hold a persistent
 * outbound connection to Discord's gateway rather than receiving inbound
 * webhooks, so there's nothing to mount on the shared Express app.
 */

import WebSocket from 'ws';
import fs from 'fs/promises';
import type { SvaraAgent, SvaraChannel } from '../core/agent.js';
import type { IncomingMessage, ChannelName, Attachment } from '../core/types.js';
import { getRegisteredFile } from '../tools/builtin/sendFile.js';
import { attachProgressReporter } from './progressReporter.js';

export interface DiscordChannelConfig {
  /** Bot token from the Discord Developer Portal */
  botToken: string;
  /** Gateway URL override, mainly for tests. @default 'wss://gateway.discord.gg/?v=10&encoding=json' */
  gatewayUrl?: string;
}

// Gateway opcodes (https://discord.com/developers/docs/topics/opcodes-and-status-codes)
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT (the latter is a privileged intent
// that must also be enabled for the bot in the Discord Developer Portal).
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface DiscordMessageCreate {
  id: string;
  channel_id: string;
  author: { id: string; bot?: boolean };
  content: string;
  timestamp: string;
}

export class DiscordChannel implements SvaraChannel {
  readonly name: ChannelName = 'discord';

  private agent!: SvaraAgent;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private stopped = false;
  private readonly gatewayUrl: string;

  constructor(private config: DiscordChannelConfig) {
    if (!config.botToken) {
      throw new Error('[@yesvara/svara] Discord requires: botToken.');
    }
    this.gatewayUrl = config.gatewayUrl ?? 'wss://gateway.discord.gg/?v=10&encoding=json';
  }

  async mount(agent: SvaraAgent): Promise<void> {
    this.agent = agent;
    this.connect();
  }

  async send(channelId: string, text: string, attachments?: Attachment[]): Promise<void> {
    await this.deliver(channelId, null, text, attachments);
  }

  /** Delivers a reply, editing an in-progress placeholder into the final text if one exists (see handle()) instead of sending it as a brand new message. */
  private async deliver(channelId: string, progressMessageId: string | null, text: string, attachments?: Attachment[]): Promise<void> {
    const [firstChunk, ...restChunks] = this.split(text, 2000);
    if (progressMessageId !== null) {
      try {
        await this.editText(channelId, progressMessageId, firstChunk);
      } catch {
        await this.sendText(channelId, firstChunk);
      }
    } else {
      await this.sendText(channelId, firstChunk);
    }
    for (const chunk of restChunks) await this.sendText(channelId, chunk);

    for (const attachment of attachments ?? []) {
      await this.sendAttachment(channelId, attachment).catch((err: Error) =>
        console.error('[@yesvara/svara] Discord attachment upload failed:', err.message)
      );
    }
  }

  /** Posts a new message, returning its id so it can be edited later (see progressReporter.ts). */
  private async sendText(channelId: string, text: string): Promise<string> {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(`Discord API: ${res.status} ${err.message ?? res.statusText}`);
    }
    const data = await res.json() as { id: string };
    return data.id;
  }

  private async editText(channelId: string, messageId: string, text: string): Promise<void> {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(`Discord API: ${res.status} ${err.message ?? res.statusText}`);
    }
  }

  private async sendAttachment(channelId: string, attachment: Attachment): Promise<void> {
    const file = getRegisteredFile(attachment.token);
    if (!file) return;
    const buffer = await fs.readFile(file.absolutePath);
    const form = new FormData();
    form.append('payload_json', JSON.stringify({}));
    form.append('files[0]', new Blob([buffer], { type: file.mimeType ?? 'application/octet-stream' }), file.filename);
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${this.config.botToken}` },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(`Discord API: ${res.status} ${err.message ?? res.statusText}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  // ─── Gateway connection ──────────────────────────────────────────────────

  private connect(resume = false): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.gatewayUrl);
    this.ws = ws;

    ws.on('message', (raw: Buffer | string) => {
      const payload = JSON.parse(raw.toString()) as GatewayPayload;
      this.handlePayload(payload, resume);
    });

    ws.on('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.stopped) return;
      console.warn('[@yesvara/svara] Discord gateway closed, reconnecting in 3s...');
      setTimeout(() => this.connect(this.sessionId !== null), 3000);
    });

    ws.on('error', (err: Error) => {
      console.error('[@yesvara/svara] Discord gateway error:', err.message);
    });
  }

  private handlePayload(payload: GatewayPayload, resume: boolean): void {
    if (typeof payload.s === 'number') this.lastSeq = payload.s;

    switch (payload.op) {
      case OP_HELLO: {
        const { heartbeat_interval } = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(heartbeat_interval);
        if (resume && this.sessionId) {
          this.send_({ op: OP_RESUME, d: { token: this.config.botToken, session_id: this.sessionId, seq: this.lastSeq } });
        } else {
          this.identify();
        }
        break;
      }
      case OP_HEARTBEAT_ACK:
        break;
      case OP_INVALID_SESSION:
        this.sessionId = null;
        setTimeout(() => this.identify(), 1000 + Math.random() * 4000);
        break;
      case OP_RECONNECT:
        this.ws?.close();
        break;
      case OP_DISPATCH:
        this.handleDispatch(payload.t ?? '', payload.d);
        break;
      default:
        break;
    }
  }

  private handleDispatch(type: string, data: unknown): void {
    if (type === 'READY') {
      this.sessionId = (data as { session_id: string }).session_id;
      console.log('[@yesvara/svara] Discord gateway connected.');
      return;
    }
    if (type === 'MESSAGE_CREATE') {
      const msg = data as DiscordMessageCreate;
      if (msg.author.bot || !msg.content) return;
      this.handle(msg).catch((err: Error) => console.error('[@yesvara/svara] Discord error:', err.message));
    }
  }

  private async handle(msg: DiscordMessageCreate): Promise<void> {
    const message: IncomingMessage = {
      id: msg.id,
      sessionId: msg.channel_id,
      userId: msg.author.id,
      channel: 'discord',
      text: msg.content,
      timestamp: new Date(msg.timestamp),
      raw: msg,
    };

    // See telegram.ts's handleUpdate() for why this exists - no live-stream
    // API for a Discord message, so a placeholder gets edited in place as
    // tool:call events land instead of the reply just appearing 20-30s later
    // with no sign anything was happening.
    let progressMessageId: string | null = null;
    const reporter = attachProgressReporter({
      agent: this.agent,
      sessionId: message.sessionId,
      onUpdate: async (text) => {
        if (progressMessageId === null) {
          progressMessageId = await this.sendText(msg.channel_id, text);
        } else {
          await this.editText(msg.channel_id, progressMessageId, text);
        }
      },
    });

    try {
      const result = await this.agent.receive(message);
      reporter.stop();
      await this.deliver(msg.channel_id, progressMessageId, result.response, result.attachments);
    } catch (err) {
      reporter.stop();
      await this.send(msg.channel_id, 'Sorry, something went wrong. Please try again.');
      throw err;
    }
  }

  private identify(): void {
    this.send_({
      op: OP_IDENTIFY,
      d: {
        token: this.config.botToken,
        intents: INTENTS,
        properties: { os: 'linux', browser: 'svarajs', device: 'svarajs' },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.send_({ op: OP_HEARTBEAT, d: this.lastSeq }), intervalMs);
  }

  private send_(payload: GatewayPayload): void {
    this.ws?.send(JSON.stringify(payload));
  }

  private split(text: string, max: number): string[] {
    if (text.length <= max) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > 0) { chunks.push(rest.slice(0, max)); rest = rest.slice(max); }
    return chunks;
  }
}
