import { randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { logger } from '../logger.js';
import {
  AllenEngine,
  StateManager,
  loadAgents,
  getBuiltIns,
  type WorkflowDef,
  type EngineConfig,
  type ExecutionState,
  type WorkflowFeedbackEntry,
  aggregateTokenUsage,
  type TokenUsageInfo,
  type ModelCostInfo,
} from '@allen/engine';
import { createSSEEmitter } from './stream.service.js';
import {
  InterventionService,
  type InterventionSeverity,
  type InterventionDocLink,
  type InterventionField,
} from './intervention.service.js';
import type { AgentDef } from '@allen/engine';
import { WorkspaceManager } from './workspace.service.js';
import { ArtifactService } from './artifact.service.js';
import { CostRollupService } from './cost-rollup.service.js';
import { MonitoringService } from './self-healing-monitor.service.js';
import { assertSelfHealingLinearConfig, isSelfHealingWorkflowName } from './self-healing-env.js';
import { AgentActivityService, type PersistedActivityRow } from './agent-activity.service.js';
import { RepoContextPacketService } from './context/core/repo-context-packet.service.js';
import { ContextEvaluationService } from './context/evaluation/context-evaluation.service.js';
import { ContextWorkflowEvaluationService } from './context/evaluation/context-workflow-evaluation.service.js';
import { hydrateTraceContextEvaluations } from './context/evaluation/context-evaluation-trace-hydrator.js';
import { isContextEngineEnabled } from './context/config/context-provider-config.js';
import { buildClaudeCompatibleEnvOverlay } from './chat-providers.js';
import { resolveClaudeCodeExecutable } from './claude-code-executable.js';

/**
 * Build the in-process service hook bundle the engine passes to built-ins.
 * Lets built-ins like `create-workspace` invoke server-side infra (Mongo +
 * filesystem operations) without looping back through /api, which would
 * fail the `requireAuth` middleware. Same process, same DB, no HTTP hop.
 */
function buildEngineServices(db: Db): EngineConfig['services'] {
  const wsManager = new WorkspaceManager(db);
  const artifactService = new ArtifactService(db);
  const repoKnowledge = new RepoContextPacketService(db);
  const services: EngineConfig['services'] = {
    workspaces: {
      create: async (payload) => {
        const ws = await wsManager.create(payload);
        return ws as unknown as Record<string, unknown>;
      },
      get: async (id) => {
        const ws = await wsManager.get(id);
        return (ws as unknown as Record<string, unknown> | null) ?? null;
      },
    },
    artifacts: {
      save: async (input) => {
        const res = await artifactService.save({
          rootType: input.rootType,
          rootId: input.rootId,
          filename: input.filename,
          content: input.content,
          contentType: input.contentType,
          description: input.description,
          overwrite: input.overwrite,
          spawnContext: input.spawnContext
            ? {
                originType: input.spawnContext.originType,
                nodeName: input.spawnContext.nodeName,
                agentName: input.spawnContext.agentName,
                agentExecutionId: input.spawnContext.agentExecutionId,
                parentId: input.spawnContext.parentId,
              }
            : undefined,
        });
        return { artifactId: res.artifactId, url: res.url };
      },
      listForRoot: async (input) => {
        const docs = await artifactService.list({
          rootType: input.rootType,
          rootId: input.rootId,
          limit: input.limit,
        });
        return docs.map((d) => ({
          artifactId: d.artifactId,
          filename: d.filename,
          relativePath: d.relativePath,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          nodeName: d.spawnContext?.nodeName,
        }));
      },
    },
  };
  if (isContextEngineEnabled()) {
    services.repoKnowledge = {
      buildNodeContextPacket: (input) => repoKnowledge.buildNodeContextPacket(input),
      recordContextUsage: (input) => repoKnowledge.recordContextUsage(input),
    };
  }
  return services;
}

/**
 * Build aliasMap and costMap from the model_registry collection.
 * These are passed to EngineConfig → NodeExecutorDeps so the engine can
 * resolve model aliases and estimate costs from the registry.
 */
async function buildAliasAndCostMaps(db: Db): Promise<{
  aliasMap: Record<string, string>;
  costMap: Record<string, ModelCostInfo>;
}> {
  const models = await db.collection('model_registry')
    .find({ isActive: true })
    .toArray();
  const aliasMap: Record<string, string> = {};
  const costMap: Record<string, ModelCostInfo> = {};
  for (const m of models) {
    aliasMap[m.alias as string] = m.fullId as string;
    const info: ModelCostInfo = {
      costInputPerMTok: (m.costInputPerMTok as number | null) ?? undefined,
      costOutputPerMTok: (m.costOutputPerMTok as number | null) ?? undefined,
      costCacheReadPerMTok: (m.costCacheReadPerMTok as number | null) ?? undefined,
    };
    // Keyed by both alias and fullId — nodes may hold either form (or a
    // free-text "Other…" id that matches a registry fullId).
    costMap[m.alias as string] = info;
    if (typeof m.fullId === 'string') costMap[m.fullId] = info;
  }
  return { aliasMap, costMap };
}

// Track running engines by executionId
const runningEngines = new Map<string, AllenEngine>();

/** Load agents from YAML + database (DB is source of truth, YAML is fallback). */
async function loadAllAgents(db: Db): Promise<Record<string, AgentDef>> {
  const yamlAgents = loadAgents();
  const dbAgents = await db
    .collection('agents')
    .find(
      {},
      {
        projection: {
          name: 1,
          system: 1,
          model: 1,
          provider: 1,
          tools: 1,
          externalMcpServers: 1,
          disabledAllenMcpTools: 1,
          disabledMcpTools: 1,
          type: 1,
          reasoningEffort: 1,
          planMode: 1,
          sourceRepoPath: 1,
        },
      },
    )
    .toArray();
  const merged: Record<string, AgentDef> = { ...yamlAgents };
  for (const a of dbAgents) {
    merged[a.name as string] = {
      system: (a.system as string) ?? '',
      model: a.model as string,
      provider: a.provider as AgentDef['provider'],
      tools: a.tools as string[],
      externalMcpServers: Array.isArray(a.externalMcpServers) ? a.externalMcpServers as string[] : [],
      disabledAllenMcpTools: Array.isArray(a.disabledAllenMcpTools) ? a.disabledAllenMcpTools as string[] : a.disabledAllenMcpTools as null | undefined,
      disabledMcpTools: (a.disabledMcpTools && typeof a.disabledMcpTools === 'object' && !Array.isArray(a.disabledMcpTools))
        ? a.disabledMcpTools as Record<string, string[]>
        : undefined,
      reasoningEffort: a.reasoningEffort as AgentDef['reasoningEffort'],
      planMode: a.planMode as boolean | undefined,
      sourceRepoPath: (a.sourceRepoPath as string | undefined) || undefined,
    };
  }
  return merged;
}

// ── Children query helpers ──────────────────────────────────────────────

const CHILDREN_PROJECTION = {
  id: 1, workflowName: 1, parentExecutionId: 1, parentCaller: 1,
  rootExecutionId: 1, spawnDepth: 1, status: 1, startedAt: 1,
  completedAt: 1, durationMs: 1, cost: 1, tokenUsage: 1, failedNode: 1,
  errorMessage: 1, input: 1, meta: 1, currentNodes: 1, completedNodes: 1,
};

const EXECUTION_LIST_PROJECTION = {
  _id: 0,
  id: 1,
  workflowId: 1,
  workflowName: 1,
  parentExecutionId: 1,
  rootExecutionId: 1,
  spawnDepth: 1,
  source: 1,
  status: 1,
  startedAt: 1,
  completedAt: 1,
  durationMs: 1,
  cost: 1,
  failedNode: 1,
  errorMessage: 1,
  currentNodes: 1,
  completedNodes: 1,

  'meta.origin': 1,
  'meta.chatSessionId': 1,
  'meta.parentMessageId': 1,
  'meta.startedByUserId': 1,
  'meta.startedByUserEmail': 1,
  'meta.startedByUserName': 1,
  'meta.linearIssueId': 1,
  'meta.linearIdentifier': 1,
  'meta.linearTitle': 1,
  'meta.linearUrl': 1,
  'meta.taskTitle': 1,
  'meta.requestText': 1,
  'meta.workspaceId': 1,
  'meta.workspacePath': 1,
  'meta.repoId': 1,
  'meta.repoPath': 1,
  'meta.cwd': 1,
  'meta.prUrl': 1,
  'meta.prTitle': 1,
  'meta.prStatus': 1,

  'input.linear_issue_id': 1,
  'input.linear_identifier': 1,
  'input.linear_title': 1,
  'input.linear_url': 1,
  'input.ticket_id': 1,
  'input.ticket_title': 1,
  'input.ticket_url': 1,
  'input.issue_title': 1,
  'input.task_title': 1,
  'input.workspace_id': 1,
  'input.worktree_path': 1,
  'input.repo_path': 1,
  'input.pr_url': 1,
  'input.url': 1,
  'input.pr_title': 1,
  'input.pr_status': 1,
  'input.branch_name': 1,
  'input.branch': 1,
  'input.base_branch': 1,

  'state.linear_issue_id': 1,
  'state.linear_identifier': 1,
  'state.linear_title': 1,
  'state.linear_url': 1,
  'state.ticket_id': 1,
  'state.ticket_url': 1,
  'state.workspace_id': 1,
  'state.worktree_path': 1,
  'state.repo_id': 1,
  'state.repo_path': 1,
  'state.pr_url': 1,
  'state.url': 1,
  'state.pr_title': 1,
  'state.pr_status': 1,
  'state.branch_name': 1,
  'state.branch': 1,
  'state.base_branch': 1,
} satisfies Record<string, 0 | 1>;

function listItemSummary(item: Record<string, unknown>): Record<string, unknown> {
  const workflowName = stringValue(item.workflowName) ?? '';
  const input = ((item.input ?? {}) as Record<string, unknown>) ?? {};
  const state = ((item.state ?? {}) as Record<string, unknown>) ?? {};
  const meta = ((item.meta ?? {}) as Record<string, unknown>) ?? {};
  const isAgentExecution = workflowName.includes(':spawn_agent/')
    || item.source === 'spawn'
    || (!item.workflowId && item.source === 'chat');
  const linear = (() => {
    const identifier =
      stringValue(meta.linearIdentifier)
      ?? stringValue(input.linear_identifier)
      ?? stringValue(input.ticket_id)
      ?? stringValue(state.linear_identifier)
      ?? stringValue(state.ticket_id);
    const url = firstUrl([meta.linearUrl, input.linear_url, input.ticket_url, state.linear_url, state.ticket_url], /linear\.app/i);
    const issueId = stringValue(meta.linearIssueId) ?? stringValue(input.linear_issue_id);
    if (!identifier && !url && !issueId) return null;
    return {
      issueId,
      identifier,
      title: stringValue(meta.linearTitle) ?? stringValue(input.linear_title) ?? stringValue(state.linear_title),
      url,
      assignment: null,
    };
  })();
  const prUrl = firstGithubPullRequestUrl([state.pr_url, state.url, input.pr_url, input.url, meta.prUrl, meta.url]);
  const pullRequest = prUrl
    ? {
        number: Number(prUrl.match(/\/pull\/(\d+)/i)?.[1] ?? '') || null,
        title: stringValue(state.pr_title) ?? stringValue(input.pr_title) ?? stringValue(meta.prTitle) ?? null,
        url: prUrl,
        status: stringValue(state.pr_status) ?? stringValue(input.pr_status) ?? stringValue(meta.prStatus) ?? 'open',
        branch: stringValue(state.branch_name) ?? stringValue(state.branch) ?? stringValue(input.branch_name) ?? stringValue(input.branch) ?? null,
        baseBranch: stringValue(state.base_branch) ?? stringValue(input.base_branch) ?? null,
      }
    : null;

  return {
    ...item,
    type: isAgentExecution ? 'agent' : 'workflow',
    origin: stringValue(meta.origin) ?? (item.source === 'chat' ? 'chat' : isAgentExecution ? 'direct_agent' : 'workflow'),
    user: listUserSummary(meta),
    title: executionDisplayTitle(input, meta, workflowName),
    linear,
    pullRequest,
  };
}

function listUserSummary(meta: Record<string, unknown>): Record<string, unknown> | null {
  const userId = stringValue(meta.startedByUserId);
  const name = stringValue(meta.startedByUserName);
  const email = stringValue(meta.startedByUserEmail);
  if (!userId && !name && !email) return null;
  return { userId: userId ?? null, name: name ?? null, email: email ?? null };
}

function decorateChildRow(
  row: Record<string, unknown>,
  linkType: 'direct' | 'timing',
): Record<string, unknown> {
  const wf = (row.workflowName as string | undefined) ?? '';
  const agentNameFromWf = wf.includes(':spawn_agent/') ? wf.split(':spawn_agent/')[1] : '';
  const input = (row.input ?? {}) as Record<string, unknown>;
  const agentName = (input.agent_name as string | undefined) ?? agentNameFromWf ?? 'unknown';
  const promptText = (input.prompt as string | undefined) ?? '';
  const promptPreview = promptText.length > 200 ? promptText.slice(0, 200) + '…' : promptText;
  // For timing-correlated rows, parentCaller is unknown — infer from
  // meta.spawnedBy which the old spawn_agent code did populate.
  const inferredCaller = (row.parentCaller as string | undefined)
    ?? ((row.meta as Record<string, unknown> | undefined)?.spawnedBy as string | undefined)
    ?? null;
  return {
    id: row.id,
    workflowName: row.workflowName,
    agentName,
    parentCaller: inferredCaller,
    parentExecutionId: row.parentExecutionId ?? null,
    rootExecutionId: row.rootExecutionId ?? null,
    spawnDepth: row.spawnDepth ?? 0,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    durationMs: row.durationMs ?? null,
    cost: row.cost ?? null,
    tokenUsage: row.tokenUsage ?? null,
    // Model/provider the child agent ran on — needed so cost breakdowns can
    // show per-row "tokens × this model's price" math that actually checks out.
    model: ((row.meta as Record<string, unknown> | undefined)?.model as string | undefined)
      ?? ((row.cost as Record<string, unknown> | undefined)?.model as string | undefined)
      ?? null,
    provider: ((row.meta as Record<string, unknown> | undefined)?.provider as string | undefined) ?? null,
    failedNode: row.failedNode ?? null,
    errorMessage: row.errorMessage ?? null,
    currentStep: Array.isArray(row.currentNodes) && row.currentNodes.length > 0
      ? (row.currentNodes as unknown[]).filter(Boolean).join(', ')
      : null,
    completedNodes: row.completedNodes ?? [],
    promptPreview,
    linkType,
  };
}

function stringValue(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function compactJsonValue(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  try {
    const text = JSON.stringify(v, null, 2);
    return text && text !== '{}' && text !== '[]' ? text : undefined;
  } catch {
    return undefined;
  }
}

function firstUrl(values: unknown[], pattern?: RegExp): string | undefined {
  for (const value of values) {
    const s = stringValue(value);
    if (!s) continue;
    if (!/^https?:\/\//i.test(s)) continue;
    if (pattern && !pattern.test(s)) continue;
    return s;
  }
  return undefined;
}

function collectStringValues(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (out.length >= 120 || value == null) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.slice(0, 8000));
    return out;
  }
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out, seen);
    return out;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectStringValues(item, out, seen);
  }
  return out;
}

function firstGithubPullRequestUrl(values: unknown[]): string | undefined {
  const direct = firstUrl(values, /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i);
  if (direct) return direct;
  for (const value of values) {
    for (const text of collectStringValues(value)) {
      const match = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i);
      if (match?.[0]) return match[0];
    }
  }
  return undefined;
}

function executionDisplayTitle(input: Record<string, unknown>, meta: Record<string, unknown>, fallback: string): string {
  return stringValue(meta.linearTitle)
    ?? stringValue(input.linear_title)
    ?? stringValue(input.issue_title)
    ?? stringValue(input.ticket_title)
    ?? stringValue(meta.taskTitle)
    ?? stringValue(input.task_title)
    ?? stringValue(meta.requestText)
    ?? stringValue(input.task)
    ?? stringValue(input.request)
    ?? stringValue(input.prompt)
    ?? fallback;
}

function applyWorkflowAgentProvider(workflow: WorkflowDef, provider?: WorkflowAgentProvider): WorkflowDef {
  if (!provider) return workflow;

  const copy = JSON.parse(JSON.stringify(workflow)) as WorkflowDef;
  const nodes = (copy.nodes ?? {}) as Record<string, Record<string, unknown>>;

  for (const node of Object.values(nodes)) {
    if (typeof node.agent !== 'string' || !node.agent) continue;

    const existing = (
      node.agentOverrides
      && typeof node.agentOverrides === 'object'
      && !Array.isArray(node.agentOverrides)
    )
      ? node.agentOverrides as Record<string, unknown>
      : {};
    const next: Record<string, unknown> = { ...existing, provider };

    if (provider === 'codex' && next.model === undefined) {
      next.model = 'default';
    }
    if (provider === 'claude' && next.model === 'default') {
      delete next.model;
    }

    node.agentOverrides = next;
  }

  return copy;
}

export type RunOrigin = 'chat' | 'linear' | 'workflow' | 'direct_agent';
export type RunType = 'workflow' | 'agent';
export type WorkflowAgentProvider = 'claude' | 'codex' | (string & {});
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

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled']);

function normalizeTerminalCurrentNodes<T extends { status?: unknown; currentNodes?: unknown }>(row: T): T {
  const status = String(row.status ?? '').toLowerCase();
  if (!TERMINAL_STATUSES.has(status)) return row;
  if (!Array.isArray(row.currentNodes) || row.currentNodes.length === 0) return row;
  return { ...row, currentNodes: [] };
}

export interface RunStatus {
  origin: RunOrigin;
  runType: RunType;
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
  execution: Record<string, unknown>;
  progress: {
    completed: number;
    total: number;
    percent: number;
    label: string;
    currentStep: string | null;
    phase: RunPhase;
  };
  humanInput: Record<string, unknown>;
  linear: Record<string, unknown> | null;
  workspace: Record<string, unknown> | null;
  pullRequest: Record<string, unknown> | null;
  childAgents: Record<string, unknown>[];
  workflowSteps: Record<string, unknown>[];
  interventions: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  recentActivity: Record<string, unknown>[];
}

export class ExecutionService {
  private db: Db;
  private stateManager: StateManager;

  constructor(db: Db) {
    this.db = db;
    this.stateManager = new StateManager(db);
  }

  async start(
    workflowId: string,
    input: Record<string, unknown>,
    options: { agentProvider?: WorkflowAgentProvider } = {},
  ): Promise<Record<string, unknown>> {
    const { ObjectId } = await import('mongodb');
    const workflowDoc = await this.db.collection('workflows').findOne({ _id: new ObjectId(workflowId) });
    if (!workflowDoc) throw new Error('Workflow not found');

    const workflow = applyWorkflowAgentProvider(workflowDoc.parsed as WorkflowDef, options.agentProvider);
    this.validateWorkflowInput(workflow, input);
    if (isSelfHealingWorkflowName(workflow.name)) {
      const config = assertSelfHealingLinearConfig();
      input = {
        ...input,
        linear_team_key: config.teamKey,
        linear_project_name: config.projectName,
        linear_assignee_email: config.assigneeEmail,
      };
    }
    const executionId = randomUUID();

    // TEMPORARILY DISABLED: concurrency queueing can leave new chat-started
    // work stuck behind stale running/waiting executions. Keep the old path
    // here so it can be re-enabled after stale-run cleanup is fixed.
    const concurrencyQueueingEnabled = false;
    if (concurrencyQueueingEnabled && workflow.context?.concurrency) {
      const running = await this.stateManager.countRunningExecutions(workflow.name);
      if (running >= workflow.context.concurrency) {
        // Queue the execution instead of rejecting
        const queuedExec: ExecutionState = {
          id: executionId,
          workflowId,
          workflowName: workflow.name,
          workflowVersion: workflow.version ?? 1,
          status: 'queued',
          input,
          state: { ...input },
          sessions: {},
          retryCounts: {},
          feedbackEntries: [],
          currentNodes: [],
          completedNodes: [],
          nodeAttempts: {},
          cost: { actual: null, estimated: 0 },
          durationMs: 0,
          startedAt: new Date(),
        };
        await this.stateManager.createExecution(queuedExec);

        return {
          id: executionId,
          status: 'queued',
          workflowName: workflow.name,
          workflowId,
        };
      }
    }

    // Track repo usage
    await this.trackRepoUsage(input);

    // Start immediately
    return this.launchExecution(executionId, workflowId, workflow, input);
  }

  private validateWorkflowInput(workflow: WorkflowDef, input: Record<string, unknown>): void {
    const inputDef = (workflow as unknown as { input?: Record<string, { required?: boolean; type?: string; label?: string }> }).input;
    if (!inputDef) return;

    const missingFields = Object.entries(inputDef)
      .filter(([key, def]) => def.required && (input[key] === undefined || input[key] === null || input[key] === ''))
      .map(([key]) => key);
    if (missingFields.length === 0) return;

    const requiredInputs = Object.entries(inputDef)
      .filter(([, def]) => def.required)
      .map(([name, def]) => `${name}${def.type ? ` (${def.type})` : ''}`)
      .join(', ');

    const err = new Error(
      `Missing required workflow input${missingFields.length === 1 ? '' : 's'} for "${workflow.name}": ${missingFields.join(', ')}. Required inputs: ${requiredInputs}. Call get_workflow first and rebuild input with the exact parsed.input field names.`,
    );
    (err as Error & { code?: string; missingFields?: string[] }).code = 'WORKFLOW_INPUT_VALIDATION_FAILED';
    (err as Error & { missingFields?: string[] }).missingFields = missingFields;
    throw err;
  }

  /**
   * Launch an execution (called directly or from dequeue).
   */
  private async launchExecution(
    executionId: string,
    workflowId: string,
    workflow: WorkflowDef,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Base SSE emitter for live event streaming to the UI.
    const sseEmitter = createSSEEmitter(executionId);
    // Middleware emitter: forwards every event to the SSE emitter AND
    // intercepts `input_required` to create a HIP intervention record.
    // This is how every `human` node in every workflow — current and
    // future — automatically surfaces on the Interventions page.
    const emitter = this.wrapEmitterWithInterventionHook(
      sseEmitter,
      executionId,
      workflow,
      input,
    );

    const allWorkflowDocs = await this.db.collection('workflows').find({}).toArray();
    const workflows: Record<string, WorkflowDef> = {};
    for (const doc of allWorkflowDocs) {
      workflows[(doc.parsed as WorkflowDef).name] = doc.parsed as WorkflowDef;
    }

    const _aliasMapResult = await buildAliasAndCostMaps(this.db).catch(() => undefined);
    const config: EngineConfig = {
      db: this.db,
      agents: await loadAllAgents(this.db),
      builtIns: getBuiltIns(),
      workflows,
      emitter,
      services: buildEngineServices(this.db),
      discoverMcpToolNames: async () => {
        // Lazy-import to avoid pulling chat-mcp-client into engine type
        // resolution. Cached behind chat-mcp-client's connection map, so
        // repeated workflow runs reuse the same MCP subprocesses.
        try {
          const { loadMcpTools } = await import('./chat-mcp-client.js');
          const tools = await loadMcpTools(this.db);
          return tools.map(t => t.fullName);
        } catch (err) {
          logger.warn('MCP tool discovery failed for workflow run', { component: 'engine', error: (err as Error).message });
          return [];
        }
      },
      claudeCodeExecutable: resolveClaudeCodeExecutable(),
      buildClaudeCompatibleEnvOverlay,
      aliasMap: _aliasMapResult?.aliasMap,
      costMap: _aliasMapResult?.costMap,
    };

    const engine = new AllenEngine(config);
    runningEngines.set(executionId, engine);

    engine.run(workflow, input, 0, { executionId, workflowId })
      .catch(() => {})
      .finally(() => {
        runningEngines.delete(executionId);
        this.enqueueWorkflowContextEvaluation(executionId).catch((err) => {
          logger.warn('workflow context semantic evaluation enqueue failed', { executionId, error: (err as Error).message });
        });
        // Auto-dequeue next waiting execution for this workflow
        this.dequeueNext(workflow.name).catch(() => {});
      });

    // ── Watcher registration ─────────────────────────────────────────────
    // Fire-and-forget: register a watcher if the execution carries a chatSessionId.
    setImmediate(async () => {
      const chatSessionId = (input.meta as Record<string, unknown> | undefined)?.chatSessionId as string | undefined
        ?? (input.chatSessionId as string | undefined);
      if (chatSessionId) {
        try {
          const { WatcherService } = await import('./watcher.service.js');
          const { ChatService } = await import('./chat.service.js');
          await new WatcherService(this.db, new ChatService(this.db)).register({
            executionId,
            chatSessionId,
            executionType: 'workflow',
          });
        } catch (err) {
          logger.warn('[execution] Watcher auto-registration failed', {
            component: 'execution',
            executionId,
            error: (err as Error).message,
          });
        }
      }
    });

    return {
      id: executionId,
      status: 'running',
      workflowName: workflow.name,
      workflowId,
    };
  }

  /**
   * Dequeue the next queued execution for a workflow when a slot opens.
   */
  private async dequeueNext(workflowName: string): Promise<void> {
    // Find the workflow definition to check concurrency config
    const workflowDoc = await this.db.collection('workflows').findOne({ name: workflowName });
    if (!workflowDoc) return;

    const workflow = workflowDoc.parsed as WorkflowDef;
    const limit = workflow.context?.concurrency;
    if (!limit) return;

    const running = await this.stateManager.countRunningExecutions(workflowName);
    if (running >= limit) return;

    // Find oldest queued execution
    const queued = await this.db.collection('executions')
      .findOne(
        { workflowName, status: 'queued' },
        { sort: { startedAt: 1 } },
      );

    if (!queued) return;

    const exec = queued as unknown as ExecutionState;
    await this.launchExecution(exec.id, exec.workflowId, workflow, exec.input);
  }

  /**
   * Increment executionCount and update lastUsedAt for the repo matching the input path.
   */
  private async trackRepoUsage(input: Record<string, unknown>): Promise<void> {
    const repoPath = input.repo_path as string | undefined;
    if (!repoPath) return;
    try {
      await this.db.collection('repos').updateOne(
        { path: repoPath },
        { $inc: { executionCount: 1 }, $set: { lastUsedAt: new Date() } },
      );
    } catch {
      // Non-critical — don't block execution
    }
  }

  async list(filter: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const query: Record<string, unknown> = {};
    if (filter.status) query.status = filter.status;
    if (filter.workflowId) query.workflowId = filter.workflowId;
    if (filter.workflowName) query.workflowName = filter.workflowName;

    const results = await this.stateManager.listExecutions(query);
    const rows = (results as unknown as Record<string, unknown>[]).map(normalizeTerminalCurrentNodes);
    await this.hydrateOwnCosts(rows);
    return rows;
  }

  /**
   * Attach `cost`/`tokenUsage` to row objects from each execution's OWN
   * traces (one grouped aggregation per call). Rows whose executions have no
   * trace spend keep whatever legacy stored value they carry, so pre-fix
   * documents still render.
   */
  private async hydrateOwnCosts(rows: Record<string, unknown>[]): Promise<void> {
    const ids = rows.map((r) => stringValue(r.id)).filter((v): v is string => Boolean(v));
    if (ids.length === 0) return;
    const ownCosts = await new CostRollupService(this.db).getOwnCosts(ids).catch(() => null);
    if (!ownCosts) return;
    for (const row of rows) {
      const own = ownCosts.get(stringValue(row.id) ?? '');
      if (!own) continue;
      row.cost = { actual: own.costUsd, estimated: own.estimatedUsd };
      row.tokenUsage = {
        inputCachedTokens: own.inputCachedTokens,
        inputNonCachedTokens: own.inputNonCachedTokens,
        outputTokens: own.outputTokens,
      };
    }
  }

  /**
   * Paginated list with optional free-text search and agent/workflow type
   * filter. `type='agent'` matches workflowName patterns produced by
   * spawn_agent (`<caller>:spawn_agent/<name>`); `type='workflow'` excludes
   * those. `search` is a case-insensitive substring match against
   * workflowName, id, and failedNode.
   */
  async listPaged(opts: {
    status?: string;
    workflowId?: string;
    workflowName?: string;
    type?: 'agent' | 'workflow';
    search?: string;
    skip?: number;
    limit?: number;
    includeTotal?: boolean;
    enrich?: boolean;
    hydrateLegacyChatMetadata?: boolean;
  } = {}): Promise<{ items: Record<string, unknown>[]; total?: number }> {
    const query: Record<string, unknown> = {};
    if (opts.status) query.status = opts.status;
    if (opts.workflowId) query.workflowId = opts.workflowId;
    if (opts.workflowName) query.workflowName = opts.workflowName;

    if (opts.type === 'agent') {
      query.workflowName = { $regex: ':spawn_agent/' };
    } else if (opts.type === 'workflow') {
      query.workflowName = { $not: { $regex: ':spawn_agent/' } };
    }

    if (opts.search && opts.search.trim()) {
      const escaped = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: escaped, $options: 'i' };
      const searchOr: Record<string, unknown>[] = [
        { id: rx },
        { failedNode: rx },
      ];
      // If we already constrained workflowName by type, combine via $and so
      // the search OR doesn't override the type filter.
      if (query.workflowName) {
        const wfConstraint = query.workflowName;
        delete query.workflowName;
        query.$and = [
          { workflowName: wfConstraint },
          { $or: [...searchOr, { workflowName: rx }] },
        ];
      } else {
        query.$or = [...searchOr, { workflowName: rx }];
      }
    }

    const { items, total } = await this.stateManager.listExecutionsPaged(query, {
      skip: opts.skip,
      limit: opts.limit,
      includeTotal: opts.includeTotal,
      projection: EXECUTION_LIST_PROJECTION,
    });
    const normalizedItems = (items as unknown as Record<string, unknown>[]).map(normalizeTerminalCurrentNodes);
    if (opts.hydrateLegacyChatMetadata) {
      await this.attachChatMetadataFromMessages(normalizedItems);
    }
    // Execution rows store no cost — hydrate per-row own-trace cost for the
    // visible page in one batch aggregation (on-demand, never persisted).
    await this.hydrateOwnCosts(normalizedItems);
    if (!opts.enrich) {
      return { items: normalizedItems.map(listItemSummary), total };
    }
    const enriched = await Promise.all(normalizedItems.map((item) => this.listItemContext(item)));
    return { items: enriched, total };
  }

  async listForChatSession(sessionId: string): Promise<Record<string, unknown>[]> {
    const messageLinks = new Map<string, { parentMessageId: string }>();
    const messages = await this.db.collection('chat_messages')
      .find({
        sessionId,
        role: 'assistant',
        $or: [
          { 'toolCalls.result.id': { $type: 'string' } },
          { 'toolCalls.result.execution_id': { $type: 'string' } },
        ],
      }, {
        projection: { _id: 1, toolCalls: 1, createdAt: 1 },
      })
      .sort({ createdAt: 1 })
      .limit(300)
      .toArray()
      .catch(() => []);

    for (const message of messages) {
      const parentMessageId = String(message._id ?? '');
      for (const call of ((message.toolCalls ?? []) as Array<Record<string, unknown>>)) {
        const result = ((call.result ?? {}) as Record<string, unknown>) ?? {};
        const executionId = stringValue(result.id) ?? stringValue(result.execution_id);
        if (executionId && parentMessageId && !messageLinks.has(executionId)) {
          messageLinks.set(executionId, { parentMessageId });
        }
      }
    }

    const messageExecutionIds = [...messageLinks.keys()];
    const belongsToChatSession = (row: Record<string, unknown>): boolean => {
      const meta = ((row.meta ?? {}) as Record<string, unknown>) ?? {};
      const rowSessionId = stringValue(meta.chatSessionId);
      return !rowSessionId || rowSessionId === sessionId;
    };

    const isDirectChatLinkedExecution = (row: Record<string, unknown>): boolean => {
      const id = stringValue(row.id);
      if (!id) return false;

      // The chat page should list only executions directly started by chat:
      //   - a workflow run launched from chat, or
      //   - an agent spawned directly from chat.
      // Workflow-node / nested agent executions are descendants of those
      // direct runs and belong on the execution detail page, not the chat's
      // top-level run list.
      if (stringValue(row.source) === 'spawn') return false;
      if (stringValue(row.parentExecutionId)) return false;
      const rootExecutionId = stringValue(row.rootExecutionId);
      if (rootExecutionId && rootExecutionId !== id) return false;
      return true;
    };

    const directRows = (await this.db.collection('executions')
      .find({
        $or: [
          { 'meta.chatSessionId': sessionId },
          ...(messageExecutionIds.length ? [{ id: { $in: messageExecutionIds } }] : []),
        ],
      })
      .sort({ startedAt: 1, createdAt: 1 })
      .limit(200)
      .toArray()
      .catch(() => []))
      .filter((row) => {
        const r = row as Record<string, unknown>;
        return belongsToChatSession(r) && isDirectChatLinkedExecution(r);
      }) as Record<string, unknown>[];

    const metadataUpdates = [];
    for (const row of directRows) {
      const id = stringValue(row.id);
      if (!id) continue;
      const meta = ((row.meta ?? {}) as Record<string, unknown>) ?? {};
      const link = messageLinks.get(id);
      if (stringValue(meta.chatSessionId) || !link) continue;
      row.source = row.source ?? 'chat';
      row.meta = {
        ...meta,
        origin: stringValue(meta.origin) ?? 'chat',
        chatSessionId: sessionId,
        parentMessageId: stringValue(meta.parentMessageId) ?? link.parentMessageId,
      };
      metadataUpdates.push({
        updateOne: {
          filter: { id, 'meta.chatSessionId': { $exists: false } },
          update: {
            $set: {
              source: 'chat',
              'meta.origin': 'chat',
              'meta.chatSessionId': sessionId,
              'meta.parentMessageId': link.parentMessageId,
            },
          },
        },
      });
    }
    if (metadataUpdates.length > 0) {
      await this.db.collection('executions').bulkWrite(metadataUpdates, { ordered: false }).catch(() => {});
    }

    const rootParentByExecution = new Map<string, string>();
    for (const row of directRows) {
      const id = stringValue(row.id);
      if (!id) continue;
      const meta = ((row.meta ?? {}) as Record<string, unknown>) ?? {};
      const parentMessageId = stringValue(meta.parentMessageId) ?? messageLinks.get(id)?.parentMessageId;
      if (parentMessageId) rootParentByExecution.set(id, parentMessageId);
    }

    const byId = new Map<string, Record<string, unknown>>();
    for (const row of directRows as Record<string, unknown>[]) {
      const id = stringValue(row.id);
      if (!id || byId.has(id)) continue;
      const meta = ((row.meta ?? {}) as Record<string, unknown>) ?? {};
      const rootId = stringValue(row.rootExecutionId);
      const parentMessageId =
        stringValue(meta.parentMessageId)
        ?? (rootId ? rootParentByExecution.get(rootId) : undefined)
        ?? rootParentByExecution.get(id)
        ?? messageLinks.get(id)?.parentMessageId
        ?? null;
      byId.set(id, {
        ...row,
        source: row.source ?? 'chat',
        meta: {
          ...meta,
          origin: stringValue(meta.origin) ?? 'chat',
          chatSessionId: stringValue(meta.chatSessionId) ?? sessionId,
          ...(parentMessageId ? { parentMessageId } : {}),
        },
      });
    }

    const contexts = await Promise.all([...byId.values()].map(async (row) => {
      const id = stringValue(row.id) ?? '';
      try {
        const context = await this.getContext(id);
        return { row, context };
      } catch {
        return { row, context: null };
      }
    }));

    return contexts
      .sort((a, b) => {
        const aTime = new Date(String(a.row.startedAt ?? a.row.createdAt ?? 0)).getTime();
        const bTime = new Date(String(b.row.startedAt ?? b.row.createdAt ?? 0)).getTime();
        return aTime - bTime;
      })
      .map(({ row, context }) => {
        const id = stringValue(row.id) ?? '';
        const input = ((row.input ?? {}) as Record<string, unknown>) ?? {};
        const meta = ((row.meta ?? {}) as Record<string, unknown>) ?? {};
        const workflowName = stringValue(row.workflowName) ?? '';
        const isAgentExecution = workflowName.includes(':spawn_agent/')
          || row.source === 'spawn'
          || (!row.workflowId && row.source === 'chat');
        return {
          executionId: id,
          sourceMessageId: stringValue(meta.parentMessageId) ?? null,
          agent: context?.title ?? this.executionTitle(workflowName, input, meta),
          prompt: stringValue(input.prompt) ?? stringValue(input.task) ?? stringValue(input.request) ?? stringValue(meta.requestText) ?? '',
          status: row.status,
          kind: context?.runType === 'workflow' ? 'workflow' : isAgentExecution ? 'agent' : 'lead',
          runContext: context,
        };
      });
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.stateManager.getExecution(id);
    if (!result) return null;
    const row = normalizeTerminalCurrentNodes(result as unknown as Record<string, unknown>);
    // Rows store no cost — attach this execution's OWN trace sums on demand
    // (accumulates retry attempts; descendants are rolled up separately by
    // getContext / the children panel).
    await this.hydrateOwnCosts([row]);
    return row;
  }

  async getContext(id: string): Promise<RunStatus> {
    const rawExec = await this.stateManager.getExecution(id);
    if (!rawExec) throw new Error('Execution not found');
    const exec = normalizeTerminalCurrentNodes(rawExec) as ExecutionState;

    const row = exec as unknown as Record<string, unknown>;
    const input = (exec.input ?? {}) as Record<string, unknown>;
    const state = (exec.state ?? {}) as Record<string, unknown>;
    const meta = ((row.meta ?? {}) as Record<string, unknown>) ?? {};
    const workflowName = exec.workflowName ?? '';
    const isAgentExecution = workflowName.includes(':spawn_agent/')
      || row.source === 'spawn'
      || (!exec.workflowId && row.source === 'chat');

    const [workflowDoc, traces, directChildren, interventions, logs, activity, contextWorkflowEvaluation, treeCost] = await Promise.all([
      exec.workflowId && ObjectId.isValid(exec.workflowId)
        ? this.db.collection('workflows').findOne(
            { _id: new ObjectId(exec.workflowId) },
            { projection: { name: 1, parsed: 1 } },
          )
        : Promise.resolve(null),
      this.getTraces(id),
      this.getChildren(id, 'direct'),
      new InterventionService(this.db).listForWorkflowRun(id).catch(() => []),
      this.db
        .collection('execution_logs')
        .find({ executionId: id })
        .sort({ timestamp: -1, createdAt: -1 })
        .limit(25)
        .toArray()
        .catch(() => []),
      new AgentActivityService(this.db).listForRef(id, { limit: 50 }).catch(() => []),
      new ContextWorkflowEvaluationService(this.db).getSummaryForExecution(id).catch(() => null),
      // On-demand cost: own traces + full spawn/sub-workflow tree. Execution
      // rows store no cost — this is the only way to get a total.
      new CostRollupService(this.db).getExecutionTreeCost(id).catch(() => null),
    ]);

    await this.attachChatMetadataFromMessages([row]);
    const hydratedMeta = ((row.meta ?? {}) as Record<string, unknown>) ?? meta;
    const chatSummary = await this.runChatSummary(input, hydratedMeta);
    const workspace = await this.findExecutionWorkspace(input, state, hydratedMeta);
    const assignment = await this.findExecutionAssignment(id, workspace, input, state, hydratedMeta);
    const pullRequest = await this.findExecutionPullRequest(id, workspace, input, state, hydratedMeta, [row, ...traces, ...logs, ...activity]);
    const artifacts = await this.findExecutionArtifacts(id, isAgentExecution, row, hydratedMeta);
    await this.captureChatDiffSnapshotIfReady(id, exec.status, workspace, hydratedMeta).catch(() => {});

    const workflowSnapshot = (row.workflowSnapshot && typeof row.workflowSnapshot === 'object'
      ? row.workflowSnapshot
      : {}) as Record<string, unknown>;
    const workflowSnapshotNodes = ((workflowSnapshot.nodes && typeof workflowSnapshot.nodes === 'object'
      ? workflowSnapshot.nodes
      : ((workflowSnapshot.parsed && typeof workflowSnapshot.parsed === 'object'
        ? (workflowSnapshot.parsed as Record<string, unknown>).nodes
        : {}) ?? {})) ?? {}) as Record<string, unknown>;
    const workflowNodes = ((workflowDoc?.parsed as Record<string, unknown> | undefined)?.nodes ?? workflowSnapshotNodes) as Record<string, unknown>;
    const workflowNodeNames = Object.keys(workflowNodes);
    const totalNodes = isAgentExecution
      ? 1
      : workflowNodeNames.length || Math.max(exec.completedNodes?.length ?? 0, exec.currentNodes?.length ?? 0);
    const pendingIntervention = interventions.find((i: any) => i.status === 'pending') ?? null;
    const currentStep = this.currentStep(exec, isAgentExecution, traces);
    const workflowSteps = isAgentExecution ? [] : this.workflowStepContext(exec as unknown as Record<string, unknown>, workflowNodes, traces);
    const completedCount = isAgentExecution
      ? (exec.status === 'completed' ? 1 : 0)
      : Math.min(workflowSteps.filter(step => ['completed', 'skipped'].includes(String(step.status ?? '').toLowerCase())).length, totalNodes);
    const percent = totalNodes > 0 ? Math.round((completedCount / totalNodes) * 100) : 0;
    const origin = this.inferOrigin(row, assignment) as RunOrigin;
    const runType: RunType = isAgentExecution ? 'agent' : 'workflow';
    const latestTrace = [...traces].sort((a, b) => {
      const aTime = new Date(String((a.completedAt ?? a.startedAt ?? 0))).getTime();
      const bTime = new Date(String((b.completedAt ?? b.startedAt ?? 0))).getTime();
      return bTime - aTime;
    })[0] as Record<string, unknown> | undefined;
    const traceOutput = (latestTrace?.output && typeof latestTrace.output === 'object'
      ? latestTrace.output
      : {}) as Record<string, unknown>;
    const ioInput =
      stringValue(latestTrace?.renderedPrompt)
      ?? stringValue((latestTrace?.inputState as Record<string, unknown> | undefined)?.prompt)
      ?? stringValue(input.prompt)
      ?? stringValue(input.task)
      ?? stringValue(input.request)
      ?? stringValue(hydratedMeta.requestText)
      ?? null;
    const ioOutput =
      stringValue(traceOutput.response)
      ?? stringValue(traceOutput.error)
      ?? stringValue(latestTrace?.rawResponse)
      ?? null;

    return {
      origin,
      runType,
      title: executionDisplayTitle(input, hydratedMeta, workflowName),
      status: exec.status,
      chat: {
        sessionId: stringValue(chatSummary?.sessionId) ?? stringValue(hydratedMeta.chatSessionId) ?? null,
        parentMessageId: stringValue(hydratedMeta.parentMessageId) ?? null,
        title: stringValue(chatSummary?.title) ?? null,
        userId: stringValue(chatSummary?.userId) ?? stringValue(hydratedMeta.startedByUserId) ?? null,
        userName: stringValue(chatSummary?.userName) ?? stringValue(hydratedMeta.startedByUserName) ?? null,
        userEmail: stringValue(chatSummary?.userEmail) ?? stringValue(hydratedMeta.startedByUserEmail) ?? null,
      },
      io: {
        input: ioInput,
        output: ioOutput,
      },
      execution: {
        id,
        workflowId: exec.workflowId,
        workflowName,
        status: exec.status,
        source: row.source ?? null,
        startedAt: exec.startedAt,
        completedAt: exec.completedAt ?? null,
        durationMs: exec.durationMs,
        // Tree total (own + descendants), computed on demand from traces.
        cost: treeCost
          ? { actual: treeCost.total.costUsd, estimated: treeCost.total.estimatedUsd }
          : { actual: null, estimated: 0 },
        costOwn: treeCost
          ? { actual: treeCost.own.costUsd, estimated: treeCost.own.estimatedUsd }
          : null,
        costTreeSize: treeCost?.treeSize ?? 1,
        costByModel: treeCost?.byModel ?? [],
        tokenUsage: treeCost
          ? {
              inputCachedTokens: treeCost.total.inputCachedTokens,
              inputNonCachedTokens: treeCost.total.inputNonCachedTokens,
              outputTokens: treeCost.total.outputTokens,
            }
          : null,
        currentNodes: exec.currentNodes ?? [],
        completedNodes: exec.completedNodes ?? [],
        failedNode: exec.failedNode ?? null,
        errorMessage: exec.errorMessage ?? null,
        isAgentExecution,
        parentExecutionId: stringValue(row.parentExecutionId) ?? null,
        rootExecutionId: stringValue(row.rootExecutionId) ?? null,
        spawnDepth: typeof row.spawnDepth === 'number' ? row.spawnDepth : null,
        contextWorkflowEvaluation: contextWorkflowEvaluation ?? null,
      },
      progress: {
        completed: completedCount,
        total: totalNodes,
        percent,
        label: totalNodes > 0 ? `${completedCount} / ${totalNodes}` : '0 / 0',
        currentStep,
        phase: this.phaseForExecution(exec, logs, activity),
      },
      humanInput: pendingIntervention ? {
        required: true,
        interventionId: pendingIntervention.intervention_id,
        title: pendingIntervention.title,
        stage: pendingIntervention.stage,
        severity: pendingIntervention.severity,
      } : {
        required: exec.status === 'waiting_for_input',
        title: exec.status === 'waiting_for_input' ? 'Waiting for input' : undefined,
      },
      linear: this.linearContext(assignment, input, state, hydratedMeta),
      workspace: workspace ? this.workspaceContext(workspace) : null,
      pullRequest: pullRequest ? this.pullRequestContext(pullRequest) : null,
      childAgents: directChildren.map((child) => this.childAgentContext(child)),
      workflowSteps,
      interventions: interventions.map((intervention) => ({ ...intervention })),
      artifacts: artifacts.map((artifact) => this.artifactContext(artifact)),
      recentActivity: this.recentActivity(logs, activity),
    };
  }

  private async captureChatDiffSnapshotIfReady(
    executionId: string,
    status: string,
    workspace: Record<string, unknown> | null,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'canceled']);
    if (!terminal.has(String(status ?? '').toLowerCase())) return;
    const chatSessionId = stringValue(meta.chatSessionId);
    const parentMessageId = stringValue(meta.parentMessageId);
    const workspaceId = workspace?._id ? String(workspace._id) : stringValue(meta.workspaceId);
    if (!chatSessionId || !parentMessageId || !workspaceId) return;

    const existing = await this.db.collection('chat_code_diff_snapshots').findOne({
      chatSessionId,
      parentMessageId,
      workspaceId,
    });
    if (existing) return;

    const activeSibling = await this.db.collection('executions').findOne({
      'meta.chatSessionId': chatSessionId,
      'meta.parentMessageId': parentMessageId,
      status: { $nin: [...terminal] },
    }, { projection: { _id: 1 } });
    if (activeSibling) return;

    const diff = await new WorkspaceManager(this.db).getDiff(workspaceId, { mode: 'workspace' });
    const files = diff.files.filter(file => file.diff?.trim() || file.modifiedContent?.trim());
    if (files.length === 0) return;

    const siblingIds = await this.db.collection('executions')
      .find({ 'meta.chatSessionId': chatSessionId, 'meta.parentMessageId': parentMessageId }, { projection: { id: 1 } })
      .toArray()
      .catch(() => []);
    const now = new Date();
    await this.db.collection('chat_code_diff_snapshots').insertOne({
      chatSessionId,
      parentMessageId,
      executionIds: [...new Set([executionId, ...siblingIds.map(item => stringValue(item.id)).filter((value): value is string => Boolean(value))])],
      workspaceId,
      workspaceName: stringValue(workspace?.name) ?? stringValue(workspace?.repoName) ?? null,
      baseBranch: diff.baseBranch,
      mode: diff.mode,
      files,
      createdAt: now,
      updatedAt: now,
    });
  }

  async listFeedback(executionId: string): Promise<WorkflowFeedbackEntry[]> {
    const exec = await this.stateManager.getExecution(executionId);
    if (!exec) throw new Error('Execution not found');
    return this.stateManager.listFeedback(executionId);
  }

  private async enqueueWorkflowContextEvaluation(executionId: string, reason = 'workflow_terminal', force = false): Promise<void> {
    if (!isContextEngineEnabled()) return;
    const exec = await this.stateManager.getExecution(executionId).catch(() => null);
    if (!exec || (exec.status !== 'completed' && exec.status !== 'failed')) return;
    const service = new ContextWorkflowEvaluationService(this.db);
    const job = await service.enqueueForExecution(executionId, reason, { force });
    if (!job) return;
    service.runPendingWorkflowEvaluations(1).catch((err) => {
      logger.warn('workflow context semantic evaluation failed', { executionId, error: (err as Error).message });
    });
  }

  async rerunWorkflowContextEvaluation(executionId: string): Promise<Record<string, unknown> | null> {
    if (!isContextEngineEnabled()) return null;
    const exec = await this.stateManager.getExecution(executionId).catch(() => null);
    if (!exec) throw new Error('Execution not found');
    const service = new ContextWorkflowEvaluationService(this.db);
    const job = await service.enqueueForExecution(executionId, 'manual_rerun', { force: true, allowAnyExecutionStatus: true });
    if (!job) return null;
    service.runPendingWorkflowEvaluations(1).catch((err) => {
      logger.warn('manual workflow context semantic evaluation failed', { executionId, error: (err as Error).message });
    });
    return service.getSummaryForExecution(executionId);
  }

  async appendFeedback(
    executionId: string,
    content: string,
    targetNodes?: string[],
    createdBy?: string,
  ): Promise<WorkflowFeedbackEntry> {
    const exec = await this.stateManager.getExecution(executionId);
    if (!exec) throw new Error('Execution not found');
    if (!['completed', 'failed', 'cancelled'].includes(exec.status)) {
      const err = new Error(`Can only add feedback after execution is completed, failed, or cancelled (was: ${exec.status})`);
      (err as unknown as { statusCode: number }).statusCode = 409;
      throw err;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      const err = new Error('feedback content is required');
      (err as unknown as { statusCode: number }).statusCode = 400;
      throw err;
    }

    const normalizedTargetNodes = Array.isArray(targetNodes)
      ? [...new Set(
          targetNodes
            .filter((node): node is string => typeof node === 'string')
            .map((node) => node.trim())
            .filter(Boolean),
        )]
      : [];
    if (normalizedTargetNodes.length > 0) {
      const workflowFromExecution = (exec as unknown as { workflowSnapshot?: WorkflowDef }).workflowSnapshot;
      const workflowDoc = workflowFromExecution
        ? null
        : exec.workflowId
          ? await this.db.collection('workflows').findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(exec.workflowId) })
          : await this.db.collection('workflows').findOne({ name: exec.workflowName });
      const workflow = workflowFromExecution ?? (workflowDoc?.parsed as WorkflowDef | undefined);
      const agentNodes = new Set(
        Object.entries(workflow?.nodes ?? {})
          .filter(([, nodeDef]) => ((nodeDef as { type?: string }).type ?? 'agent') === 'agent')
          .map(([nodeName]) => nodeName),
      );
      const invalidNodes = normalizedTargetNodes.filter((nodeName) => !agentNodes.has(nodeName));
      if (invalidNodes.length > 0) {
        const err = new Error(`feedback targetNodes must reference agent nodes only: ${invalidNodes.join(', ')}`);
        (err as unknown as { statusCode: number }).statusCode = 400;
        throw err;
      }
    }

    const entry: WorkflowFeedbackEntry = {
      id: randomUUID(),
      content: trimmed,
      targetNodes: normalizedTargetNodes.length > 0 ? normalizedTargetNodes : undefined,
      createdAt: new Date(),
      createdBy,
    };
    await this.stateManager.appendFeedback(executionId, entry);
    if (isContextEngineEnabled()) {
      new ContextEvaluationService(this.db).reevaluateExecution(executionId).catch((err) => {
        logger.warn('context evaluation refresh after feedback failed', { executionId, error: (err as Error).message });
      });
      this.enqueueWorkflowContextEvaluation(executionId, 'feedback', true).catch((err) => {
        logger.warn('workflow context semantic evaluation enqueue after feedback failed', { executionId, error: (err as Error).message });
      });
    }
    return entry;
  }

  async cancel(id: string): Promise<void> {
    const execBeforeCancel = await this.stateManager.getExecution(id).catch(() => null);
    // Kill workflow engine if running
    const engine = runningEngines.get(id);
    if (engine) {
      engine.cancelExecution(id);
    }
    // Kill spawned agent process (CLI subprocess or abort SDK)
    const { killExecutionProcess } = await import('./chat-tools.js');
    const killed = killExecutionProcess(id);
    if (killed) logger.warn('killing execution process', { executionId: id });

    // Clear currentNodes so the UI stops rendering the aborted nodes as
    // "running". The engine writes cancelled/failed trace rows for the
    // in-flight nodes in its catch paths; the list itself is no longer
    // meaningful once the run is cancelled.
    await this.stateManager.updateExecution(id, {
      status: 'cancelled',
      completedAt: new Date(),
      currentNodes: [],
    });
    await this.ensureCancelledSpawnTrace(execBeforeCancel).catch((err) => {
      logger.warn('failed to persist cancelled spawned-agent trace fallback', { executionId: id, error: (err as Error).message });
    });
  }

  private async ensureCancelledSpawnTrace(exec: ExecutionState | null): Promise<void> {
    if (!exec) return;
    const workflowName = String(exec.workflowName ?? '');
    const source = String((exec as unknown as Record<string, unknown>).source ?? '');
    const isSpawnedAgent = workflowName.includes(':spawn_agent/') || source === 'spawn';
    if (!isSpawnedAgent) return;
    const input = (exec.input ?? {}) as Record<string, unknown>;
    const agentName = workflowName.includes(':spawn_agent/')
      ? workflowName.split(':spawn_agent/')[1]
      : String(input.agent_name ?? exec.currentNodes?.[0] ?? 'agent');
    if (!agentName) return;
    const existing = await this.db.collection('execution_traces')
      .find({ executionId: exec.id, node: agentName }, { projection: { attempt: 1 } })
      .sort({ attempt: -1 })
      .limit(1)
      .toArray();
    const attempt = Math.max(1, Number(existing[0]?.attempt ?? 0) + 1);
    const contextAttempt = await this.db.collection('context_attempts').findOne(
      { executionId: exec.id, nodeName: agentName },
      { sort: { createdAt: -1 }, projection: { contextAttemptId: 1 } },
    );
    const now = new Date();
    const startedAt = exec.startedAt ? new Date(exec.startedAt) : now;
    const durationMs = Math.max(0, now.getTime() - startedAt.getTime());
    await this.db.collection('execution_traces').updateOne(
      { executionId: exec.id, node: agentName, attempt },
      {
        $setOnInsert: {
          executionId: exec.id,
          executionTraceId: randomUUID(),
          node: agentName,
          attempt,
          status: 'cancelled',
          type: 'agent',
          agent: agentName,
          inputState: { prompt: input.prompt },
          renderedPrompt: typeof input.prompt === 'string' ? input.prompt : '',
          rawResponse: '',
          output: { cancelled: true, reason: 'Execution cancelled by user.', session_id: input.session_id },
          toolCalls: [],
          activity: [],
          contextAttemptId: typeof contextAttempt?.contextAttemptId === 'string' ? contextAttempt.contextAttemptId : undefined,
          runtimeContext: {
            mandatoryRepoContextInjected: Boolean(contextAttempt),
          },
          cost: { actual: 0, estimated: 0, method: 'cancelled_fallback' },
          durationMs,
          startedAt,
          completedAt: now,
        },
      },
      { upsert: true },
    );
  }

  async pause(id: string): Promise<void> {
    const engine = runningEngines.get(id);
    if (engine) {
      engine.pauseExecution(id);
    }
    await this.stateManager.updateExecution(id, { status: 'waiting_for_input' as never });
  }

  async resume(id: string): Promise<void> {
    const engine = runningEngines.get(id);
    if (engine) {
      engine.resumeExecution(id);
    }
    await this.stateManager.updateExecution(id, { status: 'running' as never });

    // ── Watcher reactivation ─────────────────────────────────────────────
    setImmediate(async () => {
      try {
        const { WatcherService } = await import('./watcher.service.js');
        const { ChatService } = await import('./chat.service.js');
        await new WatcherService(this.db, new ChatService(this.db)).reactivate(id, 'engine');
      } catch (err) {
        logger.warn('[execution] Watcher reactivation failed after engine resume', {
          component: 'execution',
          executionId: id,
          error: (err as Error).message,
        });
      }
    });
  }

  async submitInput(id: string, node: string, data: Record<string, unknown>): Promise<boolean> {
    const engine = runningEngines.get(id);
    if (engine) {
      return engine.submitInput(id, node, data);
    }
    return false;
  }

  /**
   * List every checkpoint for an execution. Lightweight — returns docs as-is
   * from Mongo with _id serialized as string. Caller decides whether to
   * preview `state` or fetch full.
   */
  async listCheckpoints(executionId: string): Promise<Record<string, unknown>[]> {
    const docs = await this.stateManager.listCheckpoints(executionId);
    return docs.map((d) => ({
      ...d,
      _id: d._id.toString(),
      editedBy: (d as unknown as { editedBy?: unknown }).editedBy
        ? String((d as unknown as { editedBy: unknown }).editedBy)
        : undefined,
    }));
  }

  async getCheckpoint(
    executionId: string,
    checkpointId: string,
  ): Promise<Record<string, unknown> | null> {
    const doc = await this.stateManager.getCheckpointById(executionId, checkpointId);
    if (!doc) return null;
    return {
      ...doc,
      _id: doc._id.toString(),
      editedBy: (doc as unknown as { editedBy?: unknown }).editedBy
        ? String((doc as unknown as { editedBy: unknown }).editedBy)
        : undefined,
    };
  }

  /**
   * Edit a checkpoint's state. Refuses while the execution is actively
   * running or waiting on human input — would race with the engine that's
   * about to write a new checkpoint.
   */
  async updateCheckpoint(
    executionId: string,
    checkpointId: string,
    updates: { state?: Record<string, unknown> },
    editedBy?: string,
  ): Promise<Record<string, unknown> | null> {
    const exec = await this.stateManager.getExecution(executionId);
    if (!exec) throw new Error('Execution not found');
    if (exec.status === 'running' || exec.status === 'waiting_for_input') {
      const err = new Error('Cannot edit a checkpoint while execution is active');
      (err as unknown as { statusCode: number }).statusCode = 409;
      throw err;
    }
    if (updates.state !== undefined && (typeof updates.state !== 'object' || updates.state === null)) {
      const err = new Error('`state` must be a plain object');
      (err as unknown as { statusCode: number }).statusCode = 400;
      throw err;
    }
    const updated = await this.stateManager.updateCheckpoint(
      executionId,
      checkpointId,
      { state: updates.state, editedBy },
    );
    if (!updated) return null;
    return {
      ...updated,
      _id: updated._id.toString(),
      editedBy: (updated as unknown as { editedBy?: unknown }).editedBy
        ? String((updated as unknown as { editedBy: unknown }).editedBy)
        : undefined,
    };
  }

  /**
   * Resume the SAME execution from a specific checkpoint. Only allowed when
   * the execution is failed or cancelled — matches the user-facing rule.
   */
  async runFromCheckpoint(
    executionId: string,
    checkpointId: string,
  ): Promise<Record<string, unknown>> {
    const exec = await this.stateManager.getExecution(executionId);
    if (!exec) throw new Error('Execution not found');
    if (exec.status !== 'failed' && exec.status !== 'cancelled' && exec.status !== 'completed') {
      const err = new Error(`Can only run-from-checkpoint when status is completed, failed, or cancelled (was: ${exec.status})`);
      (err as unknown as { statusCode: number }).statusCode = 409;
      throw err;
    }

    const workflowDoc = exec.workflowId
      ? await this.db.collection('workflows').findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(exec.workflowId) })
      : await this.db.collection('workflows').findOne({ name: exec.workflowName });
    if (!workflowDoc) throw new Error('Workflow not found');

    const workflow = workflowDoc.parsed as WorkflowDef;
    const baseEmitter = createSSEEmitter(executionId);
    const emitter = this.wrapEmitterWithInterventionHook(
      baseEmitter,
      executionId,
      workflow,
      (exec.input ?? {}) as Record<string, unknown>,
    );

    const allWorkflowDocs = await this.db.collection('workflows').find({}).toArray();
    const workflows: Record<string, WorkflowDef> = {};
    for (const doc of allWorkflowDocs) {
      workflows[(doc.parsed as WorkflowDef).name] = doc.parsed as WorkflowDef;
    }

    const _aliasMapResult = await buildAliasAndCostMaps(this.db).catch(() => undefined);
    const config: EngineConfig = {
      db: this.db,
      agents: await loadAllAgents(this.db),
      builtIns: getBuiltIns(),
      workflows,
      emitter,
      services: buildEngineServices(this.db),
      discoverMcpToolNames: async () => {
        // Lazy-import to avoid pulling chat-mcp-client into engine type
        // resolution. Cached behind chat-mcp-client's connection map, so
        // repeated workflow runs reuse the same MCP subprocesses.
        try {
          const { loadMcpTools } = await import('./chat-mcp-client.js');
          const tools = await loadMcpTools(this.db);
          return tools.map(t => t.fullName);
        } catch (err) {
          logger.warn('MCP tool discovery failed for workflow run', { component: 'engine', error: (err as Error).message });
          return [];
        }
      },
      claudeCodeExecutable: resolveClaudeCodeExecutable(),
      buildClaudeCompatibleEnvOverlay,
      aliasMap: _aliasMapResult?.aliasMap,
      costMap: _aliasMapResult?.costMap,
    };

    const engine = new AllenEngine(config);
    runningEngines.set(executionId, engine);

    engine.runFromCheckpoint(workflow, executionId, checkpointId)
      .catch(() => {})
      .finally(() => runningEngines.delete(executionId));

    // ── Watcher reactivation ─────────────────────────────────────────────
    setImmediate(async () => {
      try {
        const { WatcherService } = await import('./watcher.service.js');
        const { ChatService } = await import('./chat.service.js');
        await new WatcherService(this.db, new ChatService(this.db)).reactivate(executionId, 'checkpoint');
      } catch (err) {
        logger.warn('[execution] Watcher reactivation failed after checkpoint resume', {
          component: 'execution',
          executionId,
          error: (err as Error).message,
        });
      }
    });

    return { id: executionId, status: 'running', resumingFromCheckpoint: checkpointId };
  }

  /**
   * Fork a new execution from a specific checkpoint. Creates a fresh
   * execution id inheriting the checkpoint's state. Fire-and-forget — the
   * HTTP response returns the new id immediately; execution runs in the
   * background.
   */
  async forkFromCheckpoint(
    executionId: string,
    checkpointId: string,
    ownerId?: string,
  ): Promise<Record<string, unknown>> {
    const exec = await this.stateManager.getExecution(executionId);
    if (!exec) throw new Error('Execution not found');

    const workflowDoc = exec.workflowId
      ? await this.db.collection('workflows').findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(exec.workflowId) })
      : await this.db.collection('workflows').findOne({ name: exec.workflowName });
    if (!workflowDoc) throw new Error('Workflow not found');

    const workflow = workflowDoc.parsed as WorkflowDef;
    const allWorkflowDocs = await this.db.collection('workflows').find({}).toArray();
    const workflows: Record<string, WorkflowDef> = {};
    for (const doc of allWorkflowDocs) {
      workflows[(doc.parsed as WorkflowDef).name] = doc.parsed as WorkflowDef;
    }

    // Preallocate the new execution id so we can return it synchronously
    // and register the SSE emitter before the engine starts emitting.
    const { randomUUID } = await import('node:crypto');
    const newExecutionId = randomUUID();
    const baseEmitter = createSSEEmitter(newExecutionId);
    const emitter = this.wrapEmitterWithInterventionHook(
      baseEmitter,
      newExecutionId,
      workflow,
      (exec.input ?? {}) as Record<string, unknown>,
    );

    const _aliasMapResult = await buildAliasAndCostMaps(this.db).catch(() => undefined);
    const config: EngineConfig = {
      db: this.db,
      agents: await loadAllAgents(this.db),
      builtIns: getBuiltIns(),
      workflows,
      emitter,
      services: buildEngineServices(this.db),
      discoverMcpToolNames: async () => {
        // Lazy-import to avoid pulling chat-mcp-client into engine type
        // resolution. Cached behind chat-mcp-client's connection map, so
        // repeated workflow runs reuse the same MCP subprocesses.
        try {
          const { loadMcpTools } = await import('./chat-mcp-client.js');
          const tools = await loadMcpTools(this.db);
          return tools.map(t => t.fullName);
        } catch (err) {
          logger.warn('MCP tool discovery failed for workflow run', { component: 'engine', error: (err as Error).message });
          return [];
        }
      },
      claudeCodeExecutable: resolveClaudeCodeExecutable(),
      buildClaudeCompatibleEnvOverlay,
      aliasMap: _aliasMapResult?.aliasMap,
      costMap: _aliasMapResult?.costMap,
    };

    const engine = new AllenEngine(config);
    runningEngines.set(newExecutionId, engine);

    // Fire-and-forget — the forked workflow runs independently. HTTP
    // response returns the id immediately so the caller can navigate to
    // /executions/<newExecutionId> and watch the stream.
    engine.forkFromCheckpoint(workflow, executionId, checkpointId, { ownerId, newExecutionId })
      .catch(() => { /* engine writes failure report; route already returned */ })
      .finally(() => runningEngines.delete(newExecutionId));

    return { sourceExecutionId: executionId, newExecutionId, status: 'running' };
  }

  async retryFromNode(executionId: string, nodeName: string): Promise<Record<string, unknown>> {
    const exec = await this.stateManager.getExecution(executionId);
    if (!exec) throw new Error('Execution not found');

    const workflowDoc = exec.workflowId
      ? await this.db.collection('workflows').findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(exec.workflowId) })
      : await this.db.collection('workflows').findOne({ name: exec.workflowName });
    if (!workflowDoc) throw new Error('Workflow not found');

    const workflow = workflowDoc.parsed as WorkflowDef;
    const baseEmitter = createSSEEmitter(executionId);
    const emitter = this.wrapEmitterWithInterventionHook(
      baseEmitter,
      executionId,
      workflow,
      (exec.input ?? {}) as Record<string, unknown>,
    );

    const allWorkflowDocs = await this.db.collection('workflows').find({}).toArray();
    const workflows: Record<string, WorkflowDef> = {};
    for (const doc of allWorkflowDocs) {
      workflows[(doc.parsed as WorkflowDef).name] = doc.parsed as WorkflowDef;
    }

    const _aliasMapResult = await buildAliasAndCostMaps(this.db).catch(() => undefined);
    const config: EngineConfig = {
      db: this.db,
      agents: await loadAllAgents(this.db),
      builtIns: getBuiltIns(),
      workflows,
      emitter,
      services: buildEngineServices(this.db),
      discoverMcpToolNames: async () => {
        // Lazy-import to avoid pulling chat-mcp-client into engine type
        // resolution. Cached behind chat-mcp-client's connection map, so
        // repeated workflow runs reuse the same MCP subprocesses.
        try {
          const { loadMcpTools } = await import('./chat-mcp-client.js');
          const tools = await loadMcpTools(this.db);
          return tools.map(t => t.fullName);
        } catch (err) {
          logger.warn('MCP tool discovery failed for workflow run', { component: 'engine', error: (err as Error).message });
          return [];
        }
      },
      claudeCodeExecutable: resolveClaudeCodeExecutable(),
      buildClaudeCompatibleEnvOverlay,
      aliasMap: _aliasMapResult?.aliasMap,
      costMap: _aliasMapResult?.costMap,
    };

    const engine = new AllenEngine(config);
    runningEngines.set(executionId, engine);

    engine.retryFromNode(workflow, executionId, nodeName)
      .catch(() => {})
      .finally(() => {
        runningEngines.delete(executionId);
        this.enqueueWorkflowContextEvaluation(executionId, 'retry_terminal', true).catch((err) => {
          logger.warn('workflow context semantic evaluation enqueue after retry failed', { executionId, error: (err as Error).message });
        });
      });

    return { id: executionId, status: 'running', retryingFrom: nodeName };
  }

  async getTraces(executionId: string): Promise<Record<string, unknown>[]> {
    const traces = await this.stateManager.getTraces(executionId);
    const withHumanInterventions = await this.withSyntheticHumanInterventionTraces(executionId, traces);
    return hydrateTraceContextEvaluations(this.db, executionId, withHumanInterventions);
  }

  async getTracesByNode(executionId: string, node: string): Promise<Record<string, unknown>[]> {
    const traces = await this.getTraces(executionId);
    return traces.filter((trace) => String(trace.node ?? '') === node);
  }

  async getTraceByAttempt(executionId: string, node: string, attempt: number): Promise<Record<string, unknown> | null> {
    const traces = await this.getTracesByNode(executionId, node);
    return traces.find((trace) => Number(trace.attempt ?? 1) === attempt) ?? null;
  }

  private async withSyntheticHumanInterventionTraces(
    executionId: string,
    traces: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const interventions = await new InterventionService(this.db).listForWorkflowRun(executionId).catch(() => []);
    const answered = interventions.filter((item) => item.status === 'answered' || item.status === 'skipped');
    if (answered.length === 0) return traces;

    const byNode = new Map<string, Record<string, unknown>[]>();
    for (const trace of traces) {
      const node = stringValue(trace.node);
      if (!node) continue;
      const list = byNode.get(node) ?? [];
      list.push(trace);
      byNode.set(node, list);
    }

    const synthetic: Record<string, unknown>[] = [];
    for (const intervention of answered) {
      const node = intervention.stage;
      if (!node || (byNode.get(node)?.length ?? 0) > 0) continue;
      const response = intervention.response ?? null;
      const startedAt = intervention.created_at ?? intervention.answered_at ?? new Date();
      const completedAt = intervention.answered_at ?? intervention.created_at ?? new Date();
      const startedMs = new Date(startedAt).getTime();
      const completedMs = new Date(completedAt).getTime();
      const durationMs = Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? Math.max(0, completedMs - startedMs)
        : 0;

      synthetic.push({
        executionId,
        executionTraceId: `human-${intervention.intervention_id}`,
        node,
        attempt: 1,
        status: intervention.status === 'skipped' ? 'skipped' : 'completed',
        type: 'human',
        agent: null,
        inputState: {
          question: intervention.question,
          fields: intervention.fields,
          intervention_id: intervention.intervention_id,
        },
        renderedPrompt: intervention.question ?? intervention.context_summary ?? '',
        output: {
          human_input: {
            kind: intervention.kind,
            sourceNode: node,
            decision: response?.decision,
            summary: response?.decision ? `Human selected ${response.decision}` : undefined,
            fields: [],
            fieldsByName: {},
            feedback: response?.feedback ? { label: 'Feedback', value: response.feedback } : undefined,
          },
          intervention_id: intervention.intervention_id,
          decision: response?.decision,
          feedback: response?.feedback,
          answer: response?.answer,
        },
        rawResponse: response
          ? compactJsonValue(response) ?? ''
          : '',
        activity: [],
        cost: { actual: 0, estimated: 0, method: 'human_intervention' },
        durationMs,
        startedAt,
        completedAt,
        synthetic: true,
      });
    }

    if (synthetic.length === 0) return traces;
    return [...traces, ...synthetic].sort((a, b) => {
      const aTime = new Date(String(a.startedAt ?? a.completedAt ?? 0)).getTime();
      const bTime = new Date(String(b.startedAt ?? b.completedAt ?? 0)).getTime();
      return aTime - bTime;
    });
  }

  async getStats(): Promise<Record<string, unknown>> {
    return this.stateManager.getExecutionStats();
  }

  /**
   * Fetch the spawn-tree children of an execution. The workflow-node view
   * uses this to show "what did develop spawn" under each node, and the
   * "Show all descendants" toggle uses it with mode='descendants' to see
   * the whole subtree at any depth.
   *
   * mode='direct'      → rows where parentExecutionId === id
   * mode='descendants' → rows where rootExecutionId === id (includes id itself
   *                      if the exec is its own root; we filter that out here)
   *
   * Returns a compact projection with the fields the UI needs — no rawResponse,
   * no full state, no cost history. The full rows are available via GET
   * /api/executions/:childId for deep inspection.
   */
  async getChildren(
    id: string,
    mode: 'direct' | 'descendants',
  ): Promise<Record<string, unknown>[]> {
    const filter = mode === 'descendants'
      ? { rootExecutionId: id, id: { $ne: id } }
      : { parentExecutionId: id };
    const rows = await this.db
      .collection('executions')
      .find(filter, { projection: CHILDREN_PROJECTION })
      .sort({ startedAt: 1 })
      .toArray();

    // Execution rows store no cost — hydrate each child's own-trace cost in
    // one batch aggregation so the children panel still shows per-row spend.
    const ids = rows.map((r) => r.id as string).filter(Boolean);
    const ownCosts = await new CostRollupService(this.db)
      .getOwnCosts(ids)
      .catch(() => new Map<string, never>());
    for (const row of rows) {
      const own = ownCosts.get(row.id as string);
      if (own) {
        row.cost = { actual: own.costUsd, estimated: own.estimatedUsd };
        row.tokenUsage = {
          inputCachedTokens: own.inputCachedTokens,
          inputNonCachedTokens: own.inputNonCachedTokens,
          outputTokens: own.outputTokens,
        };
      }
    }

    return rows.map(row => decorateChildRow(row, 'direct'));
  }

  private inferOrigin(exec: Record<string, unknown>, assignment: Record<string, unknown> | null): string {
    const meta = (exec.meta ?? {}) as Record<string, unknown>;
    if (stringValue(meta.origin)) return stringValue(meta.origin)!;
    if (assignment?.linearIssueId || meta.linearIssueId) return 'linear';
    if (exec.source === 'chat') return 'chat';
    if (exec.source === 'spawn') return 'workflow';
    if (String(exec.workflowName ?? '').includes(':spawn_agent/')) return 'direct_agent';
    return 'workflow';
  }

  private executionTitle(
    workflowName: string,
    input: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): string {
    return executionDisplayTitle(input, meta, workflowName);
  }

  private async listItemContext(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = stringValue(item.id) ?? '';
    const workflowName = stringValue(item.workflowName) ?? '';
    const input = ((item.input ?? {}) as Record<string, unknown>) ?? {};
    const state = ((item.state ?? {}) as Record<string, unknown>) ?? {};
    const meta = ((item.meta ?? {}) as Record<string, unknown>) ?? {};
    const isAgentExecution = workflowName.includes(':spawn_agent/')
      || item.source === 'spawn'
      || (!item.workflowId && item.source === 'chat');

    const workspace = await this.findExecutionWorkspace(input, state, meta);
    const repository = workspace ? null : await this.findExecutionRepository(input, state, meta);
    const assignment = id ? await this.findExecutionAssignment(id, workspace, input, state, meta) : null;
    const pullRequest = id ? await this.findExecutionPullRequest(id, workspace, input, state, meta, [item]) : null;
    const chatSummary = await this.runChatSummary(input, meta);

    return {
      ...item,
      type: isAgentExecution ? 'agent' : 'workflow',
      origin: this.inferOrigin(item, assignment),
      title: this.executionTitle(workflowName, input, meta),
      user: this.runUserSummary(meta, chatSummary),
      chat: chatSummary,
      linear: this.linearContext(assignment, input, state, meta),
      workspace: workspace ? this.workspaceContext(workspace) : null,
      repository: repository ? this.repositoryContext(repository) : null,
      pullRequest: pullRequest ? this.pullRequestContext(pullRequest) : null,
    };
  }

  private runUserSummary(
    meta: Record<string, unknown>,
    chatSummary: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const userId = stringValue(meta.startedByUserId) ?? stringValue(chatSummary?.userId);
    const name = stringValue(meta.startedByUserName) ?? stringValue(chatSummary?.userName);
    const email = stringValue(meta.startedByUserEmail) ?? stringValue(chatSummary?.userEmail);
    if (!userId && !name && !email) return null;
    return { userId: userId ?? null, name: name ?? null, email: email ?? null };
  }

  private async runChatSummary(
    input: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const sessionId = stringValue(meta.chatSessionId)
      ?? stringValue(input.chatSessionId)
      ?? stringValue(input.sessionId)
      ?? stringValue(input.chat_session_id);
    if (!sessionId) return null;

    let title: string | null = null;
    let userId: string | null = stringValue(meta.startedByUserId) ?? null;
    let userName: string | null = stringValue(meta.startedByUserName) ?? null;
    let userEmail: string | null = stringValue(meta.startedByUserEmail) ?? null;

    const session = ObjectId.isValid(sessionId)
      ? await this.db.collection('chat_sessions').findOne(
          { _id: new ObjectId(sessionId) },
          {
            projection: {
              title: 1,
              ownerUserId: 1,
              ownerName: 1,
              ownerEmail: 1,
              source: 1,
            },
          },
        ).catch(() => null)
      : null;

    if (session) {
      title = stringValue(session.title) ?? null;
      userId = userId ?? stringValue(session.ownerUserId) ?? null;
      userName = userName ?? stringValue(session.ownerName) ?? null;
      userEmail = userEmail ?? stringValue(session.ownerEmail) ?? null;
    }

    if ((!userId || !userName || !userEmail) && ObjectId.isValid(sessionId)) {
      const firstUserMessage = await this.db.collection('chat_messages').findOne(
        { sessionId, role: 'user' },
        {
          sort: { createdAt: 1 },
          projection: { senderUserId: 1, senderName: 1, senderEmail: 1 },
        },
      ).catch(() => null);
      userId = userId ?? stringValue(firstUserMessage?.senderUserId) ?? null;
      userName = userName ?? stringValue(firstUserMessage?.senderName) ?? null;
      userEmail = userEmail ?? stringValue(firstUserMessage?.senderEmail) ?? null;
    }

    if ((!userName || !userEmail) && userId && ObjectId.isValid(userId)) {
      const user = await this.db.collection('users').findOne(
        { _id: new ObjectId(userId) },
        { projection: { name: 1, email: 1 } },
      ).catch(() => null);
      userName = userName ?? stringValue(user?.name) ?? null;
      userEmail = userEmail ?? stringValue(user?.email) ?? null;
    }

    return {
      sessionId,
      title,
      userId,
      userName,
      userEmail,
    };
  }

  private async attachChatMetadataFromMessages(items: Record<string, unknown>[]): Promise<void> {
    const missingIds = items
      .filter((item) => {
        const meta = ((item.meta ?? {}) as Record<string, unknown>) ?? {};
        return !stringValue(meta.chatSessionId);
      })
      .map((item) => stringValue(item.id))
      .filter((id): id is string => Boolean(id));

    if (missingIds.length === 0) return;

    const messages = await this.db.collection('chat_messages')
      .find({
        role: 'assistant',
        $or: [
          { 'toolCalls.result.id': { $in: missingIds } },
          { 'toolCalls.result.execution_id': { $in: missingIds } },
        ],
      }, {
        projection: { _id: 1, sessionId: 1, toolCalls: 1, createdAt: 1 },
      })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()
      .catch(() => []);

    if (messages.length === 0) return;

    const linkByExecution = new Map<string, { chatSessionId: string; parentMessageId: string }>();
    const ids = new Set(missingIds);
    for (const message of messages) {
      const sessionId = stringValue(message.sessionId);
      const parentMessageId = String(message._id ?? '');
      if (!sessionId || !parentMessageId) continue;
      for (const call of ((message.toolCalls ?? []) as Array<Record<string, unknown>>)) {
        const result = ((call.result ?? {}) as Record<string, unknown>) ?? {};
        const executionId = stringValue(result.id) ?? stringValue(result.execution_id);
        if (!executionId || !ids.has(executionId) || linkByExecution.has(executionId)) continue;
        linkByExecution.set(executionId, { chatSessionId: sessionId, parentMessageId });
      }
    }

    if (linkByExecution.size === 0) return;

    for (const item of items) {
      const id = stringValue(item.id);
      if (!id) continue;
      const link = linkByExecution.get(id);
      if (!link) continue;
      const meta = ((item.meta ?? {}) as Record<string, unknown>) ?? {};
      item.source = item.source ?? 'chat';
      item.meta = {
        ...meta,
        origin: stringValue(meta.origin) ?? 'chat',
        chatSessionId: link.chatSessionId,
        parentMessageId: stringValue(meta.parentMessageId) ?? link.parentMessageId,
      };
    }

    await this.db.collection('executions').bulkWrite(
      [...linkByExecution.entries()].map(([executionId, link]) => ({
        updateOne: {
          filter: { id: executionId, 'meta.chatSessionId': { $exists: false } },
          update: {
            $set: {
              source: 'chat',
              'meta.origin': 'chat',
              'meta.chatSessionId': link.chatSessionId,
              'meta.parentMessageId': link.parentMessageId,
            },
          },
        },
      })),
      { ordered: false },
    ).catch(() => {});
  }

  private currentStep(exec: ExecutionState, isAgentExecution: boolean, traces: Record<string, unknown>[]): string | null {
    if (exec.status === 'waiting_for_input') {
      return exec.currentNodes?.[0] ?? 'waiting for input';
    }
    if (exec.status === 'failed') return exec.failedNode ?? 'failed';
    if (exec.status === 'completed' || CANCELLED_STATUSES.has(exec.status)) return null;
    if (exec.currentNodes?.length) return exec.currentNodes.filter(n => n !== 'END').join(', ');
    if (isAgentExecution) {
      const latest = [...traces].sort(
        (a, b) => new Date(b.startedAt as string | Date | undefined ?? 0).getTime()
          - new Date(a.startedAt as string | Date | undefined ?? 0).getTime(),
      )[0];
      return stringValue(latest?.node) ?? null;
    }
    return exec.completedNodes?.[exec.completedNodes.length - 1] ?? null;
  }

  private phaseForExecution(
    exec: ExecutionState,
    logs: Record<string, unknown>[],
    activity: PersistedActivityRow[],
  ): RunPhase {
    if (exec.status === 'queued') return 'queued';
    if (exec.status === 'waiting_for_input') return 'waiting_for_human';
    if (exec.status === 'completed') return 'completed';
    if (exec.status === 'failed') return 'failed';
    if (exec.status === 'cancelled') return 'cancelled';
    const currentStep = (exec.currentNodes ?? []).join(' ');
    if (/\b(review|validate|validation|approve|qa)\b/i.test(currentStep)) return 'reviewing';
    if (/\b(test|qa|verify)\b/i.test(currentStep)) return 'testing';
    if (/\b(develop|implement|code|edit|build|fix)\b/i.test(currentStep)) return 'editing';
    if (/\b(plan|intake|scope|design|requirements?)\b/i.test(currentStep)) return 'planning';
    const recentText = logs
      .slice(0, 8)
      .map((l) => `${l.type ?? ''} ${l.event ?? ''} ${l.message ?? ''} ${l.content ?? ''} ${l.tool ?? ''} ${l.command ?? ''}`)
      .concat(activity.slice(-8).map((a) => `${a.type} ${a.tool ?? ''} ${a.content ?? ''}`))
      .join('\n');
    if (/\b(gh pr create|open.*pr|pull request|git push)\b/i.test(recentText)) return 'opening_pr';
    if (/\b(vitest|pytest|npm test|pnpm test|playwright|test)\b/i.test(recentText)) return 'testing';
    if (/\b(apply_patch|edit|write|save file|create file|patch)\b/i.test(recentText)) return 'editing';
    if (/\b(read|grep|rg|glob|sed|inspect|search|list)\b/i.test(recentText)) return 'inspecting';
    if (/\b(plan|todo|requirements?|design)\b/i.test(recentText)) return 'planning';
    return 'running';
  }

  private async findExecutionWorkspace(
    input: Record<string, unknown>,
    state: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const workspaceId =
      stringValue(meta.workspaceId)
      ?? stringValue(state.workspace_id)
      ?? stringValue(input.workspace_id);
    if (workspaceId && ObjectId.isValid(workspaceId)) {
      const ws = await this.db.collection('workspaces').findOne({ _id: new ObjectId(workspaceId) });
      if (ws) return ws;
    }

    const workspacePath =
      stringValue(meta.workspacePath)
      ?? stringValue(state.worktree_path)
      ?? stringValue(input.worktree_path)
      ?? stringValue(input.repo_path)
      ?? stringValue(meta.cwd);
    if (workspacePath) {
      const ws = await this.db.collection('workspaces').findOne({ worktreePath: workspacePath });
      if (ws) return ws;
    }
    return null;
  }

  private async findExecutionRepository(
    input: Record<string, unknown>,
    state: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const repoId =
      stringValue(meta.repoId)
      ?? stringValue(state.repo_id)
      ?? stringValue(input.repo_id);
    if (repoId && ObjectId.isValid(repoId)) {
      const repo = await this.db.collection('repos').findOne({ _id: new ObjectId(repoId) });
      if (repo) return repo;
    }

    const repoPath =
      stringValue(meta.repoPath)
      ?? stringValue(state.repo_path)
      ?? stringValue(input.repo_path)
      ?? stringValue(meta.cwd);
    if (!repoPath) return null;
    return this.db.collection('repos').findOne({ path: repoPath });
  }

  private async findExecutionAssignment(
    executionId: string,
    workspace: Record<string, unknown> | null,
    input: Record<string, unknown>,
    state: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const ors: Record<string, unknown>[] = [{ executionId }];
    const workspaceId = workspace?._id ? String(workspace._id) : undefined;
    const workspacePath = stringValue(workspace?.worktreePath) ?? stringValue(meta.workspacePath);
    if (workspaceId) ors.push({ workspaceId });
    if (workspacePath) ors.push({ workspacePath });
    const issueId =
      stringValue(meta.linearIssueId)
      ?? stringValue(input.linear_issue_id)
      ?? stringValue(state.linear_issue_id);
    if (issueId) ors.push({ linearIssueId: issueId });
    return this.db.collection('ticket_assignments').findOne({ $or: ors });
  }

  private async findExecutionPullRequest(
    executionId: string,
    workspace: Record<string, unknown> | null,
    input: Record<string, unknown>,
    state: Record<string, unknown>,
    meta: Record<string, unknown>,
    evidence: unknown[] = [],
  ): Promise<Record<string, unknown> | null> {
    const ors: Record<string, unknown>[] = [
      { originatingExecutionId: executionId },
      { 'resolutionInProgress.executionId': executionId },
    ];
    const workspaceId = workspace?._id ? String(workspace._id) : undefined;
    if (workspaceId) ors.push({ workspaceId });
    const prUrl = firstGithubPullRequestUrl([
      state.pr_url,
      state.url,
      input.pr_url,
      input.url,
      meta.prUrl,
      meta.url,
      workspace?.prUrl,
      state,
      input,
      meta,
      ...evidence,
    ]);
    if (prUrl) ors.push({ url: prUrl });
    const stored = await this.db.collection('pull_requests').findOne({ $or: ors }, { sort: { updatedAt: -1 } });
    if (stored) return stored;
    if (!prUrl) return null;
    const numberMatch = prUrl.match(/\/pull\/(\d+)/i);
    return {
      number: numberMatch ? Number(numberMatch[1]) : null,
      title: stringValue(state.pr_title) ?? stringValue(input.pr_title) ?? stringValue(meta.prTitle) ?? null,
      url: prUrl,
      status: stringValue(state.pr_status) ?? stringValue(input.pr_status) ?? stringValue(meta.prStatus) ?? 'open',
      branch: stringValue(state.branch_name) ?? stringValue(state.branch) ?? stringValue(input.branch_name) ?? stringValue(input.branch) ?? stringValue(workspace?.branch) ?? null,
      baseBranch: stringValue(state.base_branch) ?? stringValue(input.base_branch) ?? stringValue(workspace?.baseBranch) ?? null,
      createdAt: state.pr_created_at ?? input.pr_created_at ?? meta.prCreatedAt ?? null,
      updatedAt: state.pr_updated_at ?? input.pr_updated_at ?? meta.prUpdatedAt ?? null,
      mergedAt: state.pr_merged_at ?? input.pr_merged_at ?? meta.prMergedAt ?? null,
    };
  }

  private async findExecutionArtifacts(
    executionId: string,
    isAgentExecution: boolean,
    row: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const exactRoots: Array<Record<string, unknown>> = [
      { rootType: isAgentExecution ? 'agent' : 'workflow', rootId: executionId },
    ];
    const scopedRoots: Array<Record<string, unknown>> = [];
    const chatSessionId = stringValue(meta.chatSessionId);
    if (chatSessionId) scopedRoots.push({ rootType: 'chat', rootId: chatSessionId });
    const rootExecutionId = stringValue(row.rootExecutionId);
    if (rootExecutionId && rootExecutionId !== executionId) {
      scopedRoots.push({ rootType: 'workflow', rootId: rootExecutionId });
    }
    const scopedArtifactClauses = scopedRoots.flatMap((root) => [
      { ...root, 'spawnContext.agentExecutionId': executionId },
      { ...root, 'spawnContext.parentId': executionId },
    ]);
    const clauses = [...exactRoots, ...scopedArtifactClauses];
    return this.db
      .collection('artifacts')
      .find({ $or: clauses })
      .sort({ createdAt: -1 })
      .limit(50)
      .project({
        _id: 0,
        artifactId: 1,
        rootType: 1,
        rootId: 1,
        filename: 1,
        relativePath: 1,
        contentType: 1,
        sizeBytes: 1,
        description: 1,
        createdAt: 1,
        spawnContext: 1,
      })
      .toArray();
  }

  private linearContext(
    assignment: Record<string, unknown> | null,
    input: Record<string, unknown>,
    state: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const identifier =
      stringValue(meta.linearIdentifier)
      ?? stringValue(input.linear_identifier)
      ?? stringValue(input.ticket_id)
      ?? stringValue(state.linear_identifier)
      ?? stringValue(state.ticket_id);
    const url = firstUrl([meta.linearUrl, input.linear_url, input.ticket_url, state.linear_url, state.ticket_url], /linear\.app/i);
    const issueId = stringValue(assignment?.linearIssueId) ?? stringValue(meta.linearIssueId) ?? stringValue(input.linear_issue_id);
    if (!assignment && !identifier && !url && !issueId) return null;
    return {
      issueId,
      identifier,
      title: stringValue(meta.linearTitle) ?? stringValue(input.linear_title) ?? stringValue(state.linear_title),
      url,
      assignment: assignment ? {
        status: assignment.status ?? null,
        targetKind: assignment.targetKind ?? null,
        targetName: assignment.targetName ?? assignment.agentName ?? assignment.workflowName ?? null,
        assignedBy: assignment.assignedBy ?? null,
        assignedAt: assignment.assignedAt ?? null,
      } : null,
    };
  }

  private workspaceContext(workspace: Record<string, unknown>): Record<string, unknown> {
    return {
      id: String(workspace._id),
      name: workspace.name ?? null,
      status: workspace.status ?? null,
      repoId: workspace.repoId ?? null,
      repoName: workspace.repoName ?? null,
      branch: workspace.branch ?? null,
      baseBranch: workspace.baseBranch ?? null,
      worktreePath: workspace.worktreePath ?? null,
      prUrl: workspace.prUrl ?? null,
    };
  }

  private repositoryContext(repo: Record<string, unknown>): Record<string, unknown> {
    return {
      id: repo._id ? String(repo._id) : undefined,
      name: repo.name ?? null,
      path: repo.path ?? null,
      defaultBranch: repo.defaultBranch ?? null,
      status: repo.status ?? null,
    };
  }

  private pullRequestContext(pr: Record<string, unknown>): Record<string, unknown> {
    return {
      id: pr._id ? String(pr._id) : undefined,
      number: pr.number ?? null,
      title: pr.title ?? null,
      url: pr.url ?? null,
      status: pr.status ?? null,
      branch: pr.branch ?? null,
      baseBranch: pr.baseBranch ?? null,
      createdAt: pr.createdAt ?? null,
      updatedAt: pr.updatedAt ?? null,
      mergedAt: pr.mergedAt ?? null,
    };
  }

  private childAgentContext(child: Record<string, unknown>): Record<string, unknown> {
    return {
      id: child.id,
      executionId: child.id,
      agentName: child.agentName,
      status: child.status,
      currentStep: child.currentStep ?? null,
      durationMs: child.durationMs ?? null,
      cost: child.cost ?? null,
      tokenUsage: child.tokenUsage ?? null,
      failedNode: child.failedNode ?? null,
      errorMessage: child.errorMessage ?? null,
      promptPreview: child.promptPreview ?? '',
      parentCaller: child.parentCaller ?? null,
      linkType: child.linkType ?? 'direct',
    };
  }

  private artifactContext(artifact: Record<string, unknown>): Record<string, unknown> {
    const artifactId = stringValue(artifact.artifactId);
    return {
      artifactId,
      filename: artifact.filename ?? null,
      relativePath: artifact.relativePath ?? null,
      contentType: artifact.contentType ?? null,
      sizeBytes: artifact.sizeBytes ?? null,
      description: artifact.description ?? null,
      rootType: artifact.rootType ?? null,
      rootId: artifact.rootId ?? null,
      spawnContext: artifact.spawnContext ?? null,
      url: artifactId ? `/api/artifacts/${artifactId}/content` : null,
      createdAt: artifact.createdAt ?? null,
    };
  }

  private workflowStepContext(
    exec: Record<string, unknown>,
    workflowNodes: Record<string, unknown>,
    traces: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const completedSet = new Set(((exec.completedNodes as unknown[]) ?? []).filter(Boolean).map(String));
    const currentSet = new Set(((exec.currentNodes as unknown[]) ?? []).filter(Boolean).map(String));
    const runStatus = String(exec.status ?? '').toLowerCase();
    const failedNode = stringValue(exec.failedNode);
    const sortedTraces = [...traces].sort((a, b) => {
      const aTime = new Date((a.startedAt ?? a.completedAt ?? 0) as string | Date).getTime();
      const bTime = new Date((b.startedAt ?? b.completedAt ?? 0) as string | Date).getTime();
      return aTime - bTime;
    });
    const tracesByNode = new Map<string, Record<string, unknown>[]>();
    for (const trace of sortedTraces) {
      const node = stringValue(trace.node);
      if (!node) continue;
      const list = tracesByNode.get(node) ?? [];
      list.push(trace);
      tracesByNode.set(node, list);
    }

    const steps = Object.entries(workflowNodes).map(([nodeName, rawNode], index) => {
      const nodeDef = (rawNode && typeof rawNode === 'object' ? rawNode : {}) as Record<string, unknown>;
      const nodeTraces = tracesByNode.get(nodeName) ?? [];
      const firstTrace = nodeTraces[0] ?? null;
      const lastTrace = nodeTraces[nodeTraces.length - 1] ?? null;
      const attempts = nodeTraces.length || (completedSet.has(nodeName) || currentSet.has(nodeName) ? 1 : 0);
      const retryReasons = [...new Set(nodeTraces.map(t => stringValue(t.retryReason)).filter((v): v is string => Boolean(v)))];
      const traceStatus = stringValue(lastTrace?.status);
      const status =
        failedNode === nodeName || traceStatus === 'failed' ? 'failed'
        : completedSet.has(nodeName) || traceStatus === 'completed' ? 'completed'
        : traceStatus === 'skipped' ? 'skipped'
        : currentSet.has(nodeName) && runStatus !== 'completed' ? 'running'
        : CANCELLED_STATUSES.has(runStatus) && currentSet.has(nodeName) ? 'cancelled'
        : 'pending';
      const runtimeContext = (lastTrace?.runtimeContext && typeof lastTrace.runtimeContext === 'object'
        ? lastTrace.runtimeContext
        : {}) as Record<string, unknown>;
      const agentOverrides = (lastTrace?.agentOverrides && typeof lastTrace.agentOverrides === 'object'
        ? lastTrace.agentOverrides
        : {}) as Record<string, unknown>;
      const startedAt = firstTrace?.startedAt ?? null;
      const completedAt = lastTrace?.completedAt ?? null;
      const tracedDurationMs = nodeTraces.reduce((total, trace) => {
        const duration = typeof trace.durationMs === 'number' ? trace.durationMs : 0;
        return total + duration;
      }, 0);
      const cost = nodeTraces.reduce<{ estimated: number; actual: number | null }>((total, trace) => {
        const traceCost = (trace.cost && typeof trace.cost === 'object' ? trace.cost : {}) as Record<string, unknown>;
        const estimated = typeof traceCost.estimated === 'number' ? traceCost.estimated : 0;
        const actual = typeof traceCost.actual === 'number' ? traceCost.actual : null;
        total.estimated += estimated;
        if (actual != null) total.actual = (total.actual ?? 0) + actual;
        return total;
      }, { estimated: 0, actual: null });

      // Compute aggregate tokenUsage across node traces (per-field null-aware sum)
      let stepTokenUsage: TokenUsageInfo | null = null;
      for (const trace of nodeTraces) {
        const tu = (trace.tokenUsage && typeof trace.tokenUsage === 'object' ? trace.tokenUsage : null) as TokenUsageInfo | null;
        if (tu) stepTokenUsage = aggregateTokenUsage(stepTokenUsage, tu);
      }
      const elapsedDurationMs = (() => {
        if (!startedAt) return null;
        const startMs = new Date(startedAt as string | Date).getTime();
        if (!Number.isFinite(startMs)) return null;
        const endMs = completedAt ? new Date(completedAt as string | Date).getTime() : Date.now();
        if (!Number.isFinite(endMs) || endMs < startMs) return null;
        return endMs - startMs;
      })();
      const outputObject = (lastTrace?.output && typeof lastTrace.output === 'object'
        ? lastTrace.output
        : {}) as Record<string, unknown>;
      const stepInput = lastTrace
        ? stringValue(lastTrace.renderedPrompt)
          ?? stringValue((lastTrace.inputState as Record<string, unknown> | undefined)?.prompt)
          ?? compactJsonValue(lastTrace.inputState)
          ?? compactJsonValue(nodeDef)
        : undefined;
      const stepOutput = lastTrace
        ? stringValue(outputObject.response)
          ?? stringValue(outputObject.error)
          ?? stringValue(lastTrace.rawResponse)
          ?? compactJsonValue(lastTrace.output)
        : undefined;
      return {
        id: nodeName,
        name: nodeName,
        index,
        type: nodeDef.type ?? (nodeDef.agent ? 'agent' : nodeDef.function ? 'code' : 'agent'),
        agent: nodeDef.agent ?? null,
        status,
        attempts,
        retryReasons,
        model: runtimeContext.resolvedModel ?? agentOverrides.model ?? null,
        startedAt,
        completedAt,
        durationMs: tracedDurationMs > 0 ? tracedDurationMs : elapsedDurationMs,
        cost: cost.estimated > 0 || cost.actual != null ? cost : null,
        tokenUsage: stepTokenUsage,
        error: lastTrace?.error ?? (failedNode === nodeName ? exec.errorMessage : null),
        io: {
          input: stepInput ?? null,
          output: stepOutput ?? null,
        },
      };
    });

    return this.normalizeSkippedWorkflowSteps(steps);
  }

  private normalizeSkippedWorkflowSteps(steps: Record<string, unknown>[]): Record<string, unknown>[] {
    const progressedIndexes = steps
      .map((step, index) => {
        const status = String(step.status ?? '').toLowerCase();
        const hasRunData = this.workflowStepHasRunData(step);
        return (status !== 'pending' && status !== 'not_started') || hasRunData ? index : -1;
      })
      .filter(index => index >= 0);
    const lastProgressedIndex = progressedIndexes.length > 0 ? Math.max(...progressedIndexes) : -1;

    return steps.map((step, index) => {
      const status = String(step.status ?? '').toLowerCase();
      if ((status === 'pending' || status === 'not_started') && !this.workflowStepHasRunData(step) && index < lastProgressedIndex) {
        return { ...step, status: 'skipped' };
      }
      return step;
    });
  }

  private workflowStepHasRunData(step: Record<string, unknown>): boolean {
    const io = (step.io && typeof step.io === 'object' ? step.io : {}) as Record<string, unknown>;
    return (typeof step.attempts === 'number' && step.attempts > 0)
      || Boolean(step.startedAt || step.completedAt || step.durationMs || io.input || io.output);
  }

  private recentActivity(
    logs: Record<string, unknown>[],
    activity: PersistedActivityRow[],
  ): Record<string, unknown>[] {
    const logRows = logs.map((log) => ({
      type: log.type ?? log.event ?? log.category ?? 'log',
      label: log.message ?? log.content ?? log.tool ?? log.command ?? log.type ?? 'activity',
      tool: log.tool ?? null,
      at: log.timestamp ?? log.createdAt ?? null,
      source: 'execution_log',
    }));
    const activityRows = activity.map((row) => ({
      type: row.type,
      label: row.content ?? row.tool ?? row.type,
      agent: row.agent,
      tool: row.tool ?? null,
      at: row.at,
      source: 'agent_activity',
    }));
    return [...logRows, ...activityRows]
      .filter((row) => row.at)
      .sort((a, b) => new Date(a.at as string | Date).getTime() - new Date(b.at as string | Date).getTime())
      .slice(-50);
  }

  // ── Human Intervention Protocol hook ──────────────────────────────────
  //
  // Wraps the SSE emitter in a middleware that forwards every event to the
  // base emitter AND intercepts `input_required` events to create a
  // workflow_interventions record via InterventionService. This is how
  // every `human` node in every workflow — current and future — becomes
  // visible on the Interventions page automatically, without per-workflow
  // wiring.
  //
  // Dedupe: we query the DB for an existing PENDING intervention on the
  // same (workflow_run_id, stage) before creating. If one exists, we
  // skip — this catches the case where the engine emits input_required
  // twice in a row for the same pause. If the previous intervention for
  // this stage is already answered (e.g., the workflow looped back to
  // the same human node after a retry or after the user answered), we
  // DO create a new one — loops across the same node are legitimate.
  private wrapEmitterWithInterventionHook(
    baseEmitter: ReturnType<typeof createSSEEmitter>,
    executionId: string,
    workflow: WorkflowDef,
    input: Record<string, unknown>,
  ): ReturnType<typeof createSSEEmitter> {
    const db = this.db;
    const interventionService = new InterventionService(db);

    return {
      emit(event: Parameters<typeof baseEmitter.emit>[0]) {
        // Always forward to the SSE base emitter first — intervention
        // creation is best-effort and must never block the event stream.
        try {
          baseEmitter.emit(event);
        } catch (err) {
          logger.error('[execution.emitter] base emitter threw', { executionId, error: (err as Error).message });
        }

        if (event.event === 'execution_failed' || event.event === 'node_failed') {
          new MonitoringService(db).handleEvent({
            sourceType: 'workflow_execution',
            sourceId: executionId,
            title: event.event === 'node_failed' ? `Workflow node failed: ${String(event.data.node ?? 'unknown')}` : `Workflow failed: ${workflow.name}`,
            error: String((event.data as Record<string, unknown>).error ?? 'Workflow execution failed'),
            rootCauseArea: event.event === 'node_failed' ? 'workflow_definition' : 'allen_repo',
            severity: 'high',
            confidence: 0.82,
            failureMode: event.event,
            relatedIds: {
              executionId,
              workflowName: workflow.name,
              node: (event.data as Record<string, unknown>).node,
              failedNode: (event.data as Record<string, unknown>).failedNode,
            },
          }).catch(() => {});
        }

        if (event.event !== 'input_required') return;

        const nodeName = (event.data.node as string) ?? 'unknown';
        const promptText = (event.data.prompt as string) ?? '';
        const normalizedIntervention = event.data.intervention && typeof event.data.intervention === 'object' && !Array.isArray(event.data.intervention)
          ? event.data.intervention as Record<string, unknown>
          : null;
        const rawFields = (event.data.fields as Array<{
          name: string;
          label?: string;
          type?: string;
          required?: boolean;
          options?: string[];
          placeholder?: string;
        }>) ?? [];
        // Normalise into InterventionField shape so the intervention
        // record carries exactly what the UI and respond handler need.
        const normalizedFields = Array.isArray(normalizedIntervention?.fields)
          ? normalizedIntervention.fields as Array<{
            name: string;
            label?: string;
            type?: string;
            required?: boolean;
            options?: string[];
            placeholder?: string;
          }>
          : rawFields;
        const fields: InterventionField[] = normalizedFields.map(f => ({
          name: f.name,
          label: f.label,
          type: f.type,
          required: f.required,
          options: f.options,
          placeholder: f.placeholder,
        }));

        // Fire-and-forget intervention create. Failures are logged but
        // must not block the workflow — the engine is already paused and
        // waiting for submit_execution_input regardless of whether Slack
        // or the intervention collection is reachable.
        (async () => {
          try {
            // Dedupe: skip if there's already a PENDING intervention on
            // this (execution, stage). Answered interventions don't
            // count — a workflow that loops back to the same human node
            // after a prior answer legitimately needs a new intervention.
            const existing = await db.collection('workflow_interventions').findOne({
              workflow_run_id: executionId,
              stage: nodeName,
              status: 'pending',
            });
            if (existing) return;

            const execDoc = await db.collection('executions').findOne({ id: executionId });
            const workflowState = (execDoc?.state as Record<string, unknown>) ?? {};

            // Derive severity from normalized payload when available, else
            // fall back to the stage-name convention.
            //   *_gate / *_approval → approval (🟢)
            //   *_escalation        → escalation (🔴)
            //   everything else     → question (🟡)
            let severity: InterventionSeverity = normalizedIntervention?.severity === 'approval' || normalizedIntervention?.severity === 'escalation' || normalizedIntervention?.severity === 'question'
              ? normalizedIntervention.severity as InterventionSeverity
              : 'question';
            const stageLower = nodeName.toLowerCase();
            if (!normalizedIntervention && (stageLower.endsWith('_gate') || stageLower.includes('approval'))) {
              severity = 'approval';
            } else if (!normalizedIntervention && stageLower.includes('escalation')) {
              severity = 'escalation';
            }

            // Derive a short title: prefer the node def's displayName, else
            // the humanised node name.
            const nodeDef = workflow.nodes?.[nodeName];
            const title = typeof normalizedIntervention?.title === 'string'
              ? normalizedIntervention.title
              : (nodeDef as { displayName?: string } | undefined)?.displayName
              ?? humaniseNodeName(nodeName);
            const summary = typeof normalizedIntervention?.summary === 'string'
              ? normalizedIntervention.summary
              : undefined;

            // Derive the context summary from the rendered prompt's first
            // 400 chars. The prompt is the only human-readable context we
            // have without introspecting every workflow's state schema.
            const contextSummary = (summary ?? promptText.slice(0, 400)) || `The workflow is paused at node "${nodeName}".`;

            // Derive the question from the prompt too — the full prompt
            // already contains the question text for most nodes. The
            // Interventions page renders it verbatim.
            const question = typeof normalizedIntervention?.question === 'string'
              ? normalizedIntervention.question
              : promptText || `Please respond to continue.`;

            // Build options from the human node's fields. Any field of
            // type "select" becomes a list of options; other fields are
            // surfaced as free-form inputs on the Interventions page.
            const normalizedActions = Array.isArray(normalizedIntervention?.actions)
              ? normalizedIntervention.actions as Array<Record<string, unknown>>
              : undefined;
            const options = normalizedActions && normalizedActions.length > 0
              ? normalizedActions.map((action) => {
                const value = typeof action.id === 'string' ? action.id : String(action.label ?? '');
                return {
                  label: typeof action.label === 'string' ? action.label : value.replace(/_/g, ' '),
                  value,
                  primary: value === 'approve' || value === 'answer' || value === 'retry_with_feedback',
                  destructive: value === 'reject' || value === 'cancel' || value === 'abandon',
                };
              }).filter((option) => option.value)
              : fields.flatMap(f => {
              if (f.type === 'select' && 'options' in f) {
                const fieldOpts = (f as unknown as { options?: string[] }).options ?? [];
                return fieldOpts.map(o => ({
                  label: o.replace(/_/g, ' '),
                  value: o,
                  primary: o === 'approve' || o === 'continue',
                  destructive: o === 'reject' || o === 'cancel' || o === 'abort',
                }));
              }
              return [];
            });
            // Fallback: if no select options were emitted, provide a
            // standard approve/answer/reject set based on severity.
            if (options.length === 0) {
              if (severity === 'escalation') {
                options.push(
                  { label: 'Retry with feedback', value: 'retry_with_feedback', primary: true, destructive: false },
                  { label: 'Override and continue', value: 'override_and_continue', primary: false, destructive: false },
                  { label: 'Abandon', value: 'abandon', primary: false, destructive: true },
                );
              } else if (severity === 'approval') {
                options.push(
                  { label: 'Approve', value: 'approve', primary: true, destructive: false },
                  { label: 'Request changes', value: 'request_changes', primary: false, destructive: false },
                  { label: 'Reject', value: 'reject', primary: false, destructive: true },
                );
              } else {
                options.push(
                  { label: 'Answer', value: 'answer', primary: true, destructive: false },
                  { label: 'Reject', value: 'reject', primary: false, destructive: true },
                );
              }
            }

            // Collect any doc links already in state — feature workflow
            // will have prd_url / hla_url / tdd_url set by persist_docs;
            // summary_url set by summary node; etc.
            const docs: InterventionDocLink[] = [];
            const normalizedEvidence = Array.isArray(normalizedIntervention?.evidence)
              ? normalizedIntervention.evidence as Array<Record<string, unknown>>
              : undefined;
            const kindFromKey = (k: string): InterventionDocLink['kind'] => {
              if (k.startsWith('prd')) return 'prd';
              if (k.startsWith('hla')) return 'hla';
              if (k.startsWith('tdd')) return 'tdd';
              if (k === 'pr_url') return 'pr';
              if (k === 'summary_url') return 'summary';
              return 'external';
            };
            for (const [key, val] of Object.entries(workflowState)) {
              if (typeof val !== 'string') continue;
              if (!val.startsWith('/api/files/') && !val.startsWith('http')) continue;
              if (key.endsWith('_url') || key === 'pr_url' || key === 'summary_url') {
                docs.push({
                  label: humaniseNodeName(key.replace(/_url$/, '')),
                  url: val,
                  kind: kindFromKey(key),
                });
              }
            }
            if (normalizedEvidence) {
              for (const item of normalizedEvidence) {
                if (typeof item.url !== 'string' || !item.url) continue;
                docs.push({
                  label: typeof item.label === 'string' ? item.label : 'Evidence',
                  url: item.url,
                  kind: 'external',
                });
              }
            }
            const dedupedDocs = dedupeInterventionDocs(docs);

            // Round info for clarification nodes (best-effort — state
            // may or may not have a clarify_round counter).
            const roundInfo = typeof workflowState.clarify_round === 'number'
              ? { current: workflowState.clarify_round as number, max: 3 }
              : undefined;

            await interventionService.create({
              workflow_run_id: executionId,
              workflow_name: workflow.name,
              chat_session_id: (input.chat_session_id as string | undefined),
              started_by_user_id: (input.started_by_user_id as string | undefined),
              started_by_user_email: (input.started_by_user_email as string | undefined),
              stage: nodeName,
              kind: normalizedIntervention?.kind === 'clarify' || normalizedIntervention?.kind === 'review' || normalizedIntervention?.kind === 'recover' || normalizedIntervention?.kind === 'model_recovery'
                ? normalizedIntervention.kind
                : undefined,
              severity,
              title,
              summary,
              context_summary: contextSummary,
              question,
              options,
              fields,
              actions: normalizedActions,
              highlights: Array.isArray(normalizedIntervention?.highlights)
                ? normalizedIntervention.highlights.filter((item): item is string => typeof item === 'string')
                : undefined,
              evidence: normalizedEvidence,
              retry_exhaustion: normalizedIntervention?.retryExhaustion && typeof normalizedIntervention.retryExhaustion === 'object' && !Array.isArray(normalizedIntervention.retryExhaustion)
                ? normalizedIntervention.retryExhaustion as Record<string, unknown>
                : undefined,
              recoveryContext: normalizedIntervention?.recoveryContext && typeof normalizedIntervention.recoveryContext === 'object' && !Array.isArray(normalizedIntervention.recoveryContext)
                ? normalizedIntervention.recoveryContext as Record<string, unknown>
                : undefined,
              docs: dedupedDocs,
              round_info: roundInfo,
              user_request: (input.user_request as string | undefined)
                ?? (input.bug_report as string | undefined)
                ?? (input.task as string | undefined),
            });
          } catch (err) {
            logger.error('[execution.emitter] intervention create failed', { executionId, node: nodeName, error: (err as Error).message });
          }
        })().catch(() => {});
      },
    };
  }
}

/**
 * Convert a node name like `plan_approval_gate` or `clarify_round_2` into
 * a human-readable title like "Plan Approval Gate" or "Clarify Round 2".
 */
function humaniseNodeName(name: string): string {
  return name
    .split(/[_-]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function dedupeInterventionDocs(docs: InterventionDocLink[]): InterventionDocLink[] {
  const byUrl = new Map<string, InterventionDocLink>();
  for (const doc of docs) {
    const url = doc.url.trim();
    if (!url) continue;
    const existing = byUrl.get(url);
    if (!existing || isGenericInterventionDocLabel(existing.label)) {
      byUrl.set(url, { ...doc, url });
    }
  }
  return [...byUrl.values()];
}

function isGenericInterventionDocLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === 'evidence'
    || normalized === 'external'
    || normalized === 'artifact'
    || normalized.endsWith('artifact');
}
