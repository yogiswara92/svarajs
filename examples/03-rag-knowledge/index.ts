/**
 * @example RAG Knowledge Base Agent
 *
 * An agent that answers questions from your documents.
 * Drop files in ./docs and the agent knows everything in them.
 *
 * Supported: PDF, Markdown, TXT, DOCX, HTML, JSON
 *
 * Run: npx tsx index.ts
 *
 * curl -X POST http://localhost:3000/chat \
 *   -H "Content-Type: application/json" \
 *   -d '{ "message": "What is our refund policy?", "sessionId": "customer-42" }'
 */

import 'dotenv/config';
import { SvaraApp, SvaraAgent } from '@yesvara/svara';

const agent = new SvaraAgent({
  name: 'Knowledge Base Bot',
  model: 'gpt-4o-mini',

  systemPrompt: `You are a helpful customer support agent.
Answer questions using the provided documentation.
If you don't know the answer, say so honestly — don't make things up.
Always be friendly and professional.`,

  // Point to your docs folder — any file type, glob patterns work
  knowledge: './docs/**/*',

  memory: { window: 20 },
});

const app = new SvaraApp({ cors: true });
app.route('/chat', agent.handler());

app.listen(3000);
console.log('✓ Agent running on http://localhost:3000');
console.log('  Knowledge base auto-loads on first request');
