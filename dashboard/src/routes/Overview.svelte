<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { formatUptime } from '../lib/format';

  const POLL_MS = 10000;

  let status = null;
  let loading = true;
  let error = '';
  let timer;

  async function load() {
    try {
      status = await api.get('/api/status');
      error = '';
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Failed to load status.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load();
    timer = setInterval(load, POLL_MS);
  });

  onDestroy(() => clearInterval(timer));
</script>

<h1>Overview</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else if error}
  <p class="error-text">{error}</p>
{:else if status}
  <div class="card-grid">
    <div class="card">
      <div class="card-label">Agent</div>
      <div class="card-value">{status.name}</div>
    </div>
    <div class="card">
      <div class="card-label">Uptime</div>
      <div class="card-value">{formatUptime(status.uptimeSeconds)}</div>
    </div>
    <div class="card">
      <div class="card-label">Connected channels</div>
      {#if status.channels && status.channels.length}
        <ul class="chip-list">
          {#each status.channels as channel (channel)}
            <li class="chip">{channel}</li>
          {/each}
        </ul>
      {:else}
        <div class="muted">No channels connected</div>
      {/if}
    </div>
  </div>
{/if}
