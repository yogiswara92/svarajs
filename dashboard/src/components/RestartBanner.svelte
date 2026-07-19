<script>
  import { api, ApiError } from '../lib/api';

  export let show = false;

  let restarting = false;
  let restartError = '';

  async function restart() {
    if (!confirm('Restart the runtime now to apply these changes? The dashboard will be unavailable for a few seconds.')) return;
    restarting = true;
    restartError = '';
    try {
      await api.post('/api/restart');
    } catch (e) {
      // A clean HTTP error response (e.g. "restart not available in library
      // mode") means the request landed and failed - stop here. A raw
      // network failure (connection dropped mid-restart) isn't an ApiError
      // and is the expected/successful case - fall through to polling.
      if (e instanceof ApiError) {
        restartError = e.message;
        restarting = false;
        return;
      }
    }
    waitForRestart();
  }

  function waitForRestart() {
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/health');
        if (res.ok) {
          clearInterval(poll);
          window.location.reload();
        }
      } catch {
        // Still down - keep polling.
      }
    }, 1000);
  }
</script>

{#if show}
  <div class="restart-banner">
    <p class="success-text">Saved - restart the runtime to apply these changes.</p>
    {#if restartError}<p class="error-text">{restartError}</p>{/if}
    <button class="btn secondary small" type="button" on:click={restart} disabled={restarting}>
      {restarting ? 'Restarting...' : 'Restart runtime now'}
    </button>
  </div>
{/if}

<style>
  .restart-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
  }
  .restart-banner .success-text,
  .restart-banner .error-text {
    margin: 0;
  }
</style>
