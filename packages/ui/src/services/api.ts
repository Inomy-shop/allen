import { useAuthStore } from '../stores/authStore';

const BASE = '/api';

/**
 * Returns the Authorization header for authenticated API calls.
 * Used by places that need to bypass the `request()` helper — SSE streams,
 * raw fetches, file uploads with FormData, WebSocket upgrades via query
 * string, etc. Returns an empty object if no token is set.
 */
export function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Single-flight refresh queue ─────────────────────────────────────────
// Many requests can 401 at the same time; we only want to run /auth/refresh
// once and have the rest await the result.
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return null;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        useAuthStore.getState().clear();
        return null;
      }
      const data = await res.json();
      useAuthStore.getState().setSession({
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      });
      return data.accessToken as string;
    } catch {
      useAuthStore.getState().clear();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function redirectToLogin(): void {
  const current = window.location.pathname + window.location.search;
  if (window.location.pathname === '/login') return;
  window.location.assign(`/login?from=${encodeURIComponent(current)}`);
}

async function doFetch(path: string, options: RequestInit, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { ...options, headers });
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Don't attach tokens to /auth/login or /auth/refresh themselves.
  const isPublicAuth = path.startsWith('/auth/login') || path.startsWith('/auth/refresh');
  const token = isPublicAuth ? null : useAuthStore.getState().accessToken;

  let res = await doFetch(path, options, token);

  if (res.status === 401 && !isPublicAuth) {
    // Try to refresh once.
    const fresh = await refreshAccessToken();
    if (!fresh) {
      redirectToLogin();
      throw new Error('session_expired');
    }
    res = await doFetch(path, options, fresh);
    if (res.status === 401) {
      useAuthStore.getState().clear();
      redirectToLogin();
      throw new Error('session_expired');
    }
  }

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
    fetch(`${BASE}/workflows/${id}/mermaid`, { headers: authHeaders() }).then(r => r.text()),
  exportYaml: (id: string) =>
    fetch(`${BASE}/workflows/${id}/export`, { headers: authHeaders() }).then(r => r.text()),
  importYaml: (yaml: string) =>
    request<any>('/workflows/import', { method: 'POST', body: JSON.stringify({ yaml }) }),
};

// ── Executions ─────────────────────────────────────────────────────────────

/** Shape returned by GET /executions/:id/children — spawn-tree row. */
export interface SpawnedChild {
  id: string;
  workflowName: string;
  agentName: string;
  parentCaller: string | null;
  parentExecutionId: string | null;
  rootExecutionId: string | null;
  spawnDepth: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  cost: { actual: number | null; estimated: number } | null;
  failedNode: string | null;
  errorMessage: string | null;
  promptPreview: string;
  /** How the parent↔child link was established:
   *  'direct'  — Phase 1 parentExecutionId match (authoritative).
   *  'timing'  — Timing-based correlation for pre-Phase-1 data (heuristic). */
  linkType: 'direct' | 'timing';
}

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
  /**
   * Cancel this execution and every spawn-tree descendant. Used by the
   * Spawned Agents panel's "Cancel subtree" action.
   */
  cancelSubtree: (id: string) =>
    request<{ cancelled: number; total: number; results: { id: string; ok: boolean; error?: string }[] }>(
      `/executions/${id}/cancel-subtree`,
      { method: 'POST' },
    ),
  pause: (id: string) =>
    request<any>(`/executions/${id}/pause`, { method: 'POST' }),
  resume: (id: string) =>
    request<any>(`/executions/${id}/resume`, { method: 'POST' }),
  submitInput: (id: string, node: string, data: Record<string, unknown>) =>
    request<any>(`/executions/${id}/input`, { method: 'POST', body: JSON.stringify({ node, data }) }),
  retryFrom: (id: string, node: string) =>
    request<any>(`/executions/${id}/retry-from/${node}`, { method: 'POST' }),
  /**
   * Fetch spawn-tree children of an execution.
   *   mode 'direct'      → only children spawned directly by this execution
   *   mode 'descendants' → every row in the subtree (children, grandchildren, …)
   */
  children: (id: string, mode: 'direct' | 'descendants' = 'direct') =>
    request<SpawnedChild[]>(`/executions/${id}/children?mode=${mode}`),
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
  // Import Claude agents from a registered repo's `.claude/agents/*.md` files.
  importPreview: (repoId: string) =>
    request<{ repo: { _id: string; name: string; path: string }; verdicts: any[] }>(
      '/agents/import/preview',
      { method: 'POST', body: JSON.stringify({ repoId }) },
    ),
  import: (repoId: string, agentNames: string[]) =>
    request<{ created: string[]; skipped: { name: string; reason: string }[] }>(
      '/agents/import',
      { method: 'POST', body: JSON.stringify({ repoId, agentNames }) },
    ),
  resync: (name: string) =>
    request<any>(`/agents/${name}/resync`, { method: 'POST' }),
  moveToTeam: (name: string, teamName: string, teamRole: 'lead' | 'member' = 'member') =>
    request<any>(`/agents/${name}/team`, {
      method: 'PATCH',
      body: JSON.stringify({ teamName, teamRole }),
    }),
  bulkAssignTeam: (agentNames: string[], teamName: string, autoWireDelegation = true) =>
    request<{ moved: string[]; skipped: { name: string; reason: string }[] }>(
      '/agents/bulk-team',
      {
        method: 'POST',
        body: JSON.stringify({ agentNames, teamName, autoWireDelegation }),
      },
    ),
  run: (name: string, body: { prompt: string; repo_path?: string; session_id?: string }) =>
    request<{ agent_name: string; execution_id: string; status: string; message?: string; error?: string }>(
      `/agents/${name}/run`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

// ── Teams ──────────────────────────────────────────────────────────────────
export const teams = {
  list: () => request<any[]>('/teams'),
  get: (name: string) => request<any>(`/teams/${name}`),
  members: (name: string) => request<any[]>(`/teams/${name}/members`),
  blueprint: (name: string) => request<any>(`/teams/${name}/blueprint`),
  create: (team: any) =>
    request<any>('/teams', { method: 'POST', body: JSON.stringify(team) }),
  // Create a team with an auto-generated lead agent in one call. Used by the
  // "Create Team" flow on the agents page. Optionally moves selected agents
  // into the new team as members.
  createWithMembers: (body: {
    team: { name: string; displayName: string; description?: string; mission?: string; parentTeamName?: string };
    lead?: { name?: string; displayName?: string; model?: string; reasoningEffort?: string; system?: string };
    memberAgentNames?: string[];
    autoWireDelegation?: boolean;
  }) =>
    request<any>('/teams/with-members', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (name: string, team: any) =>
    request<any>(`/teams/${name}`, { method: 'PUT', body: JSON.stringify(team) }),
  delete: (name: string) =>
    request<void>(`/teams/${name}`, { method: 'DELETE' }),
};

// ── Interventions ──────────────────────────────────────────────────────────
// Human-in-the-loop pauses surfaced by the HIP (Human Intervention Protocol).
// Every workflow human pause becomes an intervention record. The dedicated
// Interventions page lists all of them; the chat card and workflow execution
// page indicator both read from this API.
export const interventions = {
  list: (params?: {
    status?: 'pending' | 'answered' | 'expired' | 'skipped';
    workflow_run_id?: string;
    workflow_name?: string;
    severity?: 'question' | 'approval' | 'escalation';
    limit?: number;
  }) => {
    const qs = params ? '?' + new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
    ).toString() : '';
    return request<any[]>(`/interventions${qs}`);
  },
  get: (id: string) => request<any>(`/interventions/${id}`),
  listForWorkflowRun: (workflowRunId: string) =>
    request<any[]>(`/interventions/by-workflow-run/${workflowRunId}`),
  respond: (id: string, body: {
    decision: 'approve' | 'request_changes' | 'reject' | 'answer';
    field_values?: Record<string, unknown>;
    feedback?: string;
    scope?: 'requirements' | 'architecture' | 'technical_design' | 'all' | null;
    answer?: string;
    answered_by_user_id?: string;
    human_node_name?: string;
    retry_target_override?: string;
  }) =>
    request<any>(`/interventions/${id}/respond`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── Design Docs ────────────────────────────────────────────────────────────
export const designDocs = {
  list: (params?: { status?: string; chatSessionId?: string }) => {
    const qs = params ? '?' + new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
    ).toString() : '';
    return request<any[]>(`/design-docs${qs}`);
  },
  get: (id: string) => request<any>(`/design-docs/${id}`),
  getByWorkflowRun: (workflowRunId: string) =>
    request<any>(`/design-docs/by-workflow-run/${workflowRunId}`),
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
  createSession: (provider?: string, model?: string, agentOverrides?: Record<string, unknown>) =>
    request<any>('/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ provider, model, ...(agentOverrides ? { agentOverrides } : {}) }),
    }),
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
  logs: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any[]>(`/chat/logs${qs}`);
  },
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
    const res = await fetch(`/api/mcp/servers/upload`, { method: 'POST', headers: authHeaders(), body: form });
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

// ── Auth ──────────────────────────────────────────────────────────────────
import type { AuthUser } from '../stores/authStore';

interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export const auth = {
  login: (email: string, password: string) =>
    request<SessionResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: (refreshToken: string) =>
    request<{ ok: true }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
  resetPassword: (currentPassword: string, newPassword: string) =>
    request<SessionResponse>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  me: () => request<{ user: AuthUser }>('/auth/me'),
};

// ── Users (admin-only) ───────────────────────────────────────────────────
export const users = {
  list: () => request<AuthUser[]>('/users'),
  create: (body: { email: string; name: string }) =>
    request<{ user: AuthUser; tempPassword: string }>('/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (id: string, patch: { name?: string; role?: 'admin' | 'user' }) =>
    request<AuthUser>(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  delete: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),
  resetTempPassword: (id: string) =>
    request<{ tempPassword: string }>(`/users/${id}/reset-temp-password`, {
      method: 'POST',
    }),
};
