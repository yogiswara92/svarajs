/**
 * @example Multi-Channel Agent
 *
 * One agent, three channels. Same conversations, everywhere.
 * Customers can reach you on WhatsApp, Telegram, or the web —
 * the agent handles all of them seamlessly.
 *
 * Setup:
 *   1. Copy .env.example → .env and fill in your keys
 *   2. Run: npx tsx index.ts
 *   3. Expose with: npx localtunnel --port 3000
 *   4. Register the tunnel URL as your Telegram/WhatsApp webhook
 */

import 'dotenv/config';
import { SvaraAgent, createTool } from '@yesvara/svara';

// ── Tools ─────────────────────────────────────────────────────────────────────

const orderStatus = createTool({
  name: 'get_order_status',
  description: 'Look up the status of a customer order by order ID',
  parameters: {
    orderId: { type: 'string', description: 'The order ID', required: true },
  },
  async run({ orderId }) {
    // Replace with your real database query
    const mockOrders: Record<string, unknown> = {
      'ORD-001': { status: 'shipped', eta: '2024-12-25', carrier: 'FedEx' },
      'ORD-002': { status: 'processing', eta: '2024-12-27', carrier: null },
    };
    return mockOrders[orderId as string] ?? { error: 'Order not found' };
  },
});

// ── Agent ─────────────────────────────────────────────────────────────────────

const agent = new SvaraAgent({
  name: 'Aria Support',
  model: 'gpt-4o-mini',
  knowledge: './policies',  // auto-indexed on start()

  systemPrompt: `You are Aria, the customer support assistant for Acme Store.
You are helpful, empathetic, and solution-focused.
You can check order status and answer questions from our knowledge base.
Always greet customers by name if they provide it.`,

  memory: { window: 30 },
  tools: [orderStatus],
});

// ── Channels ──────────────────────────────────────────────────────────────────

agent
  // Web API — for website chat widget
  .connectChannel('web', {
    port: 3000,
    cors: true,
  })

  // Telegram Bot
  .connectChannel('telegram', {
    token: process.env.TELEGRAM_BOT_TOKEN!,
    mode: 'polling', // use 'webhook' in production
  })

  // WhatsApp Business
  .connectChannel('whatsapp', {
    token: process.env.WA_ACCESS_TOKEN!,
    phoneId: process.env.WA_PHONE_ID!,
    verifyToken: process.env.WA_VERIFY_TOKEN!,
  });

// ── Events ────────────────────────────────────────────────────────────────────

agent.on('message:received', ({ message, sessionId }: { message: string; sessionId: string }) => {
  console.log(`[${sessionId.slice(0, 8)}] User: ${message.slice(0, 50)}...`);
});

agent.on('tool:call', ({ tools }: { tools: string[] }) => {
  console.log(`[Tools] → ${tools.join(', ')}`);
});

agent.on('channel:ready', ({ channel }: { channel: string }) => {
  console.log(`[Channel] ${channel} is ready`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

await agent.start();
console.log('\n🚀 Aria Support is live across all channels!\n');
