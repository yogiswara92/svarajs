/**
 * @module tools/builtin/sendFile
 * SvaraJS - hands a file the agent already created back to the user
 *
 * `file_write` and scripts run through `terminal_exec` (e.g. the docx/xlsx/pptx
 * skills) leave their output sitting on the server's local disk - invisible to
 * whoever is chatting with the agent, in every channel. `send_file` registers
 * an existing file under a random capability token and queues it as an
 * attachment for the reply currently being generated; `agent.ts` drains that
 * queue after the tool-calling loop and channels/the dashboard use the token
 * to actually deliver the bytes (upload to Telegram/Discord/etc, or serve it
 * over HTTP for the web chat's download link).
 *
 * The registry is in-memory only and does not survive a process restart -
 * same tradeoff as the shared browser instance in builtin/browser.ts. Entries
 * older than FILE_TTL_MS are pruned so long-running processes don't leak
 * memory over files nobody ever downloaded.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { validateWithinDir } from '../../security/pathGuard.js';
import type { Tool } from '../../types.js';

export interface RegisteredFile {
  absolutePath: string;
  filename: string;
  mimeType?: string;
  size: number;
  sessionId: string;
  createdAt: number;
}

const MIME_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const FILE_TTL_MS = 24 * 60 * 60 * 1000;

const registry = new Map<string, RegisteredFile>();
const pendingBySession = new Map<string, string[]>();

function pruneExpired(): void {
  const cutoff = Date.now() - FILE_TTL_MS;
  for (const [token, file] of registry) {
    if (file.createdAt < cutoff) registry.delete(token);
  }
}

/** Looks up a registered file by its capability token. Used by the dashboard's download route and by channels resolving an attachment to real bytes. */
export function getRegisteredFile(token: string): RegisteredFile | undefined {
  return registry.get(token);
}

/** Drains (and clears) the attachment tokens queued for a session during the turn that just finished. Called once by agent.ts after the tool-calling loop. */
export function drainPendingTokens(sessionId: string): string[] {
  const tokens = pendingBySession.get(sessionId) ?? [];
  pendingBySession.delete(sessionId);
  return tokens;
}

export interface SendFileToolOptions {
  /** Directory the agent (and this tool) is confined to. @default process.cwd() */
  rootDir?: string;
  /** Max attachable file size in bytes - keeps a runaway generated file from breaking delivery (e.g. Telegram's bot API caps documents at 50MB). @default 20_000_000 */
  maxFileSize?: number;
}

export function createSendFileTool(opts: SendFileToolOptions = {}): Tool {
  const rootDir = opts.rootDir ?? process.cwd();
  const maxFileSize = opts.maxFileSize ?? 20_000_000;

  return {
    name: 'send_file',
    description:
      'Attach a file you already created on disk (via file_write, or a script run through terminal_exec - e.g. ' +
      'the docx/xlsx/pptx skills) to your reply, so the user actually receives it: as a download link in the web ' +
      'chat, or as a document in Telegram/Discord/Slack/WhatsApp. Call this once per file, after it exists. A file ' +
      'you generate but never pass to send_file stays invisible to the user - do not just report a file path.',
    parameters: {
      path: { type: 'string', description: "File path, relative to the agent's working directory", required: true },
      filename: { type: 'string', description: 'Display name shown to the user (defaults to the actual filename)' },
    },
    async run({ path: reqPath, filename }, ctx) {
      pruneExpired();
      const resolved = validateWithinDir(String(reqPath), rootDir);
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile()) {
        return { error: `File not found: ${reqPath}` };
      }
      if (stat.size > maxFileSize) {
        return { error: `File is ${stat.size} bytes, exceeds the ${maxFileSize}-byte attach limit.` };
      }

      const displayName = filename ? String(filename) : path.basename(resolved);
      const token = crypto.randomUUID();
      registry.set(token, {
        absolutePath: resolved,
        filename: displayName,
        mimeType: MIME_TYPES[path.extname(resolved).toLowerCase()],
        size: stat.size,
        sessionId: ctx.sessionId,
        createdAt: Date.now(),
      });

      const tokens = pendingBySession.get(ctx.sessionId) ?? [];
      tokens.push(token);
      pendingBySession.set(ctx.sessionId, tokens);

      return { attached: displayName, size: stat.size };
    },
  };
}
