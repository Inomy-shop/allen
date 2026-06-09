import { contextBridge, ipcRenderer } from 'electron';

const allenDesktop = {
  getRuntimeInfo: () => ipcRenderer.invoke('allen:runtime-info'),
  getAuthSession: () => ipcRenderer.invoke('allen:auth-get'),
  setAuthSession: (session: unknown) => ipcRenderer.invoke('allen:auth-set', session),
  clearAuthSession: () => ipcRenderer.invoke('allen:auth-clear'),
  selectDirectory: () => ipcRenderer.invoke('allen:select-directory'),
  showItemInFolder: (path: string) => ipcRenderer.invoke('allen:show-item-in-folder', path),
  openExternal: (url: string) => ipcRenderer.invoke('allen:open-external', url),
  openLogsDirectory: () => ipcRenderer.invoke('allen:open-logs-directory'),
  exportSupportBundle: (targetPath?: string) => ipcRenderer.invoke('allen:export-support-bundle', targetPath),
  writeClipboardText: (text: string) => ipcRenderer.invoke('allen:clipboard-write-text', text),
  getUpdateSettings: () => ipcRenderer.invoke('allen:update-settings-get'),
  setAutoUpdateEnabled: (enabled: boolean) => ipcRenderer.invoke('allen:update-settings-set-auto-enabled', enabled),
  checkForUpdates: () => ipcRenderer.invoke('allen:update-check-now'),
  onUpdatePrompt: (handler: (payload: { requestId: string; currentVersion: string; latestVersion: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: string; currentVersion: string; latestVersion: string }) => handler(payload);
    ipcRenderer.on('allen:update-prompt', listener);
    return () => ipcRenderer.off('allen:update-prompt', listener);
  },
  respondToUpdatePrompt: (requestId: string, action: 'update-now' | 'update-later') => ipcRenderer.send('allen:update-prompt-response', { requestId, action }),
};

contextBridge.exposeInMainWorld('allenDesktop', allenDesktop);
