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
  /**
   * Paginated list with search + agent/workflow type filter. Returns the
   * page slice plus the total matching count so the UI can render
   * pagination controls. Server is backward compatible — any of `limit`,
   * `offset`, `search`, or `type` triggers the paged response shape.
   */
  listPaged: (params: {
    status?: string;
    workflowId?: string;
    workflowName?: string;
    type?: 'agent' | 'workflow';
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.workflowId) qs.set('workflowId', params.workflowId);
    if (params.workflowName) qs.set('workflowName', params.workflowName);
    if (params.type) qs.set('type', params.type);
    if (params.search) qs.set('search', params.search);
    qs.set('limit', String(params.limit ?? 50));
    qs.set('offset', String(params.offset ?? 0));
    return request<{ items: any[]; total: number }>(`/executions?${qs.toString()}`);
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
  /** Agent-execution resume: appends a new attempt (attempt N+1) to the
   *  existing execution instead of creating a fresh one. See
   *  execution.routes.ts:/resume-agent for details. */
  resumeAgent: (id: string, prompt: string) =>
    request<{ execution_id: string; attempt: number }>(`/executions/${id}/resume-agent`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  submitInput: (id: string, node: string, data: Record<string, unknown>) =>
    request<any>(`/executions/${id}/input`, { method: 'POST', body: JSON.stringify({ node, data }) }),
  feedback: {
    list: (id: string) =>
      request<Array<{ id: string; content: string; targetNodes?: string[]; createdAt: string; createdBy?: string }>>(
        `/executions/${id}/feedback`,
      ),
    create: (id: string, content: string, targetNodes?: string[]) =>
      request<{ id: string; content: string; targetNodes?: string[]; createdAt: string; createdBy?: string }>(
        `/executions/${id}/feedback`,
        { method: 'POST', body: JSON.stringify({ content, targetNodes }) },
      ),
  },
  retryFrom: (id: string, node: string) =>
    request<any>(`/executions/${id}/retry-from/${node}`, { method: 'POST' }),
  /**
   * Checkpoint inspection + editing + resume/fork from a specific checkpoint.
   */
  checkpoints: {
    list: (id: string) => request<any[]>(`/executions/${id}/checkpoints`),
    get: (id: string, cid: string) =>
      request<any>(`/executions/${id}/checkpoints/${cid}`),
    update: (id: string, cid: string, body: { state?: Record<string, unknown> }) =>
      request<any>(`/executions/${id}/checkpoints/${cid}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    run: (id: string, cid: string) =>
      request<{ id: string; status: string; resumingFromCheckpoint: string }>(
        `/executions/${id}/checkpoints/${cid}/run`,
        { method: 'POST' },
      ),
    fork: (id: string, cid: string) =>
      request<{ sourceExecutionId: string; newExecutionId: string; status: string }>(
        `/executions/${id}/checkpoints/${cid}/fork`,
        { method: 'POST' },
      ),
  },
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
  // Persisted spawn-activity event log. Used by the UI to hydrate the
  // execution detail page on refresh so intermediate text / thinking /
  // tool events from the spawned agent aren't lost when the client
  // reloads mid-run.
  activity: (id: string, opts?: { since?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.since) params.set('since', opts.since);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return request<{ events: ActivityEvent[] }>(`/executions/${id}/activity${qs}`);
  },
  streamUrl: (id: string) => `${BASE}/executions/${id}/stream`,
};

// ── Agent Activity (shared shape) ─────────────────────────────────────────
// Row shape returned by both the delegation and execution activity routes.
// See packages/server/src/services/agent-activity.service.ts PersistedActivityRow.
export interface ActivityEvent {
  id: string;
  scope: 'delegation' | 'execution';
  refId: string;
  agent: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result';
  tool?: string;
  content?: string;
  toolUseId?: string;
  durationMs?: number;
  at: string;
}

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
  // Replay persisted activity for a single delegation (conversation).
  // Called from useChat on initial load to repopulate liveActivity for
  // still-running threads so a page refresh doesn't erase their visible
  // progress feed.
  getDelegationActivity: (conversationId: string, opts?: { since?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.since) params.set('since', opts.since);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return request<{ events: ActivityEvent[] }>(`/chat/delegations/${conversationId}/activity${qs}`);
  },
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
// MCP records come from either a hardcoded preset or a registered repo.
// Env/args never carry credentials — users put `ALLEN_<KEY>` vars in Allen's
// root .env and the server strips the prefix at spawn. `create()` returns
// 400 with `{ missing: string[] }` if any required ALLEN_* var is absent.
export type McpServerSource =
  | { kind: 'preset'; presetName: string }
  | { kind: 'repo'; repoId: string; entryPath: string; installPath?: string };

export interface McpServer {
  _id: string;
  ownerId?: string;
  name: string;
  description: string;
  type: 'stdio' | 'sse' | 'http';
  enabled: boolean;
  source?: McpServerSource;
  envKeys?: string[];
  argKeys?: string[];
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  status: 'connected' | 'failed' | 'untested' | 'disabled';
  lastTestedAt?: string;
  lastError?: string;
  serverInfo?: { name: string; version: string };
  toolCount?: number;
  // legacy fields (tolerated on read, never sent on create)
  bundleId?: string; bundlePath?: string; bundleEntry?: string;
  env?: Record<string, string>;
}

export interface McpPreset {
  name: string;
  description: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  envKeys: string[];
  argKeys?: string[];
  docsUrl: string;
}

export interface McpDiscoverResult {
  repoId: string;
  repoPath: string;
  candidates: Array<{ entry: string; repoRelative: string }>;
}

export const mcp = {
  list: () => request<McpServer[]>('/mcp/servers'),
  presets: () => request<McpPreset[]>('/mcp/presets'),
  /**
   * Create an MCP server. Preset flow: send `{ name, type, source: { kind: 'preset', presetName } }`
   * — backend copies command/args/envKeys from the preset and validates ALLEN_* env.
   * Repo flow: send `{ name, type, source: { kind: 'repo', repoId, entryPath, installPath? }, envKeys }`.
   */
  create: (body: {
    name: string;
    type: 'stdio' | 'sse' | 'http';
    description?: string;
    enabled?: boolean;
    source?: McpServerSource;
    envKeys?: string[];
    argKeys?: string[];
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
  }) => request<McpServer>('/mcp/servers', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<McpServer>) =>
    request<McpServer>(`/mcp/servers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  toggle: (id: string) =>
    request<McpServer>(`/mcp/servers/${id}/toggle`, { method: 'PATCH' }),
  delete: (id: string) =>
    request<void>(`/mcp/servers/${id}`, { method: 'DELETE' }),
  test: (id: string) =>
    request<{ status: string; serverInfo?: { name: string; version: string }; toolCount?: number; error?: string; durationMs: number }>(
      `/mcp/servers/${id}/test`,
      { method: 'POST' },
    ),
  /** Scan a registered repo for likely MCP entry files. */
  discover: (repoId: string) => request<McpDiscoverResult>(`/mcp/servers/discover/${repoId}`),
  /** Bust the install cache + re-run `npm install` for a repo-sourced MCP. */
  reinstall: (id: string) =>
    request<{ installDir: string; packageManager: string; durationMs: number; skipped: boolean }>(
      `/mcp/servers/${id}/reinstall`,
      { method: 'POST' },
    ),
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

// ── Linear ────────────────────────────────────────────────────────────────
export const linear = {
  status: () => request<{
    configured: boolean;
    workspaceName?: string;
    workspaceUrlKey?: string;
    error?: string;
  }>('/linear/status'),
  projects: () => request<any[]>('/linear/projects'),
  issues: (filters: { projectId?: string; state?: string; q?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (filters.projectId) qs.set('projectId', filters.projectId);
    if (filters.state) qs.set('state', filters.state);
    if (filters.q) qs.set('q', filters.q);
    if (filters.limit) qs.set('limit', String(filters.limit));
    const query = qs.toString();
    return request<any[]>(`/linear/issues${query ? `?${query}` : ''}`);
  },
  issue: (id: string) => request<any>(`/linear/issues/${id}`),
  assignAgent: (id: string, agentName: string | null) =>
    request<{ assignment: any | null }>(`/linear/issues/${id}/assign-agent`, {
      method: 'PATCH',
      body: JSON.stringify({ agentName }),
    }),
  dispatch: (
    id: string,
    body: { agentName: string; repoId: string; extraInstructions?: string; promptTemplate?: string },
  ) =>
    request<{ assignment: any }>(`/linear/issues/${id}/dispatch`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  dispatchWorkflow: (id: string, body: { workflowId: string; input: Record<string, unknown> }) =>
    request<{ assignment: any }>(`/linear/issues/${id}/dispatch-workflow`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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

// ── Artifacts ─────────────────────────────────────────────────────────────
// Hierarchical file storage keyed by the root that spawned the work —
// chat session, workflow execution, or standalone agent run. The MCP tool
// `allen_save_artifact` routes to these endpoints; the UI renders lists
// and per-file viewers on chat / execution / agent pages.

export interface ArtifactDoc {
  artifactId: string;
  rootType: 'chat' | 'workflow' | 'agent';
  rootId: string;
  spawnContext: {
    originType: 'chat' | 'workflow_node' | 'spawn_agent' | 'standalone' | 'system';
    parentId?: string;
    nodeName?: string;
    agentName?: string;
    agentExecutionId?: string;
  };
  filename: string;
  relativePath: string;
  contentType: 'markdown' | 'json' | 'csv' | 'text' | 'code' | 'binary';
  sizeBytes: number;
  description?: string;
  language?: string;
  createdAt: string;
  createdByAgent?: string;
  createdByUserId?: string;
}

export const artifacts = {
  list: (params: { rootType?: 'chat' | 'workflow' | 'agent'; rootId?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params.rootType) qs.set('rootType', params.rootType);
    if (params.rootId) qs.set('rootId', params.rootId);
    if (params.limit != null) qs.set('limit', String(params.limit));
    return request<ArtifactDoc[]>(`/artifacts${qs.toString() ? '?' + qs.toString() : ''}`);
  },
  get: (id: string) => request<ArtifactDoc>(`/artifacts/${id}`),
  /** Public content URL — no auth required; UUID is the capability. */
  contentUrl: (id: string) => `/api/artifacts/${id}/content`,
  save: (body: {
    rootType: 'chat' | 'workflow' | 'agent';
    rootId: string;
    filename: string;
    content: string;
    contentType?: 'markdown' | 'json' | 'csv' | 'text' | 'code' | 'binary';
    description?: string;
    overwrite?: boolean;
  }) =>
    request<{ artifactId: string; url: string; filename: string; sizeBytes: number }>(
      `/artifacts`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  delete: (id: string) =>
    request<{ deleted: boolean }>(`/artifacts/${id}`, { method: 'DELETE' }),
};
