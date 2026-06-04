const { contextBridge, ipcRenderer } = require('electron');

const allenDesktop = {
  getRuntimeInfo: () => ipcRenderer.invoke('allen:runtime-info'),
  getAuthSession: () => ipcRenderer.invoke('allen:auth-get'),
  setAuthSession: (session) => ipcRenderer.invoke('allen:auth-set', session),
  clearAuthSession: () => ipcRenderer.invoke('allen:auth-clear'),
  selectDirectory: () => ipcRenderer.invoke('allen:select-directory'),
  showItemInFolder: (path) => ipcRenderer.invoke('allen:show-item-in-folder', path),
  openExternal: (url) => ipcRenderer.invoke('allen:open-external', url),
  openLogsDirectory: () => ipcRenderer.invoke('allen:open-logs-directory'),
  exportSupportBundle: (targetPath) => ipcRenderer.invoke('allen:export-support-bundle', targetPath),
  writeClipboardText: (text) => ipcRenderer.invoke('allen:clipboard-write-text', text),
};

contextBridge.exposeInMainWorld('allenDesktop', allenDesktop);
