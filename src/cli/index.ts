#!/usr/bin/env node
/**
 * SvaraJS CLI
 *
 * Usage:
 *   svara new <name>        Create a new project
 *   svara dev               Start dev server with hot-reload
 *   svara build             Compile TypeScript to JavaScript
 *   svara --version         Show version
 *   svara --help            Show help
 */

import { Command } from 'commander';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../package.json') as { version: string; description: string };

const program = new Command();

program
  .name('svara')
  .description(pkg.description)
  .version(pkg.version, '-v, --version');

// ── svara new <name> ──────────────────────────────────────────────────────────
program
  .command('new <name>')
  .description('Create a new SvaraJS project')
  .option('--provider <provider>', 'LLM provider (openai|anthropic|ollama)', 'openai')
  .option('--channel <channels...>', 'Channels to include', ['web'])
  .option('--no-install', 'Skip npm install')
  .action(async (name: string, opts: { provider: string; channel: string[]; install: boolean }) => {
    const { newProject } = await import('./commands/new.js');
    await newProject({
      name,
      provider: opts.provider as 'openai' | 'anthropic' | 'ollama',
      channels: opts.channel,
      installDeps: opts.install,
    });
  });

// ── svara dev ─────────────────────────────────────────────────────────────────
program
  .command('dev')
  .description('Start development server with hot-reload')
  .option('--entry <file>', 'Entry file', 'src/index.ts')
  .option('--port <port>', 'Override PORT env variable')
  .action(async (opts: { entry: string; port?: string }) => {
    const { devServer } = await import('./commands/dev.js');
    await devServer({
      entry: opts.entry,
      port: opts.port ? parseInt(opts.port, 10) : undefined,
    });
  });

// ── svara build ───────────────────────────────────────────────────────────────
program
  .command('build')
  .description('Compile TypeScript to JavaScript')
  .action(async () => {
    const { execSync } = await import('child_process');
    console.log('🔨 Building...');
    try {
      execSync('npx tsc', { stdio: 'inherit' });
      console.log('✅ Build complete → dist/');
    } catch {
      process.exit(1);
    }
  });

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
