/**
 * Thin fetch wrapper for the SvaraJS dashboard API.
 *
 * The dashboard is served from the same Express origin as the API
 * (see src/dashboard/serve.ts), so all calls are relative paths like
 * '/api/status' - no CORS or base-URL configuration needed.
 *
 * The API is optionally bearer-token protected. Any 401 response triggers
 * a login prompt (see AuthModal.svelte); once a token is supplied it is
 * cached in localStorage and retried automatically.
 */
import { writable } from 'svelte/store';

const TOKEN_KEY = 'svara_dashboard_token';

/** '' normally; '/a/<name>' when this dashboard is served through a parent runtime's proxy. */
export const BASE_PATH: string = (() => {
  const m = window.location.pathname.match(/^(.*?)\/dashboard(?:\/|$)/);
  return m ? m[1] : '';
})();
/** Prefixes server-absolute paths (/api/..., /health) with BASE_PATH. */
export const withBase = (path: string): string => (path.startsWith('/') ? BASE_PATH + path : path);
const MAX_AUTH_ATTEMPTS = 3;

/** 'password' = email/password login, 'token' = legacy bearer token modal, 'none' = open dashboard. */
export const authMode = writable<'unknown' | 'password' | 'token' | 'none'>('unknown');
/** True when a request came back 401 in password mode - App shows the login page. */
export const sessionExpired = writable(false);

export const authPromptOpen = writable(false);
export const authMessage = writable('');

let authResolve: (() => void) | null = null;
let authReject: (() => void) | null = null;
let authPromise: Promise<void> | null = null;

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** Opens the login modal (if not already open) and resolves once a token is submitted. */
function requestToken(message: string): Promise<void> {
  if (authPromise) return authPromise;
  authMessage.set(message);
  authPromptOpen.set(true);
  authPromise = new Promise<void>((resolve, reject) => {
    authResolve = resolve;
    authReject = reject;
  });
  return authPromise;
}

function clearAuthPrompt(): void {
  authPromptOpen.set(false);
  authResolve = null;
  authReject = null;
  authPromise = null;
}

/** Called by AuthModal when the user submits a token. */
export function submitAuthToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed) return;
  setToken(trimmed);
  const resolve = authResolve;
  clearAuthPrompt();
  resolve?.();
}

/** Called by AuthModal when the user cancels the prompt. */
export function cancelAuthPrompt(): void {
  const reject = authReject;
  clearAuthPrompt();
  reject?.();
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function rawFetch(path: string, options: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // Leave Content-Type unset for FormData - the browser adds the multipart
  // boundary itself, and setting it manually breaks the upload.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(withBase(path), { ...options, headers });
}

/** Shared auth-retry logic - handles the token prompt/retry loop and throws on a non-ok response, but leaves the body unread for the caller (a streaming reader wants the raw Response; apiFetch wants it parsed as JSON). */
async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  let res = await rawFetch(path, options);
  let attempts = 0;

  if (res.status === 401) {
    let body: any = null;
    try { body = await res.clone().json(); } catch { /* not JSON */ }
    if (body?.auth === 'password') {
      sessionExpired.set(true);
      throw new ApiError(401, 'Please sign in.');
    }
  }

  while (res.status === 401 && attempts < MAX_AUTH_ATTEMPTS) {
    attempts += 1;
    const message = attempts === 1
      ? 'This dashboard requires an access token.'
      : 'That token was rejected. Please try again.';
    try {
      await requestToken(message);
    } catch {
      throw new ApiError(401, 'Authentication required.');
    }
    res = await rawFetch(path, options);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.clone().json();
      if (data && typeof data === 'object' && data.error) message = data.error;
    } catch {
      // Error response wasn't JSON - keep the generic message.
    }
    throw new ApiError(res.status, message);
  }

  return res;
}

async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, options);
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Auth endpoints sit outside the 401 retry loop: a wrong password must show an error, not re-prompt. */
async function authCall<T = any>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(withBase(path), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data as T;
}

export const auth = {
  config: () => authCall<{ mode: 'password' | 'token' | 'none'; canSetup: boolean; setupMethod: 'code' | 'direct' | null; setupMinutesLeft: number | null; setupViaLog: boolean }>('/api/auth/config', undefined, 'GET'),
  me: () => authCall<{ authenticated: boolean; email: string | null }>('/api/auth/me', undefined, 'GET'),
  login: (email: string, password: string) => authCall<{ ok: boolean; email: string }>('/api/auth/login', { email, password }),
  logout: () => authCall('/api/auth/logout', {}),
  setupRequest: () => authCall<{ ok: boolean; delivered: string[] }>('/api/auth/setup/request', {}),
  setupComplete: (code: string, email: string, password: string) =>
    authCall<{ ok: boolean; email: string }>('/api/auth/setup/complete', { code, email, password }),
  users: () => authCall<{ users: { email: string }[] }>('/api/auth/users', undefined, 'GET'),
  addUser: (email: string, password: string) => authCall('/api/auth/users', { email, password }),
  removeUser: (email: string) => authCall(`/api/auth/users/${encodeURIComponent(email)}`, undefined, 'DELETE'),
  changePassword: (currentPassword: string, newPassword: string) =>
    authCall('/api/auth/password', { currentPassword, newPassword }),
};

export const api = {
  get: <T = any>(path: string) => apiFetch<T>(path),
  post: <T = any>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T = any>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T = any>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
  upload: <T = any>(path: string, formData: FormData) => apiFetch<T>(path, { method: 'POST', body: formData }),
  /** Same auth handling as the rest of `api`, but returns the raw Response for the caller to read as a stream (NDJSON chat responses). */
  postStream: (path: string, body?: unknown) =>
    authFetch(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  /** Same as postStream but sends multipart (files + fields); the browser sets the boundary header itself. */
  postStreamForm: (path: string, form: FormData) => authFetch(path, { method: 'POST', body: form }),
};
