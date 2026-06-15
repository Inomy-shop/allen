const { contextBridge, ipcRenderer } = require('electron');

const allenDesktop = {
  getRuntimeInfo: () => ipcRenderer.invoke('allen:runtime-info'),
  getAuthSession: () => ipcRenderer.invoke('allen:auth-get'),
  setAuthSession: (session) => ipcRenderer.invoke('allen:auth-set', session),
  clearAuthSession: () => ipcRenderer.invoke('allen:auth-clear'),
  selectDirectory: () => ipcRenderer.invoke('allen:select-directory'),
  showItemInFolder: (path) => ipcRenderer.invoke('allen:show-item-in-folder', path),
  openExternal: (url) => ipcRenderer.invoke('allen:open-external', url),
  openWorkspaceIde: (workspaceId, ide) => ipcRenderer.invoke('allen:open-workspace-ide', { workspaceId, ide }),
  openLogsDirectory: () => ipcRenderer.invoke('allen:open-logs-directory'),
  exportSupportBundle: (targetPath) => ipcRenderer.invoke('allen:export-support-bundle', targetPath),
  writeClipboardText: (text) => ipcRenderer.invoke('allen:clipboard-write-text', text),
  getUpdateSettings: () => ipcRenderer.invoke('allen:update-settings-get'),
  setAutoUpdateEnabled: (enabled) => ipcRenderer.invoke('allen:update-settings-set-auto-enabled', enabled),
  checkForUpdates: () => ipcRenderer.invoke('allen:update-check-now'),
  getReleaseNotes: () => ipcRenderer.invoke('allen:release-notes-list'),
  getReleaseNote: (version, notesUrl) => ipcRenderer.invoke('allen:release-notes-get', { version, notesUrl }),
  onUpdatePrompt: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('allen:update-prompt', listener);
    return () => ipcRenderer.off('allen:update-prompt', listener);
  },
  respondToUpdatePrompt: (requestId, action) => ipcRenderer.send('allen:update-prompt-response', { requestId, action }),
  onUpdateDownloadProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('allen:update-download-progress', listener);
    return () => ipcRenderer.off('allen:update-download-progress', listener);
  },
  onUpdateDownloadError: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('allen:update-download-error', listener);
    return () => ipcRenderer.off('allen:update-download-error', listener);
  },
  onUpdateDownloadComplete: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('allen:update-download-complete', listener);
    return () => ipcRenderer.off('allen:update-download-complete', listener);
  },
  retryUpdateDownload: (requestId) => ipcRenderer.send('allen:update-download-retry', { requestId }),
  cancelUpdateDownload: (requestId) => ipcRenderer.send('allen:update-download-cancel', { requestId }),
};

contextBridge.exposeInMainWorld('allenDesktop', allenDesktop);
