<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../../lib/api';
  import RestartBanner from '../../components/RestartBanner.svelte';
  import LlmModels from '../../components/LlmModels.svelte';

  const EMBEDDINGS_PROVIDERS = [
    { value: 'openai', label: 'OpenAI (or any OpenAI-compatible embeddings endpoint)' },
    { value: 'ollama', label: 'Ollama (local or remote, no API key needed)' },
  ];

  let loading = true;
  let loadError = '';
  let saving = false;
  let saveError = '';
  let saved = false;

  let form = {
    embeddingsProvider: 'openai', embeddingsApiKey: '', embeddingsModel: '', embeddingsBaseURL: '',
  };

  function populateForm(config) {
    form = {
      embeddingsProvider: config.embeddings?.provider || 'openai',
      embeddingsApiKey: config.embeddings?.apiKey || '',
      embeddingsModel: config.embeddings?.model || '',
      embeddingsBaseURL: config.embeddings?.baseURL || '',
    };
  }

  async function load() {
    loading = true;
    try {
      const config = await api.get('/api/config');
      populateForm(config);
      loadError = '';
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Failed to load config.';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function save() {
    saving = true;
    saveError = '';
    saved = false;
    try {
      // Chat models are managed in the panel above (their own endpoints); this form only saves embeddings.
      const payload = {
        embeddings: {
          provider: form.embeddingsProvider,
          apiKey: form.embeddingsApiKey || undefined,
          model: form.embeddingsModel || undefined,
          baseURL: form.embeddingsBaseURL || undefined,
        },
      };
      const res = await api.put('/api/config', payload);
      saved = true;
      if (res?.config) populateForm(res.config);
    } catch (e) {
      saveError = e instanceof ApiError ? e.message : 'Failed to save settings.';
    } finally {
      saving = false;
    }
  }
</script>

<h1>AI Provider</h1>
<p class="note">
  Which models the agent can use, and where to send requests for them. Saved to
  <code>svara.config.json</code>.
</p>

<LlmModels />

{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else}
  <form class="form" on:submit|preventDefault={save}>
    {#if saveError}<p class="error-text">{saveError}</p>{/if}
    <RestartBanner show={saved} />

    <h2 class="section-heading">Embeddings (RAG / Knowledge)</h2>
    <p class="hint" style="margin-bottom: 0.75rem;">
      Indexes documents uploaded on the <a href="#/knowledge">Knowledge</a> page - separate from the chat
      model above, since a chat-completions endpoint doesn't necessarily also serve embeddings on the same
      account/key. Defaults to OpenAI, which needs its own API key here (a chat-only key from OpenRouter or
      similar will not work for this unless that same provider also proxies embeddings - use "Custom base
      URL" below in that case). Pick Ollama instead for a free local (or self-hosted remote) option that
      needs no key at all.
    </p>
    <label>
      Provider
      <select bind:value={form.embeddingsProvider}>
        {#each EMBEDDINGS_PROVIDERS as p}
          <option value={p.value}>{p.label}</option>
        {/each}
      </select>
    </label>
    <label>
      Custom base URL
      <input
        bind:value={form.embeddingsBaseURL}
        placeholder={form.embeddingsProvider === 'ollama' ? 'http://localhost:11434' : 'https://openrouter.ai/api/v1'}
      />
      <span class="hint">
        {#if form.embeddingsProvider === 'ollama'}
          Only needed if Ollama isn't running on this same machine at the default address - e.g. a remote
          server, or a different port.
        {:else}
          Point at any OpenAI-compatible embeddings endpoint instead of api.openai.com - OpenRouter, Azure
          OpenAI, a self-hosted proxy, etc. Leave blank for real OpenAI.
        {/if}
      </span>
    </label>
    {#if form.embeddingsProvider === 'openai'}
      <label>
        API key
        <input type="password" bind:value={form.embeddingsApiKey} placeholder="sk-..." autocomplete="off" />
        <span class="hint">Stored encrypted, separate from the chat model's key above.</span>
      </label>
    {/if}
    <label>
      Model
      <input
        bind:value={form.embeddingsModel}
        placeholder={form.embeddingsProvider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small'}
      />
      <span class="hint">Leave blank to use the default for the selected provider.</span>
    </label>

    <div class="actions">
      <button class="btn primary" type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>
    </div>
  </form>
{/if}
