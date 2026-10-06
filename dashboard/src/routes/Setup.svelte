<script>
  import { createEventDispatcher } from 'svelte';
  import { auth, ApiError } from '../lib/api';

  export let agentName = '';
  /** Lets someone who already has the old access token skip account creation. */
  export let allowSkip = false;
  /** 'direct' = just register, 'code' = confirm with a one-time code first. */
  export let method = 'direct';
  /** True when the code can only be read from the server log (no Telegram linked). */
  export let viaLog = false;
  export let minutesLeft = 0;
  const base = import.meta.env.BASE_URL;
  const dispatch = createEventDispatcher();

  // With the 'code' method the first step requests it; otherwise go straight to the form.
  let step = method === 'code' ? 1 : 2;
  let delivered = [];
  let code = '';
  let email = '';
  let password = '';
  let repeat = '';
  let busy = false;
  let error = '';

  async function requestCode() {
    busy = true;
    error = '';
    try {
      const r = await auth.setupRequest();
      delivered = r.delivered;
      step = 2;
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not send the code.';
    } finally {
      busy = false;
    }
  }

  async function create() {
    error = '';
    if (password.length < 10) { error = 'Password must be at least 10 characters.'; return; }
    if (password !== repeat) { error = 'The two passwords do not match.'; return; }
    busy = true;
    try {
      const r = await auth.setupComplete(code, email.trim(), password);
      password = repeat = '';
      dispatch('success', { email: r.email });
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not create the account.';
    } finally {
      busy = false;
    }
  }

  $: viaTelegram = delivered.includes('telegram');
</script>

<div class="page">
  <div class="card-box">
    <img src="{base}svarajs-logo.png" alt="SvaraJS" class="logo logo-light" />
    <img src="{base}svarajs-logo-white.png" alt="SvaraJS" class="logo logo-dark" />
    <h1>{agentName ? `Set up ${agentName}` : 'Set up your dashboard'}</h1>

    {#if error}<div class="error-text" role="alert">{error}</div>{/if}

    {#if step === 1}
      {#if viaLog}
        <p class="sub">Create your login so only you can open this dashboard. Because nobody finished setup in the first hour, we now need proof that you control this server.</p>
        <p class="warn-line">Click the button, then read the one-time code in the server's log, for example <code>pm2 logs</code>, <code>journalctl -u &lt;service&gt; -n 20</code>, or the terminal where you ran <code>svara start</code>.</p>
      {:else}
        <p class="sub">Create your login so only you can open this dashboard. First we confirm it's really you by sending a one-time code.</p>
      {/if}
      <ol class="steps">
        <li class="on"><b>1</b> Get a code</li><li><b>2</b> Create login</li>
      </ol>
      <button class="btn primary wide" on:click={requestCode} disabled={busy}>{busy ? 'Sending...' : 'Send me a code'}</button>
      {#if !viaLog}<p class="hint-line">The code goes to your Telegram bot chat, and is also written to the server log.</p>{/if}
    {:else}
      {#if method === 'code'}
        <ol class="steps">
          <li><b>1</b> Get a code</li><li class="on"><b>2</b> Create login</li>
        </ol>
        {#if viaTelegram}
          <p class="ok-line">Code sent. Open your Telegram bot chat and read the message.</p>
        {:else}
          <p class="warn-line">The code was written to the server log (not sent anywhere). Look for the line "Dashboard setup code".</p>
        {/if}
      {:else}
        <p class="sub">Welcome! Create the first account to open this dashboard. It becomes the administrator.</p>
        <p class="warn-line">Do this now: until an account exists, whoever opens this page first can create it. This page closes by itself in about {minutesLeft} minutes.</p>
      {/if}

      <form on:submit|preventDefault={create}>
        {#if method === 'code'}
          <label>{viaLog ? 'Code from the server log' : 'Code from Telegram'}<input inputmode="numeric" placeholder="1234-5678" bind:value={code} autocomplete="one-time-code" required /></label>
        {/if}
        <label>Your email<input type="email" bind:value={email} autocomplete="username" required /></label>
        <label>Choose a password<input type="password" bind:value={password} autocomplete="new-password" required /><span class="hint">At least 10 characters. A few random words works well.</span></label>
        <label>Repeat password<input type="password" bind:value={repeat} autocomplete="new-password" required /></label>
        <button class="btn primary wide" type="submit" disabled={busy}>{busy ? 'Creating...' : method === 'code' ? 'Create login' : 'Create account'}</button>
      </form>
      {#if method === 'code'}
        <button class="link" type="button" on:click={() => { step = 1; error = ''; }}>Send a new code</button>
      {/if}
    {/if}

    {#if allowSkip}
      <button class="link" type="button" on:click={() => dispatch('skip')}>I already have an access token</button>
    {/if}
  </div>
</div>

<style>
  .page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; background: var(--background); }
  .card-box { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: 0.9rem; padding: 2rem 1.75rem; display: flex; flex-direction: column; gap: 1rem; }
  .logo { height: 34px; width: auto; align-self: flex-start; }
  .logo-dark { display: none; }
  @media (prefers-color-scheme: dark) { .logo-light { display: none; } .logo-dark { display: block; } }
  h1 { margin: 0.25rem 0 0; font-size: 1.35rem; }
  .sub { color: var(--text-secondary); font-size: 0.92rem; }
  .steps { list-style: none; display: flex; gap: 0.5rem; font-size: 0.8rem; color: var(--text-muted); }
  .steps li { display: flex; align-items: center; gap: 0.35rem; }
  .steps li b { display: inline-flex; width: 1.3rem; height: 1.3rem; border-radius: 50%; align-items: center; justify-content: center; background: var(--surface-alt); border: 1px solid var(--border); font-size: 0.75rem; }
  .steps li.on { color: var(--text-primary); font-weight: 600; }
  .steps li.on b { background: var(--primary); border-color: var(--primary); color: #fff; }
  .steps li + li::before { content: ''; width: 1.2rem; height: 1px; background: var(--border); margin-right: 0.15rem; }
  form { display: flex; flex-direction: column; gap: 0.9rem; }
  label { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); }
  input { font-family: inherit; font-size: 1rem; color: var(--text-primary); background: var(--background); border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.65rem 0.75rem; width: 100%; }
  input:focus { outline: none; border-color: var(--primary); }
  .hint { font-size: 0.75rem; font-weight: 400; color: var(--text-muted); }
  .wide { width: 100%; padding: 0.7rem; font-size: 0.95rem; }
  .hint-line { font-size: 0.8rem; color: var(--text-muted); }
  .ok-line { font-size: 0.9rem; color: var(--success); font-weight: 600; }
  .warn-line { font-size: 0.85rem; color: var(--text-secondary); background: var(--surface-alt); border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.6rem 0.75rem; }
  .link { background: none; border: none; color: var(--primary); font-size: 0.85rem; font-weight: 600; cursor: pointer; padding: 0.2rem 0; align-self: flex-start; font-family: inherit; }
</style>
