/**
 * @example Agent with Tools
 *
 * An agent that can call custom functions (tools).
 * The LLM decides when to call each tool based on the conversation.
 *
 * Run: npx tsx index.ts
 *
 * curl -X POST http://localhost:3000/chat \
 *   -H "Content-Type: application/json" \
 *   -d '{ "message": "What time is it? Also, what is 42 * 17?", "sessionId": "user-1" }'
 */

import 'dotenv/config';
import { SvaraApp, SvaraAgent, createTool } from '@yesvara/svara';

// ── Define Tools ──────────────────────────────────────────────────────────────

const getCurrentTime = createTool({
  name: 'get_current_time',
  description: 'Get the current date and time in a specific timezone',
  parameters: {
    timezone: {
      type: 'string',
      description: 'IANA timezone name, e.g. "Asia/Jakarta", "America/New_York"',
    },
  },
  async run({ timezone = 'UTC' }) {
    return {
      datetime: new Date().toLocaleString('en-US', { timeZone: timezone as string }),
      timezone,
    };
  },
});

const calculate = createTool({
  name: 'calculate',
  description: 'Evaluate a safe mathematical expression',
  parameters: {
    expression: {
      type: 'string',
      description: 'Math expression to evaluate, e.g. "42 * 17", "(100 + 50) / 3"',
      required: true,
    },
  },
  async run({ expression }) {
    // Very simple safe eval — in production use a proper math library
    const result = Function(`"use strict"; return (${expression as string})`)() as number;
    return { expression, result };
  },
  timeout: 5_000,
});

// ── Create Agent ──────────────────────────────────────────────────────────────

const agent = new SvaraAgent({
  name: 'Calculator Bot',
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a helpful assistant with access to real-time data and calculation tools.',
  memory: { window: 10 },
  tools: [getCurrentTime, calculate],
});

// ── Start ─────────────────────────────────────────────────────────────────────

const app = new SvaraApp({ cors: true });
app.route('/chat', agent.handler());
app.listen(3000);

// Observe tool usage
agent.on('tool:call', ({ tools }: { tools: string[] }) => {
  console.log(`[Tools] Calling: ${tools.join(', ')}`);
});
