<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { formatDate } from '../lib/format';

  const POLL_MS = 4000;

  let tools = [];
  let toolsLoading = true;
  let toolsError = '';

  let approvalsEnabled = false;
  let pending = [];
  let approvalsLoading = true;
  let approvalsError = '';
  let respondingId = null;

  let pollTimer;

  async function loadTools() {
    try {
      const res = await api.get('/api/tools');
      tools = res.tools || [];
      toolsError = '';
    } catch (e) {
      toolsError = e instanceof ApiError ? e.message : 'Failed to load tools.';
    } finally {
      toolsLoading = false;
    }
  }

  async function loadApprovals() {
    try {
      const res = await api.get('/api/approvals');
      approvalsEnabled = !!res.enabled;
      pending = res.pending || [];
      approvalsError = '';
    } catch (e) {
      approvalsError = e instanceof ApiError ? e.message : 'Failed to load approvals.';
    } finally {
      approvalsLoading = false;
    }
  }

  async function respond(id, approved) {
    respondingId = id;
    try {
      await api.post(`/api/approvals/${id}/respond`, { approved });
      await loadApprovals();
    } catch (e) {
      approvalsError = e instanceof ApiError ? e.message : 'Failed to respond to approval.';
    } finally {
      respondingId = null;
    }
  }

  onMount(() => {
    loadTools();
    loadApprovals();
    pollTimer = setInterval(loadApprovals, POLL_MS);
  });

  onDestroy(() => clearInterval(pollTimer));
</script>

<h1>Tools</h1>

<section>
  <h2>Active tools</h2>
  {#if toolsLoading}
    <p class="muted">Loading...</p>
  {:else if toolsError}
    <p class="error-text">{toolsError}</p>
  {:else if tools.length === 0}
    <p class="muted">No tools registered on this agent.</p>
  {:else}
    <ul class="list">
      {#each tools as tool (tool.name)}
        <li class="list-item">
          <div class="list-item-title">{tool.name}</div>
          <div class="list-item-desc">{tool.description}</div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section>
  <h2>Pending approvals</h2>
  {#if approvalsError}
    <p class="error-text">{approvalsError}</p>
  {/if}
  {#if approvalsLoading}
    <p class="muted">Loading...</p>
  {:else if !approvalsEnabled}
    <p class="muted">The approval queue is not active on this runtime - no pending approvals to show.</p>
  {:else if pending.length === 0}
    <p class="muted">No pending approvals right now.</p>
  {:else}
    <ul class="list">
      {#each pending as item (item.id)}
        <li class="list-item approval-item">
          <div>
            <div class="list-item-title"><code>{item.command}</code></div>
            <div class="list-item-desc">{item.reason}</div>
            <div class="list-item-meta">Requested {formatDate(item.createdAt)}</div>
          </div>
          <div class="actions">
            <button
              class="btn success small"
              disabled={respondingId === item.id}
              on:click={() => respond(item.id, true)}
            >
              Approve
            </button>
            <button
              class="btn danger small"
              disabled={respondingId === item.id}
              on:click={() => respond(item.id, false)}
            >
              Deny
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
