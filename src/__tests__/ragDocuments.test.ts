import { describe, it, expect, beforeEach } from 'vitest';
import { SvaraDB } from '../database/sqlite.js';
import { VectorRetriever } from '../rag/retriever.js';

/**
 * listDocuments()/removeDocument() only touch the svara_chunks table (no
 * embedding calls), so rows are inserted directly rather than going through
 * addDocuments() - that keeps this test free of any real/mocked network call
 * to an embeddings provider.
 */
function insertChunk(db: SvaraDB, opts: { id: string; agentName: string; documentId: string; source: string; index?: number }) {
  db.run(
    `INSERT INTO svara_chunks (id, agent_name, document_id, content, content_hash, chunk_index, embedding, source, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [opts.id, opts.agentName, opts.documentId, `content for ${opts.id}`, `hash-${opts.id}`, opts.index ?? 0, '[]', opts.source, '{}']
  );
}

describe('VectorRetriever knowledge document management', () => {
  let db: SvaraDB;
  let retriever: VectorRetriever;

  beforeEach(async () => {
    db = new SvaraDB(':memory:');
    retriever = new VectorRetriever('test-agent', db);
    // OpenAIEmbeddings' constructor doesn't make a network call - safe to
    // init without a real key for tests that never call addDocuments/retrieve.
    await retriever.init({ embeddings: { provider: 'openai', apiKey: 'fake-key-for-test' } });
  });

  it('lists documents grouped by document_id, with a chunk count per document', async () => {
    insertChunk(db, { id: 'c1', agentName: 'test-agent', documentId: 'doc-a', source: '/knowledge/a.pdf', index: 0 });
    insertChunk(db, { id: 'c2', agentName: 'test-agent', documentId: 'doc-a', source: '/knowledge/a.pdf', index: 1 });
    insertChunk(db, { id: 'c3', agentName: 'test-agent', documentId: 'doc-b', source: '/knowledge/b.md', index: 0 });

    const docs = await retriever.listDocuments();
    expect(docs).toHaveLength(2);
    const docA = docs.find((d) => d.documentId === 'doc-a');
    const docB = docs.find((d) => d.documentId === 'doc-b');
    expect(docA).toEqual({ documentId: 'doc-a', source: '/knowledge/a.pdf', chunkCount: 2 });
    expect(docB).toEqual({ documentId: 'doc-b', source: '/knowledge/b.md', chunkCount: 1 });
  });

  it('only lists documents belonging to this agent, not other agents', async () => {
    insertChunk(db, { id: 'c1', agentName: 'test-agent', documentId: 'doc-a', source: '/knowledge/a.pdf' });
    insertChunk(db, { id: 'c2', agentName: 'other-agent', documentId: 'doc-x', source: '/knowledge/x.pdf' });

    const docs = await retriever.listDocuments();
    expect(docs).toEqual([{ documentId: 'doc-a', source: '/knowledge/a.pdf', chunkCount: 1 }]);
  });

  it('removeDocument deletes all chunks for that document but leaves others untouched', async () => {
    insertChunk(db, { id: 'c1', agentName: 'test-agent', documentId: 'doc-a', source: '/knowledge/a.pdf', index: 0 });
    insertChunk(db, { id: 'c2', agentName: 'test-agent', documentId: 'doc-a', source: '/knowledge/a.pdf', index: 1 });
    insertChunk(db, { id: 'c3', agentName: 'test-agent', documentId: 'doc-b', source: '/knowledge/b.md', index: 0 });

    await retriever.removeDocument('doc-a');

    const docs = await retriever.listDocuments();
    expect(docs).toEqual([{ documentId: 'doc-b', source: '/knowledge/b.md', chunkCount: 1 }]);
  });

  it('returns an empty list when no documents are indexed', async () => {
    expect(await retriever.listDocuments()).toEqual([]);
  });
});
