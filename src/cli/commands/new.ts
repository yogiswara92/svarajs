/**
 * @module cli/commands/new
 * SvaraJS — `svara new <project-name>` command
 *
 * Scaffolds a new SvaraJS project with opinionated defaults.
 * Creates a ready-to-run project in seconds.
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

interface ScaffoldOptions {
  name: string;
  provider?: 'openai' | 'anthropic' | 'ollama';
  channels?: string[];
  installDeps?: boolean;
}

export async function newProject(options: ScaffoldOptions): Promise<void> {
  const { name, provider = 'openai', channels = ['web'] } = options;
  const targetDir = path.resolve(process.cwd(), name);

  console.log(`\n✨ Creating SvaraJS project: ${name}\n`);

  // Check if directory already exists
  try {
    await fs.access(targetDir);
    console.error(`❌ Directory "${name}" already exists.`);
    process.exit(1);
  } catch {
    // Good — it doesn't exist
  }

  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(path.join(targetDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(targetDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(targetDir, 'data'), { recursive: true });

  const files: Record<string, string> = {
    'package.json': generatePackageJson(name),
    'tsconfig.json': generateTsConfig(),
    '.env.example': generateEnvExample(provider, channels),
    '.gitignore': generateGitignore(),
    'src/index.ts': generateIndexFile(name, provider, channels),
    'docs/README.md': `# ${name} Knowledge Base\n\nAdd your documents here for RAG.\n`,
  };

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(targetDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    console.log(`  ✓ ${filePath}`);
  }

  if (options.installDeps !== false) {
    console.log('\n📦 Installing dependencies...\n');
    try {
      execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
    } catch {
      console.warn('\n⚠️  Dependency install failed. Run "npm install" manually.\n');
    }
  }

  console.log(`
✅ Project ready!

  cd ${name}
  cp .env.example .env     # Add your API keys
  npm run dev              # Start the agent

📚 Docs: https://svarajs.dev
`);
}

// ─── File Templates ────────────────────────────────────────────────────────────

function generatePackageJson(name: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'tsx watch src/index.ts',
      build: 'tsc',
      start: 'node dist/index.js',
    },
    dependencies: {
      '@yesvara/svara': '^0.1.3',
      dotenv: '^16.4.5',
    },
    devDependencies: {
      '@types/node': '^20.14.2',
      tsx: '^4.15.7',
      typescript: '^5.4.5',
    },
  }, null, 2);
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'bundler',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist'],
  }, null, 2);
}

function generateEnvExample(
  provider: string,
  channels: string[]
): string {
  const lines = ['# SvaraJS Environment Variables', ''];

  if (provider === 'openai') {
    lines.push('# OpenAI', 'OPENAI_API_KEY=sk-...', '');
  } else if (provider === 'anthropic') {
    lines.push('# Anthropic', 'ANTHROPIC_API_KEY=sk-ant-...', '');
  }

  if (channels.includes('telegram')) {
    lines.push('# Telegram', 'TELEGRAM_BOT_TOKEN=...', '');
  }
  if (channels.includes('whatsapp')) {
    lines.push('# WhatsApp', 'WA_ACCESS_TOKEN=...', 'WA_PHONE_ID=...', 'WA_VERIFY_TOKEN=...', '');
  }

  return lines.join('\n');
}

function generateIndexFile(
  name: string,
  provider: string,
  channels: string[]
): string {
  const modelMap: Record<string, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-opus-4-6',
    ollama: 'llama3',
  };

  const channelSetup = channels.includes('web')
    ? `const app = new SvaraApp({ cors: true });\napp.route('/chat', agent.handler());\napp.listen(3000);`
    : channels.length > 0
      ? `agent\n  ${channels
          .map((ch) => {
            if (ch === 'telegram') return `.connectChannel('telegram', { token: process.env.TELEGRAM_BOT_TOKEN! })`;
            if (ch === 'whatsapp')
              return `.connectChannel('whatsapp', {\n    token: process.env.WA_ACCESS_TOKEN!,\n    phoneId: process.env.WA_PHONE_ID!,\n    verifyToken: process.env.WA_VERIFY_TOKEN!,\n  })`;
            return '';
          })
          .filter(Boolean)
          .join('\n  ')};\nawait agent.start();`
      : '';

  return `import 'dotenv/config';
import { SvaraApp, SvaraAgent, createTool } from '@yesvara/svara';

/**
 * ${name} — powered by SvaraJS
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
  name: '${name}',
  model: '${modelMap[provider] ?? 'gpt-4o-mini'}',
  systemPrompt: 'You are a helpful AI assistant. Be concise and friendly.',
  tools: [timeTool],
  knowledge: './docs/**/*', // Add your documents here for RAG
});

// Setup channels
${channelSetup}

console.log('✨ ${name} is running!');
`;
}

function generateGitignore(): string {
  return `node_modules/
dist/
.env
data/*.db
*.log
`;
}
