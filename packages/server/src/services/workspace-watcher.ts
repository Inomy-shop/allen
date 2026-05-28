/**
 * Workspace File Watcher
 * Watches workspace worktree for file changes and broadcasts via the shared WebSocket on port 4024.
 * Clients connect to /ws/workspaces/:id/watch — handled by workspace-terminal.ts upgrade handler.
 */

import { watch, type FSWatcher } from 'node:fs';
import type { WebSocket } from 'ws';

const watchers = new Map<string, FSWatcher>();
const DEBOUNCE_MS = 300;

function getClients(): Map<string, Set<WebSocket>> {
  if (!(globalThis as any).__fileWatchClients) (globalThis as any).__fileWatchClients = new Map();
  return (globalThis as any).__fileWatchClients;
}

export function startFileWatchServer(): void {
  // No separate server — file watch clients are handled by workspace-terminal.ts
  console.log('[file-watch] File watcher ready (shared WS on terminal port)');
}

export function stopFileWatchServer(): void {
  for (const [workspaceId, watcher] of watchers) {
    try { watcher.close(); } catch { /* ignore */ }
    watchers.delete(workspaceId);
  }

  const clients = getClients();
  for (const [workspaceId, wsClients] of clients) {
    for (const client of wsClients) {
      try { client.close(); } catch { /* ignore */ }
    }
    clients.delete(workspaceId);
  }
}

export function watchWorkspace(workspaceId: string, worktreePath: string): void {
  if (watchers.has(workspaceId)) return;

  let debounceTimer: NodeJS.Timeout | null = null;
  const pendingChanges = new Set<string>();

  try {
    const watcher = watch(worktreePath, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.includes('node_modules') || filename.includes('.git/') || filename.includes('.turbo')) return;

      pendingChanges.add(filename);

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const changes = Array.from(pendingChanges);
        pendingChanges.clear();

        const clients = getClients();
        const wsClients = clients.get(workspaceId);
        if (wsClients && wsClients.size > 0) {
          const msg = JSON.stringify({ type: 'file_changes', files: changes, timestamp: Date.now() });
          for (const client of wsClients) {
            if (client.readyState === 1 /* OPEN */) client.send(msg);
          }
        }
      }, DEBOUNCE_MS);
    });

    watchers.set(workspaceId, watcher);
  } catch {}
}

export function unwatchWorkspace(workspaceId: string): void {
  const watcher = watchers.get(workspaceId);
  if (watcher) { watcher.close(); watchers.delete(workspaceId); }

  const clients = getClients();
  const wsClients = clients.get(workspaceId);
  if (wsClients) { for (const c of wsClients) c.close(); clients.delete(workspaceId); }
}
