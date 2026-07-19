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
const MAX_AUTH_ATTEMPTS = 3;

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
  return fetch(path, { ...options, headers });
}

/** Shared auth-retry logic - handles the token prompt/retry loop and throws on a non-ok response, but leaves the body unread for the caller (a streaming reader wants the raw Response; apiFetch wants it parsed as JSON). */
async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  let res = await rawFetch(path, options);
  let attempts = 0;

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
};
