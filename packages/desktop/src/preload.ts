import { contextBridge, ipcRenderer } from 'electron';

const allenDesktop = {
  getRuntimeInfo: () => ipcRenderer.invoke('allen:runtime-info'),
  getAuthSession: () => ipcRenderer.invoke('allen:auth-get'),
  setAuthSession: (session: unknown) => ipcRenderer.invoke('allen:auth-set', session),
  clearAuthSession: () => ipcRenderer.invoke('allen:auth-clear'),
  setRealtimeAuth: (token: string | null) => ipcRenderer.invoke('allen:realtime-auth', token),
  subscribeExecutionState: (executionIds: string[]) => ipcRenderer.invoke('allen:realtime-subscribe', executionIds),
  onRealtimeEvent: (handler: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on('allen:realtime-event', listener);
    return () => ipcRenderer.off('allen:realtime-event', listener);
  },
  onRealtimeStatus: (handler: (payload: { status: 'connecting' | 'connected' | 'disconnected' }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { status: 'connecting' | 'connected' | 'disconnected' }) => handler(payload);
    ipcRenderer.on('allen:realtime-status', listener);
    return () => ipcRenderer.off('allen:realtime-status', listener);
  },
  selectDirectory: () => ipcRenderer.invoke('allen:select-directory'),
  showItemInFolder: (path: string) => ipcRenderer.invoke('allen:show-item-in-folder', path),
  openExternal: (url: string) => ipcRenderer.invoke('allen:open-external', url),
  openWorkspaceIde: (workspaceId: string, ide: 'vscode' | 'cursor') => ipcRenderer.invoke('allen:open-workspace-ide', { workspaceId, ide }),
  openLogsDirectory: () => ipcRenderer.invoke('allen:open-logs-directory'),
  exportSupportBundle: (targetPath?: string) => ipcRenderer.invoke('allen:export-support-bundle', targetPath),
  writeClipboardText: (text: string) => ipcRenderer.invoke('allen:clipboard-write-text', text),
  getUpdateSettings: () => ipcRenderer.invoke('allen:update-settings-get'),
  setAutoUpdateEnabled: (enabled: boolean) => ipcRenderer.invoke('allen:update-settings-set-auto-enabled', enabled),
  checkForUpdates: () => ipcRenderer.invoke('allen:update-check-now'),
  getReleaseNotes: () => ipcRenderer.invoke('allen:release-notes-list'),
  getReleaseNote: (version: string, notesUrl?: string) => ipcRenderer.invoke('allen:release-notes-get', { version, notesUrl }),
  onUpdatePrompt: (handler: (payload: { requestId: string; currentVersion: string; latestVersion: string; releaseNotes: Record<string, unknown> | null; releaseNotesError: string | null }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: string; currentVersion: string; latestVersion: string; releaseNotes: Record<string, unknown> | null; releaseNotesError: string | null }) => handler(payload);
    ipcRenderer.on('allen:update-prompt', listener);
    return () => ipcRenderer.off('allen:update-prompt', listener);
  },
  respondToUpdatePrompt: (requestId: string, action: 'update-now' | 'update-later') => ipcRenderer.send('allen:update-prompt-response', { requestId, action }),
  onUpdateDownloadProgress: (handler: (payload: { requestId: string; percent: number | null; downloadedBytes: number; totalBytes: number | null; status: 'downloading' }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: string; percent: number | null; downloadedBytes: number; totalBytes: number | null; status: 'downloading' }) => handler(payload);
    ipcRenderer.on('allen:update-download-progress', listener);
    return () => ipcRenderer.off('allen:update-download-progress', listener);
  },
  onUpdateDownloadError: (handler: (payload: { requestId: string; error: string; retryable: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: string; error: string; retryable: boolean }) => handler(payload);
    ipcRenderer.on('allen:update-download-error', listener);
    return () => ipcRenderer.off('allen:update-download-error', listener);
  },
  onUpdateDownloadComplete: (handler: (payload: { requestId: string; dmgPath: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: string; dmgPath: string }) => handler(payload);
    ipcRenderer.on('allen:update-download-complete', listener);
    return () => ipcRenderer.off('allen:update-download-complete', listener);
  },
  retryUpdateDownload: (requestId: string) => ipcRenderer.send('allen:update-download-retry', { requestId }),
  cancelUpdateDownload: (requestId: string) => ipcRenderer.send('allen:update-download-cancel', { requestId }),
};

contextBridge.exposeInMainWorld('allenDesktop', allenDesktop);
