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
import { MonitoringService } from './self-healing-monitor.service.js';
import { assertSelfHealingLinearConfig, isSelfHealingWorkflowName } from './self-healing-env.js';
import { AgentActivityService, type PersistedActivityRow } from './agent-activity.service.js';

/**
 * Build the in-process service hook bundle the engine passes to built-ins.
 * Lets built-ins like `create-workspace` invoke server-side infra (Mongo +
 * filesystem operations) without looping back through /api, which would
 * fail the `requireAuth` middleware. Same process, same DB, no HTTP hop.
 */
function buildEngineServices(db: Db): EngineConfig['services'] {
  const wsManager = new WorkspaceManager(db);
  const artifactService = new ArtifactService(db);
  return {
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
  completedAt: 1, durationMs: 1, cost: 1, failedNode: 1,
  errorMessage: 1, input: 1, meta: 1, currentNodes: 1, completedNodes: 1,
};

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
    if (provider === 'claude-cli' && next.model === 'default') {
      delete next.model;
    }

    node.agentOverrides = next;
  }

  return copy;
}

export type RunOrigin = 'chat' | 'linear' | 'workflow' | 'direct_agent';
export type RunType = 'workflow' | 'agent';
export type WorkflowAgentProvider = 'claude-cli' | 'codex';
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
    };

    const engine = new AllenEngine(config);
    runningEngines.set(executionId, engine);

    engine.run(workflow, input, 0, { executionId, workflowId })
      .catch(() => {})
      .finally(() => {
        runningEngines.delete(executionId);
        // Auto-dequeue next waiting execution for this workflow
        this.dequeueNext(workflow.name).catch(() => {});
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
    return (results as unknown as Record<string, unknown>[]).map(normalizeTerminalCurrentNodes);
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
  } = {}): Promise<{ items: Record<string, unknown>[]; total: number }> {
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
    });
    const normalizedItems = (items as unknown as Record<string, unknown>[]).map(normalizeTerminalCurrentNodes);
    await this.attachChatMetadataFromMessages(normalizedItems);
    const enriched = await Promise.all(
      normalizedItems.map((item) => this.listItemContext(item)),
    );
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
      .filter((row) => belongsToChatSession(row as Record<string, unknown>)) as Record<string, unknown>[];

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

    const rootIds = [...new Set(directRows
      .map(row => stringValue(row.id))
      .filter((id): id is string => Boolean(id)))];
    const rootParentByExecution = new Map<string, string>();
    for (const row of directRows) {
      const id = stringValue(row.id);
      if (!id) continue;
      const meta = ((row.meta ?? {}) as Record<string, unknown>) ?? {};
      const parentMessageId = stringValue(meta.parentMessageId) ?? messageLinks.get(id)?.parentMessageId;
      if (parentMessageId) rootParentByExecution.set(id, parentMessageId);
    }

    const descendants = rootIds.length
      ? (await this.db.collection('executions')
        .find({
          id: { $nin: rootIds },
          $or: [
            { rootExecutionId: { $in: rootIds } },
            { parentExecutionId: { $in: rootIds } },
          ],
        })
        .sort({ startedAt: 1, createdAt: 1 })
        .limit(300)
        .toArray()
        .catch(() => []))
        .filter((row) => belongsToChatSession(row as Record<string, unknown>)) as Record<string, unknown>[]
      : [];

    const byId = new Map<string, Record<string, unknown>>();
    for (const row of [...directRows, ...descendants] as Record<string, unknown>[]) {
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
    return result ? normalizeTerminalCurrentNodes(result as unknown as Record<string, unknown>) : null;
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

    const [workflowDoc, traces, directChildren, interventions, logs, activity] = await Promise.all([
      exec.workflowId && ObjectId.isValid(exec.workflowId)
        ? this.db.collection('workflows').findOne(
            { _id: new ObjectId(exec.workflowId) },
            { projection: { name: 1, parsed: 1 } },
          )
        : Promise.resolve(null),
      this.stateManager.getTraces(id),
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
    ]);

    const workspace = await this.findExecutionWorkspace(input, state, meta);
    const assignment = await this.findExecutionAssignment(id, workspace, input, state, meta);
    const pullRequest = await this.findExecutionPullRequest(id, workspace, input, state, meta, [row, ...traces, ...logs, ...activity]);
    const artifacts = await this.findExecutionArtifacts(id, isAgentExecution, row, meta);
    await this.captureChatDiffSnapshotIfReady(id, exec.status, workspace, meta).catch(() => {});

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
    const workflowNodeSet = new Set(workflowNodeNames);
    const completedWorkflowNodes = [...new Set((exec.completedNodes ?? [])
      .filter((node) => workflowNodeSet.size === 0 || workflowNodeSet.has(node)))];
    const totalNodes = isAgentExecution
      ? 1
      : workflowNodeNames.length || Math.max(completedWorkflowNodes.length, exec.currentNodes?.length ?? 0);
    const completedCount = isAgentExecution
      ? (exec.status === 'completed' ? 1 : 0)
      : Math.min(completedWorkflowNodes.length, totalNodes);
    const pendingIntervention = interventions.find((i: any) => i.status === 'pending') ?? null;
    const currentStep = this.currentStep(exec, isAgentExecution, traces);
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
      ?? stringValue(meta.requestText)
      ?? null;
    const ioOutput =
      stringValue(traceOutput.response)
      ?? stringValue(traceOutput.error)
      ?? stringValue(latestTrace?.rawResponse)
      ?? null;

    return {
      origin,
      runType,
      title: executionDisplayTitle(input, meta, workflowName),
      status: exec.status,
      chat: {
        sessionId: stringValue(meta.chatSessionId) ?? null,
        parentMessageId: stringValue(meta.parentMessageId) ?? null,
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
        cost: exec.cost,
        currentNodes: exec.currentNodes ?? [],
        completedNodes: exec.completedNodes ?? [],
        failedNode: exec.failedNode ?? null,
        errorMessage: exec.errorMessage ?? null,
        isAgentExecution,
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
      linear: this.linearContext(assignment, input, state, meta),
      workspace: workspace ? this.workspaceContext(workspace) : null,
      pullRequest: pullRequest ? this.pullRequestContext(pullRequest) : null,
      childAgents: directChildren.map((child) => this.childAgentContext(child)),
      workflowSteps: isAgentExecution ? [] : this.workflowStepContext(exec as unknown as Record<string, unknown>, workflowNodes, traces),
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

    const diff = await new WorkspaceManager(this.db).getDiff(workspaceId, { mode: 'auto' });
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
    return entry;
  }

  async cancel(id: string): Promise<void> {
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
    };

    const engine = new AllenEngine(config);
    runningEngines.set(executionId, engine);

    engine.runFromCheckpoint(workflow, executionId, checkpointId)
      .catch(() => {})
      .finally(() => runningEngines.delete(executionId));

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
    const emitter = createSSEEmitter(newExecutionId);

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
    const emitter = createSSEEmitter(executionId);

    const allWorkflowDocs = await this.db.collection('workflows').find({}).toArray();
    const workflows: Record<string, WorkflowDef> = {};
    for (const doc of allWorkflowDocs) {
      workflows[(doc.parsed as WorkflowDef).name] = doc.parsed as WorkflowDef;
    }

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
    };

    const engine = new AllenEngine(config);
    runningEngines.set(executionId, engine);

    engine.retryFromNode(workflow, executionId, nodeName)
      .catch(() => {})
      .finally(() => runningEngines.delete(executionId));

    return { id: executionId, status: 'running', retryingFrom: nodeName };
  }

  async getTraces(executionId: string): Promise<Record<string, unknown>[]> {
    return this.stateManager.getTraces(executionId);
  }

  async getTracesByNode(executionId: string, node: string): Promise<Record<string, unknown>[]> {
    return this.stateManager.getTracesByNode(executionId, node);
  }

  async getTraceByAttempt(executionId: string, node: string, attempt: number): Promise<Record<string, unknown> | null> {
    return this.stateManager.getTraceByAttempt(executionId, node, attempt);
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
    const assignment = id ? await this.findExecutionAssignment(id, workspace, input, state, meta) : null;
    const pullRequest = id ? await this.findExecutionPullRequest(id, workspace, input, state, meta, [item]) : null;

    return {
      ...item,
      type: isAgentExecution ? 'agent' : 'workflow',
      origin: this.inferOrigin(item, assignment),
      title: this.executionTitle(workflowName, input, meta),
      linear: this.linearContext(assignment, input, state, meta),
      pullRequest: pullRequest ? this.pullRequestContext(pullRequest) : null,
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

    return Object.entries(workflowNodes).map(([nodeName, rawNode], index) => {
      const nodeDef = (rawNode && typeof rawNode === 'object' ? rawNode : {}) as Record<string, unknown>;
      const nodeTraces = tracesByNode.get(nodeName) ?? [];
      const firstTrace = nodeTraces[0] ?? null;
      const lastTrace = nodeTraces[nodeTraces.length - 1] ?? null;
      const attempts = nodeTraces.length || (completedSet.has(nodeName) || currentSet.has(nodeName) ? 1 : 0);
      const retryReasons = [...new Set(nodeTraces.map(t => stringValue(t.retryReason)).filter((v): v is string => Boolean(v)))];
      const traceStatus = stringValue(lastTrace?.status);
      const status =
        failedNode === nodeName || traceStatus === 'failed' ? 'failed'
        : completedSet.has(nodeName) || (runStatus === 'completed' && traceStatus === 'completed') ? 'completed'
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
        error: lastTrace?.error ?? (failedNode === nodeName ? exec.errorMessage : null),
        io: {
          input: stepInput ?? null,
          output: stepOutput ?? null,
        },
      };
    });
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
        const fields: InterventionField[] = rawFields.map(f => ({
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

            // Derive severity from the stage name. Convention:
            //   *_gate / *_approval → approval (🟢)
            //   *_escalation        → escalation (🔴)
            //   everything else     → question (🟡)
            let severity: InterventionSeverity = 'question';
            const stageLower = nodeName.toLowerCase();
            if (stageLower.endsWith('_gate') || stageLower.includes('approval')) {
              severity = 'approval';
            } else if (stageLower.includes('escalation')) {
              severity = 'escalation';
            }

            // Derive a short title: prefer the node def's displayName, else
            // the humanised node name.
            const nodeDef = workflow.nodes?.[nodeName];
            const title = (nodeDef as { displayName?: string } | undefined)?.displayName
              ?? humaniseNodeName(nodeName);

            // Derive the context summary from the rendered prompt's first
            // 400 chars. The prompt is the only human-readable context we
            // have without introspecting every workflow's state schema.
            const contextSummary = promptText.slice(0, 400) || `The workflow is paused at node "${nodeName}".`;

            // Derive the question from the prompt too — the full prompt
            // already contains the question text for most nodes. The
            // Interventions page renders it verbatim.
            const question = promptText || `Please respond to continue.`;

            // Build options from the human node's fields. Any field of
            // type "select" becomes a list of options; other fields are
            // surfaced as free-form inputs on the Interventions page.
            const options = fields.flatMap(f => {
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
              if (severity === 'approval' || severity === 'escalation') {
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
              severity,
              title,
              context_summary: contextSummary,
              question,
              options,
              fields,
              docs,
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
