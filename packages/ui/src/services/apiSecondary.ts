import type { AuthUser } from '../stores/authStore';
import { request } from './apiCore';
import type { JudgeRunDoc, FindingDoc, ReviewTaskDoc, WorkerAssignmentDoc, ReviewDecisionDoc, RemediationDoc, CurationRevisionDoc, LearningPromotionDoc, PagedContextQualityResponse, OrchestrationSessionDoc } from './contextQualityTypes';

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
// Env/args never carry literal credentials. Users provide `ALLEN_<KEY>` values
// through the desktop secret store (or env in web/dev mode); MCP subprocesses
// receive only bare `<KEY>` via an allowlist. Creates return 400 with
// `{ missing: string[] }` if any required credential is absent.
export type McpServerSource =
  | { kind: 'preset'; presetName: string }
  | { kind: 'repo'; repoId: string; entryPath: string; installPath?: string };

export interface McpServer {
  _id: string;
  ownerId?: string;
  ownerName?: string;
  ownerEmail?: string;
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
  /** Python venv config for repo-sourced .py MCPs without a manual command override. */
  python?: { interpreter?: string; requirementsPath?: string };
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
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  envKeys: string[];
  argKeys?: string[];
  docsUrl: string;
}

export interface McpDiscoverResult {
  repoId: string;
  repoPath: string;
  candidates: Array<{
    entry: string;
    repoRelative: string;
    detectedLanguage: 'python' | 'node';
  }>;
}

export interface McpToolGroup {
  serverName: string;
  builtIn: boolean;
  enabled: boolean;
  tools: Array<{ name: string; fullName: string; description: string }>;
}

export const mcp = {
  list: () => request<McpServer[]>('/mcp/servers'),
  presets: () => request<McpPreset[]>('/mcp/presets'),
  tools: (options?: { refresh?: boolean }) =>
    request<McpToolGroup[]>(`/mcp/tools${options?.refresh === false ? '?refresh=0' : ''}`),
  /**
   * Create an MCP server. Preset flow: send `{ name, type, source: { kind: 'preset', presetName }, credentials? }`
   * — backend copies command/args/envKeys from the preset and validates app-managed credentials.
   * Repo flow: send `{ name, type, source: { kind: 'repo', repoId, entryPath, installPath? }, envKeys, credentials? }`.
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
    credentials?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    /** Python venv config — sent only for .py entries without a manual command override. */
    python?: { interpreter?: string; requirementsPath?: string };
  }) => request<McpServer>('/mcp/servers', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<McpServer> & { credentials?: Record<string, string> }) =>
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
  /** Bust the install cache + re-run `npm install` (Node) or recreate the
   * venv (Python) for a repo-sourced MCP. */
  reinstall: (id: string) =>
    request<{
      installDir?: string;
      packageManager?: string;
      durationMs?: number;
      skipped: boolean;
      reason?: string;
      message?: string;
      requirementsInstalled?: boolean;
      requirementsPath?: string | null;
    }>(
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
  bootstrap: (body: { name: string; email: string; password: string }) =>
    request<SessionResponse>('/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify(body),
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

// ── Model Registry ─────────────────────────────────────────────────────────
export interface ModelRegistryEntry {
  _id: string;
  provider: string;
  fullId: string;
  displayName: string;
  providerDisplayName: string;
  costInputPerMTok?: number | null;
  costOutputPerMTok?: number | null;
  costCacheReadPerMTok?: number | null;
  tier?: 'default' | 'opus' | 'flash' | null;
  sortOrder?: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// ── System ────────────────────────────────────────────────────────────────
export type DesktopRuntimeSettingsResponse = {
  desktop: boolean;
  editable: boolean;
  configPath: string | null;
  contextSetup: {
    selected: boolean;
    configuredPython: string | null;
    pythonPath: string;
    venvPython: string;
    cogneeImportOk: boolean;
    setupRecommended: boolean;
    detail: string;
  };
  groups: Array<{
    id: string;
    title: string;
    description: string;
    fields: Array<{
      key: string;
      label: string;
      description?: string;
      kind: 'boolean' | 'number' | 'path' | 'select' | 'string';
      defaultValue: string;
      currentValue: string;
      configuredValue: string | null;
      source: 'desktop_config' | 'env' | 'default';
      placeholder?: string;
      options?: Array<{ label: string; value: string }>;
      restartRequired: boolean;
      readOnly: boolean;
      advanced: boolean;
      showWhen?: {
        key: string;
        equals?: string;
        notEquals?: string;
        in?: string[];
      };
    }>;
  }>;
};

export const system = {
  onboardingStatus: () =>
    request<{
      isFirstRun: boolean;
      userCount: number;
      adminCount: number;
      complete: boolean;
      step: 'account' | 'health' | 'model_defaults' | 'repository' | 'first_workflow' | 'complete';
    }>('/system/onboarding-status'),
  health: () =>
    request<{
      status: 'pass' | 'warn' | 'fail';
      generatedAt: string;
      requiredPassed: boolean;
      checks: Array<{
        id: string;
        label: string;
        required: boolean;
        status: 'pass' | 'warn' | 'fail';
        version?: string;
        detail: string;
        fix?: {
          summary: string;
          commands?: string[];
          docsPath?: string;
        };
      }>;
    }>('/system/health'),
  runtimeConfig: () =>
    request<{
      contextEngine: {
        enabled: boolean;
        provider: 'allen' | 'cognee' | 'cognee_memory' | null;
        cogneeEnabled: boolean;
      };
    }>('/system/runtime-config'),
  desktopRuntime: () =>
    request<{
      desktop: boolean;
      paths: {
        allenHome: string | null;
        workspaceBaseDir: string | null;
      };
      runtime: {
        terminalWsPort: string | null;
        mongoUriConfigured: boolean;
        managedMongo: boolean;
      };
      secrets: Array<{
        key: string;
        label: string;
        group: string;
        configured: boolean;
        source: 'secret' | 'config' | 'missing';
      }>;
    }>('/system/desktop-runtime'),
  desktopRuntimeSettings: () =>
    request<DesktopRuntimeSettingsResponse>('/system/desktop-runtime/settings'),
  updateDesktopRuntimeSettings: (values: Record<string, string | boolean | number | null>) =>
    request<DesktopRuntimeSettingsResponse>(
      '/system/desktop-runtime/settings',
      { method: 'PATCH', body: JSON.stringify({ values }) },
    ),
  saveDesktopOnboardingModelDefaults: (body: {
    chatProvider: 'codex' | 'claude' | (string & {});
    agentProvider: '' | 'codex' | 'claude' | (string & {});
    agentModel?: string;
  }) =>
    request<{
      chatProvider: 'codex' | 'claude' | (string & {});
      agentProvider: '' | 'codex' | 'claude' | (string & {});
      agentModel: string;
      settings: DesktopRuntimeSettingsResponse;
    }>('/system/desktop-runtime/onboarding/model-defaults', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  setupDesktopCogneeContext: (provider: 'cognee' | 'cognee_memory' = 'cognee') =>
    request<{
      setup: DesktopRuntimeSettingsResponse['contextSetup'];
      output: string[];
      settings: DesktopRuntimeSettingsResponse;
    }>('/system/desktop-runtime/context/cognee/setup', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
  setDesktopSecret: (key: string, value: string) =>
    request<{ key: string; configured: boolean; source: 'secret' }>(
      '/system/desktop-runtime/secrets',
      { method: 'PUT', body: JSON.stringify({ key, value }) },
    ),
  recheckProviderAuth: (provider: string) =>
    request<{ provider: string; authStatus: 'logged_in' | 'not_logged_in' | 'cli_missing'; loginCommand?: string }>(
      `/system/providers/${encodeURIComponent(provider)}/recheck-auth`,
      { method: 'POST' },
    ),
  deleteDesktopSecret: (key: string) =>
    request<void>(`/system/desktop-runtime/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  verifySsh: (host = 'github.com') =>
    request<{
      ok: boolean;
      host: string;
      detail: string;
      fix?: { summary: string; commands?: string[]; docsPath?: string };
    }>('/system/verify-ssh', {
      method: 'POST',
      body: JSON.stringify({ host }),
    }),
  onboardingProgress: () =>
    request<{
      complete: boolean;
      skipped: boolean;
      step: 'health' | 'model_defaults' | 'repository' | 'first_workflow' | 'complete';
      completedAt: string | null;
      skippedAt: string | null;
    }>('/system/onboarding-progress'),
  updateOnboardingProgress: (body: {
    step?: 'health' | 'model_defaults' | 'repository' | 'first_workflow' | 'complete';
    action?: 'complete' | 'skip';
  }) =>
    request<{
      complete: boolean;
      skipped: boolean;
      step: 'health' | 'model_defaults' | 'repository' | 'first_workflow' | 'complete';
      completedAt: string | null;
      skippedAt: string | null;
    }>('/system/onboarding-progress', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  models: {
    list: (params?: { includeInactive?: boolean; provider?: string }) => {
      const qs = new URLSearchParams();
      if (params?.includeInactive) qs.set('includeInactive', 'true');
      if (params?.provider) qs.set('provider', params.provider);
      const q = qs.toString();
      return request<{ models: ModelRegistryEntry[] }>(`/system/models${q ? `?${q}` : ''}`);
    },
    get: (id: string) => request<ModelRegistryEntry>(`/system/models/${id}`),
    create: (data: Record<string, unknown>) =>
      request<ModelRegistryEntry>('/system/models', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<ModelRegistryEntry>(`/system/models/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/system/models/${id}`, { method: 'DELETE' }),
  },
};

// ── Linear Types ──────────────────────────────────────────────────────────
export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  priority: number;
  priorityLabel: string;
  state: {
    id: string;
    name: string;
    type: string;
    color: string;
  };
}

// ── Linear ────────────────────────────────────────────────────────────────
export const linear = {
  status: (signal?: AbortSignal) => request<{
    configured: boolean;
    workspaceName?: string;
    workspaceUrlKey?: string;
    error?: string;
  }>('/linear/status', {}, signal),
  projects: () => request<any[]>('/linear/projects'),
  issues: (filters: { projectId?: string; state?: string; q?: string; limit?: number; assignee?: 'me' } = {}, signal?: AbortSignal): Promise<LinearIssueSummary[]> => {
    const qs = new URLSearchParams();
    if (filters.projectId) qs.set('projectId', filters.projectId);
    if (filters.state) qs.set('state', filters.state);
    if (filters.q) qs.set('q', filters.q);
    if (filters.limit) qs.set('limit', String(filters.limit));
    if (filters.assignee === 'me') qs.set('assignee', 'me');
    const query = qs.toString();
    return request<LinearIssueSummary[]>(`/linear/issues${query ? `?${query}` : ''}`, {}, signal);
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

// ── Self-Healing Monitoring ───────────────────────────────────────────────
export const monitoring = {
  incidents: (filters: { status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (filters.status) qs.set('status', filters.status);
    if (filters.limit) qs.set('limit', String(filters.limit));
    const query = qs.toString();
    return request<{ incidents: any[] }>(`/monitoring/incidents${query ? `?${query}` : ''}`);
  },
  incident: (id: string) => request<{ incident: any }>(`/monitoring/incidents/${id}`),
  scan: (body: Record<string, unknown> = {}) =>
    request<any>('/monitoring/scan', { method: 'POST', body: JSON.stringify(body) }),
  ticket: (id: string) =>
    request<{ incident: any }>(`/monitoring/incidents/${id}/ticket`, { method: 'POST' }),
  dispatch: (id: string) =>
    request<{ incident: any }>(`/monitoring/incidents/${id}/dispatch`, { method: 'POST' }),
  mark: (id: string, status: 'ignored' | 'suppressed' | 'resolved') =>
    request<{ incident: any }>(`/monitoring/incidents/${id}/${status}`, { method: 'POST' }),
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

// ── Context Quality (Judge / Review / Remediation) ───────────────────────────

export const contextQuality = {
  // Judge Runs
  listJudgeRuns: (params: { scope?: string; status?: string; active?: boolean; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<JudgeRunDoc[]>(`/context/quality/judge-runs${qs.toString() ? '?' + qs : ''}`);
  },
  createJudgeRun: (body: Record<string, unknown>) =>
    request<JudgeRunDoc>('/context/quality/judge-runs', { method: 'POST', body: JSON.stringify(body) }),
  getJudgeRun: (id: string) => request<JudgeRunDoc>(`/context/quality/judge-runs/${id}`),
  rejudge: (id: string) =>
    request<JudgeRunDoc>(`/context/quality/judge-runs/${id}/rejudge`, { method: 'POST' }),

  // Findings
  listFindings: (params: { judgeRunId?: string; scope?: string; status?: string; reliabilityLabel?: string; active?: boolean; learningId?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<FindingDoc[]>(`/context/quality/findings${qs.toString() ? '?' + qs : ''}`);
  },
  getFinding: (id: string) => request<FindingDoc>(`/context/quality/findings/${id}`),
  patchFinding: (id: string, body: Record<string, unknown>) =>
    request<FindingDoc>(`/context/quality/findings/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Review
  getQueues: () => request<Record<string, number>>('/context/quality/review/queues'),
  listQueue: (queue: string, params: { scope?: string; fixType?: string; risk?: string; confidenceBand?: string; sourceType?: string; repoId?: string; severity?: string; classification?: string; status?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<ReviewTaskDoc[]>(`/context/quality/review/queues/${queue}${qs.toString() ? '?' + qs : ''}`);
  },
  listQueuePaged: (queue: string, params: { scope?: string; fixType?: string; risk?: string; confidenceBand?: string; sourceType?: string; repoId?: string; severity?: string; classification?: string; status?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries({ ...params, includeTotal: true }).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<PagedContextQualityResponse<ReviewTaskDoc>>(`/context/quality/review/queues/${queue}?${qs.toString()}`);
  },
  addDecision: (taskId: string, body: { actor: string; action: string; notes?: string; remediationHint?: string }) =>
    request<void>(`/context/quality/review/${taskId}/decisions`, { method: 'POST', body: JSON.stringify(body) }),
  listHistory: (params: { taskId?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<ReviewDecisionDoc[]>(`/context/quality/review/history${qs.toString() ? '?' + qs : ''}`);
  },

  // Remediations
  listRemediations: (params: { taskId?: string; remediationId?: string; status?: string; repoId?: string; targetRepoId?: string; includeAssignments?: boolean; includeRevisions?: boolean; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<RemediationDoc[]>(`/context/quality/remediation-tasks${qs.toString() ? '?' + qs : ''}`);
  },
  listRemediationsPaged: (params: { taskId?: string; remediationId?: string; status?: string; repoId?: string; targetRepoId?: string; includeAssignments?: boolean; includeRevisions?: boolean; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries({ ...params, includeTotal: true }).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<PagedContextQualityResponse<RemediationDoc>>(`/context/quality/remediation-tasks?${qs.toString()}`);
  },
  createRemediation: (body: Record<string, unknown>) =>
    request<RemediationDoc>('/context/quality/remediation-tasks', { method: 'POST', body: JSON.stringify(body) }),
  dispatchRemediation: (id: string) =>
    request<void>(`/context/quality/remediation-tasks/${id}/dispatch`, { method: 'POST' }),

  // Curated Edits
  getCurationHistory: (repoId: string, entryId: string) =>
    request<CurationRevisionDoc[]>(`/context/quality/curated-edits/${encodeURIComponent(repoId)}/${encodeURIComponent(entryId)}/history`),
  applyEdit: (repoId: string, entryId: string, body: Record<string, unknown>) =>
    request<{ revision: CurationRevisionDoc; entry: Record<string, unknown> }>(`/context/quality/curated-edits/${encodeURIComponent(repoId)}/${encodeURIComponent(entryId)}`, { method: 'POST', body: JSON.stringify(body) }),
  revertEdit: (repoId: string, entryId: string, revisionId: string) =>
    request<{ revision: CurationRevisionDoc; entry: Record<string, unknown> }>(`/context/quality/curated-edits/${encodeURIComponent(repoId)}/${encodeURIComponent(entryId)}/revert/${encodeURIComponent(revisionId)}`, { method: 'POST' }),

  // Learning Promotions
  listPromotions: (params: { learningId?: string; decision?: string; status?: string; repoId?: string; remediationStatus?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<LearningPromotionDoc[]>(`/context/quality/learning-promotions${qs.toString() ? '?' + qs : ''}`);
  },
  listPromotionsPaged: (params: { learningId?: string; decision?: string; status?: string; repoId?: string; remediationStatus?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries({ ...params, includeTotal: true }).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<PagedContextQualityResponse<LearningPromotionDoc>>(`/context/quality/learning-promotions?${qs.toString()}`);
  },
  createPromotion: (body: Record<string, unknown>) =>
    request<LearningPromotionDoc>('/context/quality/learning-promotions', { method: 'POST', body: JSON.stringify(body) }),
  decidePromotion: (id: string, body: { actor: string; decision: string; notes?: string }) =>
    request<LearningPromotionDoc>(`/context/quality/learning-promotions/${id}/decisions`, { method: 'POST', body: JSON.stringify(body) }),

  // Split cross-repo task
  splitTask: (taskId: string, body: { repoIds: string[] }) =>
    request<ReviewTaskDoc[]>(`/context/quality/review/${taskId}/split`, { method: 'POST', body: JSON.stringify(body) }),

  // Worker assignments
  listWorkerAssignments: (params: { status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<WorkerAssignmentDoc[]>(`/context/quality/worker-assignments${qs.toString() ? '?' + qs : ''}`);
  },
  createWorkerAssignment: (body: { maxBatch?: number; workerAgentName?: string; workerRole?: string }) =>
    request<{ assigned: number; assignments: WorkerAssignmentDoc[] }>('/context/quality/worker-assignments', { method: 'POST', body: JSON.stringify(body) }),
  dispatchWorkerAssignment: (assignmentId: string) =>
    request<{ dispatched: boolean; queuedRecord?: Record<string, unknown> }>(`/context/quality/worker-assignments/${assignmentId}/dispatch`, { method: 'POST' }),

  // Config
  getConfig: () => request<Record<string, unknown>>('/context/quality/config'),
  patchConfig: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/context/quality/config', { method: 'PATCH', body: JSON.stringify(body) }),

  // Orchestrator trigger / runs
  triggerOrchestrator: (body: { repoId?: string; repoIds?: string[]; global?: boolean; triggeredBy?: string }) =>
    request<{ runId: string; status: string; triggeredBy: string; global: boolean; repoId?: string; triggeredAt: string }>('/context/quality/orchestrator/trigger', { method: 'POST', body: JSON.stringify(body) }),
  listOrchestratorRuns: (params: { status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.append('status', params.status);
    if (params.limit) qs.append('limit', String(params.limit));
    return request<Array<{ runId: string; status: string; triggeredBy: string; global: boolean; repoId?: string; triggeredAt: string; completedAt?: string }>>(`/context/quality/orchestrator/runs${qs.toString() ? '?' + qs : ''}`);
  },
};

// ── Context Judge Orchestrator ────────────────────────────────────────────────

export const contextJudgeOrchestrator = {
  listSessions: (params: { scope?: string; status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && qs.set(k, String(v)));
    return request<OrchestrationSessionDoc[]>(`/context/quality/orchestrator/sessions${qs.toString() ? '?' + qs : ''}`);
  },
  beginSession: (body: { agentModel?: string; agentProvider?: string; agentRationale?: string; scope: string; sourceId?: string; sourceKind?: string; repoId?: string }) =>
    request<OrchestrationSessionDoc>('/context/quality/orchestrator/sessions', { method: 'POST', body: JSON.stringify(body) }),
  getSession: (sessionId: string) =>
    request<OrchestrationSessionDoc>(`/context/quality/orchestrator/sessions/${sessionId}`),
  logDecision: (sessionId: string, body: { kind: string; detail: string; metadata?: Record<string, unknown> }) =>
    request<void>(`/context/quality/orchestrator/sessions/${sessionId}/decisions`, { method: 'POST', body: JSON.stringify(body) }),
  submitFindings: (sessionId: string, body: { findings: Record<string, unknown>[] }) =>
    request<{ judgeRunId: string; findingIds: string[]; reviewTaskIds: string[] }>(`/context/quality/orchestrator/sessions/${sessionId}/findings`, { method: 'POST', body: JSON.stringify(body) }),
  finalizeSession: (sessionId: string, summary?: string) =>
    request<OrchestrationSessionDoc>(`/context/quality/orchestrator/sessions/${sessionId}/finalize`, { method: 'POST', body: JSON.stringify({ summary }) }),
};
