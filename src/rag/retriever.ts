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
import { SvaraDB } from '../database/sqlite.js';
import crypto from 'crypto';

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

// ─── Vector Store (Persistent with SQLite) ────────────────────────────────────

abstract class VectorStore {
  abstract add(chunk: DocumentChunk, embedding: number[]): Promise<void>;
  abstract search(queryEmbedding: number[], topK: number, threshold?: number): Promise<DocumentChunk[]>;
  abstract size(): Promise<number>;
  protected contentHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }
}

class PersistentVectorStore extends VectorStore {
  constructor(private db: SvaraDB, private agentName: string) {
    super();
  }

  async add(chunk: DocumentChunk, embedding: number[]): Promise<void> {
    const contentHash = this.contentHash(chunk.content);

    // Check if content already exists for this agent (deduplication per agent)
    const existing = this.db.query(
      'SELECT id FROM svara_chunks WHERE agent_name = ? AND content_hash = ?',
      [this.agentName, contentHash]
    ) as Array<{ id: string }>;

    if (existing.length > 0) {
      console.log(`[SvaraJS:RAG] Duplicate content detected for ${this.agentName}, skipping chunk ${chunk.id}`);
      return;
    }

    // Store embedding as JSON string
    const embeddingJson = JSON.stringify(embedding);

    this.db.run(
      `INSERT OR REPLACE INTO svara_chunks
       (id, agent_name, document_id, content, content_hash, chunk_index, embedding, source, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        chunk.id,
        this.agentName,
        chunk.documentId,
        chunk.content,
        contentHash,
        chunk.index,
        embeddingJson,
        chunk.source,
        JSON.stringify(chunk.metadata),
      ]
    );
  }

  async search(queryEmbedding: number[], topK: number, threshold = 0): Promise<DocumentChunk[]> {
    // Retrieve chunks for this agent only
    const rows = this.db.query(
      'SELECT id, document_id, content, chunk_index, embedding, source, metadata FROM svara_chunks WHERE agent_name = ? ORDER BY id DESC',
      [this.agentName]
    ) as Array<{
      id: string;
      document_id: string;
      content: string;
      chunk_index: number;
      embedding: string;
      source: string;
      metadata: string;
    }>;

    // Score and sort in-memory (SQLite doesn't have vector similarity)
    const scored = rows
      .map((row) => {
        const embedding = JSON.parse(row.embedding) as number[];
        return {
          chunk: {
            id: row.id,
            documentId: row.document_id,
            content: row.content,
            index: row.chunk_index,
            source: row.source,
            metadata: JSON.parse(row.metadata),
          } as DocumentChunk,
          score: cosineSimilarity(queryEmbedding, embedding),
        };
      })
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map((s) => s.chunk);
  }

  async size(): Promise<number> {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM svara_chunks WHERE agent_name = ?',
      [this.agentName]
    ) as Array<{
      count: number;
    }>;
    return result[0]?.count ?? 0;
  }
}

// ─── VectorRetriever ─────────────────────────────────────────────────────────

export class VectorRetriever implements RAGRetriever {
  private embedder!: EmbeddingProvider;
  private store!: VectorStore;
  private loader: DocumentLoader;
  private chunker: Chunker;
  private config!: RAGConfig;
  private db: SvaraDB;
  private agentName: string;

  constructor(agentName: string, db?: SvaraDB) {
    this.agentName = agentName;
    this.loader = new DocumentLoader();
    this.chunker = new Chunker();
    this.db = db || new SvaraDB('./data/svara.db');
  }

  async init(config: RAGConfig): Promise<void> {
    this.config = config;

    // Init vector store (persistent per agent)
    this.store = new PersistentVectorStore(this.db, this.agentName);

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
      await this.store.add(chunks[i], embeddings[i]);
    }

    const size = await this.store.size();
    console.log(`[SvaraJS:RAG] Vector store now has ${size} chunk(s).`);
  }

  async retrieve(query: string, topK = 5): Promise<string> {
    const size = await this.store.size();
    if (size === 0) return '';

    const queryEmbedding = await this.embedder.embedOne(query);
    const threshold = this.config.retrieval?.threshold ?? 0.3;

    const chunks = await this.store.search(queryEmbedding, topK, threshold);

    if (!chunks.length) return '';

    // Format chunks into a context string
    return chunks
      .map((chunk, i) => `[Context ${i + 1}]\nSource: ${String(chunk.metadata.filename ?? chunk.documentId)}\n${chunk.content}`)
      .join('\n\n---\n\n');
  }

  async retrieveChunks(query: string, topK = 5): Promise<RetrievedContext> {
    const queryEmbedding = await this.embedder.embedOne(query);
    const threshold = this.config.retrieval?.threshold ?? 0.3;
    const chunks = await this.store.search(queryEmbedding, topK, threshold);

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
