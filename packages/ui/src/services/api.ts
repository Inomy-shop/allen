import { BASE, authHeaders, encodeFilePath, request } from './apiCore';

export { authHeaders, request } from './apiCore';

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
  exportJson: (ids: string[] = []) =>
    request<any>('/workflows/export', { method: 'POST', body: JSON.stringify({ ids }) }),
  importJson: (bundle: any) =>
    request<{ created: string[]; skipped: { name: string; reason: string }[] }>('/workflows/import/json', {
      method: 'POST',
      body: JSON.stringify(bundle),
    }),
  ensureDefaults: (names: string[]) =>
    request<any[]>('/workflows/ensure-defaults', { method: 'POST', body: JSON.stringify({ names }) }),
};

// ── Skills ────────────────────────────────────────────────────────────────
export interface SkillRecord {
  _id?: string;
  id?: string;
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  triggers?: string[];
  excludes?: string[];
  priority?: number;
  enabled?: boolean;
  allowedRoutes?: string[];
  relatedWorkflows?: string[];
  relatedAgents?: string[];
  body?: string;
  tags?: string[];
  version?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export const skills = {
  list: (includeDisabled = true) =>
    request<SkillRecord[]>(`/skills?includeDisabled=${includeDisabled ? 'true' : 'false'}`),
  get: (idOrName: string) => request<SkillRecord>(`/skills/${idOrName}`),
  create: (body: Partial<SkillRecord>) =>
    request<SkillRecord>('/skills', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<SkillRecord>) =>
    request<SkillRecord>(`/skills/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<void>(`/skills/${id}`, { method: 'DELETE' }),
  validate: (body: Partial<SkillRecord>) =>
    request<{ valid: boolean; errors: string[]; warnings: string[] }>('/skills/validate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  search: (body: { query: string; context?: Record<string, unknown>; limit?: number; includeDisabled?: boolean }) =>
    request<{ query: string; matches: Array<SkillRecord & { score: number; confidence: number; matched: string[] }> }>('/skills/search', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── Executions ─────────────────────────────────────────────────────────────

export type RunPhase =
  | 'queued'
  | 'planning'
  | 'inspecting'
  | 'editing'
  | 'testing'
  | 'reviewing'
  | 'opening_pr'
  | 'waiting_for_human'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TokenUsageInfo {
  inputCachedTokens: number | null;
  inputNonCachedTokens: number | null;
  outputTokens: number | null;
}

export interface RunStatus {
  origin: 'chat' | 'linear' | 'workflow' | 'direct_agent';
  runType: 'workflow' | 'agent';
  title: string;
  status: string;
  chat?: {
    sessionId?: string | null;
    parentMessageId?: string | null;
    title?: string | null;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
  } | null;
  io?: {
    input?: string | null;
    output?: string | null;
  } | null;
  execution: {
    id: string;
    workflowId?: string | null;
    workflowName: string;
    status: string;
    revision?: number;
    runGeneration?: number;
    updatedAt?: string;
    source?: string | null;
    startedAt?: string;
    completedAt?: string | null;
    durationMs?: number | null;
    /** Tree total (own + all spawned/nested descendants), computed on demand
     *  by the server from execution_traces. */
    cost?: { actual: number | null; estimated: number } | null;
    /** This execution's own traces only (no descendants). */
    costOwn?: { actual: number | null; estimated: number } | null;
    /** Executions in the rolled-up tree (1 = no children). */
    costTreeSize?: number;
    /** Per-(provider, model) breakdown across the tree. */
    costByModel?: Array<{
      provider: string;
      model: string;
      costUsd: number;
      estimatedUsd: number;
      inputCachedTokens: number;
      inputNonCachedTokens: number;
      outputTokens: number;
      llmCalls: number;
    }>;
    tokenUsage?: TokenUsageInfo | null;
    currentNodes?: string[];
    completedNodes?: string[];
    failedNode?: string | null;
    errorMessage?: string | null;
    isAgentExecution?: boolean;
    parentExecutionId?: string | null;
    rootExecutionId?: string | null;
    spawnDepth?: number | null;
    contextWorkflowEvaluation?: {
      jobId?: string;
      provider?: string;
      mode?: string;
      status?: string;
      attempts?: number;
      maxAttempts?: number;
      stale?: boolean;
      staleReason?: string;
      latestWorkflowChangeAt?: string | null;
      evaluatedAt?: string | null;
      completedAt?: string | null;
      error?: string;
      audit?: {
        promptPreview?: string;
        promptChars?: number;
        promptSha256?: string;
        evidencePayload?: Record<string, unknown>;
        packedEvidencePayload?: Record<string, unknown>;
        evidenceTruncated?: boolean;
        evidenceStats?: Record<string, unknown>;
        rawJudgeResponse?: string;
        judgeProvider?: string;
        judgeModel?: string;
        judgeDurationMs?: number;
        judgeCostUsd?: number;
      };
      result?: {
        status?: string;
        scores?: Record<string, number>;
        summary?: string;
        diagnostics?: Array<{ code?: string; severity?: string; message?: string }>;
        nodeFindings?: Array<{
          executionId?: string;
          nodeName?: string;
          attempt?: number;
          source?: string;
          fallbackReason?: string;
          identityNormalized?: boolean;
          status?: string;
          scores?: Record<string, number>;
          summary?: string;
        }>;
        evaluationCoverage?: {
          expectedNodeFindings?: number;
          returnedNodeFindings?: number;
          fallbackNodeFindings?: number;
          missingNodeFindings?: Array<{ executionId?: string; nodeName?: string; attempt?: number; reason?: string }>;
        };
      };
    } | null;
  };
  progress: {
    completed: number;
    total: number;
    percent: number;
    label: string;
    currentStep: string | null;
    phase: RunPhase;
  };
  humanInput: {
    required: boolean;
    interventionId?: string;
    title?: string;
    stage?: string;
    severity?: string;
  };
  linear: {
    issueId?: string;
    identifier?: string;
    title?: string;
    url?: string;
    assignment?: Record<string, unknown> | null;
  } | null;
  workspace: {
    id?: string;
    name?: string | null;
    status?: string | null;
    repoId?: string | null;
    repoName?: string | null;
    branch?: string | null;
    baseBranch?: string | null;
    worktreePath?: string | null;
    prUrl?: string | null;
  } | null;
  pullRequest: {
    id?: string;
    number?: number | null;
    title?: string | null;
    url?: string | null;
    status?: string | null;
    branch?: string | null;
    baseBranch?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    mergedAt?: string | null;
  } | null;
  childAgents: Array<{
    executionId: string;
    agentName: string;
    status: string;
    currentStep?: string | null;
    durationMs?: number | null;
    cost?: { actual: number | null; estimated: number } | null;
    tokenUsage?: TokenUsageInfo | null;
    errorMessage?: string | null;
  }>;
  workflowSteps: Array<{
    id: string;
    name: string;
    index: number;
    type?: string | null;
    agent?: string | null;
    status: string;
    attempts: number;
    retryReasons?: string[];
    model?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    durationMs?: number | null;
    cost?: { actual: number | null; estimated: number } | null;
    tokenUsage?: TokenUsageInfo | null;
    error?: string | null;
    io?: {
      input?: string | null;
      output?: string | null;
    } | null;
  }>;
  interventions: Record<string, unknown>[];
  artifacts: Array<{
    artifactId: string;
    filename?: string | null;
    relativePath?: string | null;
    url?: string | null;
    contentType?: string | null;
    description?: string | null;
    rootType?: string | null;
    rootId?: string | null;
    spawnContext?: {
      originType?: string | null;
      parentId?: string | null;
      nodeName?: string | null;
      agentName?: string | null;
      agentExecutionId?: string | null;
    } | null;
    createdAt?: string | null;
  }>;
  recentActivity: Array<{
    type: string;
    label: string;
    agent?: string;
    tool?: string | null;
    at?: string | null;
    source?: string;
  }>;
}

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
  cost: { actual: number | null; estimated: number; method?: string } | null;
  tokenUsage?: TokenUsageInfo | null;
  /** Model/provider the child agent ran on (from execution meta). */
  model?: string | null;
  provider?: string | null;
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
    includeTotal?: boolean;
    enrich?: boolean;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.workflowId) qs.set('workflowId', params.workflowId);
    if (params.workflowName) qs.set('workflowName', params.workflowName);
    if (params.type) qs.set('type', params.type);
    if (params.search) qs.set('search', params.search);
    if (params.includeTotal) qs.set('includeTotal', 'true');
    if (params.enrich) qs.set('enrich', 'true');
    qs.set('limit', String(params.limit ?? 50));
    qs.set('offset', String(params.offset ?? 0));
    return request<{ items: any[]; total?: number }>(`/executions?${qs.toString()}`);
  },
  count: (params: { status?: string | string[]; chatSession?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (Array.isArray(params.status)) qs.set('status', params.status.join(','));
    else if (params.status) qs.set('status', params.status);
    if (params.chatSession) qs.set('chatSession', 'true');
    return request<{ count: number }>(`/executions/count${qs.toString() ? `?${qs.toString()}` : ''}`);
  },
  get: (id: string) => request<any>(`/executions/${id}`),
  snapshot: (id: string) => request<import('../stores/executionStore').ExecutionSnapshot>(`/executions/${id}/snapshot`),
  forChat: (sessionId: string) => request<Array<{
    executionId: string;
    sourceMessageId?: string | null;
    agent?: string | null;
    prompt?: string | null;
    status?: string | null;
    kind?: 'agent' | 'lead' | 'workflow';
    runContext?: RunStatus | null;
  }>>(`/executions/chat/${sessionId}`),
  context: (id: string) => request<RunStatus>(`/executions/${id}/context`),
  contextUsage: (id: string, params?: { view?: 'summary' | 'full' | 'normalized'; refresh?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.view) qs.set('view', params.view);
    if (params?.refresh) qs.set('refresh', 'true');
    return request<any>(`/executions/${id}/context-usage${qs.toString() ? `?${qs.toString()}` : ''}`);
  },
  start: (
    workflowId: string,
    input: Record<string, unknown>,
    options?: { agentProvider?: 'claude' | 'codex'; runtimeModel?: Record<string, unknown> },
  ) =>
    request<any>('/executions', {
      method: 'POST',
      body: JSON.stringify({
        workflowId,
        input,
        ...(options?.agentProvider ? { agentProvider: options.agentProvider } : {}),
        ...(options?.runtimeModel ? { runtimeModel: options.runtimeModel } : {}),
      }),
    }),
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
  rerunWorkflowContextEvaluation: (id: string) =>
    request<any>(`/executions/${id}/context-evaluation/workflow/rerun`, { method: 'POST' }),
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
  logs: (id: string, params?: Record<string, string | number | boolean>) => {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString() : '';
    return request<any[]>(`/executions/${id}/logs${qs}`);
  },
  logsPage: (id: string, params?: Record<string, string | number | boolean>) => {
    const merged = { ...(params ?? {}), page: true };
    const qs = '?' + new URLSearchParams(Object.entries(merged).map(([key, value]) => [key, String(value)])).toString();
    return request<{ items: any[]; limit: number; offset: number; hasMore: boolean }>(`/executions/${id}/logs${qs}`);
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
  /** Recover a failed node by retrying with a different provider/model. */
  recoverModel: (executionId: string, body: { node: string; provider: string; model: string; reasoningEffort?: string }) =>
    request<{ executionId: string; node: string; status: string; recoveryAttempt: number; selectedProvider: string; selectedModel: string; action: string }>(
      `/executions/${executionId}/recover-model`, { method: 'POST', body: JSON.stringify(body) },
    ),
  streamUrl: (id: string) => `${BASE}/executions/${id}/stream`,
};

// ── Agent Activity (shared shape) ─────────────────────────────────────────
// Row shape returned by agent activity routes.
// See packages/server/src/services/agent-activity.service.ts PersistedActivityRow.
export interface ActivityEvent {
  id: string;
  scope: 'execution';
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
export type BulkModelSkipped = {
  name: string;
  reason: 'not-found' | 'incompatible-settings';
  code?: string;
  message?: string;
};

export type BulkUpdateModelRequest = {
  agentNames: string[];
  provider: string;
  model: string;
  clearIncompatibleSettings?: boolean;
};

export type BulkUpdateModelResponse = {
  updated: string[];
  skipped: BulkModelSkipped[];
};

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
  exportJson: (agentNames: string[] = []) =>
    request<any>('/agents/export', { method: 'POST', body: JSON.stringify({ agentNames }) }),
  importJson: (bundle: any) =>
    request<{
      created: string[];
      skipped: { name: string; reason: string }[];
      createdTeams: string[];
      skippedTeams: { name: string; reason: string }[];
    }>('/agents/import/json', { method: 'POST', body: JSON.stringify(bundle) }),
  resync: (name: string) =>
    request<any>(`/agents/${name}/resync`, { method: 'POST' }),
  moveToTeam: (name: string, teamName: string, teamRole: 'lead' | 'member' = 'member') =>
    request<any>(`/agents/${name}/team`, {
      method: 'PATCH',
      body: JSON.stringify({ teamName, teamRole }),
    }),
  bulkAssignTeam: (agentNames: string[], teamName: string, autoWireSpawnTargets = true) =>
    request<{ moved: string[]; skipped: { name: string; reason: string }[] }>(
      '/agents/bulk-team',
      {
        method: 'POST',
        body: JSON.stringify({ agentNames, teamName, autoWireSpawnTargets }),
      },
    ),
  bulkUpdateModel: (body: BulkUpdateModelRequest) =>
    request<BulkUpdateModelResponse>(
      '/agents/bulk-model',
      {
        method: 'POST',
        body: JSON.stringify(body),
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
    autoWireSpawnTargets?: boolean;
  }) =>
    request<any>('/teams/with-members', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (name: string, team: any) =>
    request<any>(`/teams/${name}`, { method: 'PUT', body: JSON.stringify(team) }),
  delete: (name: string, options?: { deleteAgents?: boolean }) =>
    request<{ deletedAgents: string[] }>(`/teams/${name}`, {
      method: 'DELETE',
      body: JSON.stringify(options ?? {}),
    }),
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
    action_id?: string;
    field_values?: Record<string, unknown>;
    feedback?: string;
    scope?: 'requirements' | 'architecture' | 'technical_design' | 'all' | null;
    answer?: string;
    answered_by_user_id?: string;
    human_node_name?: string;
    retry_target_override?: string;
    source?: 'chat' | 'execution_page' | 'interventions_page';
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
  validateLocal: (path: string) =>
    request<any>('/repos/validate-local', { method: 'POST', body: JSON.stringify({ path }) }),
  validateClone: (body: { url: string; branch?: string; name?: string }) =>
    request<any>('/repos/validate-clone', { method: 'POST', body: JSON.stringify(body) }),
  clone: (body: { url: string; branch?: string; name?: string; description?: string; tags?: string[] }) =>
    request<any>('/repos/clone', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: any) =>
    request<any>(`/repos/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<void>(`/repos/${id}`, { method: 'DELETE' }),
  updateDefaultBranch: (id: string, defaultBranch: string) =>
    request<any>(`/repos/${id}/default-branch`, {
      method: 'PUT',
      body: JSON.stringify({ defaultBranch }),
    }),
  scan: (id: string) =>
    request<any>(`/repos/${id}/scan`, { method: 'POST' }),
  pull: (id: string, rescan = false) =>
    request<any>(`/repos/${id}/pull`, { method: 'POST', body: JSON.stringify({ rescan }) }),
  getCogneeStatus: (id: string) =>
    request<any>(`/repos/${id}/cognee`),
  refreshCognee: (id: string, options?: { cleanRebuild?: boolean }) =>
    request<any>(`/repos/${id}/cognee/refresh`, { method: 'POST', body: JSON.stringify({ pullLatest: false, cleanRebuild: options?.cleanRebuild === true }) }),
  stopCognee: (id: string) =>
    request<any>(`/repos/${id}/cognee/stop`, { method: 'POST' }),
  getContextManagement: (id: string) =>
    request<any>(`/repos/${id}/context-management`),
  runContextPlayground: (id: string, body: Record<string, unknown>) =>
    request<any>(`/repos/${id}/context-management/playground`, { method: 'POST', body: JSON.stringify(body) }),
  getContextGraph: (id: string, params: Record<string, string | number | undefined> = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') search.set(key, String(value));
    });
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return request<any>(`/repos/${id}/context-management/graph${suffix}`);
  },
  getContextGraphNode: (id: string, nodeId: string, params: Record<string, string | number | boolean | undefined> = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') search.set(key, String(value));
    });
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return request<any>(`/repos/${id}/context-management/graph/nodes/${encodeURIComponent(nodeId)}${suffix}`);
  },
  createCuratedContextEntry: (id: string, body: Record<string, unknown>) =>
    request<any>(`/repos/${id}/context-management/entries`, { method: 'POST', body: JSON.stringify(body) }),
  updateCuratedContextEntry: (id: string, entryId: string, body: Record<string, unknown>) =>
    request<any>(`/repos/${id}/context-management/entries/${encodeURIComponent(entryId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCuratedContextEntry: (id: string, entryId: string) =>
    request<any>(`/repos/${id}/context-management/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),
  bulkDeleteCuratedContextEntries: (id: string, entryIds: string[]) =>
    request<any>(`/repos/${id}/context-management/entries/bulk-delete`, { method: 'POST', body: JSON.stringify({ entryIds }) }),
  bulkDeleteMandatoryMappings: (id: string, mappingIds: string[]) =>
    request<any>(`/repos/${id}/context-management/mandatory/bulk-delete`, { method: 'POST', body: JSON.stringify({ mappingIds }) }),
  saveMandatoryContext: (id: string, body: Record<string, unknown>) =>
    request<any>(`/repos/${id}/context-management/mandatory`, { method: 'POST', body: JSON.stringify(body) }),
  updateMandatoryContext: (id: string, mappingId: string, body: Record<string, unknown>) =>
    request<any>(`/repos/${id}/context-management/mandatory/${encodeURIComponent(mappingId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getAllFiles: (id: string) => request<any[]>(`/repos/${id}/all-files`),
  getFile: (id: string, path: string) => request<any>(`/repos/${id}/file/${encodeFilePath(path)}`),
  context: (id: string) =>
    request<any>(`/repos/${id}/context`),
  rescanContext: (id: string) =>
    request<any>(`/repos/${id}/rescan-context`, { method: 'POST' }),
  cancelScan: (id: string) =>
    request<any>(`/repos/${id}/scan/cancel`, { method: 'POST' }),
  getMandatoryMappings: (id: string, params?: { enabled?: 'true' | 'false' | 'all' }) => {
    const search = new URLSearchParams();
    search.set('enabled', params?.enabled ?? 'true');
    return request<any[]>(`/repos/${id}/context-management/mandatory?${search.toString()}`);
  },
  contextSetup: {
    start: (id: string, body?: Record<string, unknown>) =>
      request<any>(`/repos/${id}/context-setup`, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
    current: (id: string) =>
      request<any>(`/repos/${id}/context-setup`),
    history: (id: string) =>
      request<any>(`/repos/${id}/context-setup/runs`),
    get: (id: string, runId: string) =>
      request<import('../hooks/useRepoContextSetup').SetupDetailResponse>(`/repos/${id}/context-setup/${runId}`),
    cancel: (id: string, runId: string) =>
      request<any>(`/repos/${id}/context-setup/${runId}/cancel`, { method: 'POST' }),
    resume: (id: string, runId: string) =>
      request<any>(`/repos/${id}/context-setup/${runId}/resume`, { method: 'POST' }),
  },
  previewContextExport: (id: string) =>
    request<any>(`/repos/${id}/context-management/export/preview`),
  exportContext: (id: string) =>
    request<unknown>(`/repos/${id}/context-management/export`),
  previewContextImport: (id: string, body: { package: unknown }) =>
    request<any>(`/repos/${id}/context-management/import/preview`, { method: 'POST', body: JSON.stringify(body) }),
  applyContextImport: (id: string, body: { package: unknown; confirmRepoNameMismatch?: boolean }) =>
    request<any>(`/repos/${id}/context-management/import`, { method: 'POST', body: JSON.stringify(body) }),
};

// ── Dashboard ──────────────────────────────────────────────────────────────
export type UsageSource = 'chat' | 'workflow' | 'agent';

export interface UsageBucket {
  provider: string;
  model: string;
  costUsd: number;
  inputCachedTokens: number;
  inputNonCachedTokens: number;
  outputTokens: number;
  llmCalls: number;
  bySource: Record<UsageSource, { costUsd: number; llmCalls: number }>;
}

export interface UsageReport {
  computedAt: string;
  range: { from: string; to: string };
  totals: {
    costUsd: number;
    inputCachedTokens: number;
    inputNonCachedTokens: number;
    outputTokens: number;
    llmCalls: number;
  };
  byProviderModel: UsageBucket[];
  bySource: Record<UsageSource, { costUsd: number; llmCalls: number }>;
  series: Array<{ bucket: string; costUsd: number; llmCalls: number }>;
  seriesUnit: 'hour' | 'day';
  stale: boolean;
}

export type UsageRangeParams = { range: 'today' | '7d' | '30d' } | { from: string; to: string };

const usageQuery = (params: UsageRangeParams): string =>
  'range' in params
    ? `range=${params.range}`
    : `from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`;

export const usage = {
  get: (params: UsageRangeParams) => request<UsageReport>(`/usage?${usageQuery(params)}`),
  refresh: (params: UsageRangeParams) =>
    request<UsageReport>('/usage/refresh', { method: 'POST', body: JSON.stringify(params) }),
};

export const dashboard = {
  stats: () => request<any>('/dashboard/stats'),
  cost: () => request<any>('/dashboard/cost'),
  navCounts: () => request<{
    mywork: number;
    inbox: number;
    threads: number;
    tickets: number;
    pulls: number;
    workspaces: number;
    activity: number;
    learnings: number;
  }>('/dashboard/nav-counts'),
};

// ── Chat ──────────────────────────────────────────────────────────────────
export interface ChatSession {
  _id: string;
  title: string;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt: string;
  totalCostUsd: number;
  provider: string;
  model?: string;
  llmSessionId?: string;
  activeAgent?: string | null;
  agentOverrides?: {
    provider?: 'claude' | 'codex' | null;
    model?: string | null;
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
    planMode?: boolean | null;
  };
  repoId?: string;
  repoPath?: string;
  repoName?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRepoId?: string;
  workspaceRepoName?: string;
  workspaceBranch?: string;
  workspaceBaseBranch?: string;
  workspacePrNumber?: number;
  workspacePrUrl?: string;
  streaming?: boolean;
  archivedWorkspace?: {
    id: string;
    name?: string;
    repoId?: string;
    repoName?: string;
    repoPath?: string;
    branch?: string;
    baseBranch?: string;
    prNumber?: number;
    prUrl?: string;
    archivedAt?: string;
  };
  source?: 'ui' | 'slack';
  slackContext?: {
    channelId: string;
    threadTs: string;
    teamId: string;
  };
  automationKey?: string;
  createdAt?: string;
  updatedAt?: string;
  ownerUserId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
}

export interface ChatQueueItem {
  _id?: string;
  id: string;
  sessionId: string;
  content: string;
  agent?: string | null;
  cwd?: string | null;
  status: 'queued' | 'editing' | 'running' | 'sent' | 'failed' | 'cancelled';
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const chat = {
  listSessions: (params?: { ownerUserId?: string | 'none' }) => {
    const qs = params?.ownerUserId
      ? `?ownerUserId=${encodeURIComponent(params.ownerUserId)}`
      : '';
    return request<ChatSession[]>(`/chat/sessions${qs}`);
  },
  providers: () => request<any[]>('/chat/providers'),
  slashCommands: (params?: { provider?: string; sessionId?: string; cwd?: string }) => {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => Boolean(v)) as Array<[string, string]>).toString() : '';
    return request<any[]>(`/chat/slash-commands${qs}`);
  },
  createSession: (provider?: string, model?: string, agentOverrides?: Record<string, unknown>, repoId?: string, workspaceId?: string) =>
    request<any>('/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({
        provider,
        model,
        ...(agentOverrides ? { agentOverrides } : {}),
        ...(repoId ? { repoId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      }),
    }),
  getSession: (id: string) => request<any>(`/chat/sessions/${id}`),
  getMessages: (id: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/chat/sessions/${id}/messages${qs}`);
  },
  sendMessageUrl: (id: string) => `${BASE}/chat/sessions/${id}/messages`,
  streamUrl: (id: string) => `${BASE}/chat/sessions/${id}/stream`,
  isStreaming: (id: string) => request<{ streaming: boolean }>(`/chat/sessions/${id}/streaming`),
  getQueue: (id: string) => request<ChatQueueItem[]>(`/chat/sessions/${id}/queue`),
  enqueueMessage: (id: string, body: { content: string; agent?: string | null; cwd?: string | null }) =>
    request<ChatQueueItem>(`/chat/sessions/${id}/queue`, { method: 'POST', body: JSON.stringify(body) }),
  steerExecution: (id: string, body: { content: string }) =>
    request<{ steered?: boolean; queued?: boolean; messageId?: string; item?: ChatQueueItem }>(
      `/chat/sessions/${id}/steer`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  updateQueuedMessage: (id: string, queueId: string, body: { content?: string; status?: 'queued' | 'editing' }) =>
    request<ChatQueueItem>(`/chat/sessions/${id}/queue/${queueId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteQueuedMessage: (id: string, queueId: string) =>
    request<void>(`/chat/sessions/${id}/queue/${queueId}`, { method: 'DELETE' }),
  updateSession: (id: string, body: any) =>
    request<any>(`/chat/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  generateTitle: (id: string) =>
    request<{ title: string }>(`/chat/sessions/${id}/generate-title`, { method: 'POST' }),
  deleteSession: (id: string) =>
    request<void>(`/chat/sessions/${id}`, { method: 'DELETE' }),
  getContextUsage: (id: string) =>
    request<any>(`/chat/sessions/${id}/context-usage`),
  answerAgentQuestion: (id: string, answer: string) =>
    request<any>(`/chat/sessions/${id}/agent-answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
  logs: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any[]>(`/chat/logs${qs}`);
  },
  // ── Export / Import ──────────────────────────────────────────────────────
  exportOptions: (id: string) =>
    request<{ messageCount: number; toolCallCount: number; executionCount: number; descendantExecutionCount: number; chatLogCount: number; traceCount: number; artifactCount: number; codeDiffCount: number; estimatedSizeBytes: number; warnings: string[]; }>(`/chat/sessions/${id}/export-options`),
  exportChat: async (id: string, options: Record<string, unknown>): Promise<Blob> => {
    const res = await fetch(`${BASE}/chat/sessions/${id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(options),
    });
    if (!res.ok) {
      const text = await res.text();
      try { throw Object.assign(new Error('Export failed'), JSON.parse(text)); }
      catch { throw new Error(text || res.statusText); }
    }
    return await res.blob();
  },
  getExportBundle: (id: string) => `${BASE}/chat/sessions/${id}/export-bundle`,
  importPreview: (bundle: object) =>
    request<{ valid: true; bundleId: string; preview: any }>('/chat/import/preview', { method: 'POST', body: JSON.stringify({ bundle }) }),
  importConfirm: (bundleId: string) =>
    request<{ imported: true; sessionId: string; session: any; remappedCounts: any }>('/chat/import/confirm', { method: 'POST', body: JSON.stringify({ bundleId }) }),
};

// ── Execution Watchers ──────────────────────────────────────────────────────
export type WatcherExecutionState = 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';
export type WatcherExecutionType = 'workflow' | 'agent' | 'lead';
export interface WatcherUIDoc {
  watcherId: string;
  executionId: string;
  executionType: WatcherExecutionType;
  watcherStatus: 'active' | 'waiting' | 'resolved' | 'replaced';
  executionState: WatcherExecutionState;
  triggerSentForState: string | null;
  latestStatusText: string;
  lastCheckedAt: string;
  updateSeq: number;
}

export const executionWatchers = {
  list: (chatSessionId: string) =>
    request<WatcherUIDoc[]>(`/execution-watchers?chatSessionId=${encodeURIComponent(chatSessionId)}`),
  get: (executionId: string) =>
    request<WatcherUIDoc>(`/execution-watchers/${executionId}`),
};

export * from './apiSecondary';
