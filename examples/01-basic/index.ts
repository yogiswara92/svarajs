/**
 * @example Basic Agent
 *
 * The simplest possible SvaraJS agent.
 * 10 lines. Works out of the box.
 *
 * Run: npx tsx index.ts
 *
 * curl -X POST http://localhost:3000/chat \
 *   -H "Content-Type: application/json" \
 *   -d '{ "message": "Hello! What can you do?" }'
 */

import 'dotenv/config';
import { SvaraApp, SvaraAgent } from '@yesvara/svara';

const app = new SvaraApp({ cors: true });

const agent = new SvaraAgent({
  name: 'Aria',
  model: 'gpt-4o-mini',
  systemPrompt: 'You are Aria, a friendly and helpful AI assistant. Keep responses concise.',
});

app.route('/chat', agent.handler());
app.listen(3000);
