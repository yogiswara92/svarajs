<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../../lib/api';
  import RestartBanner from '../../components/RestartBanner.svelte';

  let loading = true;
  let loadError = '';
  let saving = false;
  let saveError = '';
  let saved = false;

  let form = { apiKey: '', dashboardToken: '' };
  let channels = {};
  let port = 3000;

  $: origin = typeof window !== 'undefined' ? window.location.origin : '';
  $: curlExample = `curl -X POST ${origin || `http://localhost:${port}`}/chat \\\n  -H "Content-Type: application/json" \\\n  ${form.apiKey ? '-H "Authorization: Bearer <your key>" \\\n  ' : ''}-d '{"message": "hi"}'`;

  function populateForm(config) {
    form = {
      apiKey: config.apiKey || '',
      dashboardToken: (typeof config.dashboard === 'object' && config.dashboard?.token) || '',
    };
    channels = (typeof config.channels === 'object' && config.channels) || {};
    port = config.port || 3000;
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
        apiKey: form.apiKey || undefined,
        dashboard: form.dashboardToken ? { token: form.dashboardToken } : true,
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

<h1>API &amp; Webhooks</h1>
<p class="note">
  Credentials for talking to this agent programmatically, and the inbound webhook endpoints your
  connected channels already expose. Saved to <code>svara.config.json</code> - changes take effect
  after you restart the runtime.
</p>

{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else}
  <form on:submit|preventDefault={save}>
    {#if saveError}<p class="error-text">{saveError}</p>{/if}
    <RestartBanner show={saved} />

    <h2 class="section-heading">Chat API key</h2>
    <p class="hint" style="margin-bottom: 0.75rem;">
      <strong>POST /chat</strong> (used by the web widget, a curl call, any external app) has no
      authentication by default - anyone who can reach this server's port can chat with the agent and
      trigger any tool it has (terminal, filesystem, browser, ...) for free. Set a key to require
      <code>Authorization: Bearer &lt;key&gt;</code> on that endpoint.
    </p>
    <label class="form-field">
      API key
      <input type="password" bind:value={form.apiKey} placeholder="Leave blank for no protection" autocomplete="off" />
    </label>
    <pre class="code-block">{curlExample}</pre>

    <h2 class="section-heading">Dashboard admin token</h2>
    <p class="hint" style="margin-bottom: 0.75rem;">
      Protects this dashboard's own <code>/api/*</code> routes (config, chat history, restart, ...) -
      separate from the chat API key above. Rotating this logs out any browser tab still using the old
      token; you'll be asked to enter the new one.
    </p>
    <label class="form-field">
      Dashboard token
      <input type="password" bind:value={form.dashboardToken} placeholder="Leave blank for no protection" autocomplete="off" />
    </label>

    <div class="actions" style="margin-top: 1.5rem">
      <button class="btn primary" type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>
    </div>
  </form>

  <h2 class="section-heading">Webhook endpoints</h2>
  <p class="hint" style="margin-bottom: 0.75rem;">
    Inbound webhook URLs for channels configured on the <a href="#/settings-channels">Channels</a> page.
    Point each platform's webhook settings at the matching URL below (needs a public HTTPS URL - a
    tunnel like ngrok, or your VPS's real domain, not localhost).
  </p>
  <div class="webhook-list">
    <div class="webhook-item" class:inactive={!channels.slack}>
      <span class="webhook-name">Slack Events API</span>
      <code class="webhook-url">{origin}/slack/events</code>
      <span class="webhook-status">{channels.slack ? 'Configured' : 'Not configured'}</span>
    </div>
    <div class="webhook-item" class:inactive={!channels.whatsapp}>
      <span class="webhook-name">WhatsApp Cloud API</span>
      <code class="webhook-url">{origin}/whatsapp/webhook</code>
      <span class="webhook-status">{channels.whatsapp ? 'Configured' : 'Not configured'}</span>
    </div>
    <div class="webhook-item" class:inactive={!channels.telegram}>
      <span class="webhook-name">Telegram (webhook mode)</span>
      <code class="webhook-url">{origin}/telegram/webhook</code>
      <span class="webhook-status">
        {channels.telegram ? 'Configured (polling unless webhookUrl is set)' : 'Not configured'}
      </span>
    </div>
  </div>
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
  .code-block {
    margin-top: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-all;
    max-width: 640px;
  }
  .webhook-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-width: 720px;
  }
  .webhook-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.9rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    flex-wrap: wrap;
  }
  .webhook-item.inactive {
    opacity: 0.55;
  }
  .webhook-name {
    font-weight: 600;
    font-size: 0.85rem;
    min-width: 170px;
  }
  .webhook-url {
    flex: 1;
    font-size: 0.8rem;
    color: var(--text-secondary);
    word-break: break-all;
  }
  .webhook-status {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>
