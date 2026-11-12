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
import { containerPath, dockerExec } from './dockerExec.js';

export interface FilesystemToolsOptions {
  /** Directory the agent is confined to. @default process.cwd() */
  rootDir?: string;
  /** Max file size (bytes) file_read/file_write will handle. @default 1_000_000 */
  maxFileSize?: number;
  /**
   * Where the files live: `'local'` (default) is this machine's disk; `'docker'` works inside an
   * already-running container (the same one the terminal tool's docker backend uses), so the agent's
   * files never touch the host. With docker, `rootDir` is a path inside the container (default `/workspace`).
   */
  backend?: 'local' | 'docker';
  /** Container name/id. Required when `backend: 'docker'`. */
  dockerContainer?: string;
}

export function createFilesystemTools(opts: FilesystemToolsOptions = {}): Tool[] {
  if (opts.backend === 'docker') return createDockerFilesystemTools(opts);
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

/** The same three tools, run inside a container: every path is resolved and opened there, never on the host. */
function createDockerFilesystemTools(opts: FilesystemToolsOptions): Tool[] {
  const container = opts.dockerContainer;
  if (!container) throw new Error('[SvaraJS] createFilesystemTools: "dockerContainer" is required when backend is "docker".');
  const rootDir = opts.rootDir ?? '/workspace';
  const maxFileSize = opts.maxFileSize ?? 1_000_000;
  const failed = (r: { stderr: string; exitCode: number | null }, what: string) => ({ error: r.stderr || `${what} failed (exit ${r.exitCode}).` });

  const fileRead: Tool = {
    name: 'file_read',
    description: `Read a UTF-8 text file. Paths are relative to the agent's workspace (${rootDir}).`,
    parameters: {
      path: { type: 'string', description: 'File path, relative to the workspace', required: true },
    },
    async run({ path: reqPath }) {
      const target = containerPath(String(reqPath), rootDir);
      const r = await dockerExec(container, ['sh', '-c',
        'if [ ! -f "$1" ]; then echo "File not found: $1" >&2; exit 3; fi; '
        + 's=$(wc -c < "$1" | tr -d "[:space:]"); if [ "$s" -gt "$2" ]; then echo "File is $s bytes, exceeds the $2-byte limit." >&2; exit 4; fi; cat -- "$1"',
        'sh', target, String(maxFileSize)]);
      if (r.exitCode !== 0) return failed(r, 'Read');
      return { content: r.stdout.toString('utf-8'), size: r.stdout.length };
    },
  };

  const fileWrite: Tool = {
    name: 'file_write',
    description: `Write (create or overwrite) a UTF-8 text file inside the agent's workspace (${rootDir}).`,
    parameters: {
      path: { type: 'string', description: 'File path, relative to the workspace', required: true },
      content: { type: 'string', description: 'Full file content to write', required: true },
    },
    async run({ path: reqPath, content }) {
      const text = String(content);
      const bytes = Buffer.byteLength(text, 'utf-8');
      if (bytes > maxFileSize) return { error: `Content is larger than the ${maxFileSize}-byte limit.` };
      const target = containerPath(String(reqPath), rootDir);
      const r = await dockerExec(container, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', target], { input: text });
      if (r.exitCode !== 0) return failed(r, 'Write');
      return { written: true, path: reqPath, bytes };
    },
  };

  const listFiles: Tool = {
    name: 'list_files',
    description: `List files and directories inside the agent's workspace (${rootDir}).`,
    parameters: {
      path: { type: 'string', description: 'Directory path, relative to the workspace', default: '.' },
    },
    async run({ path: reqPath }) {
      const target = containerPath(String(reqPath ?? '.'), rootDir);
      const r = await dockerExec(container, ['sh', '-c',
        'mkdir -p "$2"; cd "$1" || exit 3; for e in * .[!.]* ..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; '
        + 'if [ -d "$e" ]; then printf "d %s\\n" "$e"; else printf "f %s\\n" "$e"; fi; done',
        'sh', target, rootDir]);
      if (r.exitCode !== 0) return failed(r, 'List');
      const entries = r.stdout.toString('utf-8').split('\n').filter(Boolean)
        .map((line) => ({ name: line.slice(2), type: line[0] === 'd' ? 'directory' : 'file' }));
      return { entries };
    },
  };

  return [fileRead, fileWrite, listFiles];
}
