<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';

  let agents = [];
  let loading = true;
  let loadError = '';

  let form = { name: '', provider: '', model: '', llmMode: 'same', baseURL: '', apiKey: '' };
  let creating = false;
  let createError = '';
  let created = null;

  async function load() {
    try {
      const res = await api.get('/api/agents');
      agents = res.agents ?? [];
      canRun = res.canRun !== false;
      loadError = '';
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Failed to load agents.';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  const STATUS_LABEL = { running: 'Running', starting: 'Starting...', stopped: 'Stopped', crashed: 'Crashed', external: 'Running (outside dashboard)' };

  let canRun = true;
  let busyName = '';
  let actionError = '';
  let logName = '';
  let logText = '';

  async function act(name, verb) {
    busyName = name;
    actionError = '';
    try {
      await api.post(`/api/agents/${encodeURIComponent(name)}/${verb}`);
      await load();
    } catch (e) {
      actionError = e instanceof ApiError ? e.message : `Could not ${verb} ${name}.`;
    } finally {
      busyName = '';
    }
  }

  async function remove(name) {
    const typed = prompt(`This permanently deletes "${name}" and all its data (memory, uploads, settings).\n\nType the agent name to confirm:`);
    if (typed !== name) return;
    busyName = name;
    actionError = '';
    try {
      await api.delete(`/api/agents/${encodeURIComponent(name)}`, { confirm: name });
      if (logName === name) logName = '';
      await load();
    } catch (e) {
      actionError = e instanceof ApiError ? e.message : `Could not delete ${name}.`;
    } finally {
      busyName = '';
    }
  }

  async function showLog(name) {
    if (logName === name) { logName = ''; return; }
    logName = name;
    logText = 'Loading...';
    try {
      logText = (await api.get(`/api/agents/${encodeURIComponent(name)}/logs?lines=200`)).log || '(no output yet)';
    } catch (e) {
      logText = e instanceof ApiError ? e.message : 'Could not load the log.';
    }
  }

  async function createAgent() {
    creating = true;
    createError = '';
    created = null;
    try {
      const custom = form.llmMode === 'custom';
      const payload = {
        name: form.name.trim(),
        model: form.model.trim() || undefined,
        llmMode: form.llmMode,
        // 'Same as this agent' reuses this agent's connection; 'custom' sends the typed one.
        provider: custom && ['openai', 'anthropic', 'ollama'].includes(form.provider) ? form.provider : undefined,
        llm: custom ? { provider: form.provider || undefined, baseURL: form.baseURL.trim() || undefined, apiKey: form.apiKey.trim() || undefined } : undefined,
      };
      created = await api.post('/api/agents', payload);
      form = { name: '', provider: '', model: '', llmMode: 'same', baseURL: '', apiKey: '' };
      await load();
    } catch (e) {
      createError = e instanceof ApiError ? e.message : 'Failed to create agent.';
    } finally {
      creating = false;
    }
  }

</script>

<h1>Agents</h1>
<p class="note">
  Create extra agents that run on this same server, each with its own settings, memory, channels and
  dashboard. They start automatically, come back after a restart, and are opened from here with the
  same login - no extra setup on your server.
</p>

<h2>Create a new agent</h2>
<form class="form" on:submit|preventDefault={createAgent}>
  {#if createError}<p class="error-text">{createError}</p>{/if}
  <label>
    Name
    <input bind:value={form.name} placeholder="support-bot" pattern="[a-z][a-z0-9-]*" required />
    <span class="hint">Lowercase letters, numbers, and hyphens only - becomes the folder name.</span>
  </label>
  <label>
    AI model connection
    <select bind:value={form.llmMode}>
      <option value="same">Same as this agent (reuse its provider, endpoint and API key)</option>
      <option value="custom">Custom (use a different provider or API key)</option>
    </select>
  </label>
  {#if form.llmMode === 'custom'}
    <label>
      Provider
      <select bind:value={form.provider}>
        <option value="">Auto-detect from model name</option>
        <option value="openai">OpenAI, or any OpenAI-compatible endpoint</option>
        <option value="anthropic">Anthropic</option>
        <option value="groq">Groq</option>
        <option value="ollama">Ollama (local)</option>
      </select>
    </label>
    <label>
      Base URL <span class="hint" style="display:inline">(optional)</span>
      <input bind:value={form.baseURL} placeholder="https://openrouter.ai/api/v1" />
      <span class="hint">Only for OpenAI-compatible services such as OpenRouter, Together, or your own gateway.</span>
    </label>
    <label>
      API key
      <input type="password" bind:value={form.apiKey} autocomplete="off" placeholder="sk-..." />
      <span class="hint">Stored encrypted in the new agent's config. Leave blank to read it from the server's environment variable instead.</span>
    </label>
  {/if}
  <label>
    Model
    <input bind:value={form.model} placeholder={form.llmMode === 'same' ? "Blank = same model as this agent" : "gpt-4o-mini"} />
    <span class="hint">{form.llmMode === 'same' ? "Leave blank to use this agent's model." : "The model name your provider expects."}</span>
  </label>
  <div class="actions">
    <button class="btn primary" type="submit" disabled={creating}>
      {creating ? 'Creating and starting...' : 'Create agent'}
    </button>
  </div>
</form>

{#if created}
  <div class="created-banner">
    <p class="success-text">"{created.name}" is {created.started ? 'running' : 'created'}.</p>
    {#if created.url && created.started}
      <p class="hint" style="margin-top: 0.4rem;">Next: open it, connect a channel (Settings, then Channels), and give it a personality (Settings, then General).</p>
      <p style="margin-top: 0.6rem;"><a class="btn primary small" href={created.url}>Open {created.name}</a></p>
    {:else}
      <p class="hint" style="margin-top: 0.4rem;">It did not come up yet. Check its log below, or press Start.</p>
    {/if}
  </div>
{/if}

<h2 class="section-heading">Your agents</h2>
{#if actionError}<p class="error-text">{actionError}</p>{/if}
{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else if agents.length === 0}
  <p class="muted">No extra agents yet - create one above.</p>
{:else}
  <ul class="list">
    {#each agents as agent (agent.dir)}
      <li class="list-item">
        <div class="agent-row">
          <div>
            <div class="list-item-title">{agent.name}</div>
            <div class="list-item-meta">{agent.dir}{agent.restarts ? ` · restarted ${agent.restarts}x` : ''}</div>
            {#if agent.status === 'crashed'}<div class="list-item-meta" style="color:var(--danger)">Stopped after repeated crashes{agent.lastExit ? ` (${agent.lastExit})` : ''}. Check the log, fix the settings, then Start.</div>{/if}
          </div>
          <div class="agent-row-right">
            <span class="chip" class:success={agent.status === 'running'}>{STATUS_LABEL[agent.status] ?? agent.status}</span>
            {#if agent.url}
              <a class="btn primary small" href={agent.url}>Open</a>
            {/if}
            {#if canRun && (agent.status === 'stopped' || agent.status === 'crashed')}
              <button class="btn secondary small" disabled={busyName === agent.name} on:click={() => act(agent.name, 'start')}>Start</button>
            {/if}
            {#if canRun && (agent.status === 'running' || agent.status === 'starting')}
              <button class="btn secondary small" disabled={busyName === agent.name} on:click={() => act(agent.name, 'restart')}>Restart</button>
              <button class="btn secondary small" disabled={busyName === agent.name} on:click={() => act(agent.name, 'stop')}>Stop</button>
            {/if}
            <button class="btn secondary small" on:click={() => showLog(agent.name)}>{logName === agent.name ? 'Hide log' : 'Log'}</button>
            {#if agent.managed}
              <button class="btn danger small" disabled={busyName === agent.name} on:click={() => remove(agent.name)}>Delete</button>
            {/if}
          </div>
        </div>
        {#if logName === agent.name}
          <pre class="log">{logText}</pre>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .created-banner {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    padding: 1rem 1.1rem;
    margin: 1.25rem 0 2rem;
  }
  .pm2-command {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.5rem;
    background: var(--surface-alt);
    border-radius: 0.5rem;
    padding: 0.6rem 0.8rem;
  }
  .pm2-command code {
    flex: 1;
    background: none;
    padding: 0;
    overflow-x: auto;
    white-space: nowrap;
  }
  .agent-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .log {
    margin-top: 0.75rem;
    max-height: 18rem;
    overflow: auto;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.7rem 0.85rem;
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .agent-row-right {
    flex-wrap: wrap;
    justify-content: flex-end;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }
</style>
