/**
 * @module security/pathGuard
 * SvaraJS - path traversal protection
 *
 * Shared by the filesystem tool and (later) the skill manager: any tool that
 * lets the LLM specify a path must resolve it against a fixed root and refuse
 * anything that escapes it (`../../etc/passwd`, absolute paths outside root, etc).
 */

import path from 'path';

export class PathTraversalError extends Error {
  constructor(requestedPath: string, root: string) {
    super(`[SvaraJS] Path "${requestedPath}" resolves outside the allowed root "${root}".`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Resolve `requestedPath` (relative or absolute) against `root` and verify
 * the result is still inside `root`. Throws `PathTraversalError` otherwise.
 *
 * @returns the resolved absolute path, safe to use.
 */
export function validateWithinDir(requestedPath: string, root: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, requestedPath);

  const relative = path.relative(resolvedRoot, resolvedTarget);
  const escapesRoot = relative.startsWith('..') || path.isAbsolute(relative);

  if (escapesRoot) {
    throw new PathTraversalError(requestedPath, resolvedRoot);
  }

  return resolvedTarget;
}
