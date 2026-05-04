import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
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
  errorMessage: 1, input: 1, meta: 1,
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
    promptPreview,
    linkType,
  };
}

export class ExecutionService {
  private db: Db;
  private stateManager: StateManager;

  constructor(db: Db) {
    this.db = db;
    this.stateManager = new StateManager(db);
  }

  async start(workflowId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { ObjectId } = await import('mongodb');
    const workflowDoc = await this.db.collection('workflows').findOne({ _id: new ObjectId(workflowId) });
    if (!workflowDoc) throw new Error('Workflow not found');

    const workflow = workflowDoc.parsed as WorkflowDef;
    const executionId = randomUUID();

    // Check concurrency limits — queue if exceeded
    if (workflow.context?.concurrency) {
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
    return results as unknown as Record<string, unknown>[];
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
    return { items: items as unknown as Record<string, unknown>[], total };
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.stateManager.getExecution(id);
    return result as unknown as Record<string, unknown> | null;
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
