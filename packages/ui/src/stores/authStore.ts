import { create } from 'zustand';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  mustResetPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  hydrated: boolean;

  hydrate: () => void;
  setSession: (session: { user: AuthUser; accessToken: string; refreshToken: string }) => void;
  setAccessToken: (token: string | null) => void;
  setUser: (user: AuthUser | null) => void;
  clear: () => void;
}

const STORAGE_KEY = 'allen.auth.v1';

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

function loadStored(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredSession>;
  return typeof candidate.accessToken === 'string'
    && typeof candidate.refreshToken === 'string'
    && Boolean(candidate.user)
    && typeof candidate.user === 'object';
}

async function loadDesktopStored(): Promise<StoredSession | null> {
  if (typeof window === 'undefined' || !window.allenDesktop?.getAuthSession) return null;
  try {
    const stored = await window.allenDesktop.getAuthSession();
    return isStoredSession(stored) ? stored : null;
  } catch {
    return null;
  }
}

function saveStored(s: StoredSession | null): void {
  if (!s) {
    localStorage.removeItem(STORAGE_KEY);
    if (typeof window !== 'undefined' && window.allenDesktop?.clearAuthSession) {
      void window.allenDesktop.clearAuthSession().catch(() => {});
    }
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  if (typeof window !== 'undefined' && window.allenDesktop?.setAuthSession) {
    void window.allenDesktop.setAuthSession(s).catch(() => {});
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  hydrated: false,

  hydrate: () => {
    const stored = loadStored();
    set({
      user: stored?.user ?? null,
      accessToken: stored?.accessToken ?? null,
      refreshToken: stored?.refreshToken ?? null,
    });
    if (stored || typeof window === 'undefined' || !window.allenDesktop?.getAuthSession) {
      set({ hydrated: true });
      return;
    }
    void loadDesktopStored().then(desktopStored => {
      if (desktopStored) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(desktopStored));
        } catch {
          // ignore localStorage failures; desktop storage remains authoritative.
        }
      }
      set({
        user: desktopStored?.user ?? null,
        accessToken: desktopStored?.accessToken ?? null,
        refreshToken: desktopStored?.refreshToken ?? null,
        hydrated: true,
      });
    });
  },

  setSession: ({ user, accessToken, refreshToken }) => {
    saveStored({ user, accessToken, refreshToken });
    set({ user, accessToken, refreshToken });
  },

  setAccessToken: (token) => {
    const { user, refreshToken } = get();
    if (token && user && refreshToken) {
      saveStored({ user, accessToken: token, refreshToken });
    }
    set({ accessToken: token });
  },

  setUser: (user) => {
    const { accessToken, refreshToken } = get();
    if (user && accessToken && refreshToken) {
      saveStored({ user, accessToken, refreshToken });
    }
    set({ user });
  },

  clear: () => {
    saveStored(null);
    set({ user: null, accessToken: null, refreshToken: null });
  },
}));
