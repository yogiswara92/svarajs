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
import { toTelegramMarkdown, stripMarkdown } from './telegramFormat.js';

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

/** Registered via setMyCommands so they show up in Telegram's "/" menu button - see mount(). */
const BOT_COMMANDS = [
  { command: 'new', description: 'Start a new conversation (clears history)' },
  { command: 'status', description: 'Show session and model info' },
  { command: 'stop', description: 'Cancel the in-progress reply' },
];

export class TelegramChannel implements SvaraChannel {
  readonly name: ChannelName = 'telegram';

  private agent!: SvaraAgent;
  private baseUrl: string;
  private lastUpdateId = 0;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private allowedUserIds: Set<string> | null;
  /** One entry per chat with a reply in flight - lets /stop flag it for a soft-cancel (the in-flight agent.receive() still runs to completion, but its result is discarded on arrival instead of delivered). */
  private activeRequests = new Map<string, { cancelled: boolean }>();

  constructor(private config: TelegramChannelConfig) {
    if (!config.token) throw new Error('[@yesvara/svara] Telegram requires a bot token.');
    this.baseUrl = `https://api.telegram.org/bot${config.token}`;
    this.allowedUserIds = config.allowedUserIds?.length ? new Set(config.allowedUserIds) : null;
  }

  async mount(agent: SvaraAgent): Promise<void> {
    this.agent = agent;
    const me = await this.api<{ username: string }>('getMe');
    console.log(`[@yesvara/svara] Telegram connected as @${me.username}`);
    await this.api('setMyCommands', { commands: BOT_COMMANDS }).catch((err) => {
      console.warn(`[@yesvara/svara] Telegram setMyCommands failed: ${(err as Error).message}`);
    });

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
    await this.deliver(chatId, text, attachments);
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

    if (msg.text?.startsWith('/') && await this.handleCommand(msg, msg.text)) return;

    const message: IncomingMessage = {
      id: String(msg.message_id),
      sessionId: String(msg.chat.id),
      userId: String(msg.from.id),
      channel: 'telegram',
      text: msg.text ?? '',
      timestamp: new Date(msg.date * 1000),
      raw: msg,
    };

    const requestState = { cancelled: false };
    this.activeRequests.set(message.sessionId, requestState);

    // Telegram's "typing" indicator auto-expires after ~5s - resend on an
    // interval so it stays visible for the whole turn instead of vanishing
    // partway through a slow multi-tool-call reply.
    await this.api('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
    const typingTimer = setInterval(() => {
      void this.api('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
    }, 4000);

    // No live streaming API for a chat message the way the web dashboard
    // gets one over HTTP - approximated by sending a placeholder as soon as
    // the first tool call happens, then editing it in place as more come in,
    // so a slow multi-step reply doesn't look frozen for 20-30s before
    // suddenly appearing. Reuses the same tool:call event the agent already
    // emits for the web chat's streaming endpoint. Once the turn finishes,
    // this placeholder is finalized into a permanent "Done" trace rather
    // than overwritten with the reply - the reply always goes out as its
    // own message (see deliver()), so the step-by-step trace stays visible
    // in the chat instead of disappearing.
    let progressMessageId: number | null = null;
    const reporter = attachProgressReporter({
      agent: this.agent,
      sessionId: message.sessionId,
      onUpdate: async (text) => {
        if (progressMessageId === null) {
          const sent = await this.api<{ message_id: number }>('sendMessage', { chat_id: msg.chat.id, text });
          progressMessageId = sent.message_id;
        } else {
          await this.api('editMessageText', { chat_id: msg.chat.id, message_id: progressMessageId, text }).catch(() => {});
        }
      },
    });

    try {
      const result = await this.agent.receive(message);
      reporter.stop();
      clearInterval(typingTimer);
      this.activeRequests.delete(message.sessionId);
      if (requestState.cancelled) return; // /stop already told the user; drop the (now stale) result

      if (progressMessageId !== null) {
        await this.api('editMessageText', { chat_id: msg.chat.id, message_id: progressMessageId, text: reporter.summary() }).catch(() => {});
      }
      await this.deliver(msg.chat.id, result.response, result.attachments);
    } catch (err) {
      reporter.stop();
      clearInterval(typingTimer);
      this.activeRequests.delete(message.sessionId);
      if (!requestState.cancelled) {
        await this.sendMessage(msg.chat.id, 'Sorry, something went wrong. Please try again.');
        console.error('[@yesvara/svara] Telegram error:', (err as Error).message);
      }
    }
  }

  /** Handles a leading-slash message as a bot command. Returns false for anything not recognized, so it falls through and reaches the agent as ordinary chat text (e.g. a literal "/" the user meant as a message, not a command). */
  private async handleCommand(msg: NonNullable<TGUpdate['message']>, text: string): Promise<boolean> {
    const command = text.trim().split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();
    const sessionId = String(msg.chat.id);

    switch (command) {
      case 'new':
        await this.agent.clearHistory(sessionId);
        this.activeRequests.delete(sessionId);
        await this.sendMessage(msg.chat.id, 'Started a new conversation - history cleared.');
        return true;

      case 'status': {
        const current = this.agent.listSessions(50).find((s) => s.sessionId === sessionId);
        await this.sendMessage(msg.chat.id, [
          `*Agent:* ${this.agent.name}`,
          `*Model:* ${this.agent.model}`,
          `*Session:* ${sessionId}`,
          `*Messages:* ${current?.messageCount ?? 0}`,
        ].join('\n'));
        return true;
      }

      case 'stop': {
        const active = this.activeRequests.get(sessionId);
        if (active) {
          active.cancelled = true;
          await this.sendMessage(msg.chat.id, 'Stopping - the current reply will be discarded.');
        } else {
          await this.sendMessage(msg.chat.id, 'Nothing is currently running.');
        }
        return true;
      }

      default:
        return false;
    }
  }

  /** Delivers a reply as its own message - never reuses the in-progress placeholder (see handleUpdate()), so the tool-call trace it shows stays in the chat instead of being overwritten. */
  private async deliver(chatId: number, text: string, attachments?: Attachment[]): Promise<void> {
    // Headers/tables/GFM **bold** have no equivalent (or a different one) in
    // Telegram's legacy Markdown - convert before splitting, so a table
    // isn't cut mid-row by the 4096-char chunk boundary.
    const converted = toTelegramMarkdown(text);
    const [firstChunk, ...restChunks] = this.split(converted, 4096);
    await this.sendMessage(chatId, firstChunk);
    for (const chunk of restChunks) await this.sendMessage(chatId, chunk);

    for (const attachment of attachments ?? []) {
      await this.sendDocument(chatId, attachment).catch((err: Error) =>
        console.error('[@yesvara/svara] Telegram sendDocument failed:', err.message)
      );
    }
  }

  /** Sends with Markdown formatting, falling back to plain text (stripped of markdown syntax) if Telegram rejects the markdown as unparseable - a stray unbalanced `*`/`_` in the text otherwise silently drops the whole message. */
  private async sendMessage(chatId: number, text: string): Promise<void> {
    try {
      await this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
    } catch {
      await this.api('sendMessage', { chat_id: chatId, text: stripMarkdown(text) });
    }
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
