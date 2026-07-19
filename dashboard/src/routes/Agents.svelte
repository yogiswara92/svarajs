<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';

  let agents = [];
  let loading = true;
  let loadError = '';

  let form = { name: '', provider: '', model: '' };
  let creating = false;
  let createError = '';
  let created = null;
  let copied = false;

  async function load() {
    try {
      const res = await api.get('/api/agents');
      agents = res.agents ?? [];
      loadError = '';
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Failed to load agents.';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function dashboardUrl(port) {
    return `${window.location.protocol}//${window.location.hostname}:${port}/dashboard`;
  }

  async function createAgent() {
    creating = true;
    createError = '';
    created = null;
    copied = false;
    try {
      const payload = {
        name: form.name.trim(),
        provider: form.provider || undefined,
        model: form.model.trim() || undefined,
      };
      created = await api.post('/api/agents', payload);
      form = { name: '', provider: '', model: '' };
      await load();
    } catch (e) {
      createError = e instanceof ApiError ? e.message : 'Failed to create agent.';
    } finally {
      creating = false;
    }
  }

  async function copyPm2Command() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.pm2Command);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard API unavailable (non-HTTPS, permissions) - the command is
      // still shown in the code block for manual copy.
    }
  }
</script>

<h1>Agents</h1>
<p class="note">
  Each agent here is a fully separate standalone project (own folder, own <code>svara.config.json</code>,
  own port) next to this one - not multiple agents inside a single process. Scaffolding a new one runs
  <code>svara new</code> and installs its dependencies, but does not start it - start it yourself (e.g.
  with <code>pm2</code>, shown below) so it's supervised the same way as everything else you run in
  production.
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
    Provider
    <select bind:value={form.provider}>
      <option value="">Auto-detect from model name</option>
      <option value="openai">OpenAI</option>
      <option value="anthropic">Anthropic</option>
      <option value="ollama">Ollama (local)</option>
    </select>
  </label>
  <label>
    Model
    <input bind:value={form.model} placeholder="gpt-4o-mini" />
    <span class="hint">Leave blank to use the scaffold's default for the selected provider.</span>
  </label>
  <div class="actions">
    <button class="btn primary" type="submit" disabled={creating}>
      {creating ? 'Creating... (installing dependencies, can take a minute)' : 'Create agent'}
    </button>
  </div>
</form>

{#if created}
  <div class="created-banner">
    <p class="success-text">"{created.name}" created at <code>{created.dir}</code> on port {created.port}.</p>
    <p class="hint" style="margin-top: 0.4rem;">Start it under the same process manager you already use:</p>
    <div class="pm2-command">
      <code>{created.pm2Command}</code>
      <button type="button" class="btn secondary small" on:click={copyPm2Command}>{copied ? 'Copied!' : 'Copy'}</button>
    </div>
  </div>
{/if}

<h2 class="section-heading">Existing agents</h2>
{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else if agents.length === 0}
  <p class="muted">No sibling agents yet - create one above.</p>
{:else}
  <ul class="list">
    {#each agents as agent (agent.dir)}
      <li class="list-item">
        <div class="agent-row">
          <div>
            <div class="list-item-title">{agent.name}</div>
            <div class="list-item-meta">{agent.dir} · port {agent.port ?? '?'}</div>
          </div>
          <div class="agent-row-right">
            <span class="chip" class:success={agent.running}>{agent.running ? 'Running' : 'Not running'}</span>
            {#if agent.running && agent.port}
              <a class="btn secondary small" href={dashboardUrl(agent.port)} target="_blank" rel="noopener">Open dashboard</a>
            {/if}
          </div>
        </div>
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
  .agent-row-right {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }
</style>
