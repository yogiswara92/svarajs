/**
 * @module tools/builtin/dockerExec
 * SvaraJS - run one command inside an already-running container
 *
 * Shared by the `docker` backend of the filesystem and send_file tools (the
 * terminal tool has its own). Arguments go to `docker exec` as an argv array,
 * never through a host shell, and the output is collected as raw bytes so a
 * binary file survives the round trip.
 */

import { spawn } from 'child_process';
import path from 'path';

export interface DockerExecResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
}

export function dockerExec(
  container: string,
  args: string[],
  opts: { input?: string | Buffer; timeout?: number; maxBytes?: number } = {},
): Promise<DockerExecResult> {
  const timeout = opts.timeout ?? 60_000;
  const maxBytes = opts.maxBytes ?? 25_000_000;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', ...(opts.input !== undefined ? ['-i'] : []), container, ...args], { env: process.env });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (size > maxBytes) { reject(new Error(`Output is larger than ${maxBytes} bytes.`)); return; }
      resolve({ stdout: Buffer.concat(chunks), stderr: stderr.trim(), exitCode: code });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

/** Resolves `requested` against the container-side `root` (POSIX paths), refusing anything outside it. */
export function containerPath(requested: string, root: string): string {
  const target = path.posix.resolve(root, requested);
  const rel = path.posix.relative(root, target);
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) {
    throw new Error(`[SvaraJS] Path "${requested}" resolves outside the allowed root "${root}".`);
  }
  return target;
}
