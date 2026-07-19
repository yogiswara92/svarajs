import { describe, it, expect } from 'vitest';
import { Chunker } from '../rag/chunker.js';
import type { Document } from '../core/types.js';

function makeDoc(content: string): Document {
  return {
    id: 'doc1',
    content,
    type: 'text',
    source: 'test.txt',
    metadata: { filename: 'test.txt', extension: '.txt', size: content.length, lastModified: new Date().toISOString() },
  };
}

describe('Chunker', () => {
  it('returns no chunks for empty content', () => {
    const chunker = new Chunker();
    expect(chunker.chunk(makeDoc('   '))).toEqual([]);
  });

  it('splits by sentence and stays under the size budget', () => {
    const chunker = new Chunker({ strategy: 'sentence', size: 40, overlap: 0 });
    const text = 'This is one sentence. This is another one. And a third sentence here.';
    const chunks = chunker.chunk(makeDoc(text));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.metadata.strategy).toBe('sentence');
    }
  });

  it('splits by paragraph on blank lines', () => {
    const chunker = new Chunker({ strategy: 'paragraph', size: 1000 });
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = chunker.chunk(makeDoc(text));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Paragraph one.');
    expect(chunks[0].content).toContain('Paragraph three.');
  });

  it('splits fixed-size windows with overlap', () => {
    const chunker = new Chunker({ strategy: 'fixed', size: 10, overlap: 2 });
    const text = 'a'.repeat(25);
    const chunks = chunker.chunk(makeDoc(text));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content.length).toBeLessThanOrEqual(10);
  });

  it('assigns stable, deterministic chunk ids', () => {
    const chunker = new Chunker({ strategy: 'fixed', size: 10, overlap: 0 });
    const doc = makeDoc('a'.repeat(20));
    const first = chunker.chunk(doc);
    const second = chunker.chunk(doc);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
  });
});
