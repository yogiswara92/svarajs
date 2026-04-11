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
import path from 'path';
import fs from 'fs';

// Load package.json (works in both CommonJS and ESM)
const pkgPath = path.resolve(path.dirname(__filename), '../../package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string; description: string };

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

// ── svara db:* commands ────────────────────────────────────────────────────────

// svara db:list-chunks
program
  .command('db:list-chunks')
  .description('List all chunks in vector store')
  .option('--agent <name>', 'Filter by agent name')
  .action(async (opts: { agent?: string }) => {
    const { listChunks } = await import('./commands/db.js');
    await listChunks(opts);
  });

// svara db:search
program
  .command('db:search <query>')
  .description('Search chunks by content')
  .option('--agent <name>', 'Filter by agent name')
  .option('--limit <num>', 'Number of results', '5')
  .action(async (query: string, opts: { agent?: string; limit: string }) => {
    const { searchChunks } = await import('./commands/db.js');
    await searchChunks(query, {
      agent: opts.agent,
      limit: parseInt(opts.limit, 10),
    });
  });

// svara db:stats
program
  .command('db:stats')
  .description('Show database statistics')
  .option('--agent <name>', 'Filter by agent name')
  .action(async (opts: { agent?: string }) => {
    const { dbStats } = await import('./commands/db.js');
    await dbStats(opts);
  });

// svara db:users
program
  .command('db:users')
  .description('List all users in the database')
  .action(async () => {
    const { listUsers } = await import('./commands/db.js');
    await listUsers();
  });

// svara db:sessions
program
  .command('db:sessions')
  .description('List all sessions in the database')
  .option('--user <email>', 'Filter by user email')
  .action(async (opts: { user?: string }) => {
    const { listSessions } = await import('./commands/db.js');
    await listSessions(opts);
  });

// svara db:clear-chunks
program
  .command('db:clear-chunks <agent>')
  .description('Delete all chunks for an agent (requires --yes confirmation)')
  .option('--yes', 'Confirm deletion')
  .action(async (agent: string, opts: { yes?: boolean }) => {
    const { clearChunksConfirmed, clearChunks } = await import('./commands/db.js');
    if (opts.yes) {
      await clearChunksConfirmed(agent);
    } else {
      await clearChunks(agent);
    }
  });

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
