import { describe, it, expect } from 'vitest';
import { countTokens } from '../memory/tokenizer.js';

describe('countTokens', () => {
  it('returns 0 for empty text', () => {
    expect(countTokens('')).toBe(0);
  });

  it('returns a positive count for real text', () => {
    expect(countTokens('The quick brown fox jumps over the lazy dog.')).toBeGreaterThan(0);
  });

  it('scales roughly with text length', () => {
    const short = countTokens('hello');
    const long = countTokens('hello '.repeat(100));
    expect(long).toBeGreaterThan(short * 10);
  });
});
