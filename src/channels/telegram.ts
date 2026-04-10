/**
 * @module channels/telegram
 *
 * Telegram Bot channel.
 * Used when you call: `agent.connectChannel('telegram', { token: '...' })`
 */

import type { SvaraAgent, SvaraChannel } from '../core/agent.js';
import type { IncomingMessage, ChannelName } from '../core/types.js';

export interface TelegramChannelConfig {
  token: string;
  mode?: 'polling' | 'webhook';
  webhookUrl?: string;
  pollingInterval?: number;
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

  constructor(private config: TelegramChannelConfig) {
    if (!config.token) throw new Error('[@yesvara/svara] Telegram requires a bot token.');
    this.baseUrl = `https://api.telegram.org/bot${config.token}`;
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

  async send(sessionId: string, text: string): Promise<void> {
    const chatId = parseInt(sessionId, 10);
    if (!isNaN(chatId)) await this.sendMessage(chatId, text);
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

    try {
      const result = await this.agent.receive(message);
      for (const chunk of this.split(result.response, 4096)) {
        await this.sendMessage(msg.chat.id, chunk);
      }
    } catch (err) {
      await this.sendMessage(msg.chat.id, 'Sorry, something went wrong. Please try again.');
      console.error('[@yesvara/svara] Telegram error:', (err as Error).message);
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
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
