import 'dotenv/config';
import { SvaraApp, SvaraAgent } from './src/index.js';

async function main() {
  const app = new SvaraApp({ cors: true });
  
  const agent = new SvaraAgent({
    name: 'TestAgent',
    model: 'gpt-4o-mini',
    knowledge: '/Users/920078/Documents/svara/contoh_folder_knowledge/**/*',
    verbose: true,
  });
  
  await agent.start();
  app.route('/chat', agent.handler());
  app.listen(3000);
  console.log('✓ Test server on port 3000');
}

main().catch(console.error);
