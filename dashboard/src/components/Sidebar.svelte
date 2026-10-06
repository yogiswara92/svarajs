<script>
  import Icon from './Icon.svelte';
  import { BASE_PATH } from '../lib/api';

  const base = import.meta.env.BASE_URL;

  export let page = 'overview';
  /** Off-canvas open state on narrow viewports - ignored above the mobile breakpoint (see CSS). */
  export let open = false;
  /** Agent's configured name (from svara.config.json) - tells apart multiple standalone instances open in different tabs, which would otherwise all show the same generic branding. */
  export let agentName = '';
  /** Set when the dashboard uses email+password login: shows the account link and Sign out. */
  export let userEmail = '';
  export let onSignOut = () => {};

  // Each agent gets its own colour (from its name), so several agents are easy to tell apart.
  function hueOf(name) {
    let h = 0;
    for (const ch of name || 'agent') h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }
  $: initial = (agentName || 'A').trim().charAt(0).toUpperCase() || 'A';
  $: avatarBg = `linear-gradient(135deg, hsl(${hueOf(agentName)} 78% 56%), hsl(${(hueOf(agentName) + 42) % 360} 82% 44%))`;

  const items = [
    { key: 'overview', label: 'Overview', icon: 'home' },
    { key: 'agents', label: 'Agents', icon: 'folder' },
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
  </div>
  <div class="agent-card">
    <div class="avatar" style="background: {avatarBg}" aria-hidden="true">{initial}</div>
    <div class="agent-meta">
      <div class="agent-title" title={agentName}>{agentName || 'Agent'}</div>
      <div class="agent-sub"><span class="dot"></span>Online</div>
    </div>
  </div>
  {#if BASE_PATH}
    <a class="back-link" href="/dashboard/">&larr; Back to main agent</a>
  {/if}
  <nav>
    {#each items.filter((i) => !(BASE_PATH && i.key === 'agents')) as item (item.key)}
      <a href="#/{item.key}" class:active={page === item.key}>
        <span class="icon"><Icon name={item.icon} /></span>
        <span>{item.label}</span>
      </a>
    {/each}
  </nav>
  {#if userEmail}
    <div class="account">
      <a href="#/account" class:active={page === 'account'} title={userEmail}>{userEmail}</a>
      <button type="button" class="signout" on:click={onSignOut}>Sign out</button>
    </div>
  {/if}
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

  .agent-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.5rem 0.9rem;
    margin-bottom: 1.1rem;
    border-bottom: 1px solid var(--border);
  }

  .avatar {
    flex-shrink: 0;
    width: 2.6rem;
    height: 2.6rem;
    border-radius: 0.85rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 1.25rem;
    font-weight: 700;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.12);
  }

  .agent-meta {
    min-width: 0;
  }

  .agent-title {
    font-size: 1.05rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agent-sub {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.1rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .brand {
    padding: 0 0.5rem;
    margin-bottom: 1.1rem;
  }

  .brand-logo {
    display: block;
    width: 150px;
    max-width: 100%;
    height: auto;
  }

  .brand-logo-dark {
    display: none;
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

  .back-link { display: block; margin: 0 0.75rem 0.5rem; padding: 0.45rem 0.6rem; border-radius: 0.5rem; background: var(--surface-alt); border: 1px solid var(--border); color: var(--text-secondary); font-size: 0.8rem; font-weight: 600; }
  .account { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.5rem 0.75rem; border-top: 1px solid var(--border); font-size: 0.8rem; }
  .account a { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account a.active { color: var(--primary-dark); font-weight: 600; }
  .signout { align-self: flex-start; background: none; border: none; padding: 0.2rem 0; color: var(--primary); font-size: 0.8rem; font-weight: 600; cursor: pointer; font-family: inherit; }
  .sidebar-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.5rem 0.25rem;
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
