<script>
  import { onMount, onDestroy } from 'svelte';
  import Sidebar from './components/Sidebar.svelte';
  import AuthModal from './components/AuthModal.svelte';
  import Overview from './routes/Overview.svelte';
  import Chat from './routes/Chat.svelte';
  import Tools from './routes/Tools.svelte';
  import Skills from './routes/Skills.svelte';
  import Knowledge from './routes/Knowledge.svelte';
  import Mcp from './routes/Mcp.svelte';
  import Memory from './routes/Memory.svelte';
  import Cron from './routes/Cron.svelte';
  import SettingsGeneral from './routes/settings/General.svelte';
  import SettingsProvider from './routes/settings/Provider.svelte';
  import SettingsCapabilities from './routes/settings/Capabilities.svelte';
  import SettingsChannels from './routes/settings/Channels.svelte';
  import SettingsApi from './routes/settings/Api.svelte';

  const KNOWN_PAGES = new Set([
    'overview', 'chat', 'tools', 'skills', 'knowledge', 'mcp', 'memory', 'cron',
    'settings-general', 'settings-provider', 'settings-capabilities', 'settings-channels', 'settings-api',
  ]);

  let page = 'overview';
  let param = '';
  let mobileNavOpen = false;

  function parseHash() {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    const candidate = parts[0] || 'overview';
    page = KNOWN_PAGES.has(candidate) ? candidate : 'overview';
    param = parts[1] || '';
  }

  function onHashChange() {
    parseHash();
    mobileNavOpen = false;
  }

  onMount(() => {
    if (!window.location.hash) window.location.hash = '#/overview';
    parseHash();
    window.addEventListener('hashchange', onHashChange);
  });

  onDestroy(() => {
    window.removeEventListener('hashchange', onHashChange);
  });
</script>

<div class="app-shell">
  <button
    type="button"
    class="mobile-topbar-toggle"
    aria-label="Toggle navigation"
    on:click={() => (mobileNavOpen = !mobileNavOpen)}
  >
    <span></span><span></span><span></span>
  </button>
  {#if mobileNavOpen}
    <div class="mobile-nav-backdrop" role="presentation" on:click={() => (mobileNavOpen = false)}></div>
  {/if}
  <Sidebar {page} open={mobileNavOpen} />
  <main class="content" class:full-bleed={page === 'chat'}>
    {#if page === 'overview'}
      <Overview />
    {:else if page === 'chat'}
      <Chat />
    {:else if page === 'tools'}
      <Tools />
    {:else if page === 'skills'}
      <Skills {param} />
    {:else if page === 'knowledge'}
      <Knowledge />
    {:else if page === 'mcp'}
      <Mcp />
    {:else if page === 'memory'}
      <Memory />
    {:else if page === 'cron'}
      <Cron />
    {:else if page === 'settings-general'}
      <SettingsGeneral />
    {:else if page === 'settings-provider'}
      <SettingsProvider />
    {:else if page === 'settings-capabilities'}
      <SettingsCapabilities />
    {:else if page === 'settings-channels'}
      <SettingsChannels />
    {:else if page === 'settings-api'}
      <SettingsApi />
    {/if}
  </main>
</div>

<AuthModal />

<style>
  :global(:root) {
    --primary: #0ea5e9;
    --primary-dark: #0284c7;
    --primary-light: #06b6d4;
    --accent: #f97316;
    --danger: #ef4444;
    --danger-dark: #dc2626;
    --success: #16a34a;

    --background: #f8fafc;
    --surface: #ffffff;
    --surface-alt: #f1f5f9;
    --border: #e2e8f0;
    --text-primary: #0f172a;
    --text-secondary: #334155;
    --text-muted: #64748b;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --background: #0f172a;
      --surface: #1e293b;
      --surface-alt: #16213a;
      --border: #334155;
      --text-primary: #f1f5f9;
      --text-secondary: #cbd5e1;
      --text-muted: #94a3b8;
    }
  }

  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(body) {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--background);
    color: var(--text-primary);
    line-height: 1.5;
  }

  :global(h1) {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 1.25rem;
  }

  :global(h2) {
    font-size: 1.05rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: var(--text-primary);
  }

  :global(code) {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.85em;
    background: var(--surface-alt);
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
  }

  :global(a) {
    color: var(--primary);
    text-decoration: none;
  }

  :global(.muted) {
    color: var(--text-muted);
  }

  :global(.error-text) {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    padding: 0.6rem 0.85rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
  }

  :global(.success-text) {
    color: var(--success);
    font-size: 0.9rem;
    font-weight: 600;
  }

  :global(.note) {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin-bottom: 1.5rem;
  }

  /* Buttons */
  :global(.btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.55rem 1.1rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    font-family: inherit;
    border: 1px solid transparent;
    cursor: pointer;
    transition: opacity 0.15s ease, transform 0.05s ease;
  }
  :global(.btn:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
  :global(.btn:not(:disabled):active) {
    transform: translateY(1px);
  }
  :global(.btn.small) {
    padding: 0.35rem 0.7rem;
    font-size: 0.8rem;
  }
  :global(.btn.primary) {
    background: var(--primary);
    color: #fff;
  }
  :global(.btn.primary:not(:disabled):hover) {
    background: var(--primary-dark);
  }
  :global(.btn.secondary) {
    background: var(--surface-alt);
    color: var(--text-primary);
    border-color: var(--border);
  }
  :global(.btn.secondary:not(:disabled):hover) {
    background: var(--border);
  }
  :global(.btn.danger) {
    background: var(--danger);
    color: #fff;
  }
  :global(.btn.danger:not(:disabled):hover) {
    background: var(--danger-dark);
  }
  :global(.btn.success) {
    background: var(--success);
    color: #fff;
  }
  :global(.btn.success:not(:disabled):hover) {
    opacity: 0.9;
  }

  /* Cards */
  :global(.card-grid) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
  }
  :global(.card) {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1.25rem;
  }
  :global(.card-label) {
    font-size: 0.8rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.4rem;
  }
  :global(.card-value) {
    font-size: 1.4rem;
    font-weight: 700;
  }

  /* Chips */
  :global(.chip-list) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    list-style: none;
  }
  :global(.chip) {
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.2rem 0.7rem;
    font-size: 0.85rem;
    font-weight: 500;
  }
  :global(.chip.success) {
    background: color-mix(in srgb, var(--success) 12%, transparent);
    border-color: color-mix(in srgb, var(--success) 30%, transparent);
    color: var(--success);
  }
  :global(.card-header) {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    margin-bottom: 1rem;
  }
  :global(.card-header-icon) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    border-radius: 0.6rem;
    background: var(--surface-alt);
    color: var(--text-secondary);
    font-size: 1.2rem;
  }
  :global(.card-header-title) {
    font-weight: 700;
    font-size: 0.95rem;
  }

  /* Lists */
  :global(.list) {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  :global(.list-item) {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    padding: 0.9rem 1.1rem;
  }
  :global(.list-item.clickable) {
    padding: 0;
  }
  :global(.list-item-link) {
    display: block;
    padding: 0.9rem 1.1rem;
    color: inherit;
  }
  :global(.list-item-link:hover) {
    background: var(--surface-alt);
  }
  :global(.list-item-title) {
    font-weight: 600;
    margin-bottom: 0.2rem;
  }
  :global(.list-item-desc) {
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
  :global(.list-item-meta) {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-top: 0.3rem;
  }
  :global(.approval-item) {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  /* Tables */
  :global(.table) {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    overflow: hidden;
    margin-bottom: 1.5rem;
  }
  :global(.table th),
  :global(.table td) {
    text-align: left;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
  }
  :global(.table th) {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: var(--surface-alt);
  }
  :global(.table tr:last-child td) {
    border-bottom: none;
  }
  :global(.table.kv th) {
    width: 220px;
    text-transform: none;
    letter-spacing: normal;
    font-size: 0.9rem;
    background: transparent;
    color: var(--text-secondary);
  }

  /* Forms */
  :global(.form) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 640px;
  }
  :global(.form label) {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  :global(.form input),
  :global(.form textarea) {
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 400;
    color: var(--text-primary);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
    resize: vertical;
  }
  :global(.form textarea) {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  :global(.form input:focus),
  :global(.form textarea:focus) {
    outline: none;
    border-color: var(--primary);
  }
  :global(.form.inline) {
    flex-direction: row;
    align-items: flex-end;
    max-width: none;
    flex-wrap: wrap;
  }
  :global(.form.inline label) {
    flex: 0 0 auto;
  }
  :global(.form.inline label.grow) {
    flex: 1 1 260px;
  }
  :global(.actions) {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  :global(.toolbar) {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 1rem;
  }

  /* Settings pages (routes/settings/*) */
  :global(.section-heading) {
    font-size: 1rem;
    margin: 1.75rem 0 0.75rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);
  }
  :global(.section-heading:first-of-type) {
    margin-top: 0;
  }
  :global(.subsection-heading) {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin: 1.1rem 0 0.5rem;
  }
  /* Toggle rows: title + description on the left, a switch on the right - used by Capabilities */
  :global(.toggle-list) {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  :global(.toggle-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 1.1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.65rem;
  }
  :global(.toggle-row-icon) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    background: var(--surface-alt);
    color: var(--text-secondary);
    font-size: 1.1rem;
  }
  :global(.toggle-row-text) {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  :global(.toggle-row-title) {
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--text-primary);
  }
  :global(.toggle-row-desc) {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  :global(.switch) {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
    flex-shrink: 0;
  }
  :global(.switch input) {
    opacity: 0;
    width: 0;
    height: 0;
  }
  :global(.switch-track) {
    position: absolute;
    inset: 0;
    background: var(--border);
    border-radius: 999px;
    transition: background 0.15s ease;
    cursor: pointer;
  }
  :global(.switch-track::before) {
    content: '';
    position: absolute;
    height: 16px;
    width: 16px;
    left: 3px;
    top: 3px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.15s ease;
  }
  :global(.switch input:checked + .switch-track) {
    background: var(--primary);
  }
  :global(.switch input:checked + .switch-track::before) {
    transform: translateX(18px);
  }
  :global(.switch input:focus-visible + .switch-track) {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  :global(.hint) {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.2rem;
    font-weight: 400;
  }
  :global(.form select) {
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--surface);
    color: var(--text-primary);
    font-size: 0.9rem;
    font-family: inherit;
  }
  :global(.form select:focus) {
    outline: none;
    border-color: var(--primary);
  }

  :global(section) {
    margin-bottom: 2.5rem;
  }

  .app-shell {
    display: flex;
    height: 100vh;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 2.25rem 2.5rem;
    max-width: 1000px;
  }

  .content.full-bleed {
    padding: 0;
    max-width: none;
    overflow: hidden;
    display: flex;
  }

  .mobile-topbar-toggle {
    display: none;
  }

  .mobile-nav-backdrop {
    display: none;
  }

  @media (max-width: 768px) {
    .mobile-topbar-toggle {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
      position: fixed;
      top: 0.75rem;
      left: 0.75rem;
      z-index: 40;
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--surface);
      cursor: pointer;
    }
    .mobile-topbar-toggle span {
      display: block;
      width: 1.1rem;
      height: 2px;
      margin: 0 auto;
      background: var(--text-primary);
      border-radius: 1px;
    }

    .mobile-nav-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 30;
    }

    .content {
      padding: 4.25rem 1rem 1.5rem;
      max-width: none;
    }

    .content.full-bleed {
      padding: 0;
    }

    /* A wide multi-column table (Cron's job list, etc.) scrolls within
       itself instead of pushing the whole page wider than the viewport. */
    :global(.table) {
      display: block;
      overflow-x: auto;
    }
  }
</style>
