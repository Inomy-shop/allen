const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error ?? `Request failed: ${res.status}`); }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const workspaces = {
  list: () => request<any[]>('/workspaces'),
  get: (id: string) => request<any>(`/workspaces/${id}`),
  create: (body: any) => request<any>('/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  createFromPr: (body: any) => request<any>('/workspaces/from-pr', { method: 'POST', body: JSON.stringify(body) }),
  archive: (id: string) => request<any>(`/workspaces/${id}`, { method: 'DELETE' }),
  getDiff: (id: string) => request<any>(`/workspaces/${id}/diff`),
  getFiles: (id: string) => request<any[]>(`/workspaces/${id}/files`),
  getAllFiles: (id: string) => request<any[]>(`/workspaces/${id}/all-files`),
  getFile: (id: string, path: string) => request<any>(`/workspaces/${id}/file/${path}`),
  saveFile: (id: string, path: string, content: string) => request<any>(`/workspaces/${id}/file/${path}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  createFile: (id: string, path: string, content?: string) => request<any>(`/workspaces/${id}/create-file`, { method: 'POST', body: JSON.stringify({ path, content: content ?? '' }) }),
  deleteFile: (id: string, path: string) => request<any>(`/workspaces/${id}/file/${path}`, { method: 'DELETE' }),
  commit: (id: string, message: string) => request<any>(`/workspaces/${id}/commit`, { method: 'POST', body: JSON.stringify({ message }) }),
  push: (id: string) => request<any>(`/workspaces/${id}/push`, { method: 'POST' }),
  pull: (id: string) => request<any>(`/workspaces/${id}/pull`, { method: 'POST' }),
  getServices: (id: string) => request<any[]>(`/workspaces/${id}/services`),
  startService: (id: string, name: string) => request<any>(`/workspaces/${id}/services/${name}/start`, { method: 'POST' }),
  stopService: (id: string, name: string) => request<any>(`/workspaces/${id}/services/${name}/stop`, { method: 'POST' }),
  restartService: (id: string, name: string) => request<any>(`/workspaces/${id}/services/${name}/restart`, { method: 'POST' }),
  linkChat: (id: string, sessionId: string) => request<any>(`/workspaces/${id}/link-chat`, { method: 'POST', body: JSON.stringify({ sessionId }) }),
  getConfig: (repoId: string) => request<any>(`/workspaces/config/${repoId}`),
  saveConfig: (repoId: string, config: any) => request<any>(`/workspaces/config/${repoId}`, { method: 'PUT', body: JSON.stringify(config) }),
};
