const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Workflows ──────────────────────────────────────────────────────────────
export const workflows = {
  list: () => request<any[]>('/workflows'),
  get: (id: string) => request<any>(`/workflows/${id}`),
  create: (body: { yaml?: string; parsed?: any }) =>
    request<any>('/workflows', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: any) =>
    request<any>(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<void>(`/workflows/${id}`, { method: 'DELETE' }),
  validate: (id: string) =>
    request<any>(`/workflows/${id}/validate`, { method: 'POST' }),
  mermaid: (id: string) =>
    fetch(`${BASE}/workflows/${id}/mermaid`).then(r => r.text()),
  exportYaml: (id: string) =>
    fetch(`${BASE}/workflows/${id}/export`).then(r => r.text()),
  importYaml: (yaml: string) =>
    request<any>('/workflows/import', { method: 'POST', body: JSON.stringify({ yaml }) }),
};

// ── Executions ─────────────────────────────────────────────────────────────
export const executions = {
  list: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any[]>(`/executions${qs}`);
  },
  get: (id: string) => request<any>(`/executions/${id}`),
  start: (workflowId: string, input: Record<string, unknown>) =>
    request<any>('/executions', { method: 'POST', body: JSON.stringify({ workflowId, input }) }),
  cancel: (id: string) =>
    request<any>(`/executions/${id}/cancel`, { method: 'POST' }),
  pause: (id: string) =>
    request<any>(`/executions/${id}/pause`, { method: 'POST' }),
  resume: (id: string) =>
    request<any>(`/executions/${id}/resume`, { method: 'POST' }),
  submitInput: (id: string, node: string, data: Record<string, unknown>) =>
    request<any>(`/executions/${id}/input`, { method: 'POST', body: JSON.stringify({ node, data }) }),
  retryFrom: (id: string, node: string) =>
    request<any>(`/executions/${id}/retry-from/${node}`, { method: 'POST' }),
  logs: (id: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any[]>(`/executions/${id}/logs${qs}`);
  },
  traces: (id: string) => request<any[]>(`/executions/${id}/traces`),
  tracesByNode: (id: string, node: string) =>
    request<any[]>(`/executions/${id}/traces/${node}`),
  streamUrl: (id: string) => `${BASE}/executions/${id}/stream`,
};

// ── Agents ─────────────────────────────────────────────────────────────────
export const agents = {
  list: () => request<any[]>('/agents'),
  create: (agent: any) =>
    request<any>('/agents', { method: 'POST', body: JSON.stringify(agent) }),
  update: (name: string, agent: any) =>
    request<any>(`/agents/${name}`, { method: 'PUT', body: JSON.stringify(agent) }),
  delete: (name: string) =>
    request<void>(`/agents/${name}`, { method: 'DELETE' }),
};

// ── Teams ──────────────────────────────────────────────────────────────────
export const teams = {
  list: () => request<any[]>('/teams'),
  get: (name: string) => request<any>(`/teams/${name}`),
  members: (name: string) => request<any[]>(`/teams/${name}/members`),
  blueprint: (name: string) => request<any>(`/teams/${name}/blueprint`),
  create: (team: any) =>
    request<any>('/teams', { method: 'POST', body: JSON.stringify(team) }),
  update: (name: string, team: any) =>
    request<any>(`/teams/${name}`, { method: 'PUT', body: JSON.stringify(team) }),
  delete: (name: string) =>
    request<void>(`/teams/${name}`, { method: 'DELETE' }),
};

// ── Secrets ────────────────────────────────────────────────────────────────
export const secrets = {
  list: () => request<string[]>('/secrets'),
  create: (key: string, value: string) =>
    request<any>('/secrets', { method: 'POST', body: JSON.stringify({ key, value }) }),
  update: (key: string, value: string) =>
    request<any>(`/secrets/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  delete: (key: string) =>
    request<void>(`/secrets/${key}`, { method: 'DELETE' }),
};

// ── Repos ─────────────────────────────────────────────────────────────────
export const repos = {
  list: () => request<any[]>('/repos'),
  get: (id: string) => request<any>(`/repos/${id}`),
  create: (body: any) =>
    request<any>('/repos', { method: 'POST', body: JSON.stringify(body) }),
  clone: (body: { url: string; branch?: string; name?: string; description?: string; tags?: string[] }) =>
    request<any>('/repos/clone', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: any) =>
    request<any>(`/repos/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<void>(`/repos/${id}`, { method: 'DELETE' }),
  scan: (id: string) =>
    request<any>(`/repos/${id}/scan`, { method: 'POST' }),
  pull: (id: string, rescan = false) =>
    request<any>(`/repos/${id}/pull`, { method: 'POST', body: JSON.stringify({ rescan }) }),
  context: (id: string) =>
    request<any>(`/repos/${id}/context`),
  rescanContext: (id: string) =>
    request<any>(`/repos/${id}/rescan-context`, { method: 'POST' }),
};

// ── Dashboard ──────────────────────────────────────────────────────────────
export const dashboard = {
  stats: () => request<any>('/dashboard/stats'),
  cost: () => request<any>('/dashboard/cost'),
};

// ── Chat ──────────────────────────────────────────────────────────────────
export const chat = {
  listSessions: () => request<any[]>('/chat/sessions'),
  providers: () => request<any[]>('/chat/providers'),
  createSession: (provider?: string, model?: string) =>
    request<any>('/chat/sessions', { method: 'POST', body: JSON.stringify({ provider, model }) }),
  getSession: (id: string) => request<any>(`/chat/sessions/${id}`),
  getMessages: (id: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/chat/sessions/${id}/messages${qs}`);
  },
  sendMessageUrl: (id: string) => `${BASE}/chat/sessions/${id}/messages`,
  streamUrl: (id: string) => `${BASE}/chat/sessions/${id}/stream`,
  isStreaming: (id: string) => request<{ streaming: boolean }>(`/chat/sessions/${id}/streaming`),
  updateSession: (id: string, body: any) =>
    request<any>(`/chat/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSession: (id: string) =>
    request<void>(`/chat/sessions/${id}`, { method: 'DELETE' }),
  getThreads: (id: string) =>
    request<any[]>(`/chat/sessions/${id}/threads`),
  answerAgentQuestion: (id: string, answer: string) =>
    request<any>(`/chat/sessions/${id}/agent-answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
};

// ── Alerts ───────────────────────────────────────────────────────────────
export const alerts = {
  list: (unread?: boolean) => request<any[]>(`/alerts${unread ? '?unread=true' : ''}`),
  count: () => request<{ count: number }>('/alerts/count'),
  markRead: (id: string) => request<any>(`/alerts/${id}/read`, { method: 'POST' }),
  markAllRead: () => request<any>('/alerts/read-all', { method: 'POST' }),
  dismiss: (id: string) => request<void>(`/alerts/${id}`, { method: 'DELETE' }),
};

// ── MCP Servers ──────────────────────────────────────────────────────────
export const mcp = {
  list: () => request<any[]>('/mcp/servers'),
  presets: () => request<any[]>('/mcp/presets'),
  create: (body: any) =>
    request<any>('/mcp/servers', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: any) =>
    request<any>(`/mcp/servers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  toggle: (id: string) =>
    request<any>(`/mcp/servers/${id}/toggle`, { method: 'PATCH' }),
  delete: (id: string) =>
    request<void>(`/mcp/servers/${id}`, { method: 'DELETE' }),
  test: (id: string) =>
    request<any>(`/mcp/servers/${id}/test`, { method: 'POST' }),
  // Bundle upload
  uploadBundle: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/mcp/servers/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Upload failed: ${res.status}`);
    }
    return res.json();
  },
  getBundle: (bundleId: string) =>
    request<any>(`/mcp/servers/upload/${bundleId}`),
  setBundleEntry: (bundleId: string, entry: string) =>
    request<any>(`/mcp/servers/upload/${bundleId}`, { method: 'PATCH', body: JSON.stringify({ entry }) }),
  deleteBundle: (bundleId: string) =>
    request<void>(`/mcp/servers/upload/${bundleId}`, { method: 'DELETE' }),
};

// ── Learnings ─────────────────────────────────────────────────────────────
export const learnings = {
  list: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any[]>(`/learnings${qs}`);
  },
  stats: () => request<any>('/learnings/stats'),
  get: (id: string) => request<any>(`/learnings/${id}`),
  create: (body: any) =>
    request<any>('/learnings', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: any) =>
    request<any>(`/learnings/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  approve: (id: string) =>
    request<any>(`/learnings/${id}/approve`, { method: 'POST' }),
  reject: (id: string) =>
    request<any>(`/learnings/${id}/reject`, { method: 'POST' }),
  delete: (id: string) =>
    request<void>(`/learnings/${id}`, { method: 'DELETE' }),
  forExecution: (execId: string) =>
    request<any>(`/executions/${execId}/learnings`),
  evolutionCandidates: (agentName?: string) => {
    const qs = agentName ? `?agentName=${agentName}` : '';
    return request<any>(`/learnings/evolution-candidates${qs}`);
  },
  evolutionPreview: (agentName: string) =>
    request<any>(`/learnings/evolve/${agentName}/preview`),
  evolve: (agentName: string, newPrompt: string) =>
    request<any>(`/learnings/evolve/${agentName}`, { method: 'POST', body: JSON.stringify({ newPrompt }) }),
};

// ── Cron Jobs ──────────────────────────────────────────────────────────────
export const crons = {
  list: () => request<any[]>('/crons'),
  get: (id: string) => request<any>(`/crons/${id}`),
  create: (body: any) =>
    request<any>('/crons', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: any) =>
    request<any>(`/crons/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<void>(`/crons/${id}`, { method: 'DELETE' }),
  enable: (id: string) =>
    request<any>(`/crons/${id}/enable`, { method: 'POST' }),
  disable: (id: string) =>
    request<any>(`/crons/${id}/disable`, { method: 'POST' }),
  runNow: (id: string) =>
    request<any>(`/crons/${id}/run-now`, { method: 'POST' }),
  runs: (id: string, limit = 50) =>
    request<any[]>(`/crons/${id}/runs?limit=${limit}`),
  previewSchedule: (cron: string, n = 5, timezone = 'UTC') =>
    request<any>(`/crons/preview-schedule?cron=${encodeURIComponent(cron)}&n=${n}&timezone=${encodeURIComponent(timezone)}`),
  systemActions: () =>
    request<any[]>('/crons/system-actions'),
};
