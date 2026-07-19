import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { validateWithinDir, PathTraversalError } from '../security/pathGuard.js';

describe('validateWithinDir', () => {
  const root = path.join(os.tmpdir(), 'svara-pathguard-test');

  it('resolves a relative path within the root', () => {
    const resolved = validateWithinDir('foo/bar.txt', root);
    expect(resolved).toBe(path.resolve(root, 'foo/bar.txt'));
  });

  it('throws PathTraversalError for ../ escapes', () => {
    expect(() => validateWithinDir('../../etc/passwd', root)).toThrow(PathTraversalError);
  });

  it('throws PathTraversalError for an absolute path outside root', () => {
    expect(() => validateWithinDir('/etc/passwd', root)).toThrow(PathTraversalError);
  });

  it('allows the root itself', () => {
    expect(validateWithinDir('.', root)).toBe(path.resolve(root));
  });
});
