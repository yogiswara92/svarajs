<script>
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { formatDate } from '../lib/format';

  let enabled = true;
  let jobs = [];
  let loading = true;
  let loadError = '';

  let availableSkills = [];
  let skillsEnabled = false;
  let connectedChannels = [];

  const CHANNEL_LABELS = {
    telegram: 'Telegram', whatsapp: 'WhatsApp', slack: 'Slack', discord: 'Discord',
  };
  const TARGET_HINTS = {
    telegram: 'Chat ID - the numeric id of the chat to post in (message the bot once and check its logs, or use @userinfobot).',
    whatsapp: 'Phone number in international format, no "+" (e.g. 6281234567890).',
    slack: 'Channel ID or name (e.g. C0123456789 or #general - the bot must be a member of it).',
    discord: 'Channel ID (enable Developer Mode in Discord, right-click the channel, Copy Channel ID).',
  };

  const DAYS = [
    { value: '0', label: 'Sunday' },
    { value: '1', label: 'Monday' },
    { value: '2', label: 'Tuesday' },
    { value: '3', label: 'Wednesday' },
    { value: '4', label: 'Thursday' },
    { value: '5', label: 'Friday' },
    { value: '6', label: 'Saturday' },
  ];

  let name = '';
  let frequency = 'interval'; // 'interval' | 'daily' | 'weekly' | 'hourly' | 'custom'
  let intervalEvery = 30;
  let intervalUnit = 'minutes'; // 'minutes' | 'hours'
  let time = '09:00'; // daily/weekly
  let dayOfWeek = '1'; // weekly
  let minuteOfHour = '0'; // hourly
  let customSchedule = ''; // custom (raw cron expression escape hatch)
  let prompt = '';
  let selectedSkills = [];
  let deliverChannel = 'local';
  let deliverTarget = '';
  let creating = false;
  let createError = '';

  let deletingId = null;

  $: computedSchedule = (() => {
    if (frequency === 'interval') {
      const n = Number(intervalEvery);
      if (!Number.isInteger(n) || n < 1) return '';
      if (intervalUnit === 'minutes') return n < 60 ? `*/${n} * * * *` : '';
      return n < 24 ? `0 */${n} * * *` : ''; // hours
    }
    if (frequency === 'daily' || frequency === 'weekly') {
      const [h, m] = time.split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return '';
      return frequency === 'daily' ? `${m} ${h} * * *` : `${m} ${h} * * ${dayOfWeek}`;
    }
    if (frequency === 'hourly') {
      const m = Number(minuteOfHour);
      return Number.isNaN(m) ? '' : `${m} * * * *`;
    }
    return customSchedule.trim();
  })();

  function humanizeCron(expr) {
    const parts = (expr || '').trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [m, h, dom, mon, dow] = parts;
    const pad = (n) => String(n).padStart(2, '0');
    if (dom === '*' && mon === '*' && dow === '*' && h === '*' && /^\*\/\d+$/.test(m)) {
      return `Every ${m.slice(2)} minute${m.slice(2) !== '1' ? 's' : ''}`;
    }
    if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(m) && /^\*\/\d+$/.test(h)) {
      return `Every ${h.slice(2)} hour${h.slice(2) !== '1' ? 's' : ''}`;
    }
    if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(h) && /^\d+$/.test(m)) {
      return `Every day at ${pad(h)}:${pad(m)}`;
    }
    if (dom === '*' && mon === '*' && /^[0-6]$/.test(dow) && /^\d+$/.test(h) && /^\d+$/.test(m)) {
      return `Every ${DAYS[Number(dow)].label} at ${pad(h)}:${pad(m)}`;
    }
    if (dom === '*' && mon === '*' && dow === '*' && h === '*' && /^\d+$/.test(m)) {
      return `Every hour at :${pad(m)}`;
    }
    return null;
  }

  async function load() {
    loading = true;
    try {
      const res = await api.get('/api/cron');
      enabled = !!res.enabled;
      jobs = res.jobs || [];
      loadError = '';
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Failed to load cron jobs.';
    } finally {
      loading = false;
    }
  }

  async function loadSkills() {
    try {
      const res = await api.get('/api/skills');
      skillsEnabled = !!res.enabled;
      availableSkills = res.skills || [];
    } catch {
      // Non-fatal - the "Skills" section just stays empty if this fails.
    }
  }

  async function loadChannels() {
    try {
      const res = await api.get('/api/status');
      connectedChannels = (res.channels || []).filter((c) => c !== 'web');
    } catch {
      // Non-fatal - "Deliver to" just falls back to Local only.
    }
  }

  onMount(() => {
    load();
    loadSkills();
    loadChannels();
  });

  function toggleSkill(id) {
    selectedSkills = selectedSkills.includes(id)
      ? selectedSkills.filter((s) => s !== id)
      : [...selectedSkills, id];
  }

  async function createJob() {
    if (!computedSchedule) {
      createError = 'Enter a valid schedule.';
      return;
    }
    if (deliverChannel !== 'local' && !deliverTarget.trim()) {
      createError = `Enter a target for ${CHANNEL_LABELS[deliverChannel]} delivery.`;
      return;
    }
    creating = true;
    createError = '';
    try {
      await api.post('/api/cron', {
        schedule: computedSchedule,
        prompt,
        name: name || undefined,
        skills: selectedSkills.length ? selectedSkills : undefined,
        deliverTo: deliverChannel !== 'local' ? { channel: deliverChannel, target: deliverTarget.trim() } : undefined,
      });
      name = '';
      prompt = '';
      customSchedule = '';
      selectedSkills = [];
      deliverChannel = 'local';
      deliverTarget = '';
      await load();
    } catch (e) {
      createError = e instanceof ApiError ? e.message : 'Failed to create job.';
    } finally {
      creating = false;
    }
  }

  async function removeJob(id) {
    if (!confirm('Delete this cron job?')) return;
    deletingId = id;
    try {
      await api.delete(`/api/cron/${id}`);
      await load();
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Failed to delete job.';
    } finally {
      deletingId = null;
    }
  }
</script>

<h1>Cron</h1>

{#if loading}
  <p class="muted">Loading...</p>
{:else if !enabled}
  <p class="muted">No scheduler is running on this runtime.</p>
{:else}
  {#if loadError}<p class="error-text">{loadError}</p>{/if}

  <table class="table">
    <thead>
      <tr>
        <th>Job</th>
        <th>Schedule</th>
        <th>Prompt</th>
        <th>Deliver to</th>
        <th>Created</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each jobs as job (job.id)}
        <tr>
          <td>{#if job.name}{job.name}{:else}<span class="muted">-</span>{/if}</td>
          <td>
            {#if humanizeCron(job.expression)}
              <div>{humanizeCron(job.expression)}</div>
              <div class="muted" style="font-size: 0.75rem;"><code>{job.expression}</code></div>
            {:else}
              <code>{job.expression}</code>
            {/if}
          </td>
          <td>
            {job.prompt}
            {#if job.skills?.length}
              <ul class="chip-list" style="margin-top: 0.35rem;">
                {#each job.skills as s}<li class="chip">{s}</li>{/each}
              </ul>
            {/if}
          </td>
          <td>
            {#if job.deliverTo}
              <span class="chip success">{CHANNEL_LABELS[job.deliverTo.channel] || job.deliverTo.channel}</span>
              <div class="muted" style="font-size: 0.75rem; margin-top: 0.25rem;">{job.deliverTo.target}</div>
            {:else}
              <span class="muted">Local</span>
            {/if}
          </td>
          <td>{formatDate(job.createdAt)}</td>
          <td>
            <button
              class="btn danger small"
              disabled={deletingId === job.id}
              on:click={() => removeJob(job.id)}
            >
              Delete
            </button>
          </td>
        </tr>
      {/each}
      {#if jobs.length === 0}
        <tr><td colspan="6" class="muted">No jobs scheduled.</td></tr>
      {/if}
    </tbody>
  </table>

  <h2>New job</h2>
  <form class="form" on:submit|preventDefault={createJob}>
    {#if createError}<p class="error-text">{createError}</p>{/if}

    <label>
      Name (optional)
      <input bind:value={name} placeholder="e.g. Daily summary" />
    </label>

    <label>
      Prompt
      <textarea bind:value={prompt} placeholder="What should the agent do on each run?" rows="3" required></textarea>
    </label>

    <label>
      Schedule
      <select bind:value={frequency}>
        <option value="interval">Every interval</option>
        <option value="daily">Every day</option>
        <option value="weekly">Every week</option>
        <option value="hourly">Every hour (at a specific minute)</option>
        <option value="custom">Custom (cron expression)</option>
      </select>
    </label>

    {#if frequency === 'interval'}
      <div class="form inline">
        <label>
          Every
          <input type="number" min="1" bind:value={intervalEvery} required />
        </label>
        <label>
          Unit
          <select bind:value={intervalUnit}>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </label>
      </div>
      {#if intervalUnit === 'minutes' && Number(intervalEvery) >= 60}
        <p class="error-text">Minute intervals must be under 60 - use hours instead.</p>
      {:else if intervalUnit === 'hours' && Number(intervalEvery) >= 24}
        <p class="error-text">Hour intervals must be under 24.</p>
      {/if}
    {:else if frequency === 'daily'}
      <label>
        At
        <input type="time" bind:value={time} required />
      </label>
    {:else if frequency === 'weekly'}
      <label>
        On
        <select bind:value={dayOfWeek}>
          {#each DAYS as d}
            <option value={d.value}>{d.label}</option>
          {/each}
        </select>
      </label>
      <label>
        At
        <input type="time" bind:value={time} required />
      </label>
    {:else if frequency === 'hourly'}
      <label>
        At minute
        <input type="number" min="0" max="59" bind:value={minuteOfHour} required />
        <span class="hint">e.g. 0 = on the hour, 30 = half past every hour</span>
      </label>
    {:else}
      <label>
        Cron expression
        <input bind:value={customSchedule} placeholder="0 9 * * *" required />
        <span class="hint">Standard 5-field cron syntax (minute hour day-of-month month day-of-week).</span>
      </label>
    {/if}

    {#if computedSchedule && humanizeCron(computedSchedule)}
      <p class="hint">Runs: {humanizeCron(computedSchedule)}</p>
    {/if}

    <label>
      Deliver to
      <select bind:value={deliverChannel}>
        <option value="local">Local (logged on the server)</option>
        {#each connectedChannels as ch}
          <option value={ch}>{CHANNEL_LABELS[ch] || ch}</option>
        {/each}
      </select>
      {#if connectedChannels.length === 0}
        <span class="hint">
          No channels are connected yet - connect one on the <a href="#/settings-channels">Channels</a> page
          to deliver results there instead of just the server log.
        </span>
      {/if}
    </label>
    {#if deliverChannel !== 'local'}
      <label>
        Target
        <input bind:value={deliverTarget} placeholder="e.g. 123456789" required />
        <span class="hint">{TARGET_HINTS[deliverChannel]}</span>
      </label>
    {/if}

    {#if skillsEnabled && availableSkills.length > 0}
      <div class="skills-heading">
        <span class="skills-heading-title">Skills (optional)</span>
        <span class="hint">
          Scope this job to specific skills instead of the agent's whole skill set - their full
          instructions are prepended to the prompt on every run.
        </span>
      </div>
      <div class="skills-list">
        {#each availableSkills as skill (skill.id)}
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={selectedSkills.includes(skill.id)}
              on:change={() => toggleSkill(skill.id)}
            />
            {skill.id}
          </label>
        {/each}
      </div>
    {/if}

    <div class="actions">
      <button class="btn primary" type="submit" disabled={creating}>
        {creating ? 'Adding...' : 'Add job'}
      </button>
    </div>
  </form>
{/if}

<style>
  .skills-heading {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .skills-heading-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .skills-list {
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .checkbox-row {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    font-weight: 400;
    font-size: 0.85rem;
  }
  .checkbox-row input {
    width: auto;
  }
</style>
