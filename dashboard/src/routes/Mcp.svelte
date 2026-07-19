<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import Icon from '../components/Icon.svelte';

  let servers = [];
  let serversLoading = true;
  let serversError = '';
  let disconnectingId = null;

  // ── Svaramind (guided connect on top of the same MCP client) ────────────
  const SVARAMIND_ID = 'svaramind';
  let svaramindConnecting = false;
  let svaramindError = '';
  let svaramindPopup = null;
  let svaramindWorkspaces = [];
  let svaramindWorkspacesLoading = false;
  let svaramindWorkspacesError = '';
  let svaramindAppUrl = 'https://svaramind.yesvara.com';
  let svaramindSettingWorkspace = false;
  let showWorkspacePicker = false;

  $: svaramindStatus = servers.find((s) => s.id === SVARAMIND_ID) || null;
  $: svaramindPinnedWorkspace = svaramindStatus?.pinnedParams?.workspace_id || '';
  $: otherServers = servers.filter((s) => s.id !== SVARAMIND_ID);

  // The "Default workspace" summary shows a name, not a raw id - but the
  // workspace list used to only ever load lazily, when the picker was
  // opened, so a plain page visit showed the bare uuid until you clicked
  // "Change workspace" once. Fetch it in the background as soon as there's
  // a pinned workspace to resolve.
  $: if (svaramindPinnedWorkspace && svaramindWorkspaces.length === 0 && !svaramindWorkspacesLoading) {
    loadSvaramindWorkspaces();
  }

  let searchQuery = '';
  let searchResults = [];
  let searching = false;
  let searchError = '';
  let searched = false;

  // registryName -> { fields: {secretName: value}, connecting: bool, error: string }
  let connectState = {};

  let showManualForm = false;
  let manual = { id: '', name: '', transportType: 'stdio', command: '', args: '', url: '', extra: '' };
  let manualConnecting = false;
  let manualError = '';

  async function loadServers() {
    serversLoading = true;
    try {
      const res = await api.get('/api/mcp/servers');
      servers = res.servers || [];
      serversError = '';
    } catch (e) {
      serversError = e instanceof ApiError ? e.message : 'Failed to load MCP servers.';
    } finally {
      serversLoading = false;
    }
  }

  onMount(loadServers);

  async function connectSvaramind() {
    svaramindConnecting = true;
    svaramindError = '';
    try {
      const res = await api.post('/api/svaramind/oauth/start');
      svaramindPopup = window.open(res.authorizeUrl, 'svaramind-oauth', 'width=420,height=640');
      if (!svaramindPopup) {
        svaramindError = 'Your browser blocked the sign-in popup - allow popups for this page and try again.';
        svaramindConnecting = false;
        return;
      }
      await waitForSvaramindConnection();
    } catch (e) {
      svaramindError = e instanceof ApiError ? e.message : 'Failed to start Svaramind sign-in.';
      svaramindConnecting = false;
    }
  }

  /** Polls for the connection while the sign-in popup is open - the actual token exchange happens server-side once Svaramind redirects the popup to our callback route (see dashboard/serve.ts). */
  function waitForSvaramindConnection() {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const TIMEOUT_MS = 3 * 60 * 1000;
      const poll = setInterval(async () => {
        if (svaramindPopup?.closed) {
          clearInterval(poll);
          await loadServers();
          if (!servers.some((s) => s.id === SVARAMIND_ID)) {
            svaramindError = 'Sign-in window was closed before finishing.';
          }
          svaramindConnecting = false;
          resolve();
          return;
        }
        if (Date.now() - startedAt > TIMEOUT_MS) {
          clearInterval(poll);
          svaramindError = 'Sign-in timed out - please try again.';
          svaramindConnecting = false;
          svaramindPopup?.close();
          resolve();
          return;
        }
        await loadServers();
        if (servers.some((s) => s.id === SVARAMIND_ID)) {
          clearInterval(poll);
          svaramindPopup?.close();
          svaramindConnecting = false;
          await loadSvaramindWorkspaces();
          showWorkspacePicker = true;
          resolve();
        }
      }, 1500);
    });
  }

  async function loadSvaramindWorkspaces() {
    svaramindWorkspacesLoading = true;
    svaramindWorkspacesError = '';
    try {
      const res = await api.get('/api/svaramind/workspaces');
      svaramindWorkspaces = res.workspaces || [];
      if (res.appUrl) svaramindAppUrl = res.appUrl;
    } catch (e) {
      svaramindWorkspacesError = e instanceof ApiError ? e.message : 'Failed to load workspaces.';
    } finally {
      svaramindWorkspacesLoading = false;
    }
  }

  async function chooseSvaramindWorkspace(workspaceId) {
    svaramindSettingWorkspace = true;
    svaramindError = '';
    try {
      await api.post('/api/svaramind/workspace', { workspaceId });
      showWorkspacePicker = false;
      await loadServers();
    } catch (e) {
      svaramindError = e instanceof ApiError ? e.message : 'Failed to set workspace.';
    } finally {
      svaramindSettingWorkspace = false;
    }
  }

  function svaramindWorkspaceName(id) {
    return svaramindWorkspaces.find((w) => w.id === id)?.name || id;
  }

  async function openWorkspacePicker() {
    showWorkspacePicker = true;
    if (svaramindWorkspaces.length === 0) await loadSvaramindWorkspaces();
  }

  async function disconnectSvaramind() {
    if (!confirm('Disconnect Svaramind? Its tools will no longer be available to the agent.')) return;
    await disconnect(SVARAMIND_ID);
    svaramindWorkspaces = [];
    showWorkspacePicker = false;
  }

  async function disconnect(id) {
    if (!confirm('Disconnect this MCP server? Its tools will no longer be available to the agent.')) return;
    disconnectingId = id;
    try {
      await api.delete(`/api/mcp/servers/${id}`);
      await loadServers();
    } catch (e) {
      serversError = e instanceof ApiError ? e.message : 'Failed to disconnect.';
    } finally {
      disconnectingId = null;
    }
  }

  async function search() {
    searching = true;
    searchError = '';
    searched = true;
    try {
      const res = await api.get(`/api/mcp/registry?search=${encodeURIComponent(searchQuery)}`);
      searchResults = res.results || [];
    } catch (e) {
      searchError = e instanceof ApiError ? e.message : 'Search failed.';
    } finally {
      searching = false;
    }
  }

  function stateFor(registryName) {
    if (!connectState[registryName]) {
      connectState[registryName] = { fields: {}, connecting: false, error: '' };
    }
    return connectState[registryName];
  }

  async function connectFromRegistry(result) {
    const state = stateFor(result.registryName);
    state.connecting = true;
    state.error = '';
    connectState = { ...connectState };
    try {
      await api.post('/api/mcp/servers', {
        source: 'registry',
        registryName: result.registryName,
        name: result.title,
        secrets: state.fields,
      });
      await loadServers();
    } catch (e) {
      state.error = e instanceof ApiError ? e.message : 'Failed to connect.';
    } finally {
      state.connecting = false;
      connectState = { ...connectState };
    }
  }

  async function connectManual() {
    manualConnecting = true;
    manualError = '';
    try {
      const extra = {};
      for (const pair of manual.extra.split(',').map((s) => s.trim()).filter(Boolean)) {
        const [k, ...rest] = pair.split('=');
        if (k) extra[k.trim()] = rest.join('=').trim();
      }
      const transport = manual.transportType === 'stdio'
        ? { type: 'stdio', command: manual.command, args: manual.args.split(' ').map((s) => s.trim()).filter(Boolean), env: extra }
        : { type: manual.transportType, url: manual.url, headers: extra };

      await api.post('/api/mcp/servers', {
        source: 'manual',
        id: manual.id,
        name: manual.name,
        transport,
      });
      manual = { id: '', name: '', transportType: 'stdio', command: '', args: '', url: '', extra: '' };
      showManualForm = false;
      await loadServers();
    } catch (e) {
      manualError = e instanceof ApiError ? e.message : 'Failed to connect.';
    } finally {
      manualConnecting = false;
    }
  }

  function isAlreadyConnected(registryName) {
    return servers.some((s) => s.id === registryName.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }
</script>

<h1>MCP</h1>
<p class="note">
  Connect Model Context Protocol servers - their tools become available to the agent automatically.
  Browse the <a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noreferrer">official MCP Registry</a>
  or add one manually.
</p>

{#if !serversLoading}
  <h2 class="section-heading">Svaramind</h2>
  <div class="card svaramind-card">
    <div class="card-header">
      <span class="card-header-icon"><Icon name="database" /></span>
      <span class="card-header-title">Svaramind</span>
      {#if svaramindStatus}<span class="chip success">Connected</span>{/if}
    </div>

    {#if svaramindError}<p class="error-text">{svaramindError}</p>{/if}

    {#if !svaramindStatus}
      <p class="hint" style="margin-bottom: 0.75rem;">
        Connect your Svaramind knowledge base - notes, search, and writing tools become available
        to the agent, defaulting to one workspace so it doesn't have to ask every time (it can still
        search or write to any other workspace in your account when that's actually what's needed).
        Signs you in on Svaramind's own page in a popup - SvaraJS never sees your Svaramind password.
      </p>
      <button class="btn primary" type="button" on:click={connectSvaramind} disabled={svaramindConnecting}>
        {svaramindConnecting ? 'Waiting for sign-in...' : 'Connect with Svaramind'}
      </button>
    {:else if showWorkspacePicker}
      {#if svaramindWorkspacesLoading}
        <p class="muted">Loading workspaces...</p>
      {:else if svaramindWorkspacesError}
        <p class="error-text">{svaramindWorkspacesError}</p>
      {:else if svaramindWorkspaces.length === 0}
        <p class="muted">No workspaces found.</p>
      {:else}
        <ul class="workspace-list">
          {#each svaramindWorkspaces as ws (ws.id)}
            <li>
              <button
                class="btn secondary small"
                disabled={svaramindSettingWorkspace}
                on:click={() => chooseSvaramindWorkspace(ws.id)}
              >
                {ws.id === svaramindPinnedWorkspace ? '✓ ' : ''}{ws.name}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="actions" style="margin-top: 0.75rem;">
        <a class="btn secondary small" href={svaramindAppUrl} target="_blank" rel="noreferrer">Create a new workspace &#8599;</a>
        <button class="btn secondary small" type="button" on:click={() => (showWorkspacePicker = false)}>Cancel</button>
      </div>
    {:else}
      <p class="hint">
        Default workspace:
        <strong>{svaramindPinnedWorkspace ? svaramindWorkspaceName(svaramindPinnedWorkspace) : 'not set'}</strong>
        <br />Used automatically when the agent doesn't say which workspace - it can still search or
        write to any other workspace in your account when asked to.
      </p>
      {#if svaramindStatus.tools.length > 0}
        <ul class="chip-list" style="margin-top: 0.5rem;">
          {#each svaramindStatus.tools as tool}<li class="chip">{tool}</li>{/each}
        </ul>
      {/if}
      <div class="actions" style="margin-top: 0.75rem;">
        <button class="btn secondary small" type="button" on:click={openWorkspacePicker}>
          {svaramindPinnedWorkspace ? 'Change workspace' : 'Choose workspace'}
        </button>
        <button class="btn danger small" type="button" on:click={disconnectSvaramind}>Disconnect</button>
      </div>
    {/if}
  </div>
{/if}

<h2 class="section-heading">Connected</h2>
{#if serversLoading}
  <p class="muted">Loading...</p>
{:else if serversError}
  <p class="error-text">{serversError}</p>
{:else if otherServers.length === 0}
  <p class="muted">No other MCP servers connected yet.</p>
{:else}
  <div class="card-grid">
    {#each otherServers as server (server.id)}
      <div class="card">
        <div class="card-header">
          <span class="card-header-icon"><Icon name="grid" /></span>
          <span class="card-header-title">{server.name}</span>
          <span class="chip">{server.transport.type}</span>
        </div>
        {#if server.tools.length > 0}
          <ul class="chip-list">
            {#each server.tools as tool}
              <li class="chip">{tool}</li>
            {/each}
          </ul>
        {:else}
          <p class="muted" style="font-size: 0.8rem;">This server exposes no tools.</p>
        {/if}
        <div class="actions" style="margin-top: 0.85rem;">
          <button class="btn danger small" disabled={disconnectingId === server.id} on:click={() => disconnect(server.id)}>
            Disconnect
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<h2 class="section-heading">Browse marketplace</h2>
<form class="mcp-search" on:submit|preventDefault={search}>
  <input bind:value={searchQuery} placeholder="Search MCP servers (e.g. filesystem, github, slack)..." />
  <button class="btn secondary" type="submit" disabled={searching}>{searching ? 'Searching...' : 'Search'}</button>
</form>

{#if searchError}<p class="error-text">{searchError}</p>{/if}

{#if searched && !searching && searchResults.length === 0 && !searchError}
  <p class="muted">No results.</p>
{/if}

<div class="card-grid">
  {#each searchResults as result (result.registryName)}
    <div class="card">
      <div class="card-header">
        <span class="card-header-icon"><Icon name="grid" /></span>
        <span class="card-header-title">{result.title}</span>
        <span class="chip">{result.transportKind}</span>
      </div>
      <p class="mcp-desc">{result.description || 'No description.'}</p>
      <p class="hint">v{result.version}{#if result.repositoryUrl} - <a href={result.repositoryUrl} target="_blank" rel="noreferrer">source</a>{/if}</p>

      {#if result.transportKind === 'unsupported'}
        <p class="hint">No remote endpoint or npm package - connect it manually instead.</p>
      {:else}
        {#if result.requiredSecrets.length > 0}
          <div class="mcp-secrets">
            {#each result.requiredSecrets as secretName}
              <label class="channel-field">
                {secretName}
                <input
                  type="password"
                  value={stateFor(result.registryName).fields[secretName] || ''}
                  on:input={(e) => { stateFor(result.registryName).fields[secretName] = e.currentTarget.value; connectState = { ...connectState }; }}
                  autocomplete="off"
                />
              </label>
            {/each}
          </div>
        {/if}
        {#if stateFor(result.registryName).error}<p class="error-text">{stateFor(result.registryName).error}</p>{/if}
        <div class="actions" style="margin-top: 0.6rem;">
          <button
            class="btn primary small"
            disabled={stateFor(result.registryName).connecting || isAlreadyConnected(result.registryName)}
            on:click={() => connectFromRegistry(result)}
          >
            {isAlreadyConnected(result.registryName) ? 'Connected' : stateFor(result.registryName).connecting ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      {/if}
    </div>
  {/each}
</div>

<h2 class="section-heading">Add manually</h2>
<button class="btn secondary small" on:click={() => (showManualForm = !showManualForm)}>
  {showManualForm ? 'Cancel' : 'Add a server manually'}
</button>

{#if showManualForm}
  <form class="form" on:submit|preventDefault={connectManual} style="margin-top: 1rem;">
    {#if manualError}<p class="error-text">{manualError}</p>{/if}
    <label>
      Id
      <input bind:value={manual.id} placeholder="my-server" required />
    </label>
    <label>
      Name
      <input bind:value={manual.name} placeholder="My Server" required />
    </label>
    <label>
      Transport
      <select bind:value={manual.transportType}>
        <option value="stdio">stdio (local command)</option>
        <option value="streamable-http">streamable-http (remote)</option>
        <option value="sse">sse (remote)</option>
      </select>
    </label>
    {#if manual.transportType === 'stdio'}
      <label>
        Command
        <input bind:value={manual.command} placeholder="npx" required />
      </label>
      <label>
        Args (space-separated)
        <input bind:value={manual.args} placeholder="-y @acme/some-mcp-server" />
      </label>
      <label>
        Environment variables
        <input bind:value={manual.extra} placeholder="API_KEY=..., OTHER=..." />
      </label>
    {:else}
      <label>
        URL
        <input bind:value={manual.url} placeholder="https://example.com/mcp" required />
      </label>
      <label>
        Headers
        <input bind:value={manual.extra} placeholder="Authorization=Bearer ..." />
      </label>
    {/if}
    <div class="actions">
      <button class="btn primary" type="submit" disabled={manualConnecting}>
        {manualConnecting ? 'Connecting...' : 'Connect'}
      </button>
    </div>
  </form>
{/if}

<style>
  .svaramind-card {
    max-width: 640px;
    margin-bottom: 1.5rem;
  }
  .workspace-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .workspace-list button {
    width: 100%;
    justify-content: flex-start;
  }
  .mcp-search {
    display: flex;
    gap: 0.6rem;
    margin-bottom: 1rem;
    max-width: 640px;
  }
  .mcp-search input {
    flex: 1;
    font-family: inherit;
    font-size: 0.9rem;
    color: var(--text-primary);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
  }
  .mcp-search input:focus {
    outline: none;
    border-color: var(--primary);
  }
  .mcp-desc {
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin-bottom: 0.3rem;
  }
  .mcp-secrets {
    margin-top: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .channel-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .channel-field input {
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 400;
    color: var(--text-primary);
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    padding: 0.5rem 0.65rem;
  }
  .channel-field input:focus {
    outline: none;
    border-color: var(--primary);
  }
</style>
