/**
 * @example Agent with Skills
 *
 * An agent that can discover, read, and write its own skills - reusable
 * playbooks stored as `<id>/SKILL.md` under `skillsDir`. The agent decides
 * when to call skills_list / skill_view, and can save new skills itself via
 * skill_manage once it finds an approach worth reusing.
 *
 * Run: npx tsx index.ts
 *
 * curl -X POST http://localhost:3000/chat \
 *   -H "Content-Type: application/json" \
 *   -d '{ "message": "A customer wants a $30 refund for order #4821.", "sessionId": "user-1" }'
 */

import 'dotenv/config';
import { SvaraApp, SvaraAgent } from '@yesvara/svara';

// ── Create Agent ──────────────────────────────────────────────────────────────

const agent = new SvaraAgent({
  name: 'Support Bot',
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a support agent. Check for a relevant skill before answering policy questions.',
  skillsDir: './skills', // see ./skills/customer-refund/SKILL.md
});

// ── Start ─────────────────────────────────────────────────────────────────────

const app = new SvaraApp({ cors: true });
app.route('/chat', agent.handler());
app.listen(3000);

agent.on('tool:call', ({ tools }: { tools: string[] }) => {
  console.log(`[Tools] Calling: ${tools.join(', ')}`);
});
