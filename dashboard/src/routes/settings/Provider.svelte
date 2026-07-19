<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../../lib/api';
  import RestartBanner from '../../components/RestartBanner.svelte';

  const PROVIDERS = [
    { value: '', label: 'Auto-detect from model name' },
    { value: 'openai', label: 'OpenAI (or any OpenAI-compatible endpoint)' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'ollama', label: 'Ollama (local)' },
    { value: 'groq', label: 'Groq' },
  ];

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
    model: '', llmProvider: '', llmBaseURL: '', llmApiKey: '', llmApiKeyEnv: '',
    embeddingsProvider: 'openai', embeddingsApiKey: '', embeddingsModel: '', embeddingsBaseURL: '',
  };

  // A real env var name never looks like this - if it doesn't match, someone
  // probably pasted an actual API key here instead of a variable name from .env.
  $: apiKeyEnvLooksLikeARealKey = form.llmApiKeyEnv
    && form.llmApiKeyEnv !== '[set]'
    && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.llmApiKeyEnv);

  function populateForm(config) {
    form = {
      model: config.model || '',
      llmProvider: config.llm?.provider || '',
      llmBaseURL: config.llm?.baseURL || '',
      llmApiKey: config.llm?.apiKey || '',
      llmApiKeyEnv: config.llm?.apiKeyEnv || '',
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
      const payload = {
        model: form.model,
        llm: (form.llmProvider || form.llmBaseURL || form.llmApiKey || form.llmApiKeyEnv) ? {
          provider: form.llmProvider || undefined,
          baseURL: form.llmBaseURL || undefined,
          apiKey: form.llmApiKey || undefined,
          apiKeyEnv: form.llmApiKeyEnv || undefined,
        } : undefined,
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
  Which model the agent uses, and where to send requests for it. Saved to
  <code>svara.config.json</code> - changes take effect after you restart the runtime.
</p>

{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else}
  <form class="form" on:submit|preventDefault={save}>
    {#if saveError}<p class="error-text">{saveError}</p>{/if}
    <RestartBanner show={saved} />

    <label>
      Model
      <input bind:value={form.model} placeholder="gpt-4o-mini" required />
      <span class="hint">Provider is auto-detected from this name unless overridden below.</span>
    </label>
    <label>
      Provider
      <select bind:value={form.llmProvider}>
        {#each PROVIDERS as p}
          <option value={p.value}>{p.label}</option>
        {/each}
      </select>
    </label>
    <label>
      Custom base URL
      <input bind:value={form.llmBaseURL} placeholder="https://openrouter.ai/api/v1" />
      <span class="hint">
        For OpenRouter or any other OpenAI-compatible endpoint: set Provider to "OpenAI" above and put
        its base URL here (e.g. <code>https://openrouter.ai/api/v1</code>).
      </span>
    </label>
    <label>
      API key
      <input type="password" bind:value={form.llmApiKey} placeholder="sk-..." autocomplete="off" />
      <span class="hint">
        Stored encrypted in <code>svara.config.json</code>. Takes priority over "API key env var" below if
        both are set.
      </span>
    </label>
    <label>
      API key env var
      <input bind:value={form.llmApiKeyEnv} placeholder="OPENROUTER_API_KEY" />
      <span class="hint">
        Alternative to the field above: name of an environment variable (in <code>.env</code>) holding the
        key instead - only used when "API key" is blank. Leave both blank to use the provider's default
        (e.g. <code>OPENAI_API_KEY</code>).
      </span>
      {#if apiKeyEnvLooksLikeARealKey}
        <span class="error-text" style="margin-top: 0.4rem;">
          This looks like an actual API key, not a variable name - it won't work as-is (the runtime
          looks up <code>process.env[apiKeyEnv]</code>, so this would search for an env var literally
          named that key). Use the "API key" field above instead, or put the real key in <code>.env</code>
          as <code>OPENROUTER_API_KEY=&lt;your key&gt;</code> and put just <code>OPENROUTER_API_KEY</code>
          here.
        </span>
      {/if}
    </label>

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
