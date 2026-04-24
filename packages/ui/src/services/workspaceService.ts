import { authHeaders } from './api';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options?.headers ?? {}) },
  });
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
  serviceLogsUrl: (id: string, name: string) => `${BASE}/workspaces/${id}/services/${name}/logs`,
  linkChat: (id: string, sessionId: string) => request<any>(`/workspaces/${id}/link-chat`, { method: 'POST', body: JSON.stringify({ sessionId }) }),
  createPR: (id: string, title: string, body?: string) => request<any>(`/workspaces/${id}/create-pr`, { method: 'POST', body: JSON.stringify({ title, body }) }),
  getConfig: (repoId: string) => request<any>(`/workspaces/config/${repoId}`),
  saveConfig: (repoId: string, config: any) => request<any>(`/workspaces/config/${repoId}`, { method: 'PUT', body: JSON.stringify(config) }),
  // Templates
  listTemplates: () => request<any[]>('/workspaces/templates'),
  saveTemplate: (name: string, template: any) => request<any>('/workspaces/templates', { method: 'POST', body: JSON.stringify({ name, ...template }) }),
  deleteTemplate: (name: string) => request<any>(`/workspaces/templates/${name}`, { method: 'DELETE' }),
  // Bulk
  bulkArchive: (ids: string[]) => request<any>('/workspaces/bulk-archive', { method: 'POST', body: JSON.stringify({ ids }) }),
  // Activity
  getActivity: (id: string) => request<any[]>(`/workspaces/${id}/activity`),
};

// ── Pull Requests ──

export const pullRequests = {
  list: (filters?: { repoId?: string; status?: string }) => {
    const params = new URLSearchParams();
    if (filters?.repoId) params.set('repoId', filters.repoId);
    if (filters?.status) params.set('status', filters.status);
    return request<any[]>(`/pull-requests?${params}`);
  },
  get: (id: string) => request<any>(`/pull-requests/${id}`),
  sync: (repoPath: string, repoId: string, repoName: string) =>
    request<any>('/pull-requests/sync', { method: 'POST', body: JSON.stringify({ repoPath, repoId, repoName }) }),
  // Sync all active repos in one request. Shared server-side logic with
  // the `pr-sync-all` cron — single source of truth for the loop.
  syncAll: () =>
    request<{
      repos: Array<{ repoId: string; repoName: string; status: 'synced' | 'error'; synced?: number; total?: number; error?: string }>;
      summary: string;
      totalSynced: number;
      totalPrs: number;
      errorCount: number;
    }>('/pull-requests/sync-all', { method: 'POST' }),
  getDiff: (id: string) => request<any>(`/pull-requests/${id}/diff`),
  createWorkspace: (id: string) => request<any>(`/pull-requests/${id}/workspace`, { method: 'POST' }),
};
