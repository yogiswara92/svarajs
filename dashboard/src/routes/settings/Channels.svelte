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
    telegramToken: '',
    telegramAllowedUserIds: '',
    whatsappToken: '',
    whatsappPhoneId: '',
    whatsappVerifyToken: '',
    slackBotToken: '',
    slackSigningSecret: '',
    discordBotToken: '',
  };

  // Channels the user clicked "Disconnect" on this form session - saved as
  // an explicit `null` so the backend removes the stored credentials
  // entirely. Blank fields alone can't express that: "all fields blank" is
  // indistinguishable from "never touched this channel", so a plain save
  // with empty inputs silently leaves the old stored token in place.
  let clearedChannels = new Set();

  function populateForm(config) {
    form = {
      telegramToken: config.channels?.telegram?.token || '',
      telegramAllowedUserIds: (config.channels?.telegram?.allowedUserIds || []).join(', '),
      whatsappToken: config.channels?.whatsapp?.token || '',
      whatsappPhoneId: config.channels?.whatsapp?.phoneId || '',
      whatsappVerifyToken: config.channels?.whatsapp?.verifyToken || '',
      slackBotToken: config.channels?.slack?.botToken || '',
      slackSigningSecret: config.channels?.slack?.signingSecret || '',
      discordBotToken: config.channels?.discord?.botToken || '',
    };
    clearedChannels = new Set();
  }

  function disconnectChannel(name) {
    if (!confirm('Disconnect this channel? Its stored credentials will be removed.')) return;
    clearedChannels = new Set([...clearedChannels, name]);
    if (name === 'telegram') { form.telegramToken = ''; form.telegramAllowedUserIds = ''; }
    if (name === 'whatsapp') { form.whatsappToken = ''; form.whatsappPhoneId = ''; form.whatsappVerifyToken = ''; }
    if (name === 'slack') { form.slackBotToken = ''; form.slackSigningSecret = ''; }
    if (name === 'discord') form.discordBotToken = '';
    form = form;
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

  // Only send a channel's config if at least one field has a value - an
  // all-empty object would still enable that channel (and, for a token sent
  // as '', override its usual env-var fallback) on the standalone runtime.
  // An empty array (e.g. a cleared allowedUserIds) doesn't count as "has a
  // value" here - it must still round-trip as `[]` once the object *is*
  // sent (see parseUserIds), just not be the sole reason to send it.
  function channelPayload(fields) {
    const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
    return Object.values(fields).some(hasValue) ? fields : undefined;
  }

  // Always returns an array, never undefined - the backend's merge treats an
  // omitted key as "keep the current value" (see mergeFieldsPreservingSetPlaceholder
  // server-side), so returning undefined here would make clearing this field
  // and saving silently fail to clear the stored allowlist.
  function parseUserIds(csv) {
    return csv.split(',').map((id) => id.trim()).filter(Boolean);
  }

  const CHANNEL_FIELDS = {
    telegram: () => ({ token: form.telegramToken, allowedUserIds: parseUserIds(form.telegramAllowedUserIds) }),
    whatsapp: () => ({ token: form.whatsappToken, phoneId: form.whatsappPhoneId, verifyToken: form.whatsappVerifyToken }),
    slack: () => ({ botToken: form.slackBotToken, signingSecret: form.slackSigningSecret }),
    discord: () => ({ botToken: form.discordBotToken }),
  };

  // A channel that was disconnected but then had a real value typed back in
  // (the user changed their mind) should save that value, not the clear -
  // channelPayload() already returns undefined for all-blank fields, so a
  // real payload here always means "the fields aren't blank anymore".
  function channelValue(name) {
    const payload = channelPayload(CHANNEL_FIELDS[name]());
    if (payload) return payload;
    return clearedChannels.has(name) ? null : undefined;
  }

  $: isConfigured = {
    telegram: !!form.telegramToken,
    whatsapp: !!form.whatsappToken || !!form.whatsappPhoneId || !!form.whatsappVerifyToken,
    slack: !!form.slackBotToken || !!form.slackSigningSecret,
    discord: !!form.discordBotToken,
  };

  async function save() {
    saving = true;
    saveError = '';
    saved = false;
    try {
      const payload = {
        channels: {
          telegram: channelValue('telegram'),
          whatsapp: channelValue('whatsapp'),
          slack: channelValue('slack'),
          discord: channelValue('discord'),
        },
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

<h1>Channels</h1>
<p class="note">
  Saved to <code>svara.config.json</code> (secrets are encrypted at rest - see SECURITY.md). Changes
  take effect after you restart the runtime.
</p>
<p class="hint" style="margin-bottom: 1.5rem;">
  Leave a channel's fields blank to configure it via environment variables instead (see
  <code>.env.example</code>). A field showing <code>[set]</code> already has a value - retype it to
  change it, or leave it as-is to keep the current one. Clearing the fields and saving does <strong>not</strong>
  remove a stored value - use each configured channel's "Disconnect" button for that.
</p>

{#if loading}
  <p class="muted">Loading...</p>
{:else if loadError}
  <p class="error-text">{loadError}</p>
{:else}
  <form on:submit|preventDefault={save}>
    {#if saveError}<p class="error-text">{saveError}</p>{/if}
    <RestartBanner show={saved} />

    <div class="card-grid">
      <div class="card">
        <div class="card-header">
          <span class="card-header-icon"><Icon name="send" /></span>
          <span class="card-header-title">Telegram</span>
          <span class="chip" class:success={isConfigured.telegram}>{isConfigured.telegram ? 'Configured' : 'Not configured'}</span>
        </div>
        <label class="channel-field">
          Bot token
          <input type="password" bind:value={form.telegramToken} placeholder="123456:ABC-DEF..." autocomplete="off" />
        </label>
        <label class="channel-field">
          Allowed Telegram user IDs (comma-separated)
          <input bind:value={form.telegramAllowedUserIds} placeholder="123456789, 987654321" autocomplete="off" />
          <span class="hint">
            Comma-separated Telegram user IDs allowed to use the bot (get ID from @userinfobot). Leave
            blank to allow anyone.
          </span>
        </label>
        {#if isConfigured.telegram}
          <button type="button" class="disconnect-link" on:click={() => disconnectChannel('telegram')}>Disconnect</button>
        {/if}
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-header-icon"><Icon name="message-circle" /></span>
          <span class="card-header-title">WhatsApp</span>
          <span class="chip" class:success={isConfigured.whatsapp}>{isConfigured.whatsapp ? 'Configured' : 'Not configured'}</span>
        </div>
        <span class="hint" style="display:block; margin-bottom: 0.6rem;">Meta Cloud API</span>
        <label class="channel-field">
          Access token
          <input type="password" bind:value={form.whatsappToken} autocomplete="off" />
        </label>
        <label class="channel-field">
          Phone number ID
          <input bind:value={form.whatsappPhoneId} autocomplete="off" />
        </label>
        <label class="channel-field">
          Webhook verify token
          <input type="password" bind:value={form.whatsappVerifyToken} autocomplete="off" />
        </label>
        {#if isConfigured.whatsapp}
          <button type="button" class="disconnect-link" on:click={() => disconnectChannel('whatsapp')}>Disconnect</button>
        {/if}
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-header-icon"><Icon name="hash" /></span>
          <span class="card-header-title">Slack</span>
          <span class="chip" class:success={isConfigured.slack}>{isConfigured.slack ? 'Configured' : 'Not configured'}</span>
        </div>
        <label class="channel-field">
          Bot token
          <input type="password" bind:value={form.slackBotToken} placeholder="xoxb-..." autocomplete="off" />
        </label>
        <label class="channel-field">
          Signing secret
          <input type="password" bind:value={form.slackSigningSecret} autocomplete="off" />
        </label>
        {#if isConfigured.slack}
          <button type="button" class="disconnect-link" on:click={() => disconnectChannel('slack')}>Disconnect</button>
        {/if}
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-header-icon"><Icon name="radio" /></span>
          <span class="card-header-title">Discord</span>
          <span class="chip" class:success={isConfigured.discord}>{isConfigured.discord ? 'Configured' : 'Not configured'}</span>
        </div>
        <label class="channel-field">
          Bot token
          <input type="password" bind:value={form.discordBotToken} autocomplete="off" />
        </label>
        {#if isConfigured.discord}
          <button type="button" class="disconnect-link" on:click={() => disconnectChannel('discord')}>Disconnect</button>
        {/if}
      </div>
    </div>

    <div class="actions" style="margin-top: 1.5rem">
      <button class="btn primary" type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>
    </div>
  </form>
{/if}

<style>
  .card-header {
    justify-content: space-between;
  }
  .card-header .chip {
    margin-left: auto;
  }
  .channel-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 0.75rem;
  }
  .channel-field:last-child {
    margin-bottom: 0;
  }
  .channel-field input {
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 400;
    color: var(--text-primary);
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    padding: 0.5rem 0.65rem;
  }
  .channel-field input:focus {
    outline: none;
    border-color: var(--primary);
  }
  .disconnect-link {
    background: none;
    border: none;
    padding: 0;
    margin-top: 0.4rem;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--danger);
    cursor: pointer;
  }
  .disconnect-link:hover {
    text-decoration: underline;
  }
</style>
