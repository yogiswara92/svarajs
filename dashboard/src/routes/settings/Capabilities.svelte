<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../../lib/api';
  import RestartBanner from '../../components/RestartBanner.svelte';
  import Icon from '../../components/Icon.svelte';

  let loading = true;
  let loadError = '';
  let saving = false;
  let saveError = '';
  let saved = false;

  let form = {
    terminal: false, filesystem: false, web: false, browser: false,
    webProvider: '', webSearchApiKey: '', webGoogleApiKey: '', webGoogleSearchEngineId: '',
    skillsDir: '', learningMemory: false, backgroundReview: false, maxIterations: '',
  };

  const SEARCH_PROVIDERS = [
    { value: '', label: 'Auto (Tavily if set, else Google, else Playwright fallback)' },
    { value: 'tavily', label: 'Tavily' },
    { value: 'google', label: 'Google Custom Search' },
  ];

  // "Browser" only flips a config flag - the agent registers the tool either
  // way and would otherwise only discover "playwright" is missing mid-reply,
  // confusingly, when it actually tries to use it. null = not checked yet.
  let playwrightInstalled = null;
  let playwrightInstalling = false;
  let playwrightInstallError = '';

  async function checkPlaywrightStatus() {
    try {
      const res = await api.get('/api/tools/browser/status');
      playwrightInstalled = res.installed;
    } catch {
      // Non-critical - just leave the warning unshown rather than blocking the page.
    }
  }

  async function installPlaywright() {
    playwrightInstalling = true;
    playwrightInstallError = '';
    try {
      const res = await api.post('/api/tools/browser/install');
      playwrightInstalled = res.installed;
    } catch (e) {
      playwrightInstallError = e instanceof ApiError ? e.message : 'Install failed.';
    } finally {
      playwrightInstalling = false;
    }
  }

  const TOOL_TOGGLES = [
    { key: 'terminal', icon: 'terminal', title: 'Terminal', desc: 'terminal_exec - see SECURITY.md before enabling' },
    { key: 'filesystem', icon: 'folder', title: 'Filesystem', desc: 'file_read / file_write / list_files' },
    { key: 'web', icon: 'globe', title: 'Web', desc: 'web_fetch / web_search' },
    { key: 'browser', icon: 'camera', title: 'Browser', desc: 'Requires the optional "playwright" package' },
  ];

  function populateForm(config) {
    const learningMemory = config.learningMemory;
    const webConfig = typeof config.tools?.web === 'object' && config.tools.web !== null ? config.tools.web : {};
    form = {
      terminal: !!config.tools?.terminal,
      filesystem: !!config.tools?.filesystem,
      web: !!config.tools?.web,
      browser: !!config.tools?.browser,
      webProvider: webConfig.provider || '',
      webSearchApiKey: webConfig.searchApiKey || '',
      webGoogleApiKey: webConfig.googleApiKey || '',
      webGoogleSearchEngineId: webConfig.googleSearchEngineId || '',
      skillsDir: config.skillsDir || '',
      learningMemory: learningMemory === true || (learningMemory && typeof learningMemory === 'object'),
      backgroundReview: !!config.backgroundReview,
      maxIterations: config.maxIterations ? String(config.maxIterations) : '',
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

  onMount(() => {
    load();
    checkPlaywrightStatus();
  });

  async function save() {
    saving = true;
    saveError = '';
    saved = false;
    try {
      const webOptions = (form.webProvider || form.webSearchApiKey || form.webGoogleApiKey || form.webGoogleSearchEngineId)
        ? {
            provider: form.webProvider || undefined,
            searchApiKey: form.webSearchApiKey || undefined,
            googleApiKey: form.webGoogleApiKey || undefined,
            googleSearchEngineId: form.webGoogleSearchEngineId || undefined,
          }
        : true;
      const payload = {
        tools: {
          terminal: form.terminal,
          filesystem: form.filesystem,
          web: form.web ? webOptions : false,
          browser: form.browser,
        },
        skillsDir: form.skillsDir || undefined,
        learningMemory: form.learningMemory,
        backgroundReview: form.backgroundReview,
        maxIterations: form.maxIterations ? Number(form.maxIterations) : undefined,
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

<h1>Capabilities</h1>
<p class="note">
  Tools and self-learning behavior the agent has access to. Saved to <code>svara.config.json</code> -
  changes take effect after you restart the runtime.
</p>

{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else}
  <form on:submit|preventDefault={save}>
    {#if saveError}<p class="error-text">{saveError}</p>{/if}
    <RestartBanner show={saved} />

    <h2 class="section-heading">Tools</h2>
    <div class="toggle-list">
      {#each TOOL_TOGGLES as t (t.key)}
        <label class="toggle-row">
          <span class="toggle-row-icon"><Icon name={t.icon} /></span>
          <span class="toggle-row-text" style="flex: 1">
            <span class="toggle-row-title">{t.title}</span>
            <span class="toggle-row-desc">{t.desc}</span>
          </span>
          <span class="switch">
            <input type="checkbox" bind:checked={form[t.key]} />
            <span class="switch-track"></span>
          </span>
        </label>
        {#if t.key === 'web' && form.web}
          <div class="web-search-config">
            <label class="form-field">
              Search provider
              <select bind:value={form.webProvider}>
                {#each SEARCH_PROVIDERS as p}
                  <option value={p.value}>{p.label}</option>
                {/each}
              </select>
              <span class="hint">
                With no key configured for either provider, web_search automatically falls back to scraping
                DuckDuckGo with the Browser tool's Playwright instance - slower and less reliable, but needs
                no API key at all.
              </span>
            </label>
            <label class="form-field">
              Tavily API key
              <input type="password" bind:value={form.webSearchApiKey} placeholder="tvly-..." autocomplete="off" />
              <span class="hint">Stored encrypted in <code>svara.config.json</code>. Get one at tavily.com.</span>
            </label>
            <label class="form-field">
              Google API key
              <input type="password" bind:value={form.webGoogleApiKey} placeholder="AIza..." autocomplete="off" />
              <span class="hint">From a Google Cloud project with the "Custom Search API" enabled.</span>
            </label>
            <label class="form-field">
              Google Search Engine ID (cx)
              <input bind:value={form.webGoogleSearchEngineId} placeholder="a1b2c3d4e5f6g7h8i" />
              <span class="hint">From a Programmable Search Engine configured to search the whole web.</span>
            </label>
          </div>
        {/if}
        {#if t.key === 'browser' && form.browser && playwrightInstalled === false}
          <div class="playwright-warning">
            <p>
              <Icon name="alert-triangle" /> Playwright isn't installed yet - the browser tool is on but will
              fail as soon as the agent tries to use it. Downloads Chromium (~170-300 MB), usually 1-3 minutes.
            </p>
            {#if playwrightInstallError}<p class="error-text">{playwrightInstallError}</p>{/if}
            <button type="button" class="btn secondary small" on:click={installPlaywright} disabled={playwrightInstalling}>
              {playwrightInstalling ? 'Installing...' : 'Install now'}
            </button>
          </div>
        {/if}
      {/each}
    </div>
    <p class="hint">
      Toggling a tool that already has extra options set (e.g. a custom filesystem root) keeps those
      options - it only flips the on/off state.
    </p>

    <h2 class="section-heading">Skills &amp; Memory</h2>
    <label class="form-field">
      Skills directory
      <input bind:value={form.skillsDir} placeholder="./skills" />
      <span class="hint">Leave blank to disable the skill system.</span>
    </label>
    <div class="toggle-list" style="margin-top: 0.75rem">
      <label class="toggle-row">
        <span class="toggle-row-icon"><Icon name="brain" /></span>
        <span class="toggle-row-text" style="flex: 1">
          <span class="toggle-row-title">Learning memory</span>
          <span class="toggle-row-desc">MEMORY.md / USER.md</span>
        </span>
        <span class="switch">
          <input type="checkbox" bind:checked={form.learningMemory} />
          <span class="switch-track"></span>
        </span>
      </label>
      <label class="toggle-row">
        <span class="toggle-row-icon"><Icon name="sliders" /></span>
        <span class="toggle-row-text" style="flex: 1">
          <span class="toggle-row-title">Background auto-review</span>
          <span class="toggle-row-desc">Let the agent save memory/skills after a reply, without being asked</span>
        </span>
        <span class="switch">
          <input type="checkbox" bind:checked={form.backgroundReview} />
          <span class="switch-track"></span>
        </span>
      </label>
    </div>

    <h2 class="section-heading">Reasoning</h2>
    <label class="form-field">
      Max tool-calling iterations
      <input type="number" min="1" step="1" bind:value={form.maxIterations} placeholder="10" />
      <span class="hint">
        Per-request cap on tool calls before the agent stops with "reasoning limit reached" instead of
        continuing. Default is 10 - raise it for tasks that need many steps to converge (e.g. multi-page
        browsing); this only changes how long a request can run before the safety net kicks in.
      </span>
    </label>

    <div class="actions" style="margin-top: 1.5rem">
      <button class="btn primary" type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>
    </div>
  </form>
{/if}

<style>
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
    max-width: 640px;
  }
  .form-field input {
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 400;
    color: var(--text-primary);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
  }
  .form-field input:focus {
    outline: none;
    border-color: var(--primary);
  }
  .form-field select {
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 400;
    color: var(--text-primary);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
  }

  .web-search-config {
    margin: -0.25rem 0 0.75rem;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .playwright-warning {
    margin: -0.25rem 0 0.75rem;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, orange 12%, var(--surface));
    border: 1px solid color-mix(in srgb, orange 35%, var(--border));
  }
  .playwright-warning p {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.6rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
</style>
