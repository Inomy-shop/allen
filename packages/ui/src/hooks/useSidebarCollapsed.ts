import { useEffect, useState } from 'react';

/**
 * Persists a sidebar collapsed/expanded preference in localStorage so
 * the user's choice survives reloads. One key per logical sidebar
 * (e.g. 'workspaces', 'conversations').
 */
export function useSidebarCollapsed(key: string, defaultValue = false): [boolean, () => void] {
  const storageKey = `allen-sidebar-${key}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultValue;
    const v = localStorage.getItem(storageKey);
    return v == null ? defaultValue : v === '1';
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [storageKey, collapsed]);
  return [collapsed, () => setCollapsed((c) => !c)];
}
