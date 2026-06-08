import { useAuthStore } from '../stores/authStore';

export const BASE = '/api';

export function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Returns the Authorization header for authenticated API calls.
 * Used by places that need to bypass the `request()` helper — SSE streams,
 * raw fetches, file uploads with FormData, WebSocket upgrades via query
 * string, etc. Returns an empty object if no token is set.
 */
export function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Single-flight refresh queue ─────────────────────────────────────────
// Many requests can 401 at the same time; we only want to run /auth/refresh
// once and have the rest await the result.
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return null;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        useAuthStore.getState().clear();
        return null;
      }
      const data = await res.json();
      useAuthStore.getState().setSession({
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      });
      return data.accessToken as string;
    } catch {
      useAuthStore.getState().clear();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function redirectToLogin(): void {
  const current = window.location.pathname + window.location.search;
  if (window.location.pathname === '/login') return;
  window.location.assign(`/login?from=${encodeURIComponent(current)}`);
}

async function doFetch(path: string, options: RequestInit, token: string | null, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { ...options, headers, signal });
}

export async function request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  // Don't attach tokens to /auth/login or /auth/refresh themselves.
  const isPublicAuth = path.startsWith('/auth/login')
    || path.startsWith('/auth/refresh')
    || path.startsWith('/auth/bootstrap')
    || path.startsWith('/system/onboarding-status')
    || path.startsWith('/system/health')
    || path.startsWith('/system/runtime-config');
  const token = isPublicAuth ? null : useAuthStore.getState().accessToken;

  let res = await doFetch(path, options, token, signal);

  if (res.status === 401 && !isPublicAuth) {
    // Try to refresh once.
    const fresh = await refreshAccessToken();
    if (!fresh) {
      redirectToLogin();
      throw new Error('session_expired');
    }
    res = await doFetch(path, options, fresh, signal);
    if (res.status === 401) {
      useAuthStore.getState().clear();
      redirectToLogin();
      throw new Error('session_expired');
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error ?? `Request failed: ${res.status}`) as Error & {
      status?: number;
      body?: unknown;
    };
    error.status = res.status;
    error.body = body;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
