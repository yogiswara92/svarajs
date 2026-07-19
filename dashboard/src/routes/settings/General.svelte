<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../../lib/api';
  import RestartBanner from '../../components/RestartBanner.svelte';

  let loading = true;
  let loadError = '';
  let saving = false;
  let saveError = '';
  let saved = false;

  let form = { name: '', systemPrompt: '', port: 3000 };

  function populateForm(config) {
    form = {
      name: config.name || '',
      systemPrompt: config.systemPrompt || '',
      port: config.port || 3000,
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
        name: form.name,
        systemPrompt: form.systemPrompt || undefined,
        port: Number(form.port),
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

<h1>General</h1>
<p class="note">
  Agent identity and server port. Saved to <code>svara.config.json</code> - changes take effect after
  you restart the runtime (stop the process and run <code>svara start</code> / <code>npm start</code> again).
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
      Name
      <input bind:value={form.name} required />
    </label>
    <label>
      System prompt
      <textarea bind:value={form.systemPrompt} rows="3"></textarea>
    </label>
    <label>
      Port
      <input type="number" bind:value={form.port} min="1" max="65535" required />
    </label>

    <div class="actions">
      <button class="btn primary" type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>
    </div>
  </form>
{/if}
