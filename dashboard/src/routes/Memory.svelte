<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';

  let enabled = true;
  let loading = true;
  let loadError = '';

  let agentContent = '';
  let userContent = '';

  let savingAgent = false;
  let savingUser = false;
  let agentError = '';
  let userError = '';
  let agentSaved = false;
  let userSaved = false;

  async function load() {
    loading = true;
    try {
      const res = await api.get('/api/memory');
      enabled = !!res.enabled;
      agentContent = res.agent || '';
      userContent = res.user || '';
      loadError = '';
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Failed to load memory.';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function saveAgent() {
    savingAgent = true;
    agentError = '';
    agentSaved = false;
    try {
      await api.put('/api/memory/agent', { content: agentContent });
      agentSaved = true;
      setTimeout(() => (agentSaved = false), 2000);
    } catch (e) {
      agentError = e instanceof ApiError ? e.message : 'Failed to save MEMORY.md.';
    } finally {
      savingAgent = false;
    }
  }

  async function saveUser() {
    savingUser = true;
    userError = '';
    userSaved = false;
    try {
      await api.put('/api/memory/user', { content: userContent });
      userSaved = true;
      setTimeout(() => (userSaved = false), 2000);
    } catch (e) {
      userError = e instanceof ApiError ? e.message : 'Failed to save USER.md.';
    } finally {
      savingUser = false;
    }
  }
</script>

<h1>Memory</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else if !enabled}
  <p class="muted">Learning memory is not enabled on this agent.</p>
{:else}
  <p class="muted small">
    Saves are scanned for dangerous content and blocked if the file changed on disk since it was last
    loaded (your attempt is backed up instead of overwriting the change).
  </p>
  <div class="memory-grid">
    <div class="memory-col">
      <h2>MEMORY.md <span class="muted">(agent)</span></h2>
      {#if agentError}<p class="error-text">{agentError}</p>{/if}
      <textarea bind:value={agentContent} rows="18"></textarea>
      <div class="actions">
        <button class="btn primary" disabled={savingAgent} on:click={saveAgent}>Save</button>
        {#if agentSaved}<span class="success-text">Saved</span>{/if}
      </div>
    </div>
    <div class="memory-col">
      <h2>USER.md <span class="muted">(user)</span></h2>
      {#if userError}<p class="error-text">{userError}</p>{/if}
      <textarea bind:value={userContent} rows="18"></textarea>
      <div class="actions">
        <button class="btn primary" disabled={savingUser} on:click={saveUser}>Save</button>
        {#if userSaved}<span class="success-text">Saved</span>{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .memory-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }

  .memory-col {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  textarea {
    width: 100%;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text-primary);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.75rem;
    resize: vertical;
  }

  textarea:focus {
    outline: none;
    border-color: var(--primary);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  p.small {
    font-size: 0.8rem;
    margin-bottom: 1rem;
  }

  @media (max-width: 800px) {
    .memory-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
