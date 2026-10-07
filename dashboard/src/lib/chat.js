/**
 * Chat state that outlives the Chat page.
 *
 * The page used to keep its messages and the running request in the component, so navigating to another page threw
 * away the question and the reply being written. Everything that must survive navigation lives here instead: the
 * threads, the in-flight requests (the stream keeps being read while another page is open), the session list and the
 * unsent draft. A page reload is covered by the server, which reports the turn still running (`pending`) so it can be
 * shown again and followed until it finishes.
 */
import { writable, get } from 'svelte/store';
import { api, ApiError } from './api';

const SESSION_KEY = 'svara_chat_session_id';

function storedSessionId() {
  try { return localStorage.getItem(SESSION_KEY) || crypto.randomUUID(); } catch { return crypto.randomUUID(); }
}

const emptyThread = () => ({ messages: [], sending: false, error: '', loaded: false, loading: false });

export const chat = writable({
  sessionId: storedSessionId(),
  threads: {},
  sessions: [],
  sessionsLoading: true,
  sessionsError: '',
});

/** Unsent text and attachments - kept across navigation so a half-written message is not lost either. */
export const draft = { input: '', attached: [] };

const pollers = new Map();

/** Applies `fn` to the thread (creating it if needed) and notifies subscribers. */
function mutate(id, fn) {
  chat.update((s) => {
    const thread = s.threads[id] || (s.threads[id] = emptyThread());
    fn(thread);
    return { ...s, threads: { ...s.threads } };
  });
}

function toMessage(m) {
  const base = {
    role: m.role,
    toolsUsed: m.metadata?.toolsUsed || [],
    iterations: m.metadata?.iterations,
    retrievedDocuments: m.metadata?.retrievedDocuments || [],
    attachments: m.metadata?.attachments || [],
  };
  if (m.role !== 'user') return { ...base, content: m.content };
  const { text, files } = splitAttachmentNote(m.content);
  return { ...base, content: text, files };
}

// The agent receives a text note listing the saved files; history shows them as chips instead of raw text.
export function splitAttachmentNote(content) {
  const marker = '\n\n[Attachments from the user, saved on the server.';
  const i = (content || '').indexOf(marker);
  if (i < 0) return { text: content, files: [] };
  const files = content.slice(i).split('\n').slice(3).flatMap((line) => {
    const m = /^- (.+) \(([^,()]+), ([^)]+)\): (.+)$/.exec(line);
    return m ? [{ name: m[1], mimeType: m[2], sizeLabel: m[3] }] : [];
  });
  return { text: content.slice(0, i), files };
}

export async function loadSessions() {
  try {
    const res = await api.get('/api/chat/sessions');
    chat.update((s) => ({ ...s, sessions: res.sessions || [], sessionsLoading: false, sessionsError: '' }));
  } catch (e) {
    chat.update((s) => ({ ...s, sessionsLoading: false, sessionsError: e instanceof ApiError ? e.message : 'Failed to load sessions.' }));
  }
}

function pendingMessages(pending) {
  return [
    { role: 'user', content: pending.message, files: pending.files || [] },
    { role: 'assistant', content: '', toolsUsed: pending.tools || [], iterations: (pending.tools || []).length, retrievedDocuments: [], attachments: [], streaming: true },
  ];
}

/** Loads a thread from the server, including a turn that is still running (then follows it until it finishes). */
export async function loadThread(id) {
  const existing = get(chat).threads[id];
  if (existing?.sending && !existing.remote) return; // this tab is already streaming it
  mutate(id, (t) => { t.loading = true; });
  try {
    const res = await api.get(`/api/chat/sessions/${id}/messages`);
    const history = (res.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant').map(toMessage);
    mutate(id, (t) => {
      t.loading = false;
      t.loaded = true;
      t.error = '';
      if (res.pending) {
        t.messages = [...history, ...pendingMessages(res.pending)];
        t.sending = true;
        t.remote = true;
      } else {
        t.messages = history;
        t.sending = false;
        t.remote = false;
      }
    });
    if (res.pending) followPending(id);
  } catch (e) {
    mutate(id, (t) => { t.loading = false; t.error = e instanceof ApiError ? e.message : "Failed to load this session's history."; });
  }
}

/** Polls a turn that is running on the server (this tab is not streaming it) until it finishes. */
function followPending(id) {
  if (pollers.has(id)) return;
  const timer = setInterval(async () => {
    try {
      const res = await api.get(`/api/chat/sessions/${id}/messages`);
      if (res.pending) {
        mutate(id, (t) => {
          const live = t.messages[t.messages.length - 1];
          if (live?.streaming) { live.toolsUsed = res.pending.tools || []; live.iterations = live.toolsUsed.length; }
        });
        return;
      }
      clearInterval(timer);
      pollers.delete(id);
      const history = (res.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant').map(toMessage);
      mutate(id, (t) => { t.messages = history; t.sending = false; t.remote = false; });
      loadSessions();
    } catch {
      // transient: keep trying
    }
  }, 2000);
  pollers.set(id, timer);
}

export function selectSession(id) {
  chat.update((s) => ({ ...s, sessionId: id }));
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* private mode */ }
  const t = get(chat).threads[id];
  if (!t || (!t.loaded && !t.sending)) loadThread(id);
  else if (t.remote) followPending(id);
}

export function newSession() {
  const id = crypto.randomUUID();
  chat.update((s) => ({ ...s, sessionId: id, threads: { ...s.threads, [id]: { ...emptyThread(), loaded: true } } }));
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* private mode */ }
}

export function forgetThread(id) {
  const timer = pollers.get(id);
  if (timer) { clearInterval(timer); pollers.delete(id); }
  chat.update((s) => {
    const threads = { ...s.threads };
    delete threads[id];
    return { ...s, threads, sessions: s.sessions.filter((x) => x.sessionId !== id) };
  });
}

/**
 * Sends a message and reads the streamed reply. Runs to completion even if the user opens another page meanwhile.
 * Resolves { ok: true } or { ok: false, error } (the caller then gives the typed text back).
 */
export async function sendMessage({ text, files }) {
  const id = get(chat).sessionId;
  const thread = get(chat).threads[id];
  if (thread?.sending) return { ok: false, error: 'Wait for the current reply to finish.' };

  const live = { role: 'assistant', content: '', toolsUsed: [], iterations: 0, retrievedDocuments: [], attachments: [], streaming: true };
  mutate(id, (t) => {
    t.error = '';
    t.sending = true;
    t.remote = false;
    t.loaded = true;
    t.messages = [
      ...t.messages,
      { role: 'user', content: text, files: files.map((f) => ({ name: f.file.name, mimeType: f.file.type, sizeLabel: sizeLabel(f.file.size), url: f.url })) },
      live,
    ];
  });

  try {
    let res;
    if (files.length) {
      const form = new FormData();
      form.append('message', text);
      form.append('sessionId', id);
      for (const f of files) form.append('files', f.file, f.file.name);
      res = await api.postStreamForm('/api/chat/stream', form);
    } else {
      res = await api.postStream('/api/chat/stream', { message: text, sessionId: id });
    }

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
        if (evt.type === 'tool_call') {
          mutate(id, () => { live.toolsUsed = [...live.toolsUsed, ...evt.tools]; live.iterations += 1; });
        } else if (evt.type === 'done') {
          sawDone = true;
          mutate(id, () => {
            live.content = evt.response;
            live.toolsUsed = evt.toolsUsed || [];
            live.retrievedDocuments = evt.retrievedDocuments || [];
            live.attachments = evt.attachments || [];
            live.iterations = evt.iterations;
            live.duration = evt.duration;
            live.streaming = false;
          });
        } else if (evt.type === 'error') {
          throw new Error(evt.error);
        }
      }
    }
    if (!sawDone) throw new Error('Connection closed before the agent finished responding.');
    mutate(id, (t) => { t.sending = false; });
    loadSessions();
    return { ok: true };
  } catch (e) {
    const message = e instanceof ApiError ? e.message : (e?.message || 'Failed to send message.');
    // If the connection dropped while the server is still working (tab slept, network blip), do not discard the
    // turn: follow it on the server instead of showing an error.
    if (!(e instanceof ApiError) && /closed|network|fetch|load failed/i.test(message)) {
      mutate(id, (t) => { t.remote = true; });
      followPending(id);
      return { ok: true };
    }
    mutate(id, (t) => {
      t.messages = t.messages.slice(0, -2); // the live placeholder and the question that never got an answer
      t.sending = false;
      t.error = message;
    });
    return { ok: false, error: message };
  }
}

function sizeLabel(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
