/**
 * @module channels/telegram
 *
 * Telegram Bot channel.
 * Used when you call: `agent.connectChannel('telegram', { token: '...' })`
 */

import fs from 'fs/promises';
import type { SvaraAgent, SvaraChannel } from '../core/agent.js';
import type { IncomingMessage, ChannelName, Attachment } from '../core/types.js';
import { getRegisteredFile } from '../tools/builtin/sendFile.js';
import { attachProgressReporter } from './progressReporter.js';

export interface TelegramChannelConfig {
  token: string;
  mode?: 'polling' | 'webhook';
  webhookUrl?: string;
  pollingInterval?: number;
  /** Restrict the bot to these Telegram user IDs (from `msg.from.id`, e.g. via @userinfobot). Unset means anyone can use it. */
  allowedUserIds?: string[];
}

interface TGUpdate {
  update_id: number;
  message?: { message_id: number; from: { id: number; username?: string }; chat: { id: number }; date: number; text?: string };
}

export class TelegramChannel implements SvaraChannel {
  readonly name: ChannelName = 'telegram';

  private agent!: SvaraAgent;
  private baseUrl: string;
  private lastUpdateId = 0;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private allowedUserIds: Set<string> | null;

  constructor(private config: TelegramChannelConfig) {
    if (!config.token) throw new Error('[@yesvara/svara] Telegram requires a bot token.');
    this.baseUrl = `https://api.telegram.org/bot${config.token}`;
    this.allowedUserIds = config.allowedUserIds?.length ? new Set(config.allowedUserIds) : null;
  }

  async mount(agent: SvaraAgent): Promise<void> {
    this.agent = agent;
    const me = await this.api<{ username: string }>('getMe');
    console.log(`[@yesvara/svara] Telegram connected as @${me.username}`);

    if (this.config.mode === 'webhook' && this.config.webhookUrl) {
      await this.api('setWebhook', { url: `${this.config.webhookUrl}/telegram/webhook` });
      console.log(`[@yesvara/svara] Telegram webhook registered.`);
    } else {
      this.startPolling();
    }
  }

  async send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void> {
    const chatId = parseInt(sessionId, 10);
    if (isNaN(chatId)) return;
    await this.deliver(chatId, null, text, attachments);
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
  }

  private startPolling(): void {
    const interval = this.config.pollingInterval ?? 1000;
    console.log('[@yesvara/svara] Telegram polling started...');
    this.pollingTimer = setInterval(async () => {
      try {
        const updates = await this.api<TGUpdate[]>('getUpdates', {
          offset: this.lastUpdateId + 1,
          allowed_updates: ['message'],
        });
        for (const update of updates) {
          this.lastUpdateId = update.update_id;
          if (update.message?.text) await this.handleUpdate(update);
        }
      } catch { /* polling errors are transient */ }
    }, interval);
  }

  private async handleUpdate(update: TGUpdate): Promise<void> {
    const msg = update.message!;

    // Silently drop rather than reply "not allowed" - confirming the bot
    // exists to an unauthorized user is itself information leakage.
    if (this.allowedUserIds && !this.allowedUserIds.has(String(msg.from.id))) return;

    const message: IncomingMessage = {
      id: String(msg.message_id),
      sessionId: String(msg.chat.id),
      userId: String(msg.from.id),
      channel: 'telegram',
      text: msg.text ?? '',
      timestamp: new Date(msg.date * 1000),
      raw: msg,
    };

    await this.api('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});

    // No live streaming API for a chat message the way the web dashboard
    // gets one over HTTP - approximated by sending a placeholder as soon as
    // the first tool call happens, then editing it in place as more come in,
    // so a slow multi-step reply doesn't look frozen for 20-30s before
    // suddenly appearing. Reuses the same tool:call event the agent already
    // emits for the web chat's streaming endpoint.
    let progressMessageId: number | null = null;
    const reporter = attachProgressReporter({
      agent: this.agent,
      sessionId: message.sessionId,
      onUpdate: async (text) => {
        if (progressMessageId === null) {
          const sent = await this.api<{ message_id: number }>('sendMessage', { chat_id: msg.chat.id, text });
          progressMessageId = sent.message_id;
        } else {
          await this.api('editMessageText', { chat_id: msg.chat.id, message_id: progressMessageId, text });
        }
      },
    });

    try {
      const result = await this.agent.receive(message);
      reporter.stop();
      await this.deliver(msg.chat.id, progressMessageId, result.response, result.attachments);
    } catch (err) {
      reporter.stop();
      await this.sendMessage(msg.chat.id, 'Sorry, something went wrong. Please try again.');
      console.error('[@yesvara/svara] Telegram error:', (err as Error).message);
    }
  }

  /** Delivers a reply, editing an in-progress placeholder into the final text if one exists (see handleUpdate()) instead of sending it as a brand new message. */
  private async deliver(chatId: number, progressMessageId: number | null, text: string, attachments?: Attachment[]): Promise<void> {
    const [firstChunk, ...restChunks] = this.split(text, 4096);
    if (progressMessageId !== null) {
      try {
        await this.api('editMessageText', { chat_id: chatId, message_id: progressMessageId, text: firstChunk, parse_mode: 'Markdown' });
      } catch {
        await this.sendMessage(chatId, firstChunk);
      }
    } else {
      await this.sendMessage(chatId, firstChunk);
    }
    for (const chunk of restChunks) await this.sendMessage(chatId, chunk);

    for (const attachment of attachments ?? []) {
      await this.sendDocument(chatId, attachment).catch((err: Error) =>
        console.error('[@yesvara/svara] Telegram sendDocument failed:', err.message)
      );
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
  }

  private async sendDocument(chatId: number, attachment: Attachment): Promise<void> {
    const file = getRegisteredFile(attachment.token);
    if (!file) return;
    const buffer = await fs.readFile(file.absolutePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([buffer], { type: file.mimeType ?? 'application/octet-stream' }), file.filename);
    const res = await fetch(`${this.baseUrl}/sendDocument`, { method: 'POST', body: form });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(data.description ?? 'sendDocument failed');
  }

  private async api<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: params ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
    });
    const data = await res.json() as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram API: ${data.description}`);
    return data.result;
  }

  private split(text: string, max: number): string[] {
    if (text.length <= max) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > 0) { chunks.push(rest.slice(0, max)); rest = rest.slice(max); }
    return chunks;
  }
}
