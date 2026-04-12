import 'dotenv/config';
import { SvaraApp, SvaraAgent, createTool } from '@yesvara/svara';

/**
 * my-agent — powered by SvaraJS
 */

// Define tools
const timeTool = createTool({
  name: 'get_time',
  description: 'Get the current date and time',
  parameters: {},
  async run() {
    return {
      datetime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },
});

// Create agent
const agent = new SvaraAgent({
  name: 'my-agent',
  model: 'gpt-4o',
  systemPrompt: 'You are a helpful AI assistant. Be concise and friendly.',
  tools: [timeTool],
  knowledge: './docs', // Add your documents here for RAG
});

// Setup channels
const app = new SvaraApp({ cors: true });
app.route('/chat', agent.handler());
app.listen(3000);

console.log('✨ my-agent is running!');
