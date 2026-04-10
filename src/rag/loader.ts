/**
 * @module rag/loader
 * SvaraJS — Document loader
 *
 * Loads documents from various sources into a normalized format.
 * Supported formats: TXT, MD, PDF, DOCX, HTML, JSON
 *
 * @example
 * const loader = new DocumentLoader();
 * const docs = await loader.loadMany(['./docs/*.pdf', './knowledge/*.txt']);
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { Document, DocumentType } from '../core/types.js';

// ─── Loader Strategy Interface ────────────────────────────────────────────────

interface FileLoader {
  extensions: string[];
  load(filePath: string): Promise<string>;
}

// ─── Plain Text Loader ────────────────────────────────────────────────────────

class TextFileLoader implements FileLoader {
  extensions = ['.txt', '.md', '.mdx', '.rst', '.csv', '.log'];

  async load(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }
}

// ─── JSON Loader ──────────────────────────────────────────────────────────────

class JsonFileLoader implements FileLoader {
  extensions = ['.json', '.jsonl'];

  async load(filePath: string): Promise<string> {
    const raw = await fs.readFile(filePath, 'utf-8');

    if (path.extname(filePath) === '.jsonl') {
      // JSON Lines — one JSON object per line
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const obj = JSON.parse(line) as Record<string, unknown>;
          return Object.values(obj).join(' ');
        })
        .join('\n');
    }

    const data = JSON.parse(raw);
    return JSON.stringify(data, null, 2);
  }
}

// ─── HTML Loader ──────────────────────────────────────────────────────────────

class HtmlFileLoader implements FileLoader {
  extensions = ['.html', '.htm'];

  async load(filePath: string): Promise<string> {
    const raw = await fs.readFile(filePath, 'utf-8');
    // Strip HTML tags — simple regex, good enough for RAG
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

// ─── PDF Loader ───────────────────────────────────────────────────────────────

class PdfFileLoader implements FileLoader {
  extensions = ['.pdf'];

  async load(filePath: string): Promise<string> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;
      const buffer = await fs.readFile(filePath);
      const data = await pdfParse(buffer);
      return data.text;
    } catch {
      throw new Error(
        '[SvaraJS] PDF loading requires the "pdf-parse" package.\n' +
        'Run: npm install pdf-parse'
      );
    }
  }
}

// ─── DOCX Loader ──────────────────────────────────────────────────────────────

class DocxFileLoader implements FileLoader {
  extensions = ['.docx'];

  async load(filePath: string): Promise<string> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require('mammoth') as {
        extractRawText: (opts: { path: string }) => Promise<{ value: string }>;
      };
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } catch {
      throw new Error(
        '[SvaraJS] DOCX loading requires the "mammoth" package.\n' +
        'Run: npm install mammoth'
      );
    }
  }
}

// ─── DocumentLoader ───────────────────────────────────────────────────────────

export class DocumentLoader {
  private loaders: FileLoader[];
  private extensionMap: Map<string, FileLoader>;

  constructor() {
    this.loaders = [
      new TextFileLoader(),
      new JsonFileLoader(),
      new HtmlFileLoader(),
      new PdfFileLoader(),
      new DocxFileLoader(),
    ];

    this.extensionMap = new Map();
    for (const loader of this.loaders) {
      for (const ext of loader.extensions) {
        this.extensionMap.set(ext, loader);
      }
    }
  }

  /**
   * Load a single file into a Document.
   */
  async load(filePath: string): Promise<Document> {
    const ext = path.extname(filePath).toLowerCase();
    const loader = this.extensionMap.get(ext);

    if (!loader) {
      throw new Error(
        `[SvaraJS] Unsupported file type: "${ext}". ` +
        `Supported: ${[...this.extensionMap.keys()].join(', ')}`
      );
    }

    const content = await loader.load(filePath);
    const stats = await fs.stat(filePath);

    return {
      id: this.hashFile(filePath),
      content,
      type: this.detectType(ext),
      source: filePath,
      metadata: {
        filename: path.basename(filePath),
        extension: ext,
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
      },
    };
  }

  /**
   * Load multiple files. Silently skips unreadable files with a warning.
   */
  async loadMany(filePaths: string[]): Promise<Document[]> {
    const results: Document[] = [];

    for (const filePath of filePaths) {
      try {
        const doc = await this.load(filePath);
        results.push(doc);
      } catch (err) {
        console.warn(`[SvaraJS:RAG] Skipping "${filePath}": ${(err as Error).message}`);
      }
    }

    return results;
  }

  /** Check if this loader supports a given file extension. */
  supports(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.extensionMap.has(ext);
  }

  private detectType(ext: string): DocumentType {
    const map: Record<string, DocumentType> = {
      '.txt': 'text',
      '.md': 'markdown',
      '.mdx': 'markdown',
      '.pdf': 'pdf',
      '.html': 'html',
      '.htm': 'html',
      '.json': 'json',
      '.jsonl': 'json',
      '.docx': 'docx',
    };
    return map[ext] ?? 'text';
  }

  private hashFile(filePath: string): string {
    return crypto.createHash('md5').update(filePath).digest('hex');
  }
}
