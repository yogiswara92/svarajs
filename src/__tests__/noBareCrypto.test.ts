import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Node 18 (still common on VPSes, and what `engines` allows) has no global `crypto`: any source file that
// calls `crypto.something` must import it, or it works on a Node 20+ dev laptop and fails on the server.
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('Node 18 compatibility', () => {
  it('imports crypto in every source file that uses it', () => {
    const offenders = walk(path.resolve(__dirname, '..')).filter((f) => {
      const src = fs.readFileSync(f, 'utf-8');
      if (!/\bcrypto\.[a-zA-Z]/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) return false;
      return !/import\s+(\*\s+as\s+)?crypto\b|import\s*\{[^}]*\}\s*from\s*'(node:)?crypto'|require\('(node:)?crypto'\)/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
