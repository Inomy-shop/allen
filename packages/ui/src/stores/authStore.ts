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

function saveStored(s: StoredSession | null): void {
  if (!s) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
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
      hydrated: true,
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
