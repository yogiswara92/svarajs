<script>
  import { onMount, afterUpdate } from 'svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import { api, ApiError } from '../lib/api';
  import Icon from '../components/Icon.svelte';

  marked.setOptions({ gfm: true, breaks: true }); // gfm: tables/strikethrough; breaks: a single newline is <br>, matching how the agent actually writes replies

  const SESSION_STORAGE_KEY = 'svara_chat_session_id';

  const TOOL_ICONS = {
    terminal_exec: 'terminal',
    file_read: 'folder',
    file_write: 'folder',
    list_files: 'folder',
    web_fetch: 'globe',
    web_search: 'globe',
    browser_navigate: 'camera',
    browser_click: 'camera',
    browser_get_text: 'camera',
    browser_screenshot: 'camera',
    memory: 'brain',
    session_search: 'database',
    cronjob: 'clock',
    skill_install: 'grid',
    delegate_task: 'send',
  };
  function iconFor(toolName) {
    if (TOOL_ICONS[toolName]) return TOOL_ICONS[toolName];
    if (toolName.startsWith('skill')) return 'book';
    return 'wrench';
  }

  let sessionId = (typeof localStorage !== 'undefined' && localStorage.getItem(SESSION_STORAGE_KEY)) || crypto.randomUUID();
  let messages = [];
  let input = '';
  let sending = false;
  let sendError = '';
  let scrollEl;
  let loadingHistory = false;

  let sessions = [];
  let sessionsLoading = true;
  let sessionsError = '';
  let deletingSessionId = null;
  let sessionSidebarOpen = false;

  // Agent replies are markdown (tables, bold, code, lists, links) - render it
  // properly instead of dumping raw ** and | characters. marked's output is
  // sanitized through DOMPurify before going into {@html} - reply text can
  // be influenced by whatever the agent just fetched (web_fetch, browser_*),
  // so it isn't safe to trust as HTML outright.
  function renderMarkdown(text) {
    return DOMPurify.sanitize(marked.parse(text || ''));
  }

  // Session sidebar previews are the raw last message - stripped to plain
  // text so a reply full of **bold**/tables/lists doesn't show its syntax
  // characters in a one-line title.
  function stripMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      // Table separator rows (|---|:--:|---|) and standalone horizontal
      // rules (---, ***, ___) - before pipe-stripping turns them into
      // loose dash clutter instead of disappearing cleanly.
      .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
      .replace(/\|/g, ' ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatSessionTime(epochSeconds) {
    if (!epochSeconds) return '';
    return new Date(epochSeconds * 1000).toLocaleString();
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  afterUpdate(() => {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  async function loadSessions() {
    sessionsLoading = true;
    try {
      const res = await api.get('/api/chat/sessions');
      sessions = res.sessions || [];
      sessionsError = '';
    } catch (e) {
      sessionsError = e instanceof ApiError ? e.message : 'Failed to load sessions.';
    } finally {
      sessionsLoading = false;
    }
  }

  async function loadHistory(id) {
    loadingHistory = true;
    try {
      const res = await api.get(`/api/chat/sessions/${id}/messages`);
      messages = (res.messages || [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role,
          content: m.content,
          toolsUsed: m.metadata?.toolsUsed || [],
          iterations: m.metadata?.iterations,
          retrievedDocuments: m.metadata?.retrievedDocuments || [],
          attachments: m.metadata?.attachments || [],
        }));
    } catch (e) {
      sendError = e instanceof ApiError ? e.message : 'Failed to load this session\'s history.';
    } finally {
      loadingHistory = false;
    }
  }

  onMount(async () => {
    await loadSessions();
    if (sessions.some((s) => s.sessionId === sessionId)) {
      await loadHistory(sessionId);
    }
  });

  $: if (typeof localStorage !== 'undefined') localStorage.setItem(SESSION_STORAGE_KEY, sessionId);

  async function switchSession(id) {
    sessionSidebarOpen = false;
    if (id === sessionId && messages.length > 0) return;
    sessionId = id;
    sendError = '';
    await loadHistory(id);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    input = '';
    sendError = '';
    messages = [...messages, { role: 'user', content: text }];
    sending = true;

    // A live placeholder, filled in as tool_call events arrive - this is
    // what makes "Process steps" grow in real time instead of only
    // appearing once the whole (often 20-30s) agent turn is done.
    const liveMsg = { role: 'assistant', content: '', toolsUsed: [], iterations: 0, retrievedDocuments: [], attachments: [], streaming: true };
    messages = [...messages, liveMsg];

    try {
      const res = await api.postStream('/api/chat/stream', { message: text, sessionId });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          const last = messages[messages.length - 1];

          if (evt.type === 'tool_call') {
            last.toolsUsed = [...last.toolsUsed, ...evt.tools];
            last.iterations = last.iterations + 1;
            messages = messages;
          } else if (evt.type === 'done') {
            sawDone = true;
            sessionId = evt.sessionId || sessionId;
            last.content = evt.response;
            last.toolsUsed = evt.toolsUsed || [];
            last.retrievedDocuments = evt.retrievedDocuments || [];
            last.attachments = evt.attachments || [];
            last.iterations = evt.iterations;
            last.duration = evt.duration;
            last.streaming = false;
            messages = messages;
          } else if (evt.type === 'error') {
            throw new Error(evt.error);
          }
        }
      }

      if (!sawDone) throw new Error('Connection closed before the agent finished responding.');
      await loadSessions();
    } catch (e) {
      sendError = e instanceof ApiError ? e.message : (e?.message || 'Failed to send message.');
      messages = messages.slice(0, -1);
    } finally {
      sending = false;
    }
  }

  function onKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function newSession() {
    sessionId = crypto.randomUUID();
    messages = [];
    sendError = '';
    sessionSidebarOpen = false;
  }

  async function deleteSession(id, event) {
    event.stopPropagation();
    if (!confirm('Delete this chat? This removes its history permanently.')) return;
    deletingSessionId = id;
    try {
      await api.delete(`/api/chat/sessions/${id}`);
      sessions = sessions.filter((s) => s.sessionId !== id);
      if (id === sessionId) newSession();
    } catch (e) {
      sessionsError = e instanceof ApiError ? e.message : 'Failed to delete session.';
    } finally {
      deletingSessionId = null;
    }
  }

  function basename(source) {
    return source.split(/[\\/]/).pop();
  }
</script>

<div class="chat-page">
  {#if sessionSidebarOpen}
    <div class="session-sidebar-backdrop" role="presentation" on:click={() => (sessionSidebarOpen = false)}></div>
  {/if}
  <aside class="session-sidebar" class:open={sessionSidebarOpen}>
    <div class="session-sidebar-header">
      <span>Chats</span>
      <button class="btn secondary small" type="button" on:click={newSession}>New</button>
    </div>
    <div class="session-list">
      {#if sessionsLoading}
        <p class="muted session-list-empty">Loading...</p>
      {:else if sessionsError}
        <p class="error-text session-list-empty">{sessionsError}</p>
      {:else if sessions.length === 0}
        <p class="muted session-list-empty">No past chats yet.</p>
      {/if}
      {#each sessions as s (s.sessionId)}
        <button
          class="session-item"
          class:active={s.sessionId === sessionId}
          type="button"
          on:click={() => switchSession(s.sessionId)}
        >
          <span class="session-item-preview">{stripMarkdown(s.preview) || '(empty)'}</span>
          <span class="session-item-meta">{formatSessionTime(s.lastMessageAt)} - {s.messageCount} msg{s.messageCount !== 1 ? 's' : ''}</span>
          <span
            class="session-item-delete"
            role="button"
            tabindex="0"
            on:click={(e) => deleteSession(s.sessionId, e)}
            on:keydown={(e) => { if (e.key === 'Enter') deleteSession(s.sessionId, e); }}
            aria-label="Delete chat"
          >
            <Icon name="trash" />
          </span>
        </button>
      {/each}
    </div>
  </aside>

  <div class="chat-main">
    <header class="chat-header">
      <button
        type="button"
        class="session-sidebar-toggle"
        aria-label="Toggle chat list"
        on:click={() => (sessionSidebarOpen = !sessionSidebarOpen)}
      >
        <Icon name="message-circle" />
      </button>
      <div>
        <h1>Chat</h1>
        <span class="hint">Talk to the agent directly - separate from any connected channel.</span>
      </div>
    </header>

    <div class="chat-scroll" bind:this={scrollEl}>
      {#if loadingHistory}
        <p class="muted chat-empty">Loading...</p>
      {:else if messages.length === 0}
        <p class="muted chat-empty">Send a message to start.</p>
      {/if}
      {#each messages as msg}
        <div class="chat-message {msg.role}">
          <div class="chat-bubble">
            {#if msg.role === 'assistant' && msg.toolsUsed && msg.toolsUsed.length > 0}
              <details class="agent-thinking" open>
                <summary>
                  {#if msg.streaming}
                    Working... ({msg.toolsUsed.length} tool{msg.toolsUsed.length !== 1 ? 's' : ''} so far)
                  {:else}
                    Process steps ({msg.toolsUsed.length} tool{msg.toolsUsed.length !== 1 ? 's' : ''}, {msg.iterations} iteration{msg.iterations !== 1 ? 's' : ''})
                  {/if}
                </summary>
                <div class="think-steps">
                  {#each msg.toolsUsed as tool}
                    <div class="think-step"><Icon name={iconFor(tool)} /> {tool}</div>
                  {/each}
                </div>
              </details>
            {/if}
            {#if msg.role === 'assistant' && msg.streaming && !msg.content}
              <div class="chat-bubble-text typing-inline">
                <span class="dot"></span><span class="dot"></span><span class="dot"></span>
              </div>
            {:else}
              <div class="chat-bubble-text">{@html renderMarkdown(msg.content)}</div>
            {/if}
            {#if msg.role === 'assistant' && msg.attachments && msg.attachments.length > 0}
              <div class="attachments-list">
                {#each msg.attachments as att}
                  <a class="attachment-card" href={att.url} download={att.filename} target="_blank" rel="noopener">
                    <Icon name="file" />
                    <span class="attachment-info">
                      <span class="attachment-name">{att.filename}</span>
                      <span class="attachment-size">{formatFileSize(att.size)}</span>
                    </span>
                    <Icon name="download" />
                  </a>
                {/each}
              </div>
            {/if}
            {#if msg.role === 'assistant' && msg.retrievedDocuments && msg.retrievedDocuments.length > 0}
              <details class="rag-sources">
                <summary><Icon name="database" /> Sources ({msg.retrievedDocuments.length})</summary>
                <div class="sources-list">
                  {#each msg.retrievedDocuments as doc}
                    <div class="source-item">
                      <div class="source-title">{basename(doc.source)}</div>
                      <div class="source-snippet">{doc.excerpt}</div>
                      <div class="source-score">Relevance: {Math.round(doc.score * 100)}%</div>
                    </div>
                  {/each}
                </div>
              </details>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    {#if sendError}<p class="error-text chat-error">{sendError}</p>{/if}

    <form class="chat-input-bar" on:submit|preventDefault={send}>
      <textarea
        bind:value={input}
        on:keydown={onKeydown}
        placeholder="Write a message..."
        rows="1"
        disabled={sending}
      ></textarea>
      <button class="btn primary" type="submit" disabled={sending || !input.trim()}>Send</button>
    </form>
  </div>
</div>

<style>
  .chat-page {
    display: flex;
    height: 100%;
    width: 100%;
  }

  .session-sidebar {
    width: 260px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .session-sidebar-backdrop {
    display: none;
  }

  .session-sidebar-toggle {
    display: none;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--text-secondary);
    font-size: 1.1rem;
    cursor: pointer;
    margin-right: 0.75rem;
  }

  .session-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.1rem 1rem 0.75rem;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text-secondary);
  }
  .session-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 0.6rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .session-list-empty {
    padding: 0.5rem;
    font-size: 0.8rem;
  }
  .session-item {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    text-align: left;
    padding: 0.55rem 1.9rem 0.55rem 0.65rem;
    border-radius: 0.5rem;
    border: none;
    background: none;
    cursor: pointer;
    font-family: inherit;
  }
  .session-item:hover {
    background: var(--surface-alt);
  }
  .session-item.active {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .session-item-preview {
    font-size: 0.82rem;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .session-item-meta {
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .session-item-delete {
    position: absolute;
    right: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 0.35rem;
    color: var(--text-muted);
    opacity: 0;
  }
  .session-item:hover .session-item-delete {
    opacity: 1;
  }
  .session-item-delete:hover {
    background: color-mix(in srgb, var(--danger) 15%, transparent);
    color: var(--danger);
  }

  .chat-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem 2rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .chat-header h1 {
    margin-bottom: 0.15rem;
  }
  .chat-header .hint {
    margin-top: 0;
  }

  .chat-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .chat-empty {
    margin: auto;
  }

  .chat-message {
    display: flex;
  }
  .chat-message.user {
    justify-content: flex-end;
  }
  .chat-message.assistant {
    justify-content: flex-start;
  }

  .chat-bubble {
    max-width: min(70ch, 80%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.9rem;
    padding: 0.85rem 1.05rem;
  }
  .chat-message.user .chat-bubble {
    background: var(--primary);
    border-color: var(--primary);
    color: #fff;
  }

  .chat-bubble-text {
    font-size: 0.95rem;
    line-height: 1.55;
    white-space: normal;
  }

  /* Markdown rendered via {@html} isn't reachable by normal scoped styles. */
  :global(.chat-bubble-text > *:first-child) { margin-top: 0; }
  :global(.chat-bubble-text > *:last-child) { margin-bottom: 0; }
  :global(.chat-bubble-text p) { margin: 0 0 0.6rem; }
  :global(.chat-bubble-text ul),
  :global(.chat-bubble-text ol) { margin: 0 0 0.6rem; padding-left: 1.3rem; }
  :global(.chat-bubble-text li) { margin: 0.15rem 0; }
  :global(.chat-bubble-text h1),
  :global(.chat-bubble-text h2),
  :global(.chat-bubble-text h3) { margin: 0.9rem 0 0.5rem; font-size: 1.05em; line-height: 1.3; }
  :global(.chat-bubble-text strong) { font-weight: 700; }
  :global(.chat-bubble-text a) { color: inherit; text-decoration: underline; }
  :global(.chat-bubble-text code) {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.85em;
    background: rgba(127, 127, 127, 0.18);
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
  }
  :global(.chat-bubble-text pre) {
    background: rgba(127, 127, 127, 0.12);
    border-radius: 0.5rem;
    padding: 0.75rem 0.9rem;
    overflow-x: auto;
    margin: 0 0 0.6rem;
  }
  :global(.chat-bubble-text pre code) {
    background: none;
    padding: 0;
  }
  :global(.chat-bubble-text blockquote) {
    margin: 0 0 0.6rem;
    padding-left: 0.75rem;
    border-left: 3px solid rgba(127, 127, 127, 0.35);
    color: inherit;
    opacity: 0.85;
  }
  :global(.chat-bubble-text table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0 0 0.6rem;
    font-size: 0.88em;
    display: block;
    overflow-x: auto;
    /* A wide table shouldn't stretch the whole bubble - just scroll within it. */
    max-width: 100%;
  }
  :global(.chat-bubble-text th),
  :global(.chat-bubble-text td) {
    border: 1px solid rgba(127, 127, 127, 0.3);
    padding: 0.4rem 0.6rem;
    text-align: left;
  }
  :global(.chat-bubble-text th) {
    background: rgba(127, 127, 127, 0.12);
    font-weight: 600;
  }
  :global(.chat-bubble-text hr) {
    border: none;
    border-top: 1px solid rgba(127, 127, 127, 0.3);
    margin: 0.75rem 0;
  }

  .typing-inline {
    display: flex;
    gap: 0.3rem;
    padding: 0.2rem 0;
  }
  .typing-inline .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: pulse 1.2s infinite ease-in-out;
  }
  .typing-inline .dot:nth-child(2) { animation-delay: 0.2s; }
  .typing-inline .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse {
    0%, 80%, 100% { opacity: 0.3; }
    40% { opacity: 1; }
  }

  .agent-thinking {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.6rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
    background: var(--surface-alt);
  }
  .agent-thinking summary {
    cursor: pointer;
    font-weight: 500;
    color: var(--text-primary);
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .agent-thinking summary::-webkit-details-marker { display: none; }
  .agent-thinking[open] summary { margin-bottom: 0.5rem; }
  .think-steps {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding-left: 0.2rem;
  }
  .think-step {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
  }

  .rag-sources {
    margin-top: 0.6rem;
    font-size: 0.8rem;
  }
  .rag-sources summary {
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--text-muted);
    user-select: none;
  }
  .sources-list {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .source-item {
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.5rem 0.65rem;
  }
  .source-title {
    font-weight: 600;
    font-size: 0.8rem;
  }
  .source-snippet {
    color: var(--text-secondary);
    font-size: 0.78rem;
    margin: 0.15rem 0;
  }
  .source-score {
    color: var(--text-muted);
    font-size: 0.72rem;
  }

  .attachments-list {
    margin-top: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .attachment-card {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.55rem 0.75rem;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s ease;
  }
  .attachment-card:hover {
    border-color: var(--primary);
  }
  .attachment-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .attachment-name {
    font-size: 0.85rem;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .attachment-size {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .chat-error {
    margin: 0 2rem;
  }

  .chat-input-bar {
    display: flex;
    align-items: flex-end;
    gap: 0.75rem;
    padding: 1rem 2rem 1.5rem;
    border-top: 1px solid var(--border);
  }
  .chat-input-bar textarea {
    flex: 1;
    resize: none;
    max-height: 8rem;
    font-family: inherit;
    font-size: 0.9rem;
    color: var(--text-primary);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    padding: 0.65rem 0.85rem;
  }
  .chat-input-bar textarea:focus {
    outline: none;
    border-color: var(--primary);
  }

  @media (max-width: 768px) {
    .session-sidebar-toggle {
      display: flex;
    }

    .chat-header {
      justify-content: flex-start;
      /* Room for the app shell's own fixed hamburger button (top: 0.75rem; left: 0.75rem; width: 2.5rem). */
      padding: 1rem 1rem 0.85rem 3.75rem;
    }

    .session-sidebar {
      position: fixed;
      inset: 0 20% 0 0;
      z-index: 25;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      box-shadow: 2px 0 12px rgba(0, 0, 0, 0.15);
    }
    .session-sidebar.open {
      transform: translateX(0);
    }

    .session-sidebar-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 20;
    }

    /* No hover on touch - the delete button needs to just be visible. */
    .session-item-delete {
      opacity: 1;
    }

    .chat-scroll {
      padding: 1.1rem 1rem;
    }

    .chat-bubble {
      max-width: 90%;
    }

    .chat-error {
      margin: 0 1rem;
    }

    .chat-input-bar {
      padding: 0.85rem 1rem 1.1rem;
    }
  }
</style>
