/**
 * @module tools/builtin/filesystem
 * SvaraJS - built-in filesystem tools
 *
 * `file_read`, `file_write`, `list_files` - all paths are resolved against
 * a fixed `rootDir` via `validateWithinDir`, so the agent can't escape it
 * with `../` traversal or an absolute path outside the root.
 *
 * @example
 * agent.tools ??= [];
 * agent.addTool(...createFilesystemTools({ rootDir: './workspace' }));
 */

import fs from 'fs/promises';
import path from 'path';
import { validateWithinDir } from '../../security/pathGuard.js';
import type { Tool } from '../../types.js';

export interface FilesystemToolsOptions {
  /** Directory the agent is confined to. @default process.cwd() */
  rootDir?: string;
  /** Max file size (bytes) file_read/file_write will handle. @default 1_000_000 */
  maxFileSize?: number;
}

export function createFilesystemTools(opts: FilesystemToolsOptions = {}): Tool[] {
  const rootDir = opts.rootDir ?? process.cwd();
  const maxFileSize = opts.maxFileSize ?? 1_000_000;

  const fileRead: Tool = {
    name: 'file_read',
    description: `Read a UTF-8 text file. Paths are relative to the agent's confined root directory (${rootDir}).`,
    parameters: {
      path: { type: 'string', description: 'File path, relative to the root directory', required: true },
    },
    async run({ path: reqPath }) {
      const resolved = validateWithinDir(String(reqPath), rootDir);
      const stat = await fs.stat(resolved);
      if (stat.size > maxFileSize) {
        return { error: `File is ${stat.size} bytes, exceeds the ${maxFileSize}-byte limit.` };
      }
      return { content: await fs.readFile(resolved, 'utf-8'), size: stat.size };
    },
  };

  const fileWrite: Tool = {
    name: 'file_write',
    description: `Write (create or overwrite) a UTF-8 text file inside the agent's confined root directory (${rootDir}).`,
    parameters: {
      path: { type: 'string', description: 'File path, relative to the root directory', required: true },
      content: { type: 'string', description: 'Full file content to write', required: true },
    },
    async run({ path: reqPath, content }) {
      const text = String(content);
      if (Buffer.byteLength(text, 'utf-8') > maxFileSize) {
        return { error: `Content is larger than the ${maxFileSize}-byte limit.` };
      }
      const resolved = validateWithinDir(String(reqPath), rootDir);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, text, 'utf-8');
      return { written: true, path: reqPath, bytes: Buffer.byteLength(text, 'utf-8') };
    },
  };

  const listFiles: Tool = {
    name: 'list_files',
    description: `List files and directories inside the agent's confined root directory (${rootDir}).`,
    parameters: {
      path: { type: 'string', description: 'Directory path, relative to the root directory', default: '.' },
    },
    async run({ path: reqPath }) {
      const resolved = validateWithinDir(String(reqPath ?? '.'), rootDir);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return {
        entries: entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        })),
      };
    },
  };

  return [fileRead, fileWrite, listFiles];
}
