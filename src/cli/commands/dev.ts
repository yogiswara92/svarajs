/**
 * @module cli/commands/dev
 * SvaraJS — `svara dev` command
 *
 * Starts a development server with hot-reload and a pretty REPL.
 * Wraps tsx watch for TypeScript + restarts on file changes.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

interface DevOptions {
  entry?: string;
  port?: number;
}

export async function devServer(options: DevOptions = {}): Promise<void> {
  const entry = options.entry ?? findEntry();

  if (!entry) {
    console.error(`
❌ Could not find entry file.

Create src/index.ts or specify one:
  svara dev --entry src/app.ts
`);
    process.exit(1);
  }

  console.log(`
🚀 SvaraJS Dev Server
─────────────────────
  Entry: ${entry}
  Watch: enabled

`);

  const runner = spawn(
    'npx',
    ['tsx', 'watch', '--clear-screen=false', entry],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ...(options.port ? { PORT: String(options.port) } : {}),
      },
    }
  );

  runner.on('error', (err) => {
    console.error('\n❌ Dev server error:', err.message);
    console.error('Make sure "tsx" is installed: npm install -D tsx');
  });

  runner.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.exit(code);
    }
  });

  // Forward signals
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      runner.kill(signal);
      process.exit(0);
    });
  }
}

function findEntry(): string | null {
  const candidates = [
    'src/index.ts',
    'src/app.ts',
    'src/main.ts',
    'index.ts',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.resolve(process.cwd(), candidate))) {
      return candidate;
    }
  }

  return null;
}
