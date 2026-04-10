/**
 * @module rag/retriever
 * SvaraJS — Vector retrieval for RAG
 *
 * Embeds document chunks and performs similarity search.
 * Uses in-memory vector store by default (great for dev),
 * with SQLite persistence for production.
 *
 * @example
 * const retriever = new VectorRetriever();
 * await retriever.init({ embeddings: { provider: 'openai' } });
 * await retriever.addDocuments(['./docs/*.pdf']);
 *
 * const context = await retriever.retrieve('What is the refund policy?');
 */

import type { RAGConfig, DocumentChunk, RetrievedContext } from '../core/types.js';
import type { RAGRetriever } from '../core/agent.js';
import { DocumentLoader } from './loader.js';
import { Chunker } from './chunker.js';

// ─── Embedding Interface ──────────────────────────────────────────────────────

interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

// ─── OpenAI Embeddings ────────────────────────────────────────────────────────

class OpenAIEmbeddings implements EmbeddingProvider {
  private client: unknown;
  private model: string;

  constructor(apiKey?: string, model = 'text-embedding-3-small') {
    this.model = model;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: OpenAI } = require('openai');
      this.client = new OpenAI({ apiKey: apiKey ?? process.env.OPENAI_API_KEY });
    } catch {
      throw new Error('[SvaraJS] OpenAI embeddings require the "openai" package.');
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const client = this.client as {
      embeddings: {
        create: (params: unknown) => Promise<{ data: Array<{ embedding: number[] }> }>;
      };
    };

    // Batch to avoid rate limits (max 2048 inputs per request)
    const BATCH_SIZE = 100;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await client.embeddings.create({
        model: this.model,
        input: batch,
      });
      results.push(...response.data.map((d) => d.embedding));
    }

    return results;
  }

  async embedOne(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding;
  }
}

// ─── Ollama Embeddings (local) ────────────────────────────────────────────────

class OllamaEmbeddings implements EmbeddingProvider {
  private baseURL: string;
  private model: string;

  constructor(model = 'nomic-embed-text', baseURL = 'http://localhost:11434') {
    this.model = model;
    this.baseURL = baseURL;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedOne(t)));
  }

  async embedOne(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseURL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!response.ok) {
      throw new Error(`[SvaraJS] Ollama embeddings failed: ${response.statusText}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }
}

// ─── In-Memory Vector Store ───────────────────────────────────────────────────

interface VectorEntry {
  chunk: DocumentChunk;
  embedding: number[];
}

class InMemoryVectorStore {
  private entries: VectorEntry[] = [];

  add(chunk: DocumentChunk, embedding: number[]): void {
    // Replace if same chunk id
    const existing = this.entries.findIndex((e) => e.chunk.id === chunk.id);
    if (existing >= 0) {
      this.entries[existing] = { chunk, embedding };
    } else {
      this.entries.push({ chunk, embedding });
    }
  }

  search(queryEmbedding: number[], topK: number, threshold = 0): DocumentChunk[] {
    const scored = this.entries.map((entry) => ({
      chunk: entry.chunk,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    return scored
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.chunk);
  }

  get size(): number {
    return this.entries.length;
  }
}

// ─── VectorRetriever ─────────────────────────────────────────────────────────

export class VectorRetriever implements RAGRetriever {
  private embedder!: EmbeddingProvider;
  private store: InMemoryVectorStore;
  private loader: DocumentLoader;
  private chunker: Chunker;
  private config!: RAGConfig;

  constructor() {
    this.store = new InMemoryVectorStore();
    this.loader = new DocumentLoader();
    this.chunker = new Chunker();
  }

  async init(config: RAGConfig): Promise<void> {
    this.config = config;

    // Init chunker with config
    if (config.chunking) {
      this.chunker = new Chunker({
        strategy: config.chunking.strategy ?? 'sentence',
        size: config.chunking.size ? config.chunking.size * 4 : 2000, // rough token→char
        overlap: config.chunking.overlap ? config.chunking.overlap * 4 : 200,
      });
    }

    // Init embeddings provider
    const emb = config.embeddings ?? { provider: 'openai' };
    switch (emb.provider) {
      case 'openai':
        this.embedder = new OpenAIEmbeddings(emb.apiKey, emb.model);
        break;
      case 'ollama':
        this.embedder = new OllamaEmbeddings(emb.model);
        break;
      default:
        throw new Error(`[SvaraJS] Unknown embeddings provider: "${emb.provider}"`);
    }
  }

  async addDocuments(filePaths: string[]): Promise<void> {
    const documents = await this.loader.loadMany(filePaths);
    if (!documents.length) return;

    const chunks = this.chunker.chunkMany(documents);
    if (!chunks.length) return;

    console.log(`[SvaraJS:RAG] Embedding ${chunks.length} chunk(s)...`);
    const embeddings = await this.embedder.embed(chunks.map((c) => c.content));

    for (let i = 0; i < chunks.length; i++) {
      this.store.add(chunks[i], embeddings[i]);
    }

    console.log(`[SvaraJS:RAG] Vector store now has ${this.store.size} chunk(s).`);
  }

  async retrieve(query: string, topK = 5): Promise<string> {
    if (this.store.size === 0) return '';

    const queryEmbedding = await this.embedder.embedOne(query);
    const threshold = this.config.retrieval?.threshold ?? 0.3;

    const chunks = this.store.search(queryEmbedding, topK, threshold);

    if (!chunks.length) return '';

    // Format chunks into a context string
    return chunks
      .map((chunk, i) => `[Context ${i + 1}]\nSource: ${String(chunk.metadata.filename ?? chunk.documentId)}\n${chunk.content}`)
      .join('\n\n---\n\n');
  }

  async retrieveChunks(query: string, topK = 5): Promise<RetrievedContext> {
    const queryEmbedding = await this.embedder.embedOne(query);
    const threshold = this.config.retrieval?.threshold ?? 0.3;
    const chunks = this.store.search(queryEmbedding, topK, threshold);

    return {
      chunks,
      query,
      totalFound: chunks.length,
    };
  }
}

// ─── Math Utils ──────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
