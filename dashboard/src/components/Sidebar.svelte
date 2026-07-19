<script>
  import Icon from './Icon.svelte';

  const base = import.meta.env.BASE_URL;

  export let page = 'overview';
  /** Off-canvas open state on narrow viewports - ignored above the mobile breakpoint (see CSS). */
  export let open = false;
  /** Agent's configured name (from svara.config.json) - tells apart multiple standalone instances open in different tabs, which would otherwise all show the same generic branding. */
  export let agentName = '';

  const items = [
    { key: 'overview', label: 'Overview', icon: 'home' },
    { key: 'chat', label: 'Chat', icon: 'message-circle' },
    { key: 'settings-general', label: 'General', icon: 'sliders' },
    { key: 'settings-provider', label: 'AI Provider', icon: 'cpu' },
    { key: 'settings-capabilities', label: 'Capabilities', icon: 'toggle' },
    { key: 'settings-channels', label: 'Channels', icon: 'radio' },
    { key: 'settings-api', label: 'API & Webhooks', icon: 'hash' },
    { key: 'tools', label: 'Tools', icon: 'wrench' },
    { key: 'skills', label: 'Skills', icon: 'book' },
    { key: 'knowledge', label: 'Knowledge', icon: 'database' },
    { key: 'mcp', label: 'MCP', icon: 'grid' },
    { key: 'memory', label: 'Memory', icon: 'brain' },
    { key: 'cron', label: 'Cron', icon: 'clock' },
  ];
</script>

<aside class="sidebar" class:open>
  <div class="brand">
    <img src="{base}svarajs-logo.png" alt="SvaraJS" class="brand-logo brand-logo-light" />
    <img src="{base}svarajs-logo-white.png" alt="SvaraJS" class="brand-logo brand-logo-dark" />
    {#if agentName}
      <div class="agent-name" title={agentName}>{agentName}</div>
    {/if}
  </div>
  <nav>
    {#each items as item (item.key)}
      <a href="#/{item.key}" class:active={page === item.key}>
        <span class="icon"><Icon name={item.icon} /></span>
        <span>{item.label}</span>
      </a>
    {/each}
  </nav>
  <div class="sidebar-footer">
    <span class="dot"></span> Standalone runtime
  </div>
</aside>

<style>
  .sidebar {
    width: 220px;
    flex-shrink: 0;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 1.5rem 1rem;
    overflow-y: auto;
  }

  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      inset: 0 25% 0 0;
      z-index: 35;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      box-shadow: 2px 0 12px rgba(0, 0, 0, 0.15);
    }
    .sidebar.open {
      transform: translateX(0);
    }
  }

  .brand {
    padding: 0 0.5rem;
    margin-bottom: 2rem;
  }

  .brand-logo {
    display: block;
    width: 100%;
    height: auto;
  }

  .brand-logo-dark {
    display: none;
  }

  .agent-name {
    margin-top: 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (prefers-color-scheme: dark) {
    .brand-logo-light {
      display: none;
    }

    .brand-logo-dark {
      display: block;
    }
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1;
  }

  nav a {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.6rem 0.75rem;
    border-radius: 0.5rem;
    color: var(--text-secondary);
    font-size: 0.9rem;
    font-weight: 500;
  }

  nav a:hover {
    background: var(--surface-alt);
    color: var(--text-primary);
  }

  nav a.active {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    color: var(--primary-dark);
    font-weight: 600;
  }

  .icon {
    display: inline-flex;
    justify-content: center;
    width: 1.25rem;
    font-size: 1.05rem;
  }

  .sidebar-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--success);
    display: inline-block;
  }
</style>
