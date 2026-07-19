<script>
  import { authPromptOpen, authMessage, submitAuthToken, cancelAuthPrompt } from '../lib/api';

  let value = '';

  function submit() {
    if (!value.trim()) return;
    submitAuthToken(value);
    value = '';
  }

  function onKeydown(e) {
    if (e.key === 'Enter') submit();
  }

  function focusOnMount(node) {
    node.focus();
  }
</script>

{#if $authPromptOpen}
  <div class="overlay">
    <div class="modal">
      <h2>Access token required</h2>
      <p class="desc">This dashboard is protected. Enter the bearer token configured for this runtime.</p>
      {#if $authMessage}<p class="hint">{$authMessage}</p>{/if}
      <input
        type="password"
        placeholder="Access token"
        bind:value
        on:keydown={onKeydown}
        use:focusOnMount
      />
      <div class="actions">
        <button class="btn secondary" on:click={cancelAuthPrompt}>Cancel</button>
        <button class="btn primary" on:click={submit}>Continue</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
  }

  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1.75rem;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  }

  .desc {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin: 0.5rem 0 0.75rem;
  }

  .hint {
    color: var(--accent);
    font-size: 0.85rem;
    margin-bottom: 0.75rem;
  }

  input {
    width: 100%;
    font-family: inherit;
    font-size: 0.9rem;
    color: var(--text-primary);
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
    margin-bottom: 1.1rem;
  }

  input:focus {
    outline: none;
    border-color: var(--primary);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
  }
</style>
