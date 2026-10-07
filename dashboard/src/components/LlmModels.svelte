<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';

  // Quick starts: fill provider / base URL / a sensible model so a newcomer only has to paste a key.
  const PRESETS = [
    { key: 'openai', label: 'OpenAI', provider: 'openai', baseURL: '', model: 'gpt-4o-mini' },
    { key: 'anthropic', label: 'Anthropic (Claude)', provider: 'anthropic', baseURL: '', model: 'claude-sonnet-5-5' },
    { key: 'openrouter', label: 'OpenRouter', provider: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: '' },
    { key: 'groq', label: 'Groq', provider: 'groq', baseURL: '', model: 'llama-3.3-70b-versatile' },
    { key: 'ollama', label: 'Ollama (local)', provider: 'ollama', baseURL: 'http://localhost:11434', model: 'llama3.2' },
    { key: 'custom', label: 'Other OpenAI-compatible', provider: 'openai', baseURL: '', model: '' },
  ];
  const PROVIDER_LABEL = { openai: 'OpenAI-compatible', anthropic: 'Anthropic', groq: 'Groq', ollama: 'Ollama' };

  let data = null;
  let loading = true;
  let error = '';
  let notice = '';
  let editing = null; // null | 'new' | <profile id>
  let form = blank();
  let formError = '';
  let busy = false;
  let testing = {};   // id -> true while testing
  let results = {};   // id -> { ok, ms, reply|error }

  function blank() {
    return { name: '', model: '', provider: 'openai', baseURL: '', apiKey: '', apiKeyEnv: '', vision: 'auto', clearKey: false, hasKey: false, preset: 'custom' };
  }

  async function load() {
    try {
      data = await api.get('/api/llm');
      error = '';
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Failed to load models.';
    } finally {
      loading = false;
    }
  }
  onMount(load);

  function hostOf(url) {
    try { return new URL(url).host; } catch { return url; }
  }

  function startAdd(presetKey) {
    const p = PRESETS.find((x) => x.key === presetKey) || PRESETS[PRESETS.length - 1];
    form = { ...blank(), preset: p.key, provider: p.provider, baseURL: p.baseURL, model: p.model, name: p.key === 'custom' ? '' : p.label };
    formError = '';
    editing = 'new';
  }

  function startEdit(p) {
    form = {
      ...blank(), name: p.name, model: p.model, provider: p.provider || '', baseURL: p.baseURL || '',
      apiKeyEnv: p.apiKeyEnv || '', vision: p.vision === true ? 'yes' : p.vision === false ? 'no' : 'auto', hasKey: p.hasKey,
    };
    formError = '';
    editing = p.id;
  }

  function cancel() { editing = null; formError = ''; }

  function payload() {
    const body = {
      name: form.name, model: form.model, provider: form.provider, baseURL: form.baseURL, apiKeyEnv: form.apiKeyEnv,
      vision: form.vision === 'yes' ? true : form.vision === 'no' ? false : 'auto',
    };
    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();       // blank on edit = keep the saved key
    if (editing !== 'new' && form.clearKey) body.clearKey = true;
    return body;
  }

  async function submit() {
    busy = true; formError = ''; notice = '';
    try {
      const adding = editing === 'new';
      data = adding ? await api.post('/api/llm/profiles', payload()) : await api.put(`/api/llm/profiles/${editing}`, payload());
      notice = adding ? `"${form.name}" saved. Press "Make default" to use it.` : 'Saved.';
      editing = null;
    } catch (e) {
      formError = e instanceof ApiError ? e.message : 'Could not save.';
    } finally {
      busy = false;
    }
  }

  async function makeDefault(p) {
    notice = ''; error = '';
    try {
      data = await api.post('/api/llm/default', { id: p.id });
      notice = data.applied
        ? `Now using "${p.name}" (${p.model}). It applies right away, no restart needed.`
        : (data.warning || `"${p.name}" is the default. Restart the runtime to apply it.`);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not switch the default.';
    }
  }

  async function remove(p) {
    if (!confirm(`Delete "${p.name}"? Its saved key is removed too.`)) return;
    notice = ''; error = '';
    try { data = await api.delete(`/api/llm/profiles/${p.id}`); }
    catch (e) { error = e instanceof ApiError ? e.message : 'Could not delete.'; }
  }

  async function test(p) {
    testing = { ...testing, [p.id]: true };
    results = { ...results, [p.id]: undefined };
    try {
      results = { ...results, [p.id]: await api.post(`/api/llm/profiles/${p.id}/test`) };
    } catch (e) {
      results = { ...results, [p.id]: { ok: false, error: e instanceof ApiError ? e.message : 'Test failed.' } };
    } finally {
      testing = { ...testing, [p.id]: false };
    }
  }
</script>

<section class="models">
  <div class="models-head">
    <h2 class="section-heading" style="margin:0">Chat models</h2>
    {#if data}<span class="muted small">Running now: <code>{data.activeModel}</code></span>{/if}
  </div>
  <p class="hint" style="margin: 0.4rem 0 0.9rem">
    Save several models or providers side by side and pick which one is the default. Switching the default takes effect
    immediately for the running agent, in every channel, with no restart.
  </p>

  {#if loading}
    <p class="muted">Loading...</p>
  {:else if error}
    <p class="error-text">{error}</p>
  {:else if data}
    {#if notice}<p class="success-text" style="margin-bottom:0.6rem">{notice}</p>{/if}

    <ul class="list">
      {#each data.profiles as p (p.id)}
        <li class="list-item">
          <div class="model-row">
            <div class="model-main">
              <div class="list-item-title">
                {p.name}
                {#if p.isDefault}<span class="chip success">Default</span>{/if}
                {#if p.vision === true}<span class="chip">sees images</span>{/if}
              </div>
              <div class="list-item-meta"><code>{p.model}</code> · {PROVIDER_LABEL[p.provider] || 'auto-detect'}{p.baseURL ? ` · ${hostOf(p.baseURL)}` : ''} ·
                {#if p.hasKey}key saved{:else if p.apiKeyEnv}key from <code>{p.apiKeyEnv}</code>{:else}key from the server environment{/if}</div>
              {#if results[p.id]}
                <div class="list-item-meta" style="color: {results[p.id].ok ? 'var(--success)' : 'var(--danger)'}">
                  {#if results[p.id].ok}Works: replied "{results[p.id].reply}" in {(results[p.id].ms / 1000).toFixed(1)}s
                  {:else}Failed: {results[p.id].error}{/if}
                </div>
              {/if}
            </div>
            <div class="model-actions">
              {#if !p.isDefault}<button type="button" class="btn primary small" on:click={() => makeDefault(p)}>Make default</button>{/if}
              <button type="button" class="btn secondary small" disabled={testing[p.id]} on:click={() => test(p)}>{testing[p.id] ? 'Testing...' : 'Test'}</button>
              <button type="button" class="btn secondary small" on:click={() => startEdit(p)}>Edit</button>
              {#if !p.isDefault}<button type="button" class="btn danger small" on:click={() => remove(p)}>Delete</button>{/if}
            </div>
          </div>
        </li>
      {/each}
    </ul>

    {#if editing}
      <form class="form model-form" on:submit|preventDefault={submit}>
        <h2 style="margin:0">{editing === 'new' ? 'Add a model' : 'Edit model'}</h2>
        {#if formError}<p class="error-text">{formError}</p>{/if}
        {#if editing === 'new'}
          <label>
            Start from
            <select value={form.preset} on:change={(e) => startAdd(e.currentTarget.value)}>
              {#each PRESETS as p}<option value={p.key}>{p.label}</option>{/each}
            </select>
          </label>
        {/if}
        <label>Name <input bind:value={form.name} placeholder="e.g. Claude for writing" required /></label>
        <label>Model <input bind:value={form.model} placeholder="the model name your provider expects" required /></label>
        <label>
          Provider
          <select bind:value={form.provider}>
            <option value="">Auto-detect from model name</option>
            <option value="openai">OpenAI (or any OpenAI-compatible endpoint)</option>
            <option value="anthropic">Anthropic</option>
            <option value="groq">Groq</option>
            <option value="ollama">Ollama (local)</option>
          </select>
        </label>
        <label>
          Base URL <span class="hint" style="display:inline">(optional)</span>
          <input bind:value={form.baseURL} placeholder="https://openrouter.ai/api/v1" />
        </label>
        <label>
          API key {#if editing !== 'new' && form.hasKey}<span class="hint" style="display:inline">(saved - leave blank to keep it)</span>{/if}
          <input type="password" bind:value={form.apiKey} autocomplete="off" placeholder={form.hasKey ? '••••••••' : 'sk-...'} />
          <span class="hint">Stored encrypted in <code>svara.config.json</code>. Never shown again after saving.</span>
        </label>
        {#if editing !== 'new' && form.hasKey}
          <label class="inline-check"><input type="checkbox" bind:checked={form.clearKey} /> Remove the saved key</label>
        {/if}
        <label>
          Key from an environment variable <span class="hint" style="display:inline">(optional, used when no key is saved)</span>
          <input bind:value={form.apiKeyEnv} placeholder="OPENROUTER_API_KEY" />
        </label>
        <label>
          Can this model read images?
          <select bind:value={form.vision}>
            <option value="auto">Automatic (guess from the model name)</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <div class="actions">
          <button class="btn primary" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
          <button class="btn secondary" type="button" on:click={cancel}>Cancel</button>
        </div>
      </form>
    {:else}
      <div class="actions" style="margin-top: 0.8rem">
        <button type="button" class="btn secondary" on:click={() => startAdd('custom')}>+ Add a model</button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .models { margin-bottom: 2rem; max-width: 760px; }
  .models-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .small { font-size: 0.8rem; }
  .model-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem 1rem; flex-wrap: wrap; }
  .model-main { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; }
  .model-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: flex-end; }
  .model-form { margin-top: 1rem; padding: 1.1rem; background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; max-width: none; }
  .inline-check { flex-direction: row !important; align-items: center; gap: 0.5rem !important; font-weight: 500 !important; }
  .inline-check input { width: auto; }
</style>
