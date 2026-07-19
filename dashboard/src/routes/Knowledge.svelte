<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import Icon from '../components/Icon.svelte';

  let documents = [];
  let loading = true;
  let loadError = '';

  let uploading = false;
  let uploadError = '';
  let fileInput;

  let deletingId = null;

  async function load() {
    loading = true;
    try {
      const res = await api.get('/api/knowledge');
      documents = res.documents || [];
      loadError = '';
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Failed to load knowledge documents.';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function basename(source) {
    return source.split(/[\\/]/).pop();
  }

  async function handleFiles(files) {
    if (!files || files.length === 0) return;
    uploading = true;
    uploadError = '';
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        await api.upload('/api/knowledge', formData);
      }
      await load();
    } catch (e) {
      uploadError = e instanceof ApiError ? e.message : 'Upload failed.';
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
    }
  }

  function onFileInputChange(e) {
    handleFiles(e.target.files);
  }

  let dragging = false;
  function onDrop(e) {
    e.preventDefault();
    dragging = false;
    handleFiles(e.dataTransfer?.files);
  }

  async function removeDocument(doc) {
    if (!confirm(`Remove "${basename(doc.source)}" from the knowledge base? This deletes its indexed chunks (and the uploaded file, if SvaraJS manages it).`)) return;
    deletingId = doc.documentId;
    try {
      await api.delete(`/api/knowledge/${doc.documentId}`);
      await load();
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Failed to delete document.';
    } finally {
      deletingId = null;
    }
  }
</script>

<h1>Knowledge</h1>
<p class="note">
  Documents indexed for RAG (retrieval-augmented generation) - the agent searches these
  automatically when answering. Supports .pdf .docx .txt .md .mdx .rst .csv .log .jsonl, up to 25 MB.
</p>

<div
  class="dropzone"
  class:dragging
  role="region"
  aria-label="Upload a knowledge document"
  on:dragover|preventDefault={() => (dragging = true)}
  on:dragleave={() => (dragging = false)}
  on:drop={onDrop}
>
  <span class="dropzone-icon"><Icon name="upload" /></span>
  <p>Drag &amp; drop a file here, or</p>
  <label class="btn secondary">
    Choose file
    <input bind:this={fileInput} type="file" hidden multiple on:change={onFileInputChange} disabled={uploading} />
  </label>
  {#if uploading}<p class="muted">Uploading and indexing...</p>{/if}
  {#if uploadError}<p class="error-text">{uploadError}</p>{/if}
</div>

{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else if documents.length === 0}
  <p class="muted">No documents indexed yet.</p>
{:else}
  <ul class="list">
    {#each documents as doc (doc.documentId)}
      <li class="list-item knowledge-item">
        <span class="knowledge-item-icon"><Icon name="file" /></span>
        <div class="knowledge-item-text">
          <div class="list-item-title">{basename(doc.source)}</div>
          <div class="list-item-meta">{doc.chunkCount} chunk{doc.chunkCount !== 1 ? 's' : ''} - {doc.source}</div>
        </div>
        <button
          class="btn danger small"
          disabled={deletingId === doc.documentId}
          on:click={() => removeDocument(doc)}
        >
          <Icon name="trash" /> Remove
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 2rem;
    margin-bottom: 1.5rem;
    border: 2px dashed var(--border);
    border-radius: 0.75rem;
    text-align: center;
    color: var(--text-muted);
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .dropzone.dragging {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 6%, transparent);
  }
  .dropzone-icon {
    color: var(--text-secondary);
    font-size: 1.5rem;
  }
  .knowledge-item {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }
  .knowledge-item-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    background: var(--surface-alt);
    color: var(--text-secondary);
  }
  .knowledge-item-text {
    flex: 1;
    min-width: 0;
  }
  .knowledge-item-text .list-item-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
