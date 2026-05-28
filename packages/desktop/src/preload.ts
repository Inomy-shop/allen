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
};

contextBridge.exposeInMainWorld('allenDesktop', allenDesktop);
