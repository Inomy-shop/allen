import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import {
  FlowForgeEngine,
  StateManager,
  loadAgents,
  getBuiltIns,
  type WorkflowDef,
  type EngineConfig,
  type ExecutionState,
} from '@flowforge/engine';
import { createSSEEmitter } from './stream.service.js';
import type { AgentDef } from '@flowforge/engine';

// Track running engines by executionId
const runningEngines = new Map<string, FlowForgeEngine>();

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
    };
  }
  return merged;
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
          currentNodes: [],
          completedNodes: [],
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
    };

    const engine = new FlowForgeEngine(config);
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

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.stateManager.getExecution(id);
    return result as unknown as Record<string, unknown> | null;
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
    if (killed) console.log(`[cancel] Killed process for execution ${id}`);

    await this.stateManager.updateExecution(id, {
      status: 'cancelled',
      completedAt: new Date(),
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
    };

    const engine = new FlowForgeEngine(config);
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
}
