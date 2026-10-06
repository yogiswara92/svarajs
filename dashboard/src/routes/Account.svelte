<script>
  import { onMount } from 'svelte';
  import { auth, ApiError } from '../lib/api';

  export let email = '';

  let current = '';
  let next = '';
  let repeat = '';
  let busy = false;
  let error = '';
  let done = false;

  async function submit() {
    error = '';
    done = false;
    if (next.length < 10) { error = 'New password must be at least 10 characters.'; return; }
    if (next !== repeat) { error = 'The new passwords do not match.'; return; }
    busy = true;
    try {
      await auth.changePassword(current, next);
      current = next = repeat = '';
      done = true;
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not change the password.';
    } finally {
      busy = false;
    }
  }

  let people = [];
  let newEmail = '';
  let newPassword = '';
  let peopleBusy = false;
  let peopleError = '';
  let peopleNote = '';

  async function loadPeople() {
    try { people = (await auth.users()).users; } catch { /* shown empty */ }
  }
  onMount(loadPeople);

  async function addPerson() {
    peopleError = '';
    peopleNote = '';
    if (newPassword.length < 10) { peopleError = 'Password must be at least 10 characters.'; return; }
    peopleBusy = true;
    try {
      await auth.addUser(newEmail.trim(), newPassword);
      peopleNote = `${newEmail.trim()} can now sign in. Share the password with them privately.`;
      newEmail = newPassword = '';
      await loadPeople();
    } catch (e) {
      peopleError = e instanceof ApiError ? e.message : 'Could not add that person.';
    } finally {
      peopleBusy = false;
    }
  }

  async function removePerson(addr) {
    if (!confirm(`Remove ${addr}? They will be signed out and lose access.`)) return;
    peopleError = '';
    try {
      await auth.removeUser(addr);
      await loadPeople();
    } catch (e) {
      peopleError = e instanceof ApiError ? e.message : 'Could not remove that person.';
    }
  }
</script>



<h1>Account</h1>
<p class="note">Signed in as <strong>{email}</strong>.</p>

<h2>Change password</h2>
<form class="form" on:submit|preventDefault={submit}>
  {#if error}<div class="error-text">{error}</div>{/if}
  {#if done}<div class="success-text">Password changed. Other devices signed in with the old password are signed out.</div>{/if}
  <label>Current password<input type="password" bind:value={current} autocomplete="current-password" required /></label>
  <label>New password<input type="password" bind:value={next} autocomplete="new-password" required /><span class="hint">At least 10 characters. A few random words is fine.</span></label>
  <label>Repeat new password<input type="password" bind:value={repeat} autocomplete="new-password" required /></label>
  <div class="actions"><button class="btn primary" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Change password'}</button></div>
</form>

<h2 style="margin-top:2rem">People with access</h2>
<ul class="list" style="max-width:640px;margin-bottom:1rem">
  {#each people as p (p.email)}
    <li class="list-item approval-item">
      <span>{p.email}{p.email.toLowerCase() === email.toLowerCase() ? ' (you)' : ''}</span>
      {#if p.email.toLowerCase() !== email.toLowerCase()}
        <button class="btn small danger" type="button" on:click={() => removePerson(p.email)}>Remove</button>
      {/if}
    </li>
  {/each}
</ul>
<form class="form" on:submit|preventDefault={addPerson}>
  {#if peopleError}<div class="error-text">{peopleError}</div>{/if}
  {#if peopleNote}<div class="success-text">{peopleNote}</div>{/if}
  <label>Add a person (email)<input type="email" bind:value={newEmail} required /></label>
  <label>Their starting password<input type="password" bind:value={newPassword} autocomplete="new-password" required /><span class="hint">At least 10 characters. They can change it here after signing in.</span></label>
  <div class="actions"><button class="btn secondary" type="submit" disabled={peopleBusy}>{peopleBusy ? 'Adding...' : 'Add person'}</button></div>
</form>
