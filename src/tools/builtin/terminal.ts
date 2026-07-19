/**
 * @module tools/builtin/terminal
 * SvaraJS - built-in terminal execution tool
 *
 * Gives an agent a `terminal_exec` tool backed by a real shell. Every command
 * passes through an `ApprovalGate` first - commands that match a known
 * dangerous pattern are blocked unless allowlisted or explicitly approved.
 *
 * This is a heuristic safety net, not a sandbox - see docs/SECURITY.md.
 *
 * @example
 * agent.addTool(createTerminalTool({ cwd: process.cwd() }));
 */

import { spawn } from 'child_process';
import { ApprovalGate, type ApprovalGateOptions } from '../../security/approval.js';
import type { Tool } from '../../types.js';

export interface TerminalToolOptions {
  /** Working directory for executed commands (local backend only). @default process.cwd() */
  cwd?: string;
  /** Kill the process if it runs longer than this. @default 30000 */
  timeout?: number;
  /** Reuse an existing gate (e.g. shared across tools/dashboard) instead of creating one. */
  approvalGate?: ApprovalGate;
  /** Options for the gate created when `approvalGate` isn't provided. */
  approval?: ApprovalGateOptions;
  /**
   * Where commands actually execute.
   * - `'local'` - runs directly on this process's host (default). The
   *   approval gate is a heuristic, not a sandbox - see docs/SECURITY.md.
   * - `'docker'` - runs via `docker exec` inside an already-running
   *   container, a real OS-level boundary. Requires `dockerContainer`.
   * @default 'local'
   */
  backend?: 'local' | 'docker';
  /** Container name/id to `docker exec` into. Required when `backend: 'docker'`. */
  dockerContainer?: string;
}

export function createTerminalTool(opts: TerminalToolOptions = {}): Tool {
  const cwd = opts.cwd ?? process.cwd();
  const timeout = opts.timeout ?? 30_000;
  const gate = opts.approvalGate ?? new ApprovalGate(opts.approval);
  const backend = opts.backend ?? 'local';

  if (backend === 'docker' && !opts.dockerContainer) {
    throw new Error('[SvaraJS] createTerminalTool: "dockerContainer" is required when backend is "docker".');
  }

  return {
    name: 'terminal_exec',
    description:
      'Run a shell command and return its stdout/stderr/exit code. ' +
      'Commands matching a dangerous pattern (rm -rf, sudo, mkfs, ...) require approval.',
    parameters: {
      command: { type: 'string', description: 'The shell command to execute', required: true },
    },
    timeout: timeout + 5_000, // give the tool executor a bit more room than the process kill timeout
    async run({ command }) {
      const cmd = String(command);

      const { allowed, reason } = await gate.check(cmd);
      if (!allowed) {
        return {
          blocked: true,
          reason: reason ?? 'Command blocked by approval gate.',
        };
      }

      return backend === 'docker'
        ? runInDocker(cmd, opts.dockerContainer!, timeout)
        : runShell(cmd, cwd, timeout);
    },
  };
}

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runInDocker(command: string, container: string, timeout: number): Promise<ShellResult> {
  return runProcess('docker', ['exec', container, 'sh', '-c', command], undefined, timeout);
}

function runShell(command: string, cwd: string, timeout: number): Promise<ShellResult> {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
  return runProcess(shell, shellArgs, cwd, timeout);
}

function runProcess(command: string, args: string[], cwd: string | undefined, timeout: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (exitCode) => {
      clearTimeout(killer);
      resolve({
        stdout: stdout.slice(0, 20_000),
        stderr: stderr.slice(0, 20_000),
        exitCode,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: null, timedOut });
    });
  });
}
