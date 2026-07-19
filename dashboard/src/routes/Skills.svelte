<script>
  import { api, ApiError } from '../lib/api';

  export let param = '';

  const RESOURCE_DIRS = ['references', 'templates', 'scripts', 'assets'];

  let enabled = true;
  let skills = [];
  let listLoading = true;
  let listError = '';

  let formLoading = false;
  let formError = '';
  let saving = false;
  let deleting = false;
  let isEdit = false;

  const emptyForm = { id: '', name: '', description: '', version: '', license: '', platforms: '', tags: '', relatedSkills: '', envVars: '', body: '' };
  let form = { ...emptyForm };
  let resources = { references: [], templates: [], scripts: [], assets: [] };

  // Resource file editor state (which file is open + its content)
  let openResource = null; // { dir, filename }
  let resourceContent = '';
  let resourceLoading = false;
  let resourceError = '';
  let newResourceFilename = { references: '', templates: '', scripts: '', assets: '' };

  $: mode = param === 'new' ? 'new' : param ? 'edit' : 'list';

  function resetForm() {
    form = { ...emptyForm };
    resources = { references: [], templates: [], scripts: [], assets: [] };
    isEdit = false;
    formError = '';
    closeResource();
  }

  function csv(value) {
    return (value || []).join(', ');
  }

  function parseCsv(str) {
    return str.split(',').map((s) => s.trim()).filter(Boolean);
  }

  async function loadList() {
    listLoading = true;
    try {
      const res = await api.get('/api/skills');
      enabled = !!res.enabled;
      skills = res.skills || [];
      listError = '';
    } catch (e) {
      listError = e instanceof ApiError ? e.message : 'Failed to load skills.';
    } finally {
      listLoading = false;
    }
  }

  async function loadForEdit(id) {
    formLoading = true;
    formError = '';
    try {
      const skill = await api.get(`/api/skills/${id}`);
      form = {
        id: skill.id,
        name: skill.name || '',
        description: skill.description || '',
        version: skill.version || '',
        license: skill.license || '',
        platforms: csv(skill.platforms),
        tags: csv(skill.metadata?.tags),
        relatedSkills: csv(skill.metadata?.related_skills),
        envVars: csv(skill.prerequisites?.env_vars),
        body: skill.body || '',
      };
      resources = skill.resources || { references: [], templates: [], scripts: [], assets: [] };
      isEdit = true;
    } catch (e) {
      formError = e instanceof ApiError ? e.message : 'Failed to load skill.';
    } finally {
      formLoading = false;
    }
  }

  let lastLoadedParam = null;
  $: {
    if (mode === 'new' && lastLoadedParam !== 'new') {
      resetForm();
      lastLoadedParam = 'new';
    } else if (mode === 'edit' && lastLoadedParam !== param) {
      loadForEdit(param);
      lastLoadedParam = param;
    } else if (mode === 'list' && lastLoadedParam !== 'list') {
      loadList();
      lastLoadedParam = 'list';
    }
  }

  async function save() {
    saving = true;
    formError = '';
    try {
      const payload = {
        name: form.name,
        description: form.description,
        version: form.version || undefined,
        license: form.license || undefined,
        platforms: form.platforms ? parseCsv(form.platforms) : undefined,
        tags: form.tags ? parseCsv(form.tags) : undefined,
        relatedSkills: form.relatedSkills ? parseCsv(form.relatedSkills) : undefined,
        envVars: form.envVars ? parseCsv(form.envVars) : undefined,
        body: form.body,
      };
      if (isEdit) {
        await api.put(`/api/skills/${form.id}`, payload);
      } else {
        await api.post('/api/skills', { id: form.id, ...payload });
      }
      window.location.hash = '#/skills';
    } catch (e) {
      formError = e instanceof ApiError ? e.message : 'Failed to save skill.';
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!confirm(`Delete skill "${form.name || form.id}"? This cannot be undone.`)) return;
    deleting = true;
    formError = '';
    try {
      await api.delete(`/api/skills/${form.id}`);
      window.location.hash = '#/skills';
    } catch (e) {
      formError = e instanceof ApiError ? e.message : 'Failed to delete skill.';
    } finally {
      deleting = false;
    }
  }

  // ── Resource files (references/templates/scripts/assets) ────────────────

  function closeResource() {
    openResource = null;
    resourceContent = '';
    resourceError = '';
  }

  async function openResourceFile(dir, filename) {
    resourceLoading = true;
    resourceError = '';
    try {
      const res = await api.get(`/api/skills/${form.id}/resources/${dir}/${encodeURIComponent(filename)}`);
      resourceContent = res.content || '';
      openResource = { dir, filename };
    } catch (e) {
      resourceError = e instanceof ApiError ? e.message : 'Failed to load file.';
    } finally {
      resourceLoading = false;
    }
  }

  async function saveResourceFile() {
    if (!openResource) return;
    resourceLoading = true;
    resourceError = '';
    try {
      await api.put(`/api/skills/${form.id}/resources/${openResource.dir}/${encodeURIComponent(openResource.filename)}`, { content: resourceContent });
      await refreshResources();
    } catch (e) {
      resourceError = e instanceof ApiError ? e.message : 'Failed to save file.';
    } finally {
      resourceLoading = false;
    }
  }

  async function deleteResourceFile(dir, filename) {
    if (!confirm(`Delete "${filename}" from ${dir}/?`)) return;
    resourceLoading = true;
    resourceError = '';
    try {
      await api.delete(`/api/skills/${form.id}/resources/${dir}/${encodeURIComponent(filename)}`);
      if (openResource && openResource.dir === dir && openResource.filename === filename) closeResource();
      await refreshResources();
    } catch (e) {
      resourceError = e instanceof ApiError ? e.message : 'Failed to delete file.';
    } finally {
      resourceLoading = false;
    }
  }

  async function addResourceFile(dir) {
    const filename = (newResourceFilename[dir] || '').trim();
    if (!filename) return;
    resourceLoading = true;
    resourceError = '';
    try {
      await api.put(`/api/skills/${form.id}/resources/${dir}/${encodeURIComponent(filename)}`, { content: '' });
      newResourceFilename[dir] = '';
      await refreshResources();
      await openResourceFile(dir, filename);
    } catch (e) {
      resourceError = e instanceof ApiError ? e.message : 'Failed to create file.';
    } finally {
      resourceLoading = false;
    }
  }

  async function refreshResources() {
    const skill = await api.get(`/api/skills/${form.id}`);
    resources = skill.resources || { references: [], templates: [], scripts: [], assets: [] };
  }
</script>

<h1>Skills</h1>

{#if mode === 'list'}
  {#if !listLoading && enabled}
    <div class="toolbar">
      <a class="btn primary" href="#/skills/new">New Skill</a>
    </div>
  {/if}
  {#if listLoading}
    <p class="muted">Loading...</p>
  {:else if listError}
    <p class="error-text">{listError}</p>
  {:else if !enabled}
    <p class="muted">
      Skills are not enabled on this agent. Configure a skills directory in <code>svara.config.json</code> to use this page.
    </p>
  {:else if skills.length === 0}
    <p class="muted">No skills yet. Create the first one.</p>
  {:else}
    <ul class="list">
      {#each skills as skill (skill.id)}
        <li class="list-item clickable">
          <a class="list-item-link" href="#/skills/{skill.id}">
            <div class="list-item-title">
              {skill.name} <span class="muted">({skill.id})</span>
              {#if skill.version}<span class="badge">v{skill.version}</span>{/if}
              {#if skill.metadata?.trust === 'agent-created'}<span class="badge accent">agent-created</span>{/if}
            </div>
            <div class="list-item-desc">{skill.description}</div>
            {#if (skill.metadata?.tags || []).length}
              <div class="tag-row">
                {#each skill.metadata.tags as tag}<span class="badge">{tag}</span>{/each}
              </div>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
{:else}
  <div class="toolbar" style="justify-content: flex-start;">
    <a class="btn secondary" href="#/skills">&larr; Back to skills</a>
  </div>
  {#if formLoading}
    <p class="muted">Loading...</p>
  {:else}
    <form class="form" on:submit|preventDefault={save}>
      {#if formError}<p class="error-text">{formError}</p>{/if}
      <label>
        ID
        <input bind:value={form.id} disabled={isEdit} placeholder="letters, numbers, underscore, hyphen only" required />
      </label>
      <label>
        Name
        <input bind:value={form.name} maxlength="64" required />
      </label>
      <label>
        Description
        <input bind:value={form.description} maxlength="1024" />
        <span class="hint">Only the first ~60 characters show in the agent's skill index.</span>
      </label>
      <div class="form-row">
        <label>
          Version
          <input bind:value={form.version} placeholder="1.0.0" />
        </label>
        <label>
          License
          <input bind:value={form.license} placeholder="MIT" />
        </label>
      </div>
      <label>
        Platforms (comma-separated: macos, linux, windows)
        <input bind:value={form.platforms} placeholder="macos, linux" />
      </label>
      <label>
        Tags (comma-separated)
        <input bind:value={form.tags} placeholder="e.g. research, writing" />
      </label>
      <label>
        Related skills (comma-separated ids)
        <input bind:value={form.relatedSkills} placeholder="e.g. escalation" />
      </label>
      <label>
        Prerequisite env vars (comma-separated)
        <input bind:value={form.envVars} placeholder="e.g. DEPLOY_TOKEN" />
      </label>
      <label>
        Body (Markdown)
        <textarea bind:value={form.body} rows="14" placeholder="Full skill instructions in Markdown..."></textarea>
      </label>
      <div class="actions">
        <button class="btn primary" type="submit" disabled={saving}>
          {isEdit ? 'Save changes' : 'Create skill'}
        </button>
        {#if isEdit}
          <button class="btn danger" type="button" disabled={deleting} on:click={remove}>Delete</button>
        {/if}
      </div>
    </form>

    {#if isEdit}
      <h2 class="resources-heading">Resources</h2>
      <p class="hint">
        Files under this skill's references/templates/scripts/assets folders - not loaded into the agent's
        context until it asks for one by name via skill_view.
      </p>
      {#if resourceError}<p class="error-text">{resourceError}</p>{/if}
      <div class="resources-grid">
        {#each RESOURCE_DIRS as dir}
          <div class="resource-col">
            <h3>{dir}/</h3>
            {#if resources[dir].length === 0}
              <p class="muted small">No files.</p>
            {:else}
              <ul class="resource-file-list">
                {#each resources[dir] as filename}
                  <li>
                    <button type="button" class="link-btn" on:click={() => openResourceFile(dir, filename)}>{filename}</button>
                    <button type="button" class="icon-btn danger" title="Delete" on:click={() => deleteResourceFile(dir, filename)}>&times;</button>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="resource-add">
              <input placeholder="new-file.md" bind:value={newResourceFilename[dir]} />
              <button type="button" class="btn secondary small" on:click={() => addResourceFile(dir)}>Add</button>
            </div>
          </div>
        {/each}
      </div>

      {#if openResource}
        <div class="resource-editor">
          <h3>{openResource.dir}/{openResource.filename}</h3>
          <textarea bind:value={resourceContent} rows="10" disabled={resourceLoading}></textarea>
          <div class="actions">
            <button class="btn primary" disabled={resourceLoading} on:click={saveResourceFile}>Save file</button>
            <button class="btn secondary" type="button" on:click={closeResource}>Close</button>
          </div>
        </div>
      {/if}
    {/if}
  {/if}
{/if}

<style>
  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .hint {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.2rem;
    font-weight: 400;
  }

  .badge {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.5rem;
    border-radius: 1rem;
    background: var(--surface-alt);
    color: var(--text-secondary);
    margin-left: 0.4rem;
  }

  .badge.accent {
    background: color-mix(in srgb, var(--primary) 15%, transparent);
    color: var(--primary-dark);
  }

  .tag-row {
    margin-top: 0.35rem;
  }

  .tag-row .badge {
    margin-left: 0;
    margin-right: 0.35rem;
  }

  .resources-heading {
    margin-top: 2rem;
  }

  .resources-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-top: 1rem;
  }

  .resource-col {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.75rem;
  }

  .resource-col h3 {
    font-size: 0.85rem;
    margin: 0 0 0.5rem;
  }

  .resource-file-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .resource-file-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .link-btn {
    background: none;
    border: none;
    color: var(--primary);
    cursor: pointer;
    padding: 0;
    font-size: 0.85rem;
    text-align: left;
  }

  .icon-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.25rem;
  }

  .icon-btn.danger:hover {
    color: var(--danger, #dc2626);
  }

  .resource-add {
    display: flex;
    gap: 0.35rem;
  }

  .resource-add input {
    flex: 1;
    min-width: 0;
    font-size: 0.8rem;
  }

  .btn.small {
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
  }

  .resource-editor {
    margin-top: 1.25rem;
  }

  .resource-editor textarea {
    width: 100%;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.85rem;
  }

  .small {
    font-size: 0.8rem;
  }

  @media (max-width: 900px) {
    .resources-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  @media (max-width: 600px) {
    .form-row,
    .resources-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
