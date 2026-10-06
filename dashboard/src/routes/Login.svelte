<script>
  import { createEventDispatcher } from 'svelte';
  import { auth, ApiError } from '../lib/api';

  export let agentName = '';
  const base = import.meta.env.BASE_URL;
  const dispatch = createEventDispatcher();

  let email = '';
  let password = '';
  let busy = false;
  let error = '';
  let showPassword = false;

  async function submit() {
    if (busy || !email.trim() || !password) return;
    busy = true;
    error = '';
    try {
      const r = await auth.login(email.trim(), password);
      password = '';
      dispatch('success', { email: r.email });
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not sign in. Please try again.';
    } finally {
      busy = false;
    }
  }
</script>

<div class="login-page">
  <form class="login-card" on:submit|preventDefault={submit}>
    <img src="{base}svarajs-logo.png" alt="SvaraJS" class="logo logo-light" />
    <img src="{base}svarajs-logo-white.png" alt="SvaraJS" class="logo logo-dark" />
    <h1>{agentName ? `Sign in to ${agentName}` : 'Sign in'}</h1>
    <p class="sub">Enter your email and password to open the dashboard.</p>

    {#if error}<div class="error-text" role="alert">{error}</div>{/if}

    <label>
      Email
      <input type="email" bind:value={email} autocomplete="username" autocapitalize="off" spellcheck="false" required />
    </label>
    <label>
      Password
      <span class="pw">
        {#if showPassword}
          <input type="text" bind:value={password} autocomplete="current-password" required />
        {:else}
          <input type="password" bind:value={password} autocomplete="current-password" required />
        {/if}
        <button type="button" class="toggle" on:click={() => (showPassword = !showPassword)}>{showPassword ? 'Hide' : 'Show'}</button>
      </span>
    </label>

    <button class="btn primary submit" type="submit" disabled={busy || !email.trim() || !password}>
      {busy ? 'Signing in...' : 'Sign in'}
    </button>
  </form>
</div>

<style>
  .login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; background: var(--background); }
  .login-card { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--border); border-radius: 0.9rem; padding: 2rem 1.75rem; display: flex; flex-direction: column; gap: 1rem; }
  .logo { height: 34px; width: auto; align-self: flex-start; }
  .logo-dark { display: none; }
  @media (prefers-color-scheme: dark) { .logo-light { display: none; } .logo-dark { display: block; } }
  h1 { margin: 0.25rem 0 0; font-size: 1.35rem; }
  .sub { color: var(--text-muted); font-size: 0.9rem; margin-top: -0.4rem; }
  label { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); }
  input { font-family: inherit; font-size: 1rem; color: var(--text-primary); background: var(--background); border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.65rem 0.75rem; width: 100%; }
  input:focus { outline: none; border-color: var(--primary); }
  .pw { position: relative; display: block; }
  .pw input { padding-right: 4.2rem; }
  .toggle { position: absolute; right: 0.4rem; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--primary); font-size: 0.8rem; font-weight: 600; cursor: pointer; padding: 0.3rem 0.5rem; }
  .submit { width: 100%; padding: 0.7rem; font-size: 0.95rem; margin-top: 0.25rem; }
</style>
