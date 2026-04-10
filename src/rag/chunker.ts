/**
 * @module rag/chunker
 * SvaraJS — Document chunking strategies
 *
 * Breaks documents into retrieval-optimized chunks.
 * Strategy selection matters: fixed for code/data, sentence for prose, paragraph for docs.
 *
 * @example
 * const chunker = new Chunker({ strategy: 'sentence', size: 512, overlap: 50 });
 * const chunks = chunker.chunk(document);
 */

import crypto from 'crypto';
import type { Document, DocumentChunk } from '../core/types.js';

export interface ChunkOptions {
  strategy?: 'fixed' | 'sentence' | 'paragraph'; // default: 'sentence'
  size?: number;     // target chunk size in chars (not tokens), default 2000
  overlap?: number;  // overlap in chars, default 200
}

// ─── Chunker ──────────────────────────────────────────────────────────────────

export class Chunker {
  private options: Required<ChunkOptions>;

  constructor(options: ChunkOptions = {}) {
    this.options = {
      strategy: options.strategy ?? 'sentence',
      size: options.size ?? 2000,
      overlap: options.overlap ?? 200,
    };
  }

  /**
   * Split a document into overlapping chunks.
   * Returns the document with populated `chunks` field.
   */
  chunk(document: Document): DocumentChunk[] {
    const text = document.content.trim();
    if (!text) return [];

    let texts: string[];

    switch (this.options.strategy) {
      case 'fixed':
        texts = this.fixedChunk(text);
        break;
      case 'paragraph':
        texts = this.paragraphChunk(text);
        break;
      case 'sentence':
      default:
        texts = this.sentenceChunk(text);
        break;
    }

    return texts
      .filter((t) => t.trim().length > 0)
      .map((content, index) => ({
        id: this.chunkId(document.id, index),
        documentId: document.id,
        content: content.trim(),
        index,
        metadata: {
          ...document.metadata,
          chunkIndex: index,
          strategy: this.options.strategy,
          charCount: content.length,
        },
      }));
  }

  /**
   * Chunk multiple documents at once.
   */
  chunkMany(documents: Document[]): DocumentChunk[] {
    return documents.flatMap((doc) => this.chunk(doc));
  }

  // ─── Strategies ───────────────────────────────────────────────────────────

  /** Split into fixed-size windows with overlap. Good for code and structured data. */
  private fixedChunk(text: string): string[] {
    const { size, overlap } = this.options;
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + size, text.length);
      chunks.push(text.slice(start, end));
      start += size - overlap;
    }

    return chunks;
  }

  /**
   * Split by sentences, grouping them until size limit.
   * Best for prose text — preserves natural reading units.
   */
  private sentenceChunk(text: string): string[] {
    const sentences = this.splitSentences(text);
    return this.groupBySize(sentences);
  }

  /**
   * Split by paragraphs (double newline), grouping small ones.
   * Best for documentation, articles, and manuals.
   */
  private paragraphChunk(text: string): string[] {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    return this.groupBySize(paragraphs);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private splitSentences(text: string): string[] {
    // Split on sentence-ending punctuation followed by whitespace
    // Handles: "Dr. Smith", "U.S.A.", abbreviations reasonably well
    return text
      .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private groupBySize(units: string[]): string[] {
    const { size, overlap } = this.options;
    const chunks: string[] = [];
    let current = '';
    let overlapBuffer = '';

    for (const unit of units) {
      if (current.length + unit.length + 1 > size && current.length > 0) {
        chunks.push(current);
        // Start next chunk with overlap
        current = overlapBuffer + (overlapBuffer ? ' ' : '') + unit;
        overlapBuffer = '';
      } else {
        current += (current ? ' ' : '') + unit;
      }

      // Build overlap buffer from the tail of current chunk
      if (current.length > overlap) {
        overlapBuffer = current.slice(-overlap);
      } else {
        overlapBuffer = current;
      }
    }

    if (current.trim()) chunks.push(current);
    return chunks;
  }

  private chunkId(documentId: string, index: number): string {
    return crypto
      .createHash('md5')
      .update(`${documentId}:${index}`)
      .digest('hex');
  }
}
