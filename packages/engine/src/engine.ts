import { randomUUID } from 'node:crypto';
import type {
  WorkflowDef,
  EdgeDef,
  NodeDef,
  ExecutionState,
  EngineEventEmitter,
  AgentDef,
  BuiltInFunction,
  NodeTrace,
  NodeStatus,
  SSEEvent,
  Checkpoint,
  ExecutionLog,
  LogCategory,
  LogLevel,
  WorkflowFeedbackEntry,
  HumanField,
  HumanResumeInput,
  ResumeContext,
} from './types.js';
import { aggregateTokenUsage } from './token-usage.js';
import { executeNode, resolveAgentNodeEffectiveProvider, type NodeExecutorDeps, type NodeResult } from './node-executor.js';
import { evaluateCondition } from './condition-parser.js';
import { renderTemplate, renderTemplateWithBindings, collectPlaceholders } from './template.js';
import { mergeParallelOutputs } from './parallel.js';
import { extractAutoGateFields, buildNodeContext } from './output-extractor.js';
import { needsSynthesis, synthesizeClarifyContext } from './clarify-synthesizer.js';
import {
  appendHumanEvent,
  buildHumanEvent,
  buildHumanResumeInput,
  buildRetryExhaustionContext,
  renderClarifyIntervention,
  renderHumanHistory,
  renderHumanIntervention,
  renderHumanResumePrompt,
  renderModelRecoveryIntervention,
} from './human-intervention.js';
import {
  classifyFailure,
  buildRecoveryState,
  defaultMaxRecoveryAttempts,
  sanitizeErrorSummary,
} from './model-recovery.js';
import type { RecoveryState } from './model-recovery.js';
import { StateManager } from './state-manager.js';
import { LearningManager, type ExtractionContext } from './learning-manager.js';
import type { Db } from 'mongodb';
import type { EngineServices } from './types.js';

export interface EngineConfig {
  db: Db;
  agents: Record<string, AgentDef>;
  builtIns: Record<string, BuiltInFunction>;
  workflows: Record<string, WorkflowDef>;
  emitter: EngineEventEmitter;
  maxNestingDepth?: number;
  /** In-process service hooks for built-ins (e.g. workspace creation without HTTP). */
  services?: EngineServices;
  /**
   * Optional discoverer that returns every registered MCP tool's
   * `mcp__<server>__<tool>` name. Engine forwards it to NodeExecutorDeps
   * so the materialized agent file's `tools:` allowlist gets the full
   * MCP tool set appended — preventing Claude Code's allowlist from
   * silently hiding Linear / Postgres / GitHub tools. Server-side
   * callers wire this to their `loadMcpTools(db)` helper.
   */
  discoverMcpToolNames?: () => Promise<string[]>;
  /** Resolved Claude Code executable path for CLI-mode workflow agents. */
  claudeCodeExecutable?: string;
  /** Optional provider-specific env builder for Claude-compatible workflow agents. */
  buildClaudeCompatibleEnvOverlay?: (provider: string, model?: string, db?: import('mongodb').Db) => Promise<Record<string, string>>;
  /** Registry-backed alias map: alias → fullId. Optional — static defaults used when absent. */
  aliasMap?: Record<string, string>;
  /** Registry-backed per-MTok cost map, keyed by alias and fullId. Optional — cost falls back to the provider-reported figure when absent. */
  costMap?: Record<string, import('./types.js').ModelCostInfo>;
  /** Registry-backed model owner map, keyed by alias and fullId. Used for provider inference when only a model is overridden. */
  modelProviderMap?: Record<string, string>;
}

export interface RunOptions {
  /** Externally-provided execution ID (for SSE wiring). Generated if omitted. */
  executionId?: string;
  /** Externally-provided workflowId (MongoDB _id). */
  workflowId?: string;
  /** Execution that triggered this run (sub-workflow node / spawn). Links the
   *  new execution into the tree so cost rollups can find it on demand. */
  parentExecutionId?: string;
  /** Root of the triggering tree. Defaults to parent's root, else own id. */
  rootExecutionId?: string;
}

function hasMeaningfulRepoContextUsage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return [
    'module_identified',
    'context_preselected',
    'context_summary_used',
    'context_loaded',
    'context_applied',
    'context_skipped',
    'validation_performed',
  ].some((key) => {
    const current = record[key];
    return Array.isArray(current) ? current.length > 0 : current != null && current !== '';
  });
}

function humanizeStateKey(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export class AllenEngine {
  private stateManager: StateManager;
  private learningManager: LearningManager;
  private config: EngineConfig;
  private pendingInputResolvers = new Map<string, {
    resolve: (data: Record<string, unknown>) => void;
    reject: (err: Error) => void;
  }>();
  private cancelledExecutions = new Set<string>();
  private pausedExecutions = new Set<string>();
  // One execution can have many in-flight subprocesses simultaneously
  // (parallel-fork branches, retry loops, the parallel-coordinator's own
  // fail-fast controller). Track them all so cancelExecution can abort
  // every child cleanly instead of only the most-recently-registered one.
  private abortControllers = new Map<string, Set<AbortController>>();

  constructor(config: EngineConfig) {
    this.config = config;
    this.stateManager = new StateManager(config.db);
    this.learningManager = new LearningManager(config.db);
    // Best-effort cleanup of allen-*.md agent files left over in
    // ~/.claude/agents/ by crashed prior runs in CLI mode. Silent — never
    // blocks engine startup.
    try {
      // Dynamic import so this stays tree-shakable and doesn't slow boot for
      // non-CLI-mode deployments.
      import('./orphan-sweeper.js').then(({ sweepOrphanAgentFiles }) => {
        const result = sweepOrphanAgentFiles();
        if (result.removed > 0) {
          // eslint-disable-next-line no-console
          console.log(`[engine] swept ${result.removed} orphan agent file(s) from ~/.claude/agents/`);
        }
      }).catch(() => { /* swallow */ });
    } catch { /* swallow */ }
  }

  get state(): StateManager {
    return this.stateManager;
  }

  async run(
    workflow: WorkflowDef,
    input: Record<string, unknown>,
    nestingDepth = 0,
    options?: RunOptions,
  ): Promise<Record<string, unknown>> {
    const maxDepth = this.config.maxNestingDepth ?? 3;
    if (nestingDepth >= maxDepth) {
      throw new Error(`Max workflow nesting depth (${maxDepth}) exceeded`);
    }

    const executionId = options?.executionId ?? randomUUID();
    const exec: ExecutionState = {
      id: executionId,
      workflowId: options?.workflowId ?? '',
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? 1,
      status: 'running',
      input,
      state: {
        ...input,
        inputs: { ...input },
        nodes: {},
        human: {},
      },
      sessions: {},
      retryCounts: {},
      feedbackEntries: [],
      currentNodes: [],
      completedNodes: [],
      nodeAttempts: {},
      parentExecutionId: options?.parentExecutionId ?? null,
      rootExecutionId: options?.rootExecutionId ?? options?.parentExecutionId ?? executionId,
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    };

    // Derive context tags for the learning system
    const contextTags = this.learningManager.deriveContextTags(input, workflow);
    exec.state.__contextTags = contextTags;

    // Snapshot the workflow definition at execution start. Frozen DAG so the
    // UI can render traces against exactly the shape the engine ran against,
    // even if the workflow is edited later. Stored on the executions row as
    // an extra field (not in ExecutionState type, intentionally out-of-band).
    (exec as unknown as Record<string, unknown>).workflowSnapshot = workflow;

    await this.stateManager.createExecution(exec);
    this.emit({ event: 'execution_started', data: { executionId, workflowName: workflow.name } });
    this.log(executionId, { category: 'system', message: `Execution started: ${workflow.name}` });

    try {
      const result = await this.executeGraph(workflow, exec, nestingDepth);

      exec.status = 'completed';
      exec.completedAt = new Date();
      exec.durationMs = Date.now() - exec.startedAt.getTime();
      exec.currentNodes = [];
      await this.stateManager.updateExecution(executionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
        currentNodes: [],
        completedNodes: exec.completedNodes,
      });

      this.log(executionId, { category: 'system', message: `Execution completed in ${(exec.durationMs / 1000).toFixed(1)}s` });
      this.emit({
        event: 'execution_completed',
        data: { executionId, durationMs: exec.durationMs, cost: exec.cost },
      });

      // Post-execution review: fire-and-forget (never delays result)
      this.triggerPostExecutionReview(exec).catch(() => {});

      // Tell the parent workflow node WHICH execution ran — never how much it
      // cost. Cost stays on this execution's own traces; parents link via
      // childExecutionId and totals are rolled up on demand.
      result.__child_execution_id = executionId;

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      exec.status = 'failed';
      exec.errorMessage = message;
      exec.completedAt = new Date();
      exec.durationMs = Date.now() - exec.startedAt.getTime();
      await this.stateManager.updateExecution(executionId, {
        status: 'failed',
        errorMessage: message,
        failedNode: exec.failedNode,
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
      });

      // Persist a detailed failure report (gate-specific diagnostics + state)
      // so the UI can surface WHY the workflow failed.
      await this.stateManager.saveFailureReport(exec, err as Error);

      this.log(executionId, { category: 'system', level: 'error', message: `Execution failed: ${message}` });
      this.emit({
        event: 'execution_failed',
        data: { executionId, failedNode: exec.failedNode, error: message },
      });

      // Post-execution review on failure: fire-and-forget
      this.triggerPostExecutionReview(exec).catch(() => {});

      throw err;
    }
  }

  /**
   * Resume execution from a checkpoint, starting at the node after the checkpoint.
   */
  async resumeFromCheckpoint(
    workflow: WorkflowDef,
    executionId: string,
  ): Promise<Record<string, unknown>> {
    const checkpoint = await this.stateManager.getLatestCheckpoint(executionId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for execution ${executionId}`);
    }

    const existing = await this.stateManager.getExecution(executionId);
    const latestSessions = await this.stateManager.getLatestSessions(executionId);
    const exec: ExecutionState = {
      id: executionId,
      workflowId: existing?.workflowId ?? '',
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? 1,
      status: 'running',
      input: existing?.input ?? {},
      state: { ...checkpoint.state } as Record<string, unknown>,
      sessions: { ...checkpoint.sessions, ...latestSessions },
      retryCounts: { ...checkpoint.retryCounts },
      feedbackEntries: [...((existing?.feedbackEntries as WorkflowFeedbackEntry[] | undefined) ?? [])],
      currentNodes: [],
      completedNodes: [...checkpoint.completedNodes],
      nodeAttempts: { ...(checkpoint.nodeAttempts ?? {}) },
      // This resumes the SAME executions row — seed from the cost already
      // accumulated before the pause/failure so completion doesn't wipe it.
      cost: {
        actual: existing?.cost?.actual ?? null,
        estimated: existing?.cost?.estimated ?? 0,
      },
      durationMs: 0,
      startedAt: new Date(),
    };

    await this.stateManager.updateExecution(executionId, {
      status: 'running',
      state: exec.state,
      sessions: exec.sessions,
      retryCounts: exec.retryCounts,
      feedbackEntries: exec.feedbackEntries,
      completedNodes: exec.completedNodes,
    });

    this.emit({ event: 'execution_started', data: { executionId, workflowName: workflow.name } });

    try {
      const result = await this.executeGraph(workflow, exec, 0);

      exec.status = 'completed';
      exec.completedAt = new Date();
      exec.durationMs = Date.now() - exec.startedAt.getTime();
      exec.currentNodes = [];
      await this.stateManager.updateExecution(executionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
        currentNodes: [],
        completedNodes: exec.completedNodes,
      });

      this.emit({
        event: 'execution_completed',
        data: { executionId, durationMs: exec.durationMs, cost: exec.cost },
      });

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      exec.status = 'failed';
      exec.errorMessage = message;
      await this.stateManager.updateExecution(executionId, {
        status: 'failed',
        errorMessage: message,
        failedNode: exec.failedNode,
      });
      await this.stateManager.saveFailureReport(exec, err as Error);
      this.emit({
        event: 'execution_failed',
        data: { executionId, failedNode: exec.failedNode, error: message },
      });
      throw err;
    }
  }

  /**
   * Retry execution from a specific node using the latest checkpoint before that node.
   */
  async retryFromNode(
    workflow: WorkflowDef,
    executionId: string,
    nodeName: string,
  ): Promise<Record<string, unknown>> {
    // Get all checkpoints and find one before the target node. The start
    // node has no "before" checkpoint, so retrying it falls back to the
    // original execution input below.
    const checkpoint = await this.stateManager.getCheckpointBefore(executionId, nodeName);
    const existing = await this.stateManager.getExecution(executionId);
    if (!existing) {
      throw new Error(`Execution ${executionId} not found`);
    }
    const latestSessions = await this.stateManager.getLatestSessions(executionId);
    const isStartNode = this.getStartNodes(workflow.edges).includes(nodeName);
    if (!checkpoint && !isStartNode) {
      throw new Error(`No checkpoint found before node ${nodeName} for execution ${executionId}`);
    }

    // Remove the target node and everything after it from completedNodes
    const checkpointCompletedNodes = checkpoint?.completedNodes ?? [];
    const nodeIdx = checkpointCompletedNodes.indexOf(nodeName);
    const completedNodes = nodeIdx >= 0
      ? checkpointCompletedNodes.slice(0, nodeIdx)
      : [...checkpointCompletedNodes];

    // Carry `input` forward from the existing execution record so any node
    // that reads `${input.*}` templates still resolves correctly on retry.
    // The previous behavior reset to `{}` which silently broke such templates.
    const state = checkpoint
      ? ({ ...checkpoint.state } as Record<string, unknown>)
      : { ...(existing.input ?? {}) };
    if (existing.state && typeof existing.state === 'object') {
      for (const key of ['__retry_target', '__retry_source', '__retry_attempt', 'human_input', 'resume_context']) {
        if (Object.prototype.hasOwnProperty.call(existing.state, key)) {
          state[key] = (existing.state as Record<string, unknown>)[key];
        }
      }
      if (existing.state.nodes && typeof existing.state.nodes === 'object' && !Array.isArray(existing.state.nodes)) {
        state.nodes = existing.state.nodes;
      }
      if (existing.state.human && typeof existing.state.human === 'object' && !Array.isArray(existing.state.human)) {
        state.human = existing.state.human;
      }
      if (existing.state.inputs && typeof existing.state.inputs === 'object' && !Array.isArray(existing.state.inputs)) {
        state.inputs = existing.state.inputs;
      }
    }
    if (!checkpoint && existing.state?.__contextTags) {
      state.__contextTags = existing.state.__contextTags;
    }
    if (!state.resume_context && state.human_input && typeof state.human_input === 'object' && !Array.isArray(state.human_input)) {
      const humanInput = state.human_input as HumanResumeInput;
      if (typeof humanInput.sourceNode === 'string') {
        state.resume_context = this.buildHumanResumeContext(humanInput, nodeName);
      }
    }
    const exec: ExecutionState = {
      id: executionId,
      workflowId: existing?.workflowId ?? '',
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? 1,
      status: 'running',
      input: existing?.input ?? {},
      state,
      sessions: { ...(checkpoint?.sessions ?? {}), ...latestSessions },
      retryCounts: { ...(checkpoint?.retryCounts ?? {}) },
      feedbackEntries: [...((existing?.feedbackEntries as WorkflowFeedbackEntry[] | undefined) ?? [])],
      currentNodes: [],
      completedNodes,
      nodeAttempts: { ...(checkpoint?.nodeAttempts ?? {}) },
      // This resumes the SAME executions row — seed from the cost already
      // accumulated before the pause/failure so completion doesn't wipe it.
      cost: {
        actual: existing?.cost?.actual ?? null,
        estimated: existing?.cost?.estimated ?? 0,
      },
      durationMs: 0,
      startedAt: new Date(),
    };

    await this.stateManager.updateExecutionWithUnset(
      executionId,
      {
        status: 'running',
        state: exec.state,
        sessions: exec.sessions,
        retryCounts: exec.retryCounts,
        feedbackEntries: exec.feedbackEntries,
        completedNodes,
        currentNodes: [],
      },
      ['errorMessage', 'failedNode'],
    );

    this.emit({ event: 'execution_started', data: { executionId, workflowName: workflow.name } });

    try {
      const result = await this.executeGraph(workflow, exec, 0);
      exec.status = 'completed';
      exec.completedAt = new Date();
      exec.durationMs = Date.now() - exec.startedAt.getTime();
      exec.currentNodes = [];
      await this.stateManager.updateExecution(executionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
        currentNodes: [],
        completedNodes: exec.completedNodes,
      });
      this.emit({
        event: 'execution_completed',
        data: { executionId, durationMs: exec.durationMs, cost: exec.cost },
      });
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      exec.status = 'failed';
      exec.errorMessage = message;
      await this.stateManager.updateExecution(executionId, {
        status: 'failed',
        errorMessage: message,
        failedNode: exec.failedNode,
      });
      await this.stateManager.saveFailureReport(exec, err as Error);
      this.emit({
        event: 'execution_failed',
        data: { executionId, failedNode: exec.failedNode, error: message },
      });
      throw err;
    }
  }

  /**
   * Resume execution from a SPECIFIC checkpoint (by id), not "the last
   * checkpoint before this node." Used by the Editable Checkpoints UI flow:
   * user edits a checkpoint's state, then clicks "Run from here" — the
   * edited state is loaded verbatim and the graph runs forward.
   *
   * Differs from retryFromNode:
   *   - Keyed by checkpoint._id instead of a node name
   *   - Uses checkpoint.completedNodes AS-IS (the checkpoint already
   *     represents the correct cut-point; no need to trim downstream)
   *   - Carries `input` forward from the existing execution record (same
   *     fix as retryFromNode)
   *
   * Runs against the SAME execution id — not a fork. Status transitions
   * `failed`/`cancelled` → `running` → `completed`/`failed` as normal.
   */
  async runFromCheckpoint(
    workflow: WorkflowDef,
    executionId: string,
    checkpointId: string,
  ): Promise<Record<string, unknown>> {
    const checkpoint = await this.stateManager.getCheckpointById(executionId, checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found for execution ${executionId}`);
    }

    const existing = await this.stateManager.getExecution(executionId);
    const latestSessions = await this.stateManager.getLatestSessions(executionId);
    const exec: ExecutionState = {
      id: executionId,
      workflowId: existing?.workflowId ?? '',
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? 1,
      status: 'running',
      input: existing?.input ?? {},
      state: { ...checkpoint.state } as Record<string, unknown>,
      sessions: { ...checkpoint.sessions, ...latestSessions },
      retryCounts: { ...checkpoint.retryCounts },
      feedbackEntries: [...((existing?.feedbackEntries as WorkflowFeedbackEntry[] | undefined) ?? [])],
      currentNodes: [],
      completedNodes: [...checkpoint.completedNodes],
      nodeAttempts: { ...(checkpoint.nodeAttempts ?? {}) },
      // This resumes the SAME executions row — seed from the cost already
      // accumulated before the pause/failure so completion doesn't wipe it.
      cost: {
        actual: existing?.cost?.actual ?? null,
        estimated: existing?.cost?.estimated ?? 0,
      },
      durationMs: 0,
      startedAt: new Date(),
    };

    // Clear prior error fields via $unset so the UI no longer shows them
    // after the re-run starts.
    await this.stateManager.updateExecutionWithUnset(
      executionId,
      {
        status: 'running',
        state: exec.state,
        sessions: exec.sessions,
        retryCounts: exec.retryCounts,
        feedbackEntries: exec.feedbackEntries,
        completedNodes: exec.completedNodes,
      },
      ['errorMessage', 'failedNode'],
    );

    this.emit({ event: 'execution_started', data: { executionId, workflowName: workflow.name } });

    try {
      const result = await this.executeGraph(workflow, exec, 0);
      exec.status = 'completed';
      exec.completedAt = new Date();
      exec.durationMs = Date.now() - exec.startedAt.getTime();
      exec.currentNodes = [];
      await this.stateManager.updateExecution(executionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
        currentNodes: [],
        completedNodes: exec.completedNodes,
      });
      this.emit({
        event: 'execution_completed',
        data: { executionId, durationMs: exec.durationMs, cost: exec.cost },
      });
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      exec.status = 'failed';
      exec.errorMessage = message;
      await this.stateManager.updateExecution(executionId, {
        status: 'failed',
        errorMessage: message,
        failedNode: exec.failedNode,
      });
      await this.stateManager.saveFailureReport(exec, err as Error);
      this.emit({
        event: 'execution_failed',
        data: { executionId, failedNode: exec.failedNode, error: message },
      });
      throw err;
    }
  }

  /**
   * Fork from a specific checkpoint into a NEW execution id. The new run
   * inherits the checkpoint's state/sessions/retryCounts/completedNodes but
   * gets its own executions row, own trace stream, own cost counter.
   * Useful for "try this state edit without destroying the original run."
   * Returns the new execution id.
   */
  async forkFromCheckpoint(
    workflow: WorkflowDef,
    sourceExecutionId: string,
    checkpointId: string,
    options?: { ownerId?: string; newExecutionId?: string },
  ): Promise<{ newExecutionId: string; result: Record<string, unknown> }> {
    const checkpoint = await this.stateManager.getCheckpointById(sourceExecutionId, checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found for execution ${sourceExecutionId}`);
    }
    const source = await this.stateManager.getExecution(sourceExecutionId);
    if (!source) {
      throw new Error(`Source execution ${sourceExecutionId} not found`);
    }

    const latestSessions = await this.stateManager.getLatestSessions(sourceExecutionId);
    // Caller may preallocate the id (service layer does this so the HTTP
    // response can return the id without awaiting execution completion).
    const newExecutionId = options?.newExecutionId ?? randomUUID();
    const exec: ExecutionState = {
      id: newExecutionId,
      workflowId: source.workflowId ?? '',
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? 1,
      status: 'running',
      input: source.input ?? {},
      state: { ...checkpoint.state } as Record<string, unknown>,
      sessions: { ...checkpoint.sessions, ...latestSessions },
      retryCounts: { ...checkpoint.retryCounts },
      feedbackEntries: [...((source.feedbackEntries as WorkflowFeedbackEntry[] | undefined) ?? [])],
      currentNodes: [],
      completedNodes: [...checkpoint.completedNodes],
      nodeAttempts: { ...(checkpoint.nodeAttempts ?? {}) },
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    } as ExecutionState;
    // Stamp ownerId + fork lineage as extra metadata. ExecutionState's type
    // doesn't declare these, so write via a plain object cast.
    const execAny = exec as unknown as Record<string, unknown>;
    if (options?.ownerId) execAny.ownerId = options.ownerId;
    execAny.forkedFrom = { executionId: sourceExecutionId, checkpointId };

    await this.stateManager.createExecution(exec);
    this.emit({ event: 'execution_started', data: { executionId: newExecutionId, workflowName: workflow.name } });

    try {
      const result = await this.executeGraph(workflow, exec, 0);
      exec.status = 'completed';
      exec.completedAt = new Date();
      exec.durationMs = Date.now() - exec.startedAt.getTime();
      exec.currentNodes = [];
      await this.stateManager.updateExecution(newExecutionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
        currentNodes: [],
        completedNodes: exec.completedNodes,
      });
      this.emit({
        event: 'execution_completed',
        data: { executionId: newExecutionId, durationMs: exec.durationMs, cost: exec.cost },
      });
      return { newExecutionId, result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      exec.status = 'failed';
      exec.errorMessage = message;
      await this.stateManager.updateExecution(newExecutionId, {
        status: 'failed',
        errorMessage: message,
        failedNode: exec.failedNode,
      });
      await this.stateManager.saveFailureReport(exec, err as Error);
      this.emit({
        event: 'execution_failed',
        data: { executionId: newExecutionId, failedNode: exec.failedNode, error: message },
      });
      throw err;
    }
  }

  /**
   * Submit human-in-the-loop input for a waiting execution.
   * Returns false if no pending resolver was found.
   */
  submitInput(executionId: string, node: string, data: Record<string, unknown>): boolean {
    const key = `${executionId}:${node}`;
    const resolver = this.pendingInputResolvers.get(key);
    if (resolver) {
      resolver.resolve(data);
      this.pendingInputResolvers.delete(key);
      return true;
    }
    return false;
  }

  /** Register a child-process abort controller against an execution. */
  private registerAbort(executionId: string, ac: AbortController): void {
    let set = this.abortControllers.get(executionId);
    if (!set) {
      set = new Set();
      this.abortControllers.set(executionId, set);
    }
    set.add(ac);
  }

  /** Remove a controller after its node finishes — keeps the map bounded. */
  private unregisterAbort(executionId: string, ac: AbortController): void {
    const set = this.abortControllers.get(executionId);
    if (!set) return;
    set.delete(ac);
    if (set.size === 0) this.abortControllers.delete(executionId);
  }

  cancelExecution(executionId: string): void {
    this.cancelledExecutions.add(executionId);
    // Abort every in-flight child process for this execution. Includes
    // serial node spawns, parallel-fork branches, and the parallel
    // coordinator's own fail-fast controller (which cascades to branches
    // via their abort listeners).
    const set = this.abortControllers.get(executionId);
    if (set) {
      for (const ac of set) {
        try { ac.abort(); } catch { /* ignore */ }
      }
      this.abortControllers.delete(executionId);
    }
    // Unblock any pending human-input awaits — otherwise the engine stays
    // parked inside waitForInput and never observes the cancel flag.
    const prefix = `${executionId}:`;
    for (const [key, resolver] of this.pendingInputResolvers) {
      if (key.startsWith(prefix)) {
        try { resolver.reject(new Error('Execution cancelled')); } catch { /* ignore */ }
        this.pendingInputResolvers.delete(key);
      }
    }
  }

  pauseExecution(executionId: string): void {
    this.pausedExecutions.add(executionId);
  }

  resumeExecution(executionId: string): void {
    this.pausedExecutions.delete(executionId);
  }

  private buildWorkflowFeedbackContext(nodeName: string, entries: WorkflowFeedbackEntry[]): string {
    if (entries.length === 0) return '';
    const applicableEntries = entries.filter((entry) => {
      const targets = entry.targetNodes ?? [];
      return targets.length === 0 || targets.includes(nodeName);
    });
    if (applicableEntries.length === 0) return '';

    const lines = applicableEntries.map((entry, index) => {
      const createdAt = entry.createdAt instanceof Date
        ? entry.createdAt.toISOString()
        : new Date(entry.createdAt).toISOString();
      return `${index + 1}. [${createdAt}] ${entry.content.trim()}`;
    });
    return `

WORKFLOW CORRECTIVE FEEDBACK
The user submitted the following cumulative feedback after earlier workflow attempts.
Treat it as authoritative corrective context for this execution. Apply all relevant
items to your current node task, and keep downstream requirements in mind.

${lines.join('\n')}
`;
  }

  private ensureScopedState(state: Record<string, unknown>): {
    inputs: Record<string, unknown>;
    nodes: Record<string, Record<string, unknown>>;
    human: Record<string, { latest?: HumanResumeInput; events: HumanResumeInput[] }>;
  } {
    if (!state.inputs || typeof state.inputs !== 'object' || Array.isArray(state.inputs)) {
      state.inputs = {};
    }
    if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes)) {
      state.nodes = {};
    }
    if (!state.human || typeof state.human !== 'object' || Array.isArray(state.human)) {
      state.human = {};
    }
    return {
      inputs: state.inputs as Record<string, unknown>,
      nodes: state.nodes as Record<string, Record<string, unknown>>,
      human: state.human as Record<string, { latest?: HumanResumeInput; events: HumanResumeInput[] }>,
    };
  }

  private writeNodeScopedOutput(state: Record<string, unknown>, nodeName: string, outputs: Record<string, unknown>): void {
    const scoped = this.ensureScopedState(state);
    const clean = { ...outputs };
    delete clean.__waiting_for_input;
    delete clean.__node;
    scoped.nodes[nodeName] = clean;
  }

  private writeHumanScopedInput(
    state: Record<string, unknown>,
    nodeName: string,
    humanInput: HumanResumeInput,
    targetNode?: string,
  ): HumanResumeInput[] {
    const scoped = this.ensureScopedState(state);
    const current = scoped.human[nodeName] ?? { events: [] };
    const events = [...(Array.isArray(current.events) ? current.events : []), humanInput];
    scoped.human[nodeName] = { latest: humanInput, events };
    const history = events.slice(0, -1);
    state.resume_context = this.buildHumanResumeContext(humanInput, targetNode, history);
    return history;
  }

  private buildHumanResumeContext(
    humanInput: HumanResumeInput,
    targetNode?: string,
    history: HumanResumeInput[] = [],
  ): ResumeContext {
    return {
      type: humanInput.kind === 'clarify' ? 'human_input' : 'human_review_feedback',
      sourceNode: humanInput.sourceNode,
      targetNode,
      attempt: history.length + 1,
      humanInput,
      retryExhaustion: humanInput.retryExhaustion,
      history,
      createdAt: new Date().toISOString(),
    };
  }

  private buildNodeFeedbackResumeContext(input: {
    sourceNodes: string[];
    targetNodes: string[];
    attempt?: number;
    retryContext?: string;
    retryExhaustion?: ResumeContext['retryExhaustion'];
    state: Record<string, unknown>;
  }): ResumeContext {
    const sourceNode = input.sourceNodes.join(',');
    const scoped = this.ensureScopedState(input.state);
    const fields: Array<{ name: string; label: string; value: unknown }> = [];
    for (const node of input.sourceNodes) {
      const outputs = scoped.nodes[node] ?? {};
      for (const [key, value] of Object.entries(outputs)) {
        if (key.startsWith('__') || value == null || value === '') continue;
        if (!/(failure|error|verdict|blocked|blocker|violation|status|report|artifact_url|details|feedback)/i.test(key)) continue;
        fields.push({ name: key, label: humanizeStateKey(key), value });
      }
    }
    return {
      type: input.retryExhaustion ? 'retry_exhausted' : 'node_feedback',
      sourceNode,
      targetNode: input.targetNodes.find((node) => node !== 'END'),
      attempt: input.attempt,
      nodeFeedback: {
        summary: input.retryContext,
        fields,
      },
      retryExhaustion: input.retryExhaustion,
      createdAt: new Date().toISOString(),
    };
  }

  // ── Post-Execution Review ──────────────────────────────────────────────────

  private async triggerPostExecutionReview(exec: ExecutionState): Promise<void> {
    try {
      const contextTags = (exec.state.__contextTags as string[]) ?? [];
      const traces = await this.stateManager.getTraces(exec.id);

      const hasRetries = traces.some((t: any) => t.attempt > 1);
      const hasFailures = traces.some((t: any) => t.status === 'failed');
      const hasGateEvents = !!(exec.state.__gate_action);

      this.learningManager.postExecutionReview(
        exec.id,
        exec.workflowName,
        contextTags,
        traces.map((t: any) => ({
          node: t.node,
          status: t.status,
          attempt: t.attempt,
          durationMs: t.durationMs,
          output: t.output,
          rawResponse: t.rawResponse,
        })),
        hasRetries,
        hasFailures,
        hasGateEvents,
        exec.durationMs,
      ).catch(() => {});
    } catch {
      // Fire-and-forget
    }
  }

  // ── Graph Execution ────────────────────────────────────────────────────────

  private async executeGraph(
    workflow: WorkflowDef,
    exec: ExecutionState,
    nestingDepth: number,
  ): Promise<Record<string, unknown>> {
    const nodes = workflow.nodes;
    const edges = workflow.edges;

    let currentNodes = this.getStartNodes(edges);
    if (currentNodes.length === 0) {
      throw new Error('No START node found in workflow edges');
    }

    // If resuming, skip already-completed nodes
    if (exec.completedNodes.length > 0) {
      currentNodes = this.getNextNodes(exec.completedNodes, edges, exec.state, exec.retryCounts, exec.id);
      if (currentNodes.length === 0 || currentNodes.includes('END')) {
        return exec.state;
      }
    }

    while (currentNodes.length > 0) {
      // Check cancellation
      if (this.cancelledExecutions.has(exec.id)) {
        this.cancelledExecutions.delete(exec.id);
        throw new Error('Execution cancelled');
      }

      // Check pause — wait until unpaused
      while (this.pausedExecutions.has(exec.id)) {
        await this.stateManager.updateExecution(exec.id, { status: 'waiting_for_input', cost: exec.cost });
        await sleep(1000);
        if (this.cancelledExecutions.has(exec.id)) {
          this.cancelledExecutions.delete(exec.id);
          this.pausedExecutions.delete(exec.id);
          throw new Error('Execution cancelled');
        }
      }

      exec.currentNodes = currentNodes;
      await this.stateManager.updateExecution(exec.id, {
        currentNodes,
        completedNodes: exec.completedNodes,
        state: exec.state,
        status: 'running',
      });

      // Check if current nodes ARE the targets of a parallel edge — i.e. we're
      // entering a parallel fork. This fires when getNextNodes / getStartNodes
      // returned multiple nodes that all match a single parallel edge's `to`.
      //
      // NOTE: we must NOT match when currentNodes[0] is the SOURCE of a parallel
      // edge — the source node must run first as a normal single-node execution;
      // the parallel fork happens afterwards when getNextNodes returns the targets.
      const parallelEdge = edges.find(e => {
        if (!e.parallel || !Array.isArray(e.to)) return false;
        if (e.to.length !== currentNodes.length) return false;
        return e.to.every(t => currentNodes.includes(t));
      });

      // Track which nodes we just finished so the dead-end diagnostic
      // below can name them if no outgoing edge matches.
      let justFinishedForDiag: string[] = [];

      if (parallelEdge && Array.isArray(parallelEdge.to)) {
        await this.executeParallelNodes(parallelEdge.to, parallelEdge, nodes, exec, nestingDepth);
        const parallelJustFinished = parallelEdge.to as string[];
        justFinishedForDiag = parallelJustFinished;
        const nextNodes = this.getNextNodes(exec.completedNodes, edges, exec.state, exec.retryCounts, exec.id, parallelJustFinished);
        currentNodes = nextNodes;
      } else {
        let gateAction: 'continue' | 'stop' | 'skip' | 'clarify' = 'continue';

        for (const nodeName of currentNodes) {
          if (nodeName === 'END') continue;
          gateAction = await this.executeSingleNode(nodeName, nodes[nodeName], exec, nestingDepth, edges, workflow);

          if (gateAction === 'stop' || gateAction === 'skip') {
            // Don't emit execution_completed here — let run() handle it
            // to avoid double-emit. Just return state to exit the graph.
            return exec.state;
          }

          // Re-entrant clarify loop — if the retry itself emits clarify again
          // (e.g. the user's first clarification wasn't enough, or they gave
          // more gibberish), pause AGAIN on the same node. Prior versions
          // fell through after one retry and let the workflow advance to
          // the next node while the agent was still asking for input.
          //
          // Track every clarify field name the user filled this round so we
          // can clean up ephemeral (non-declared) keys after the retry
          // completes without falling back into another clarify.
          const clarifyFieldNames: string[] = [];
          while (gateAction === 'clarify') {
            // Pause and wait for human input at this node
            const reason = (exec.state.__gate_reason as string) ?? 'Agent needs clarification';
            const clarifyAction = (exec.state.__clarify_action as string) ?? 'retry';
            const clarifyFields = exec.state.__clarify_fields as any[] | undefined;

            // Use agent-provided form fields, or fallback to single text input
            const fields: HumanField[] = Array.isArray(clarifyFields) && clarifyFields.length > 0
              ? clarifyFields as HumanField[]
              : [{ name: 'clarification', type: 'text', label: 'Your response', required: true }];
            for (const f of fields) {
              const n = (f as { name?: unknown }).name;
              if (typeof n === 'string' && n && !n.startsWith('__')) {
                clarifyFieldNames.push(n);
              }
            }

            exec.status = 'waiting_for_input';
            await this.stateManager.updateExecution(exec.id, {
              status: 'waiting_for_input',
              completedNodes: exec.completedNodes,
              state: exec.state,
              cost: exec.cost,
            });

            this.emit({
              event: 'input_required',
              data: {
                node: nodeName,
                prompt: reason,
                fields,
                intervention: renderClarifyIntervention(nodeName, reason, fields),
              },
            });

            this.log(exec.id, {
              level: 'warn',
              category: 'gate',
              node: nodeName,
              message: `Clarify (${clarifyAction}): ${reason}`,
            });

            const humanData = await this.waitForInput(exec.id, nodeName);
            this.emit({ event: 'input_received', data: { node: nodeName, data: humanData } });
            const intervention = renderClarifyIntervention(nodeName, reason, fields);
            const humanInput = buildHumanResumeInput(intervention, humanData);
            exec.state.human_input = humanInput;
            this.writeHumanScopedInput(exec.state, nodeName, humanInput, clarifyAction === 'retry' ? nodeName : undefined);
            appendHumanEvent(
              exec.state,
              buildHumanEvent(intervention, { human_input: humanInput }),
            );

            // Learning system: DON'T extract from every human correction inline
            // Single clarification is routine — not worth a learning
            // The post-execution review (Phase 4) will analyze the FULL trace
            // and extract learnings if a PATTERN emerges (e.g., this workflow
            // always needs clarification → suggest adding fields to input schema)
            //
            // Exception: if this is the 2nd+ clarify for the SAME node in the SAME execution,
            // that's a signal the workflow input schema is broken
            const clarifyCount = (exec.state.__clarify_count as number ?? 0) + 1;
            exec.state.__clarify_count = clarifyCount;

            const humanCorrectionCtx: ExtractionContext = {
              executionId: exec.id,
              workflowName: exec.workflowName,
              contextTags: (exec.state.__contextTags as string[]) ?? [],
              nodeName,
            };

            // Only extract if this is a repeated clarification (2nd+ time)
            if (clarifyCount >= 2) {
              const humanLearning = this.learningManager.extractFromHumanCorrection(
                nodeName,
                reason,
                humanData,
                humanCorrectionCtx,
              );
              if (humanLearning) {
                this.learningManager.classifyAndStore(humanLearning).catch(() => {});
              }
            }

            // Clean up gate fields so downstream nodes don't see stale data
            delete exec.state.__gate_action;
            delete exec.state.__gate_reason;
            delete exec.state.__gate_node;
            delete exec.state.__clarify_action;
            delete exec.state.__clarify_fields;

            exec.status = 'running';
            await this.stateManager.updateExecution(exec.id, { status: 'running' });

            if (clarifyAction === 'retry') {
              // Remove from completedNodes so the node can re-run
              exec.completedNodes = exec.completedNodes.filter(n => n !== nodeName);
              // Capture state before retry for delta extraction
              const preRetryState = { ...exec.state };
              exec.state.__retry_target = [nodeName];
              exec.state.__retry_source = nodeName;
              exec.state.__retry_attempt = clarifyCount + 1;
              // Re-run the same node immediately with the clarification
              gateAction = await this.executeSingleNode(nodeName, nodes[nodeName], exec, nestingDepth, edges, workflow);

              // Learning system: extract retry delta (fire-and-forget)
              if (gateAction === 'continue') {
                const retryDeltaCtx: ExtractionContext = {
                  executionId: exec.id,
                  workflowName: exec.workflowName,
                  contextTags: (exec.state.__contextTags as string[]) ?? [],
                  nodeName,
                };
                const retryLearning = this.learningManager.extractFromRetryDelta(
                  nodeName,
                  preRetryState,
                  exec.state,
                  retryDeltaCtx,
                  renderHumanResumePrompt(humanInput),
                );
                if (retryLearning) {
                  this.learningManager.classifyAndStore(retryLearning).catch(() => {});
                }

                // Clean up ephemeral clarify keys — names the clarify
                // introduced that aren't declared workflow variables.
                // Overwrite targets (template placeholders / upstream
                // fields) are kept; one-shot helpers are dropped so they
                // don't leak into downstream nodes.
                const dropped = cleanupEphemeralClarifyKeys(
                  exec.state,
                  clarifyFieldNames,
                  nodeName,
                  workflow,
                );
                if (dropped.length > 0) {
                  this.log(exec.id, {
                    category: 'gate',
                    node: nodeName,
                    level: 'debug',
                    message: `Cleaned up ${dropped.length} ephemeral clarify key(s): ${dropped.join(', ')}`,
                    data: { dropped },
                  });
                }
              }

              // If re-run returns stop/skip, exit graph
              if (gateAction === 'stop' || gateAction === 'skip') {
                return exec.state;
              }
              // If re-run returns 'clarify' again, loop back to the top of
              // the while(gateAction === 'clarify') and pause once more on
              // the same node with the fresh gate context the retry just
              // wrote into state.
            } else {
              // 'continue' clarify: node's original output stays, human
              // input is merged into state, fall through to advance to
              // the next nodes. Break out of the clarify loop.
              break;
            }
          }
          // For 'continue' (via break above): advance to next nodes.
        }

        // Pass exec.completedNodes BY REFERENCE so getNextNodes can rewind
        // downstream history when a retry edge fires. justFinished is passed
        // separately — join edges use (completedNodes ∪ justFinished) for the
        // allFromCompleted check, while retry edges require at least one source
        // in justFinished to prevent infinite loops on stale state.
        const justFinished = currentNodes.filter(n => n !== 'END');
        justFinishedForDiag = justFinished;
        currentNodes = this.getNextNodes(exec.completedNodes, edges, exec.state, exec.retryCounts, exec.id, justFinished);
      }

      if (currentNodes.includes('END')) {
        break;
      }
      if (currentNodes.length === 0) {
        // Dead-end: getNextNodes returned no matches. Previously this
        // silently broke the loop and `run()` marked the execution as
        // `completed`, which looked identical to a successful finish —
        // the most dangerous possible failure mode because the operator
        // couldn't tell something went wrong. Common causes:
        //   - A verdict/decision field has a value no outgoing edge covers
        //     (e.g. plan_approval_gate request_changes with empty scope,
        //     or an agent emitting an unexpected string for a verdict key).
        //   - Conditions that use `!=` against undefined: the condition
        //     parser coerces undefined to false, so `foo != 'x'` is true
        //     even when foo was never set — the workflow author likely
        //     intended a stricter check.
        // Throw with the current state so the operator sees it.
        const stuck = justFinishedForDiag.length > 0
          ? justFinishedForDiag.join(', ')
          : 'unknown';
        throw new Error(
          `Workflow stuck after node(s) [${stuck}]: no outgoing edge matched the current state. ` +
          `Add a condition that covers this case, or route unexpected verdicts to escalation_review / END.`,
        );
      }
    }

    return exec.state;
  }

  // ── Single Node Execution ──────────────────────────────────────────────────

  /**
   * Execute a single node. Returns the auto-gate action if the agent signals one.
   */
  private async executeSingleNode(
    nodeName: string,
    nodeDef: NodeDef | undefined,
    exec: ExecutionState,
    nestingDepth: number,
    edges?: EdgeDef[],
    workflow?: WorkflowDef,
  ): Promise<'continue' | 'stop' | 'skip' | 'clarify'> {
    if (!nodeDef) {
      throw new Error(`Node definition not found: ${nodeName}`);
    }

    // Per-node attempt counter. Monotonically increases for every node
    // across the entire execution — independent of `completedNodes`
    // (which gets spliced when retry edges rewind downstream history).
    // Previously the counter was `completedNodes.filter(...).length + 1`,
    // which reset to 1 for any node downstream of a retry target (because
    // its prior entry was spliced out). Now every node's trace rows carry
    // a correct, increasing attempt number even mid-retry-loop.
    const edgeRetryKey = this.findRetryEdgeKey(nodeName, exec.retryCounts);
    exec.nodeAttempts[nodeName] = (exec.nodeAttempts[nodeName] ?? 0) + 1;
    const attempt = exec.nodeAttempts[nodeName];
    const traceStart = new Date();
    const executionTraceId = randomUUID();

    const nodeType = nodeDef.type ?? 'agent';

    // Compute hasConditionalOutEdges — informational for logging. We used to
    // gate auto-gate behavior on this, but auto-gate is about short-circuiting
    // the workflow (STOP/SKIP), which is orthogonal to conditional routing.
    // Agents on conditional-edge nodes still need to be able to say "the
    // premise is broken, stop everything" — see buildNodeContext for details.
    const hasConditionalOutEdges = edges?.some(e => {
      const froms = Array.isArray(e.from) ? e.from : [e.from];
      return froms.includes(nodeName) && (e.condition || e.max_retries != null);
    }) ?? false;

    // Build context-aware auto-gate instruction for EVERY agent node,
    // regardless of whether it has conditional outgoing edges.
    //
    // Also inject a short index of artifacts produced by upstream nodes so
    // this agent can fetch full content via allen_get_artifact when
    // templated state values might be truncated or summarized. Lookup is
    // best-effort — if the service hook isn't wired (e.g. in tests), we
    // skip the index silently.
    let upstreamArtifacts: import('./output-extractor.js').UpstreamArtifactSummary[] | undefined;
    if (nodeType === 'agent' && this.config.services?.artifacts?.listForRoot) {
      try {
        const artifactRootType = (process.env.ALLEN_ARTIFACT_ROOT_TYPE as 'workflow' | 'chat' | 'agent' | undefined) ?? 'workflow';
        const artifactRootId = process.env.ALLEN_ARTIFACT_ROOT_ID || exec.id;
        const list = await this.config.services.artifacts.listForRoot({
          rootType: artifactRootType,
          rootId: artifactRootId,
          limit: 30,
        });
        upstreamArtifacts = list;
      } catch {
        /* best effort — skip the index if the lookup fails */
      }
    }
    const workflowNodeContext = nodeType === 'agent' && workflow
      ? buildNodeContext(
          nodeName,
          { nodes: workflow.nodes as Record<string, unknown>, edges: workflow.edges as unknown as Array<Record<string, unknown>> },
          upstreamArtifacts,
        )
      : '';
    let nodeContext = workflowNodeContext;
    let repoKnowledgePacket: Awaited<ReturnType<NonNullable<EngineServices['repoKnowledge']>['buildNodeContextPacket']>> | null = null;
    if (nodeType === 'agent' && this.config.services?.repoKnowledge?.buildNodeContextPacket) {
      try {
        const renderedNodePrompt = nodeDef.prompt ? renderTemplate(nodeDef.prompt, exec.state) : undefined;
        const agentDef = nodeDef.agent ? this.config.agents[nodeDef.agent] : undefined;
        const effectiveProvider = resolveAgentNodeEffectiveProvider(
          nodeName,
          nodeDef,
          exec.state,
          agentDef,
          { aliasMap: this.config.aliasMap, modelProviderMap: this.config.modelProviderMap },
        );
        const packetProvider = effectiveProvider === 'codex' ? 'codex' : 'claude';
        repoKnowledgePacket = await this.config.services.repoKnowledge.buildNodeContextPacket({
          executionId: exec.id,
          workflowName: exec.workflowName,
          nodeName,
          nodeRole: nodeDef.agent,
          executionKind: 'workflow_node',
          targetRole: nodeDef.agent,
          attempt,
          state: exec.state,
          prompt: renderedNodePrompt,
          provider: packetProvider,
        });
        if (repoKnowledgePacket) {
          nodeContext = workflowNodeContext;
          this.log(exec.id, {
            category: 'system',
            node: nodeName,
            message: `[repo-knowledge] Resolved context packet ${repoKnowledgePacket.packetId}`,
            data: repoKnowledgePacket.traceSummary,
          });
        }
      } catch (err) {
        this.log(exec.id, {
          category: 'system',
          level: 'warn',
          node: nodeName,
          message: `[repo-knowledge] Failed to build node context packet: ${(err as Error).message}`,
        });
      }
    }

    // Learning injection: query and inject relevant learnings before execution.
    // Skip entirely when ALLEN_AGENT_SKIP_LEARNINGS=true — useful when you want
    // the agent's behavior to depend only on its system prompt + explicit
    // memory-tool reads, with no engine-side learning-context injection.
    const contextTags = (exec.state.__contextTags as string[]) ?? [];
    let injectedLearningIds: any[] = [];
    /** Trace-friendly snapshot of injected learnings, pinned to THIS node's
     *  trace row so the UI can display them inline with the prompt. */
    let learningsInjectedTrace: Array<{ id?: string; content: string; contextTags?: string[] }> = [];
    const skipLearnings = process.env.ALLEN_AGENT_SKIP_LEARNINGS === 'true';
    if (nodeType === 'agent' && !skipLearnings) {
      try {
        const learnings = await this.learningManager.query(
          contextTags,
          exec.workflowName,
          nodeDef.agent,
          nodeName,
          550,
        );
        if (learnings.length > 0) {
          nodeContext = `${workflowNodeContext}${this.learningManager.buildLearningsPrompt(learnings)}`;
          injectedLearningIds = learnings.map(l => l._id).filter(Boolean);
          learningsInjectedTrace = learnings.map((l) => ({
            id: l._id ? String(l._id) : undefined,
            content: (l.content ?? '').slice(0, 500),
            contextTags: (l as unknown as { contextTags?: string[] }).contextTags,
          }));
          const totalTokens = learnings.reduce((sum, l) => sum + l.tokenCount, 0);
          const previews = learnings.map(l => `"${l.content.slice(0, 50)}..."`).join(', ');
          this.config.db.collection('memory_injection_audits').insertOne({
            rootType: 'agent_execution',
            rootId: exec.id,
            agentName: nodeDef.agent ?? nodeName,
            nodeName,
            query: `${exec.workflowName}:${nodeName}`,
            retrievedLearningIds: injectedLearningIds.map(String),
            retrievalScores: [],
            injectedLearningIds: injectedLearningIds.map(String),
            injectedTokenCount: totalTokens,
            promptContextHash: `${exec.id}:${nodeName}:${attempt}`,
            createdAt: new Date(),
          }).catch(() => {});
          this.log(exec.id, {
            category: 'system',
            node: nodeName,
            message: `[learning] Injected ${learnings.length} learnings (tokens: ${totalTokens}/550): ${previews}`,
          });
        }
      } catch {
        // Fire-and-forget — never block execution
      }
    } else if (nodeType === 'agent' && skipLearnings) {
      this.log(exec.id, {
        category: 'system',
        node: nodeName,
        message: `[learning] skipped (ALLEN_AGENT_SKIP_LEARNINGS=true)`,
      });
    }

    const feedbackEntries = (exec.feedbackEntries ?? []).filter(
      (entry) => typeof entry.content === 'string' && entry.content.trim().length > 0,
    );
    const applicableFeedbackEntries = feedbackEntries.filter((entry) => {
      const targets = entry.targetNodes ?? [];
      return targets.length === 0 || targets.includes(nodeName);
    });
    const feedbackContext = nodeType === 'agent'
      ? this.buildWorkflowFeedbackContext(nodeName, feedbackEntries)
      : '';
    if (feedbackContext) {
      this.log(exec.id, {
        category: 'system',
        node: nodeName,
        message: `[feedback] Injected ${applicableFeedbackEntries.length} workflow feedback entr${applicableFeedbackEntries.length === 1 ? 'y' : 'ies'}`,
        data: { feedbackIds: applicableFeedbackEntries.map((entry) => entry.id) },
      });
    }
    if (nodeType === 'agent') {
      const humanHistory = renderHumanHistory(exec.state);
      if (humanHistory) {
        nodeContext = `${nodeContext}\n\n${humanHistory}\n`;
      }
    }

    // Create abort controller for this node — cancelled via cancelExecution()
    const ac = new AbortController();
    this.registerAbort(exec.id, ac);

    const deps: NodeExecutorDeps = {
      agents: this.config.agents,
      builtIns: this.config.builtIns,
      workflows: this.config.workflows,
      emitter: this.config.emitter,
      runWorkflow: (wf, input) => this.run(wf, input, nestingDepth + 1, {
        parentExecutionId: exec.id,
        rootExecutionId: exec.rootExecutionId ?? exec.id,
      }),
      executionId: exec.id,
      nodeContext,
      feedbackContext,
      db: this.config.db,
      services: this.config.services,
      abortSignal: ac.signal,
      discoverMcpToolNames: this.config.discoverMcpToolNames,
      claudeCodeExecutable: this.config.claudeCodeExecutable,
      buildClaudeCompatibleEnvOverlay: this.config.buildClaudeCompatibleEnvOverlay,
      repoKnowledgeContext: repoKnowledgePacket?.traceSummary ? {
        packetId: repoKnowledgePacket.traceSummary.packetId,
        repoId: repoKnowledgePacket.traceSummary.repoId,
        repoName: repoKnowledgePacket.traceSummary.repoName,
        indexId: repoKnowledgePacket.traceSummary.indexId,
        indexFreshness: repoKnowledgePacket.traceSummary.indexFreshness,
        systemPromptBlock: repoKnowledgePacket.systemPromptBlock,
        mandatoryContextInjectedCount: repoKnowledgePacket.traceSummary.mandatoryContextInjectedCount,
        mandatoryContextSkippedProviderNativeCount: repoKnowledgePacket.traceSummary.mandatoryContextSkippedProviderNativeCount,
        mandatoryContextTargetLayer: repoKnowledgePacket.traceSummary.mandatoryContextTargetLayer,
      } : undefined,
      aliasMap: this.config.aliasMap,
      costMap: this.config.costMap,
      modelProviderMap: this.config.modelProviderMap,
    };
    // Effective model/provider for the node-start log.  agentOverrides win over
    // agent document defaults — mirrors the resolution inside executeNode so the
    // log reflects what the agent will actually run with, not just the role default.
    const logAgent = nodeType === 'agent' && nodeDef.agent ? deps.agents[nodeDef.agent] : undefined;
    const logRecoveryOverrides = exec.state.__model_overrides as Record<string, import('./model-recovery.js').NodeModelOverride[]> | undefined;
    const logRecoveryOverride = logRecoveryOverrides?.[nodeName]?.at(-1);
    const logEffectiveProvider = nodeType === 'agent'
      ? resolveAgentNodeEffectiveProvider(nodeName, nodeDef, exec.state, logAgent, deps)
      : undefined;
    const logEffectiveModel = logRecoveryOverride?.model ?? nodeDef.agentOverrides?.model ?? logAgent?.model;
    this.log(exec.id, {
      category: 'system',
      node: nodeName,
      message: `Node started (type: ${nodeType}${nodeDef.agent ? `, role: ${nodeDef.agent}` : ''}${logEffectiveProvider && logEffectiveProvider !== 'claude' && logEffectiveProvider !== 'claude-cli' ? `, provider: ${logEffectiveProvider}` : ''}${logEffectiveModel ? `, model: ${logEffectiveModel}` : ''})`,
    });

    try {
      const result = await executeNode(nodeName, nodeDef, exec.state, exec.sessions, deps);
      // Subprocess has exited (or was aborted) — drop the controller so a
      // later cancel doesn't try to abort a stale handle. waitForInput
      // below has its own pendingInputResolvers cancel path and doesn't
      // need an AbortController.
      this.unregisterAbort(exec.id, ac);

      // Handle human node waiting
      if (result.outputs.__waiting_for_input) {
        const intervention = renderHumanIntervention(nodeName, nodeDef, exec.state, workflow);
        exec.status = 'waiting_for_input';
        await this.stateManager.updateExecution(exec.id, {
          status: 'waiting_for_input',
          completedNodes: exec.completedNodes,
          state: exec.state,
          cost: exec.cost,
        });

        // Save checkpoint before waiting
        await this.stateManager.saveCheckpoint({
          executionId: exec.id,
          afterNode: nodeName,
          state: { ...exec.state },
          sessions: { ...exec.sessions },
          retryCounts: { ...exec.retryCounts },
          completedNodes: [...exec.completedNodes],
          nodeAttempts: { ...exec.nodeAttempts },
          createdAt: new Date(),
        });

        const humanData = await this.waitForInput(exec.id, nodeName);
        this.emit({ event: 'input_received', data: { node: nodeName, data: humanData } });

        const humanInput = buildHumanResumeInput(intervention, humanData);
        exec.state.human_input = humanInput;
        this.writeHumanScopedInput(exec.state, nodeName, humanInput, humanInput.route?.targetNode);
        appendHumanEvent(exec.state, buildHumanEvent(intervention, { human_input: humanInput }));
        result.outputs.human_input = humanInput;
        for (const field of humanInput.fields) {
          if (nodeDef.outputs && Object.prototype.hasOwnProperty.call(nodeDef.outputs, field.name)) {
            exec.state[field.name] = field.value;
            result.outputs[field.name] = field.value;
          }
        }
        delete result.outputs.__waiting_for_input;
        delete result.outputs.__node;

        exec.status = 'running';
        await this.stateManager.updateExecution(exec.id, { status: 'running' });
      }

      let contextUsageTrace: NonNullable<NodeTrace['contextUsage']> | null = null;
      let contextEvaluationId: string | undefined;
      if (nodeType === 'agent' && this.config.services?.repoKnowledge?.recordContextUsage) {
        try {
          const recordedUsage = await this.config.services.repoKnowledge.recordContextUsage({
            executionId: exec.id,
            executionTraceId,
            workflowName: exec.workflowName,
            nodeName,
            nodeRole: nodeDef.agent,
            executionKind: 'workflow_node',
            targetRole: nodeDef.agent,
            attempt,
            packetId: repoKnowledgePacket?.packetId,
            outputs: result.outputs,
            rawResponse: result.rawResponse,
            toolCalls: result.toolCalls,
          });
          contextUsageTrace = recordedUsage ? {
            traceId: recordedUsage.traceId,
            preselectedCount: recordedUsage.preselectedCount,
            loadedCount: recordedUsage.loadedCount,
            appliedCount: recordedUsage.appliedCount,
            skippedCount: recordedUsage.skippedCount,
          } : null;
          contextEvaluationId = typeof recordedUsage?.contextEvaluation?.evaluationId === 'string'
            ? recordedUsage.contextEvaluation.evaluationId
            : typeof recordedUsage?.contextEvaluation?.traceId === 'string'
              ? recordedUsage.contextEvaluation.traceId
              : undefined;
          if (recordedUsage?.repoContextUsage && !hasMeaningfulRepoContextUsage(result.outputs.repo_context_usage)) {
            result.outputs.repo_context_usage = recordedUsage.repoContextUsage;
          }
        } catch (err) {
          this.log(exec.id, {
            category: 'system',
            level: 'warn',
            node: nodeName,
            message: `[repo-knowledge] Failed to record context usage: ${(err as Error).message}`,
          });
        }
      }

      // Update state with outputs after context usage synthesis so downstream
      // nodes see repo_context_usage even when the agent omitted it.
      this.writeNodeScopedOutput(exec.state, nodeName, result.outputs);
      Object.assign(exec.state, result.outputs);

      // If this node ran as the target of a retry edge, consume the retry
      // payload (retry_context + flags) so forward-path nodes downstream
      // don't see stale feedback. The engine is the single source of truth
      // for retry plumbing — workflow authors never manage this manually.
      const retryTargets = exec.state.__retry_target as string[] | undefined;
      if (Array.isArray(retryTargets) && retryTargets.includes(nodeName)) {
        delete exec.state.retry_context;
        delete exec.state.human_input;
        delete exec.state.resume_context;
        delete exec.state.__retry_target;
        delete exec.state.__retry_attempt;
        delete exec.state.__retry_source;
      }

      // Track session for resume. Use the resolved session_key when the
      // node declared one (per-iteration isolation, e.g. per-milestone);
      // otherwise fall back to nodeName so existing workflows behave
      // exactly as before.
      if (result.sessionId) {
        exec.sessions[result.sessionKey ?? nodeName] = result.sessionId;
      }

      // Update cost (sequential — no race condition)
      exec.cost.estimated += result.cost.estimated;
      if (result.cost.actual != null) {
        exec.cost.actual = (exec.cost.actual ?? 0) + result.cost.actual;
      }

      // Update token usage (per-field null-aware aggregation)
      exec.tokenUsage = aggregateTokenUsage(exec.tokenUsage, result.tokenUsage);

      exec.completedNodes.push(nodeName);

      // Save trace.
      //
      // Phase 2 enrichments are all optional and additive:
      // - templateBindings: placeholder → resolved values from nodeDef.prompt
      // - learningsInjected: learnings attached to this specific node spawn
      // - runtimeContext / agentOverrides / toolsAvailable / tokenUsagePerTool /
      //   gateDecision: populated by node-executor and bubbled up via NodeResult
      // - retryReason: set on retry rows only (attempt > 1). For attempt 1 of
      //   a normal first run it stays undefined.
      const promptRender = nodeDef.prompt
        ? renderTemplateWithBindings(nodeDef.prompt, exec.state)
        : undefined;
      const resultExt = result as unknown as NodeResult;
      const trace: NodeTrace = {
        node: nodeName,
        executionTraceId,
        attempt,
        status: 'completed',
        type: nodeDef.type ?? 'agent',
        agent: nodeDef.agent,
        inputState: { ...exec.state },
        // Prefer the executor's actual prompt (carries retry/forward
        // shape on retries). Fall back to the template re-render only for
        // non-agent paths that don't set result.prompt.
        renderedPrompt: resultExt.prompt ?? promptRender?.rendered,
        output: result.outputs,
        rawResponse: result.rawResponse,
        activity: [],
        sessionId: result.sessionId,
        cost: result.cost,
        durationMs: result.durationMs,
        startedAt: traceStart,
        completedAt: new Date(),
        toolCalls: result.toolCalls,
        // Enrichments — any still-undefined fields are dropped by Mongo on $set.
        templateBindings: promptRender?.bindings,
        learningsInjected: learningsInjectedTrace.length > 0 ? learningsInjectedTrace : undefined,
        contextAttemptId: repoKnowledgePacket?.packetId,
        contextUsageTraceId: contextUsageTrace?.traceId,
        contextEvaluationId,
        feedbackInjected: applicableFeedbackEntries.length > 0
          ? applicableFeedbackEntries.map((entry) => ({ id: entry.id, createdAt: entry.createdAt }))
          : undefined,
        runtimeContext: resultExt.runtimeContext,
        agentOverrides: resultExt.agentOverrides,
        toolsAvailable: resultExt.toolsAvailable,
        tokenUsagePerTool: resultExt.tokenUsagePerTool,
        tokenUsage: resultExt.tokenUsage ?? null,
        provider: resultExt.provider,
        childExecutionId: resultExt.childExecutionId,
        gateDecision: resultExt.gateDecision,
      };

      await this.stateManager.saveTrace({ ...trace, executionId: exec.id });

      // Note: there used to be an auto-capture hook here that saved outputs
      // named *_markdown / *_json / *_csv as artifacts. It was removed —
      // agents are now required to save their own artifacts via the
      // `allen_save_artifact` MCP tool for any plan, design doc, report,
      // or summary they produce. This keeps artifact content and naming
      // under the agent's control (one save call with the full text,
      // instead of the engine grabbing whatever happened to parse into
      // state, which could be truncated). See ARTIFACTS_GUIDANCE in
      // packages/engine/src/agent-file-writer.ts for the agent-side contract.

      // Save checkpoint
      await this.stateManager.saveCheckpoint({
        executionId: exec.id,
        afterNode: nodeName,
        state: { ...exec.state },
        sessions: { ...exec.sessions },
        retryCounts: { ...exec.retryCounts },
        completedNodes: [...exec.completedNodes],
        nodeAttempts: { ...exec.nodeAttempts },
        createdAt: new Date(),
      });

      const costStr = result.cost.actual != null ? `$${result.cost.actual.toFixed(4)}` : `~$${result.cost.estimated.toFixed(4)}`;
      const nodeTokenUsage = result.tokenUsage;
      const tokenStr = nodeTokenUsage
        ? ` — tokens: ${nodeTokenUsage.inputCachedTokens ?? '—'} in cached · ${nodeTokenUsage.inputNonCachedTokens ?? '—'} in fresh · ${nodeTokenUsage.outputTokens ?? '—'} out`
        : '';
      this.log(exec.id, {
        category: 'system',
        node: nodeName,
        message: `Node completed in ${(result.durationMs / 1000).toFixed(1)}s — cost: ${costStr}${tokenStr}`,
      });

      // Log extracted outputs
      const outputKeys = Object.keys(result.outputs).filter(k => !k.startsWith('__'));
      if (outputKeys.length > 0) {
        this.log(exec.id, {
          category: 'system',
          node: nodeName,
          message: `Extracted outputs: ${outputKeys.join(', ')}`,
          data: { outputKeys },
        });
      }

      this.emit({
        event: 'node_completed',
        data: {
          node: nodeName,
          attempt,
          output: result.outputs,
          durationMs: result.durationMs,
          cost: result.cost,
        },
      });

      // Learning system: confirm injected learnings on success (fire-and-forget)
      const learningCtx: ExtractionContext = {
        executionId: exec.id,
        workflowName: exec.workflowName,
        contextTags,
        nodeName,
      };

      for (const lid of injectedLearningIds) {
        this.learningManager.confirm(lid, exec.id).catch(() => {});
      }

      // Learning system: extract from __learnings in output (fire-and-forget)
      if (Array.isArray(result.outputs.__learnings)) {
        const agentLearnings = this.learningManager.extractFromAgentOutput(
          result.outputs.__learnings as any[],
          learningCtx,
        );
        for (const l of agentLearnings) {
          this.learningManager.classifyAndStore(l).catch(() => {});
        }
        // Clean up __learnings from state
        delete exec.state.__learnings;
      }

      // Auto-gate: check if agent signaled stop / skip / clarify.
      //
      // Runs for EVERY agent node now, including nodes with conditional
      // outgoing edges. Auto-gate is about short-circuiting the workflow
      // (the premise is broken, the task is already done, continuing is
      // wasted tokens), which is orthogonal to conditional routing. An
      // agent that wants to use its conditional edges simply omits
      // `__action` from its output — same as before.
      //
      // The `hasConditionalOutEdges` flag is kept for the log line so
      // operators can see that this gate fired on a node that also had
      // branch routing — useful forensic signal.
      if (nodeType === 'agent') {
        const gate = extractAutoGateFields(result.rawResponse ?? '', result.outputs);
        if (gate.action !== 'continue') {
          this.log(exec.id, {
            category: 'gate',
            node: nodeName,
            message: `Auto-gate: ${gate.action} — ${gate.reason ?? 'Agent decided to ' + gate.action}`,
            data: {
              action: gate.action,
              reason: gate.reason,
              clarifyAction: gate.clarifyAction,
              onConditionalEdgeNode: hasConditionalOutEdges,
            },
          });

          // Learning system: extract from auto-gate ONLY for stop (workflow was pointless)
          // Clarify is routine — not worth a learning unless it happens repeatedly
          // The post-execution review (Phase 4) will analyze patterns across the full trace
          if (gate.action === 'stop') {
            const gateLearning = this.learningManager.extractFromAutoGate(
              nodeName,
              gate.action,
              gate.reason ?? '',
              learningCtx,
            );
            if (gateLearning) {
              this.learningManager.classifyAndStore(gateLearning).catch(() => {});
            }
          }

          // For clarify gates lacking context, ask Haiku to synthesize a
          // targeted reason + fields from the raw response and input state.
          // Skipped when the agent already provided both (or when no API
          // key is configured — the synthesizer returns null and we fall
          // back to the agent-provided values or the generic defaults).
          let synthReason: string | undefined;
          let synthFields: unknown[] | undefined;
          if (gate.action === 'clarify'
            && needsSynthesis(gate.reason, gate.clarifyFields)) {
            this.log(exec.id, {
              category: 'gate',
              node: nodeName,
              level: 'info',
              message: `Clarify synthesizer: triggered (agent reason empty/boilerplate, no fields)`,
            });
            // Collect workflow context so the synthesizer can distinguish
            // "fix a bad input" (reuse template/upstream name → overwrite)
            // from "ask for missing info" (fresh name → ephemeral).
            const templatePlaceholders = typeof nodeDef.prompt === 'string'
              ? collectPlaceholders(nodeDef.prompt)
              : [];
            const upstreamFields = collectUpstreamHumanFields(nodeName, workflow);
            const nodeOutputs = nodeDef.outputs && typeof nodeDef.outputs === 'object'
              ? Object.keys(nodeDef.outputs as Record<string, unknown>)
              : [];
            const synth = await synthesizeClarifyContext({
              nodeName,
              nodePrompt: typeof nodeDef.prompt === 'string' ? nodeDef.prompt : undefined,
              rawResponse: result.rawResponse,
              inputVars: exec.state,
              agentReason: gate.reason,
              templatePlaceholders,
              upstreamFields,
              nodeOutputs,
              abortSignal: ac.signal,
              log: (entry) => {
                switch (entry.phase) {
                  case 'start':
                    this.log(exec.id, {
                      category: 'gate',
                      node: nodeName,
                      level: 'debug',
                      message: `Clarify synthesizer: calling ${entry.model} (${entry.contextChars} chars of context)`,
                      data: entry,
                    });
                    break;
                  case 'haiku_response':
                    this.log(exec.id, {
                      category: 'gate',
                      node: nodeName,
                      level: 'debug',
                      message: `Clarify synthesizer: Haiku responded in ${entry.durationMs}ms (${entry.textLen} chars)`,
                      data: entry,
                    });
                    break;
                  case 'parsed':
                    this.log(exec.id, {
                      category: 'gate',
                      node: nodeName,
                      level: 'info',
                      message: `Clarify synthesizer: ${entry.fieldCount} field(s) — ${entry.fieldTypes.join(', ')}`,
                      data: entry,
                    });
                    break;
                  case 'skipped':
                    this.log(exec.id, {
                      category: 'gate',
                      node: nodeName,
                      level: 'debug',
                      message: `Clarify synthesizer: skipped — ${entry.reason}`,
                      data: entry,
                    });
                    break;
                  case 'strict_rewrite':
                    this.log(exec.id, {
                      category: 'gate',
                      node: nodeName,
                      level: 'warn',
                      message: `Clarify synthesizer: strict rewrite — ${entry.detail}`,
                      data: entry,
                    });
                    break;
                  case 'failed':
                    this.log(exec.id, {
                      category: 'gate',
                      node: nodeName,
                      level: 'warn',
                      message: `Clarify synthesizer: failed at ${entry.stage} — ${entry.reason}${entry.detail ? ` (${entry.detail})` : ''}`,
                      data: entry,
                    });
                    break;
                }
              },
            });
            if (synth) {
              synthReason = synth.reason;
              synthFields = synth.fields;
              this.log(exec.id, {
                category: 'gate',
                node: nodeName,
                level: 'info',
                message: `Clarify synthesized → "${synth.reason.slice(0, 120)}"`,
                data: { fieldCount: synth.fields.length, synthesized: true },
              });
            } else {
              this.log(exec.id, {
                category: 'gate',
                node: nodeName,
                level: 'warn',
                message: `Clarify synthesizer returned null — falling back to agent/engine defaults`,
              });
            }
          }

          // Store reason in state for visibility
          exec.state.__gate_action = gate.action;
          exec.state.__gate_reason = synthReason ?? gate.reason ?? 'Agent decided to ' + gate.action;
          exec.state.__gate_node = nodeName;
          if (gate.clarifyAction) {
            exec.state.__clarify_action = gate.clarifyAction;
          }
          // Prefer agent-provided fields; only use synthesized ones when
          // the agent didn't supply any.
          if (gate.clarifyFields && gate.clarifyFields.length > 0) {
            exec.state.__clarify_fields = gate.clarifyFields;
          } else if (synthFields && synthFields.length > 0) {
            exec.state.__clarify_fields = synthFields;
          }
          return gate.action as 'stop' | 'skip' | 'clarify';
        } else {
          this.log(exec.id, {
            category: 'gate',
            node: nodeName,
            level: 'debug',
            message: 'Auto-gate: continue',
          });
        }
      }

      return 'continue';
    } catch (err: unknown) {
      // Drop the controller on the failure path too — its child has either
      // exited with an error or been aborted; either way nothing to abort.
      this.unregisterAbort(exec.id, ac);
      exec.failedNode = nodeName;
      const message = err instanceof Error ? err.message : String(err);

      // Distinguish cancel from hard failure so the UI can render a grey
      // "cancelled" chip instead of a red "failed" one. Signal.aborted is
      // the most reliable indicator — the engine only aborts this AC via
      // cancelExecution, so a fired signal always means user cancel. Fall
      // back to message-based detection for safety (e.g., waitForInput's
      // rejection predates the abort wiring).
      const wasCancelled =
        ac.signal.aborted ||
        message === 'Execution cancelled' ||
        message === 'Branch cancelled by join policy';

      // ── Model Recovery: detect recoverable provider/model failures ─────
      // PRD refs: AC1 (recovery pause), AC15 (non-recoverable keeps existing behavior)
      if (!wasCancelled) {
        // Determine the effective provider and model for classification
        const role = nodeDef.agent ? this.config.agents[nodeDef.agent] : undefined;
        const recoveryOverrides = exec.state.__model_overrides as Record<string, import('./model-recovery.js').NodeModelOverride[]> | undefined;
        const latestOverride = recoveryOverrides?.[nodeName]?.at(-1);
        const effectiveProvider = resolveAgentNodeEffectiveProvider(
          nodeName,
          nodeDef,
          exec.state,
          role,
          { aliasMap: this.config.aliasMap, modelProviderMap: this.config.modelProviderMap },
        );
        const effectiveModel = latestOverride?.model ?? nodeDef.agentOverrides?.model ?? role?.model ?? 'sonnet';

        const cls = classifyFailure(err, { provider: effectiveProvider, model: effectiveModel });

        if (cls.recoverable) {
          // Build or retrieve recovery state for this node
          let recoveryState: RecoveryState = (exec.state.__recovery_state as RecoveryState) ?? buildRecoveryState({
            nodeName,
            classification: cls,
            isParallelBranch: false,
            maxAttempts: defaultMaxRecoveryAttempts(),
          });

          // Write a failure trace with modelRecoveryAttempt info so the
          // trace history shows what triggered recovery (PRD ref: AC16).
          const promptRender = nodeDef.prompt
            ? renderTemplateWithBindings(nodeDef.prompt, exec.state)
            : undefined;
          const recoveryTrace: NodeTrace = {
            node: nodeName,
            executionTraceId,
            attempt,
            status: 'failed',
            type: nodeDef.type ?? 'agent',
            agent: nodeDef.agent,
            inputState: { ...exec.state },
            renderedPrompt: promptRender?.rendered,
            output: {},
            rawResponse: undefined,
            activity: [],
            cost: { actual: null, estimated: 0, method: 'unavailable' },
            durationMs: Date.now() - traceStart.getTime(),
            startedAt: traceStart,
            completedAt: new Date(),
            templateBindings: promptRender?.bindings,
            learningsInjected: learningsInjectedTrace.length > 0 ? learningsInjectedTrace : undefined,
            contextAttemptId: repoKnowledgePacket?.packetId,
            error: message,
            modelRecoveryAttempt: {
              recoveryAttempt: recoveryState.attempt,
              originalProvider: effectiveProvider,
              originalModel: effectiveModel,
              selectedProvider: effectiveProvider,
              selectedModel: effectiveModel,
              failureCategory: cls.category,
              sanitizedError: cls.sanitizedSummary,
            },
          };
          try {
            await this.stateManager.saveTrace({ ...recoveryTrace, executionId: exec.id });
          } catch {
            // Best effort — must not mask the original error.
          }

          // Emit node_failed so the UI can show the failed attempt
          this.emit({ event: 'node_failed', data: { node: nodeName, attempt, error: message } });

          // Recovery loop — continue prompting the user until max attempts
          // or until the user cancels.
          while (recoveryState.attempt <= recoveryState.maxAttempts) {
            if (recoveryState.attempt > recoveryState.maxAttempts) {
              // Max attempts exhausted: fall through to terminal failure
              recoveryState.overrideHistory.push({
                attempt: recoveryState.attempt,
                selectedProvider: effectiveProvider,
                selectedModel: effectiveModel,
                selectedAt: new Date().toISOString(),
                outcome: 'unrecoverable_failure',
                errorSummary: message,
              });
              exec.state.__recovery_state = recoveryState;
              this.log(exec.id, {
                level: 'error',
                category: 'gate',
                node: nodeName,
                message: `Model recovery max attempts (${recoveryState.maxAttempts}) reached for node "${nodeName}"`,
                data: { totalAttempts: recoveryState.attempt, history: recoveryState.overrideHistory },
              });
              break;
            }

            // Build recovery intervention and pause execution. Persist the
            // recovery marker before writing the waiting status so reloads
            // and /recover-model can reconstruct the dedicated recovery UI.
            const intervention = renderModelRecoveryIntervention(nodeName, recoveryState);
            exec.state.__recovery_state = recoveryState;
            exec.status = 'waiting_for_input';
            await this.stateManager.updateExecution(exec.id, {
              status: 'waiting_for_input',
              completedNodes: exec.completedNodes,
              state: exec.state,
              cost: exec.cost,
            });

            // Save checkpoint before awaiting input so a restart can resume
            await this.stateManager.saveCheckpoint({
              executionId: exec.id,
              afterNode: nodeName,
              state: { ...exec.state },
              sessions: { ...exec.sessions },
              retryCounts: { ...exec.retryCounts },
              completedNodes: [...exec.completedNodes],
              nodeAttempts: { ...exec.nodeAttempts },
              createdAt: new Date(),
            });

            // Emit input_required SSE with the model recovery intervention
            this.emit({
              event: 'input_required',
              data: {
                node: nodeName,
                prompt: intervention.question,
                fields: intervention.fields,
                intervention,
              },
            });

            this.log(exec.id, {
              level: 'warn',
              category: 'gate',
              node: nodeName,
              message: `Model recovery entered for node "${nodeName}" (attempt ${recoveryState.attempt}/${recoveryState.maxAttempts}, category: ${recoveryState.failureCategory})`,
            });

            // Wait for human input (user picks replacement provider/model)
            const humanData = await this.waitForInput(exec.id, nodeName);
            this.emit({ event: 'input_received', data: { node: nodeName, data: humanData } });

            // Parse the recovery selection
            const selectedProvider = String(humanData.provider ?? effectiveProvider);
            const selectedModel = String(humanData.model ?? effectiveModel);
            const selectedEffort = humanData.reasoning_effort as 'off' | 'low' | 'medium' | 'high' | 'max' | undefined;

            // Build and store NodeModelOverride
            const nodeOverride: import('./model-recovery.js').NodeModelOverride = {
              nodeName,
              provider: selectedProvider,
              model: selectedModel,
              reasoningEffort: selectedEffort,
              attempt: recoveryState.attempt,
              createdAt: new Date().toISOString(),
            };
            const existingOverrides = (exec.state.__model_overrides as Record<string, import('./model-recovery.js').NodeModelOverride[]>) ?? {};
            const prior = existingOverrides[nodeName] ?? [];
            existingOverrides[nodeName] = [...prior, nodeOverride];
            exec.state.__model_overrides = existingOverrides;

            // Discard prior session by deleting the session key
            const sessionKey = nodeDef.session_key
              ? (() => { try { return renderTemplate(nodeDef.session_key, exec.state).trim() || nodeName; } catch { return nodeName; } })()
              : nodeName;
            delete exec.sessions[sessionKey];

            // Emit recovery override applied event
            this.emit({
              event: 'node_recovery_override_applied',
              data: { node: nodeName, provider: selectedProvider, model: selectedModel, attempt: recoveryState.attempt },
            });

            this.log(exec.id, {
              level: 'info',
              category: 'gate',
              node: nodeName,
              message: `Model recovery override selected — provider: ${selectedProvider}, model: ${selectedModel}, attempt: ${recoveryState.attempt}`,
            });

            // Set execution back to running
            exec.status = 'running';
            // Increment recovery attempt counter
            recoveryState.attempt += 1;
            recoveryState.overrideHistory.push({
              attempt: recoveryState.attempt,
              selectedProvider,
              selectedModel,
              selectedAt: new Date().toISOString(),
              outcome: 'recoverable_failure', // will be updated on success
            });
            exec.state.__recovery_state = recoveryState;

            // Increment node attempts for trace uniqueness
            exec.nodeAttempts[nodeName] = (exec.nodeAttempts[nodeName] ?? recoveryState.attempt) + 1;

            await this.stateManager.updateExecution(exec.id, {
              status: 'running',
              state: exec.state,
              sessions: exec.sessions,
            });

            try {
              // Re-invoke the same node with the recovery override in place.
              // The override lives in exec.state.__model_overrides and will be
              // picked up by node-executor's model resolution.
              const retryResult = await this.executeSingleNode(nodeName, nodeDef, exec, nestingDepth, edges, workflow);

              // Recovery succeeded — clear recovery state for this node
              delete exec.state.__recovery_state;
              // Update the override history entry to 'success'
              const lastEntry = recoveryState.overrideHistory[recoveryState.overrideHistory.length - 1];
              if (lastEntry) lastEntry.outcome = 'success';

              this.log(exec.id, {
                level: 'info',
                category: 'gate',
                node: nodeName,
                message: `Model recovery succeeded for node "${nodeName}" after ${recoveryState.attempt} attempt(s)`,
              });

              // Return the auto-gate action from the retry
              return retryResult;
            } catch (retryErr: unknown) {
              const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
              const retryCls = classifyFailure(retryErr, { provider: selectedProvider, model: selectedModel });

              if (retryCls.recoverable && recoveryState.attempt <= recoveryState.maxAttempts) {
                this.log(exec.id, {
                  level: 'warn',
                  category: 'gate',
                  node: nodeName,
                  message: `Model recovery failed again on attempt ${recoveryState.attempt} (${retryCls.category}): ${sanitizeErrorSummary(retryMessage)}`,
                });
                // Update recovery state and loop back for another prompt
                recoveryState.failureCategory = retryCls.category;
                recoveryState.sanitizedError = retryCls.sanitizedSummary;
                recoveryState.failedProvider = selectedProvider;
                recoveryState.failedModel = selectedModel;
                // The loop continues; the next iteration will prompt the user again
              } else {
                // Non-recoverable or max attempts exceeded — mark terminal failure
                recoveryState.overrideHistory.push({
                  attempt: recoveryState.attempt,
                  selectedProvider,
                  selectedModel,
                  selectedAt: new Date().toISOString(),
                  outcome: 'unrecoverable_failure',
                  errorSummary: sanitizeErrorSummary(retryMessage),
                });
                exec.state.__recovery_state = recoveryState;

                this.log(exec.id, {
                  level: 'error',
                  category: 'gate',
                  node: nodeName,
                  message: `Model recovery failed terminally for node "${nodeName}" after ${recoveryState.attempt} attempt(s): ${retryCls.category}`,
                });

                // Fall through to terminal failure below
                // Save the error and rethrow (existing terminal behavior)
                const termMessage = `Model recovery exhausted: ${sanitizeErrorSummary(retryMessage)}`;
                const termTrace: NodeTrace = {
                  node: nodeName,
                  executionTraceId: randomUUID(),
                  attempt: exec.nodeAttempts[nodeName] ?? recoveryState.attempt + 1,
                  status: 'failed',
                  type: nodeDef.type ?? 'agent',
                  agent: nodeDef.agent,
                  inputState: { ...exec.state },
                  output: {},
                  activity: [],
                  cost: { actual: null, estimated: 0, method: 'unavailable' },
                  durationMs: 0,
                  startedAt: new Date(),
                  completedAt: new Date(),
                  error: termMessage,
                };
                try {
                  await this.stateManager.saveTrace({ ...termTrace, executionId: exec.id });
                } catch { /* best effort */ }
                this.emit({ event: 'node_failed', data: { node: nodeName, attempt: exec.nodeAttempts[nodeName] ?? 0, error: termMessage } });
                throw new Error(termMessage);
              }
            }
          } // end recovery while loop

          // If we exit the while loop without a successful return, fall through
          // to the terminal failure path below
        }
      }

      // ── Terminal Failure Path (existing behavior for non-recoverable) ──
      // Write a trace row so the node stops showing "running" in the UI.
      const terminalTraceStatus: NodeStatus = wasCancelled ? 'cancelled' : 'failed';
      const promptRender = nodeDef.prompt
        ? renderTemplateWithBindings(nodeDef.prompt, exec.state)
        : undefined;
      const failureTrace: NodeTrace = {
        node: nodeName,
        executionTraceId,
        attempt,
        status: terminalTraceStatus,
        type: nodeDef.type ?? 'agent',
        agent: nodeDef.agent,
        inputState: { ...exec.state },
        renderedPrompt: promptRender?.rendered,
        output: {},
        rawResponse: undefined,
        activity: [],
        cost: { actual: null, estimated: 0, method: 'unavailable' },
        durationMs: Date.now() - traceStart.getTime(),
        startedAt: traceStart,
        completedAt: new Date(),
        templateBindings: promptRender?.bindings,
        learningsInjected: learningsInjectedTrace.length > 0 ? learningsInjectedTrace : undefined,
        contextAttemptId: repoKnowledgePacket?.packetId,
        // Stash the error message on the trace so the UI can show what
        // happened without needing a separate log lookup.
        error: message,
      };
      try {
        await this.stateManager.saveTrace({ ...failureTrace, executionId: exec.id });
      } catch {
        // Best effort — a failure here must not mask the original error.
      }

      this.emit({ event: 'node_failed', data: { node: nodeName, attempt, error: message } });

      // Learning system: contradict injected learnings on failure (fire-and-forget)
      for (const lid of injectedLearningIds) {
        this.learningManager.contradict(lid, exec.id).catch(() => {});
      }

      throw err;
    }
  }

  // ── Parallel Execution ─────────────────────────────────────────────────────

  private async executeParallelNodes(
    nodeNames: string[],
    edge: EdgeDef,
    nodes: Record<string, NodeDef>,
    exec: ExecutionState,
    nestingDepth: number,
  ): Promise<void> {
    const joinPolicy = edge.join ?? 'wait-all';

    this.emit({
      event: 'parallel_started',
      data: { nodes: nodeNames, joinPolicy },
    });

    this.log(exec.id, {
      category: 'system',
      message: `Parallel fork: [${nodeNames.join(', ')}] with join: ${joinPolicy}`,
    });

    // Snapshot state BEFORE parallel branches so they don't interfere
    const stateSnapshot = { ...exec.state };

    // For fail-fast / wait-any we need an abort mechanism. Register with
    // the engine so cancelExecution cascades to all branches via the
    // signal listener wired below.
    const abortController = new AbortController();
    this.registerAbort(exec.id, abortController);

    interface BranchResult {
      node: string;
      outputs: Record<string, unknown>;
      result: NodeResult;
      traceStart: Date;
      injectedLearningIds: any[];
      /** Set when the branch failed with a recoverable model/provider error. */
      recoveryNeeded?: {
        err: unknown;
        message: string;
        cls: import('./model-recovery.js').ClassificationResult;
        effectiveProvider: string;
      effectiveModel: string;
      };
    }

    const contextTags = (exec.state.__contextTags as string[]) ?? [];

    const promises = nodeNames.map(async (nodeName): Promise<BranchResult> => {
      const nodeDef = nodes[nodeName];
      if (!nodeDef) throw new Error(`Node not found: ${nodeName}`);

      const traceStart = new Date();
      const nodeType = nodeDef.type ?? 'agent';

      // Learning injection for parallel branches
      let nodeContext = '';
      let branchLearningIds: any[] = [];
      if (nodeType === 'agent') {
        try {
          const learnings = await this.learningManager.query(
            contextTags, exec.workflowName, nodeDef.agent, nodeName, 550,
          );
          if (learnings.length > 0) {
            nodeContext = this.learningManager.buildLearningsPrompt(learnings);
            branchLearningIds = learnings.map(l => l._id).filter(Boolean);
          }
        } catch { /* fire-and-forget */ }
      }

      // Each branch gets its own controller registered against the
      // execution, AND listens to the coordinator's signal so a cancel
      // (external or fail-fast / wait-any loser) cascades down to the
      // child process. Without the listener, cancelExecution would have
      // to enumerate per-branch controllers itself.
      const retryAc = new AbortController();
      this.registerAbort(exec.id, retryAc);
      const onCoordinatorAbort = () => { try { retryAc.abort(); } catch { /* ignore */ } };
      abortController.signal.addEventListener('abort', onCoordinatorAbort, { once: true });

      try {
        const deps: NodeExecutorDeps = {
          agents: this.config.agents,
          builtIns: this.config.builtIns,
          workflows: this.config.workflows,
          emitter: this.config.emitter,
          runWorkflow: (wf, input) => this.run(wf, input, nestingDepth + 1, {
        parentExecutionId: exec.id,
        rootExecutionId: exec.rootExecutionId ?? exec.id,
      }),
          executionId: exec.id,
          nodeContext,
          db: this.config.db,
          services: this.config.services,
          abortSignal: retryAc.signal,
          discoverMcpToolNames: this.config.discoverMcpToolNames,
          claudeCodeExecutable: this.config.claudeCodeExecutable,
          buildClaudeCompatibleEnvOverlay: this.config.buildClaudeCompatibleEnvOverlay,
          aliasMap: this.config.aliasMap,
          costMap: this.config.costMap,
          modelProviderMap: this.config.modelProviderMap,
        };

        // Each branch reads from the snapshot, not the live state
        const result = await executeNode(nodeName, nodeDef, stateSnapshot, exec.sessions, deps);

        // Check if abort was signaled
        if (abortController.signal.aborted) {
          throw new Error('Branch cancelled by join policy');
        }

        // Track session (safe — different keys per branch).
        // Uses resolved session_key when declared; falls back to nodeName.
        if (result.sessionId) {
          exec.sessions[result.sessionKey ?? nodeName] = result.sessionId;
        }

        return { node: nodeName, outputs: result.outputs, result, traceStart, injectedLearningIds: branchLearningIds };
      } catch (err: unknown) {
        // Save a failure/cancelled trace for this branch before the outer
        // join policy decides what to do with the error. Mirrors the
        // single-node catch: otherwise aborted parallel branches leave
        // no DB footprint and the UI shows a perpetual spinner.
        const message = err instanceof Error ? err.message : String(err);
        const wasCancelled =
          retryAc.signal.aborted ||
          abortController.signal.aborted ||
          message === 'Execution cancelled' ||
          message === 'Branch cancelled by join policy';

        // ── Model Recovery for parallel branches ─────────────────────
        // Only wait-all supports recovery in this release (TDD §9.8).
        // For recoverable failures, classify and capture recovery info
        // in a synthetic BranchResult instead of throwing.
        if (!wasCancelled) {
          const role = nodeDef.agent ? this.config.agents[nodeDef.agent] : undefined;
          const recoveryOverrides = exec.state.__model_overrides as Record<string, import('./model-recovery.js').NodeModelOverride[]> | undefined;
          const latestOverride = recoveryOverrides?.[nodeName]?.at(-1);
          const effectiveProvider = resolveAgentNodeEffectiveProvider(
            nodeName,
            nodeDef,
            exec.state,
            role,
            { aliasMap: this.config.aliasMap, modelProviderMap: this.config.modelProviderMap },
          );
          const effectiveModel = latestOverride?.model ?? nodeDef.agentOverrides?.model ?? role?.model ?? 'sonnet';
          const cls = classifyFailure(err, { provider: effectiveProvider, model: effectiveModel });

          if (cls.recoverable) {
            // Save a failure trace with modelRecoveryAttempt info
            const branchTrace: NodeTrace = {
              node: nodeName,
              attempt: 1,
              status: 'failed',
              type: nodeDef.type ?? 'agent',
              agent: nodeDef.agent,
              inputState: stateSnapshot,
              renderedPrompt: nodeDef.prompt ? renderTemplate(nodeDef.prompt, stateSnapshot) : undefined,
              output: {},
              activity: [],
              cost: { actual: null, estimated: 0, method: 'unavailable' },
              durationMs: Date.now() - traceStart.getTime(),
              startedAt: traceStart,
              completedAt: new Date(),
              error: message,
              modelRecoveryAttempt: {
                recoveryAttempt: 1,
                originalProvider: effectiveProvider,
                originalModel: effectiveModel,
                selectedProvider: effectiveProvider,
                selectedModel: effectiveModel,
                failureCategory: cls.category,
                sanitizedError: cls.sanitizedSummary,
              },
            };
            try {
              await this.stateManager.saveTrace({ ...branchTrace, executionId: exec.id });
            } catch {
              // Best effort — must not shadow the original error.
            }
            // Return a synthetic branch result indicating recovery needed.
            // The sibling branches will continue running normally (AC6).
            return {
              node: nodeName,
              outputs: {},
              result: { outputs: {}, cost: { actual: null, estimated: 0, method: 'unavailable' }, durationMs: 0 },
              traceStart,
              injectedLearningIds: branchLearningIds,
              recoveryNeeded: { err, message, cls, effectiveProvider, effectiveModel },
            } as unknown as BranchResult;
          }
        }

        // Non-recoverable or cancelled — save failure trace and rethrow as before
        const branchTrace: NodeTrace = {
          node: nodeName,
          attempt: 1,
          status: wasCancelled ? 'cancelled' : 'failed',
          type: nodeDef.type ?? 'agent',
          agent: nodeDef.agent,
          inputState: stateSnapshot,
          renderedPrompt: nodeDef.prompt ? renderTemplate(nodeDef.prompt, stateSnapshot) : undefined,
          output: {},
          activity: [],
          cost: { actual: null, estimated: 0, method: 'unavailable' },
          durationMs: Date.now() - traceStart.getTime(),
          startedAt: traceStart,
          completedAt: new Date(),
          error: message,
        };
        try {
          await this.stateManager.saveTrace({ ...branchTrace, executionId: exec.id });
        } catch {
          // Best effort — must not shadow the original error.
        }
        throw err;
      } finally {
        abortController.signal.removeEventListener('abort', onCoordinatorAbort);
        this.unregisterAbort(exec.id, retryAc);
      }
    });

    let branchResults: BranchResult[];

    try {
      if (joinPolicy === 'wait-any') {
        // Take first to complete, abort the losers so their child
        // processes exit instead of dangling. Previously losers were
        // left running "silently" which leaked compute and could outlive
        // a workflow cancel.
        const first = await Promise.race(promises);
        branchResults = [first];
        abortController.abort();
        // Drain remaining promises so unhandled rejections from aborted
        // losers don't surface — they're expected to throw.
        Promise.allSettled(promises).catch(() => {});

      } else if (joinPolicy === 'fail-fast') {
        // If any fails, abort the rest and throw
        try {
          branchResults = await Promise.all(promises);
        } catch (err) {
          abortController.abort();
          throw err;
        }

      } else {
        // wait-all: collect all, throw if any failed
        const settled = await Promise.allSettled(promises);
        branchResults = [];
        const errors: unknown[] = [];
        for (const r of settled) {
          if (r.status === 'fulfilled') {
            branchResults.push(r.value);
          } else {
            errors.push(r.reason);
          }
        }
        // Separate branches that need recovery from completed ones
        // PRD refs: AC5 (branch recovery pause), AC6 (siblings not cancelled)
        const completedBranches: BranchResult[] = [];
        const recoveryBranches: BranchResult[] = [];
        for (const r of settled) {
          if (r.status === 'fulfilled') {
            if (r.value.recoveryNeeded) {
              recoveryBranches.push(r.value);
            } else {
              completedBranches.push(r.value);
            }
          } else {
            errors.push(r.reason);
          }
        }
        // Process recoverable branches (only wait-all in first release per TDD §9.8)
        if (recoveryBranches.length > 0) {
          // Save completed sibling outputs before entering recovery loop
          for (const br of completedBranches) {
            exec.completedNodes.push(br.node);
          }

          // Process recovery branches one at a time (TDD assumption 9.3)
          for (const recBr of recoveryBranches) {
            if (!recBr.recoveryNeeded) continue;
            const brName = recBr.node;
            const { cls, message: recMessage, effectiveProvider, effectiveModel } = recBr.recoveryNeeded;
            const recNodeDef = nodes[brName];
            if (!recNodeDef) throw new Error(`Recovery node not found: ${brName}`);

            // Build per-branch recovery state
            const siblingNames = [...branchResults.map(br => br.node).filter(n => n !== brName)];
            let recState: import('./model-recovery.js').RecoveryState = buildRecoveryState({
              nodeName: brName,
              classification: cls,
              isParallelBranch: true,
              siblingBranches: siblingNames,
              joinPolicy: joinPolicy,
              maxAttempts: defaultMaxRecoveryAttempts(),
            });

            this.emit({
              event: 'parallel_branch_recovery_paused',
              data: { failedBranch: brName, completedSiblings: siblingNames,
                stillRunning: exec.currentNodes.filter(n => n !== brName) },
            });

            // Recovery prompt loop for this branch
            while (recState.attempt <= recState.maxAttempts) {
              const intervention = renderModelRecoveryIntervention(brName, recState);
              exec.state.__recovery_state = exec.state.__recovery_state ?? {};
              (exec.state.__recovery_state as Record<string, unknown>)[brName] = recState;
              exec.status = 'waiting_for_input';
              await this.stateManager.updateExecution(exec.id, {
                status: 'waiting_for_input',
                completedNodes: exec.completedNodes,
                state: exec.state,
                cost: exec.cost,
              });

              await this.stateManager.saveCheckpoint({
                executionId: exec.id,
                afterNode: brName,
                state: { ...exec.state },
                sessions: { ...exec.sessions },
                retryCounts: { ...exec.retryCounts },
                completedNodes: [...exec.completedNodes],
                nodeAttempts: { ...exec.nodeAttempts },
                createdAt: new Date(),
              });

              this.emit({
                event: 'input_required',
                data: { node: brName, prompt: intervention.question,
                  fields: intervention.fields, intervention },
              });

              this.log(exec.id, {
                level: 'warn', category: 'gate', node: brName,
                message: `Parallel branch recovery entered for "${brName}" (attempt ${recState.attempt}/${recState.maxAttempts}, category: ${recState.failureCategory})`,
              });

              const humanData = await this.waitForInput(exec.id, brName);
              this.emit({ event: 'input_received', data: { node: brName, data: humanData } });

              const selectedProvider = String(humanData.provider ?? effectiveProvider);
              const selectedModel = String(humanData.model ?? effectiveModel);
              const selectedEffort = humanData.reasoning_effort as 'off' | 'low' | 'medium' | 'high' | 'max' | undefined;

              const nodeOverride: import('./model-recovery.js').NodeModelOverride = {
                nodeName: brName,
                provider: selectedProvider,
                model: selectedModel,
                reasoningEffort: selectedEffort,
                attempt: recState.attempt,
                createdAt: new Date().toISOString(),
              };
              const existingOverrides = (exec.state.__model_overrides as Record<string, import('./model-recovery.js').NodeModelOverride[]>) ?? {};
              const prior = existingOverrides[brName] ?? [];
              existingOverrides[brName] = [...prior, nodeOverride];
              exec.state.__model_overrides = existingOverrides;

              // Discard prior session
              const sessionKey = recNodeDef.session_key
                ? (() => { try { return renderTemplate(recNodeDef.session_key, exec.state).trim() || brName; } catch { return brName; } })()
                : brName;
              delete exec.sessions[sessionKey];

              this.emit({
                event: 'node_recovery_override_applied',
                data: { node: brName, provider: selectedProvider, model: selectedModel, attempt: recState.attempt },
              });

              exec.status = 'running';
              recState.attempt += 1;
              recState.overrideHistory.push({
                attempt: recState.attempt, selectedProvider, selectedModel,
                selectedAt: new Date().toISOString(),
                outcome: 'recoverable_failure',
              });
              exec.state.__recovery_state = (exec.state.__recovery_state as Record<string, unknown>) ?? {};
              (exec.state.__recovery_state as Record<string, unknown>)[brName] = recState;
              exec.nodeAttempts[brName] = (exec.nodeAttempts[brName] ?? 0) + 1;

              await this.stateManager.updateExecution(exec.id, {
                status: 'running', state: exec.state, sessions: exec.sessions,
              });

              try {
                // Re-run the failed branch with the override in place
                const deps: NodeExecutorDeps = {
                  agents: this.config.agents,
                  builtIns: this.config.builtIns,
                  workflows: this.config.workflows,
                  emitter: this.config.emitter,
                  runWorkflow: (wf, input) => this.run(wf, input, nestingDepth + 1, {
                    parentExecutionId: exec.id,
                    rootExecutionId: exec.rootExecutionId ?? exec.id,
                  }),
                  executionId: exec.id,
                  nodeContext: '',
                  db: this.config.db,
                  services: this.config.services,
                  abortSignal: new AbortController().signal,
                  discoverMcpToolNames: this.config.discoverMcpToolNames,
                  claudeCodeExecutable: this.config.claudeCodeExecutable,
                  buildClaudeCompatibleEnvOverlay: this.config.buildClaudeCompatibleEnvOverlay,
                  aliasMap: this.config.aliasMap,
                  costMap: this.config.costMap,
                  modelProviderMap: this.config.modelProviderMap,
                };
                const retryResult = await executeNode(brName, recNodeDef, stateSnapshot, exec.sessions, deps);

                // Recovery succeeded — record as a completed branch
                const lastEntry = recState.overrideHistory[recState.overrideHistory.length - 1];
                if (lastEntry) lastEntry.outcome = 'success';
                delete (exec.state.__recovery_state as Record<string, unknown>)[brName];

                completedBranches.push({
                  node: brName,
                  outputs: retryResult.outputs,
                  result: retryResult,
                  traceStart: new Date(),
                  injectedLearningIds: [],
                });

                this.log(exec.id, {
                  level: 'info', category: 'gate', node: brName,
                  message: `Parallel branch recovery succeeded for "${brName}" after ${recState.attempt} attempt(s)`,
                });

                // Break out of the recovery loop for this branch
                break;
              } catch (retryErr: unknown) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                const retryCls = classifyFailure(retryErr, { provider: selectedProvider, model: selectedModel });
                if (retryCls.recoverable && recState.attempt <= recState.maxAttempts) {
                  this.log(exec.id, {
                    level: 'warn', category: 'gate', node: brName,
                    message: `Branch model recovery failed again on attempt ${recState.attempt} (${retryCls.category}): ${sanitizeErrorSummary(retryMsg)}`,
                  });
                  recState.failureCategory = retryCls.category;
                  recState.sanitizedError = retryCls.sanitizedSummary;
                  recState.failedProvider = selectedProvider;
                  recState.failedModel = selectedModel;
                } else {
                  // Terminal failure for this recovery attempt
                  recState.overrideHistory.push({
                    attempt: recState.attempt, selectedProvider, selectedModel,
                    selectedAt: new Date().toISOString(),
                    outcome: 'unrecoverable_failure',
                    errorSummary: sanitizeErrorSummary(retryMsg),
                  });
                  this.log(exec.id, {
                    level: 'error', category: 'gate', node: brName,
                    message: `Branch model recovery failed terminally for "${brName}": ${retryCls.category}`,
                  });
                  const termMsg = `Branch model recovery exhausted: ${sanitizeErrorSummary(retryMsg)}`;
                  throw new Error(termMsg);
                }
              }
            } // end recovery while loop
          } // end for each recovery branch

          branchResults = completedBranches;
        } else if (errors.length > 0) {
          throw errors[0];
        }
      }
    } finally {
      this.unregisterAbort(exec.id, abortController);
    }

    // Aggregate costs AFTER all branches complete (no race condition)
    for (const br of branchResults) {
      exec.cost.estimated += br.result.cost.estimated;
      if (br.result.cost.actual != null) {
        exec.cost.actual = (exec.cost.actual ?? 0) + br.result.cost.actual;
      }
      exec.tokenUsage = aggregateTokenUsage(exec.tokenUsage, br.result.tokenUsage);
      exec.completedNodes.push(br.node);

      // Save trace for each parallel branch
      const nodeDef = nodes[br.node];
      const resultExt = br.result as unknown as NodeResult;
      const trace: NodeTrace = {
        node: br.node,
        attempt: 1,
        status: 'completed',
        type: nodeDef?.type ?? 'agent',
        agent: nodeDef?.agent,
        inputState: stateSnapshot,
        // Prefer the executor's actual prompt; fall back to template render
        // for non-agent branches that don't set result.prompt.
        renderedPrompt: br.result.prompt ?? (nodeDef?.prompt ? renderTemplate(nodeDef.prompt, stateSnapshot) : undefined),
        output: br.outputs,
        rawResponse: br.result.rawResponse,
        activity: [],
        sessionId: br.result.sessionId,
        cost: br.result.cost,
        durationMs: br.result.durationMs,
        startedAt: br.traceStart,
        completedAt: new Date(),
        toolCalls: br.result.toolCalls,
        runtimeContext: resultExt.runtimeContext,
        agentOverrides: resultExt.agentOverrides,
        toolsAvailable: resultExt.toolsAvailable,
        tokenUsagePerTool: resultExt.tokenUsagePerTool,
        tokenUsage: resultExt.tokenUsage ?? null,
        provider: resultExt.provider,
        childExecutionId: resultExt.childExecutionId,
        gateDecision: resultExt.gateDecision,
      };
      await this.stateManager.saveTrace({ ...trace, executionId: exec.id });

      this.emit({
        event: 'parallel_branch_done',
        data: { node: br.node, status: 'completed', remaining: 0 },
      });

      // Learning: confirm injected learnings for this branch (fire-and-forget)
      for (const lid of br.injectedLearningIds) {
        this.learningManager.confirm(lid, exec.id).catch(() => {});
      }
    }

    // Merge parallel outputs (filter internal markers)
    const cleanResults = branchResults.map(br => {
      const outputs = { ...br.outputs };
      delete outputs.__waiting_for_input;
      delete outputs.__node;
      return { node: br.node, outputs };
    });
    for (const result of cleanResults) {
      this.writeNodeScopedOutput(exec.state, result.node, result.outputs);
    }
    const merged = mergeParallelOutputs(cleanResults, edge.merge);
    Object.assign(exec.state, merged);

    this.log(exec.id, {
      category: 'system',
      message: `Parallel joined: all branches completed`,
    });

    this.emit({
      event: 'parallel_joined',
      data: { nodes: nodeNames, allPassed: true },
    });
  }

  // ── Edge Resolution ────────────────────────────────────────────────────────

  private getStartNodes(edges: EdgeDef[]): string[] {
    for (const edge of edges) {
      const from = this.normalizeFrom(edge.from);
      if (from === 'START') {
        return Array.isArray(edge.to) ? edge.to : [edge.to];
      }
    }
    return [];
  }

  /**
   * Collect every node reachable by following forward (non-retry) edges
   * starting from a set of source nodes. Used to rewind downstream history
   * when a retry edge fires — so nodes that were completed AS A CONSEQUENCE
   * of the retry target get re-executed on the retry path.
   */

  /**
   * Build a retry context summary from the source node's outputs when the
   * edge did not declare an explicit `retry_context` template. Used by the
   * engine to auto-inject feedback into retry targets without requiring the
   * workflow author to write `{{retry_context}}` scaffolding in every node.
   */
  private synthesiseRetryContext(
    fromNodes: string[],
    state: Record<string, unknown>,
  ): string {
    const lines: string[] = [
      `The previous attempt completed ${fromNodes.join(', ')}. Address any issues below before retrying.`,
      '',
    ];
    // Dump the source node's outputs from state. Prefer known gate fields
    // first, then fall back to a shallow JSON of remaining keys.
    const candidateKeys = [
      'answers', 'approved', 'failed_checks', 'missing_items',
      'security_feedback', 'review_feedback', 'final_failed_items',
      'validation_results', 'requirement_results',
    ];
    for (const key of candidateKeys) {
      if (state[key] != null && state[key] !== '') {
        const v = state[key];
        const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        lines.push(`${key}:`);
        lines.push(s.length > 2000 ? s.slice(0, 2000) + '\n... (truncated)' : s);
        lines.push('');
      }
    }
    return lines.join('\n').trim();
  }

  private findDownstreamNodes(startNodes: string[], edges: EdgeDef[]): Set<string> {
    const downstream = new Set<string>();
    const queue = [...startNodes];
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const edge of edges) {
        // Only follow forward edges — retry edges introduce cycles and
        // shouldn't propagate downstream invalidation.
        if (edge.max_retries != null) continue;
        const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
        if (!froms.includes(node)) continue;
        const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
        for (const t of tos) {
          if (t === 'END' || downstream.has(t)) continue;
          downstream.add(t);
          queue.push(t);
        }
      }
    }
    return downstream;
  }

  private getNextNodes(
    /** Mutable ref — will be spliced when a retry edge rewinds history. */
    completedNodes: string[],
    edges: EdgeDef[],
    state: Record<string, unknown>,
    retryCounts: Record<string, number>,
    executionId?: string,
    /**
     * Subset of completedNodes that were JUST finished in this iteration.
     * - Retry edges only fire when at least one source is in this set (prevents
     *   infinite loops on stale historical state).
     * - `allFromCompleted` checks use the UNION of completedNodes ∪ justFinished
     *   so join edges can fire when only one of their sources just re-ran.
     */
    justFinished?: string[],
  ): string[] {
    const nextNodes: string[] = [];
    const justFinishedSet = justFinished ? new Set(justFinished) : null;
    // The effective "completed" view = historical completedNodes ∪ justFinished.
    // justFinished nodes may or may not already be in completedNodes depending
    // on whether the caller has pushed them yet.
    const effectiveCompleted = new Set([...completedNodes, ...(justFinished ?? [])]);

    for (const edge of edges) {
      const fromNodes = Array.isArray(edge.from) ? edge.from : [edge.from];
      if (fromNodes[0] === 'START') continue;

      const allFromCompleted = fromNodes.every(f => effectiveCompleted.has(f));
      if (!allFromCompleted) continue;

      // Retry + re-route edges: only fire when at least one source is in
      // the just-finished set. Without this, a retry edge like `clarify →
      // requirements if revise` would keep firing on every subsequent
      // iteration because `clarify` stays in historical completedNodes
      // and `approved` state doesn't auto-reset. `retry_context`-bearing
      // edges (human-override routes from escalation_review) get the same
      // freshness guard so stale escalation state can't keep re-routing.
      const isReRouteEdge = edge.max_retries != null || edge.retry_context != null;
      const isAllowRevisitEdge = edge.allow_revisit === true;
      const sourceJustFinished = justFinishedSet
        ? fromNodes.some(f => justFinishedSet.has(f))
        : true;
      if ((isReRouteEdge || isAllowRevisitEdge) && justFinishedSet) {
        if (!sourceJustFinished) continue;
      }

      // For forward-only edges: skip if ALL targets are already completed.
      // This prevents re-routing to already-visited nodes on subsequent
      // iterations (e.g. edge `[req, ux] → threat-model` firing again
      // after threat-model already ran). Retry and human-override edges
      // INTENTIONALLY re-route to completed nodes (the whole point is to
      // run them again with new context). Explicit allow_revisit edges
      // bypass this check only while their source just finished; they do
      // not become stale historical reroutes on later iterations.
      if (!isReRouteEdge && !(isAllowRevisitEdge && sourceJustFinished)) {
        const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
        const allTargetsDone = targets.every(t => t !== 'END' && effectiveCompleted.has(t));
        if (allTargetsDone) continue;
      }

      if (edge.condition) {
        const condResult = evaluateCondition(edge.condition, state);
        if (executionId) {
          const fromLabel = fromNodes.join(',');
          this.log(executionId, {
            category: 'condition',
            node: fromLabel,
            message: `Condition "${edge.condition}" → ${condResult}`,
            data: { expression: edge.condition, result: condResult },
          });
        }
        if (!condResult) continue;
      }

      // Check retry limit for backward edges.
      //
      // Change from earlier behavior: when a retry edge's counter is
      // exhausted, we SKIP the edge and continue evaluating the rest of
      // the list. Previously this threw "Max retries exceeded" which
      // crashed the whole run. Skipping lets workflow authors declare
      // a catch-all fallback edge (same source, no max_retries, matching
      // condition) that fires once the retry budget is spent — e.g. to
      // route to a human escalation node instead of hard-failing.
      //
      // Logged at warn level so operators can still see when a retry
      // cap was hit. The state-manager classifier that looks for
      // "max_retries_exceeded" in thrown errors no longer gets those
      // classifications here; that's fine because the workflow's
      // fallback edge decides how the run ends.
      // ── Retry counter (retry edges only) ────────────────────────────
      //
      // When the budget is exhausted we skip the edge and stamp
      // `state.__retry_exhausted_from` so a condition-only fallback edge
      // (e.g. `audit_prd → escalation_review on revise AND __retry_exhausted_from == 'audit_prd'`)
      // can fire on the next pass. Previously this threw "Max retries
      // exceeded" which crashed the run.
      let edgeKey: string | undefined;
      let attemptForDisplay: number | undefined;
      if (edge.max_retries != null) {
        edgeKey = `${fromNodes.join(',')}→${Array.isArray(edge.to) ? edge.to.join(',') : edge.to}`;
        const count = retryCounts[edgeKey] ?? 0;
        if (count >= edge.max_retries) {
          state.__retry_exhausted_from = fromNodes.join(',');
          const retryTargets = Array.isArray(edge.to) ? edge.to : [edge.to];
          state.__retry_exhaustion = buildRetryExhaustionContext({
            exhaustedFrom: fromNodes.join(','),
            retryEdgeKey: edgeKey,
            attemptsUsed: count,
            maxRetries: edge.max_retries,
            retryTarget: retryTargets.find((target) => target !== 'END'),
            state,
          });
          if (executionId) {
            this.log(executionId, {
              category: 'condition',
              node: fromNodes.join(','),
              level: 'warn',
              message: `Retry edge ${edgeKey} exhausted (${count}/${edge.max_retries}) — skipping; state.__retry_exhausted_from set. Fallback edges guarded by that flag will fire next.`,
              data: { edgeKey, count, maxRetries: edge.max_retries },
            });
          }
          continue;
        }
        retryCounts[edgeKey] = count + 1;
        attemptForDisplay = count + 2;
      }

      // ── Retry-context payload + rewind ──────────────────────────────
      //
      // Fires for BOTH retry edges (max_retries) AND human-override edges
      // (condition-only with retry_context). Previously the whole block
      // lived inside the `max_retries != null` guard, so condition-only
      // escalation edges like `escalation_review → produce_prd` silently
      // dropped their retry_context template — the user's typed feedback
      // never reached the target agent.
      if (isReRouteEdge) {
        const targetNodes = Array.isArray(edge.to) ? edge.to : [edge.to];

        // Build the feedback payload. Retry edges without an explicit
        // template get a synthesised summary so workflow authors never
        // have to scaffold `{{retry_context}}` by hand.
        const rendered = edge.retry_context
          ? renderTemplate(edge.retry_context, state)
          : this.synthesiseRetryContext(fromNodes, state);
        state.retry_context = rendered;
        state.__retry_target = targetNodes;
        state.__retry_source = fromNodes.join(',');
        state.__retry_attempt = attemptForDisplay ?? 1;
        state.resume_context = this.buildNodeFeedbackResumeContext({
          sourceNodes: fromNodes,
          targetNodes,
          attempt: attemptForDisplay ?? 1,
          retryContext: rendered,
          retryExhaustion: state.__retry_exhaustion as ResumeContext['retryExhaustion'],
          state,
        });

        // ── Human-override path (Fix C) ────────────────────────────────
        //
        // When a condition-only edge carries retry_context, it represents
        // a human explicitly saying "try this node again with my
        // feedback". Two cleanups so the retry actually has room to work:
        //   1. Reset `retryCounts` for every edge targeting the same
        //      node(s). Otherwise the first automatic retry after this
        //      human override immediately hits the already-exhausted
        //      budget and loops straight back to escalation_review.
        //   2. Clear `state.__retry_exhausted_from` so the exhaustion-
        //      fallback edge that routed into escalation_review doesn't
        //      re-fire on the next pass.
        if (edge.max_retries == null) {
          const targetSet = new Set(targetNodes);
          for (const key of Object.keys(retryCounts)) {
            const arrowIdx = key.indexOf('→');
            if (arrowIdx < 0) continue;
            const targetPart = key.slice(arrowIdx + 1);
            const targetList = targetPart.split(',');
            if (targetList.some(t => targetSet.has(t))) {
              delete retryCounts[key];
            }
          }
          delete state.__retry_exhausted_from;
          delete state.__retry_exhaustion;
        }

        const targetNode = targetNodes[0];
        if (executionId) {
          this.log(executionId, {
            category: 'routing',
            node: targetNode,
            level: 'warn',
            message: edge.max_retries != null
              ? `Retry attempt ${attemptForDisplay}/${edge.max_retries}`
              : `Human-driven retry — fresh retry budget for [${targetNodes.join(', ')}]`,
            data: {
              attempt: attemptForDisplay ?? 1,
              maxRetries: edge.max_retries,
              retryContext: state.retry_context,
              humanOverride: edge.max_retries == null,
            },
          });
        }

        this.emit({
          event: 'node_retrying',
          data: {
            node: targetNode,
            fromNode: fromNodes.join(','),
            attempt: attemptForDisplay ?? 1,
            retryContext: state.retry_context,
          },
        });

        // Rewind downstream: remove every node reachable forward from the
        // retry targets from completedNodes. This ensures that after the
        // retry runs, the forward edges will fire again (instead of being
        // blocked by the "all targets already completed" filter above).
        //
        // Scope: only touch entries AFTER the retry target's most recent
        // position in completedNodes. Ancestors that ran before the retry
        // target are not actually "downstream" in execution order — they
        // ran first. The topological BFS can spuriously reach them when
        // a node like `escalation_review` has forward edges back to
        // ancestors (`escalation_review → clarify / produce_prd / …`).
        // Without this bound, a simple audit_tdd → produce_tdd retry
        // wipes out clarify / produce_prd / audit_prd / … from
        // completedNodes, leaving the UI timeline showing only the tail.
        let targetPos = -1;
        for (const t of targetNodes) {
          const idx = completedNodes.lastIndexOf(t);
          if (idx > targetPos) targetPos = idx;
        }
        const downstream = this.findDownstreamNodes(targetNodes, edges);
        if (downstream.size > 0 && targetPos >= 0) {
          for (let i = completedNodes.length - 1; i > targetPos; i--) {
            if (downstream.has(completedNodes[i])) {
              completedNodes.splice(i, 1);
            }
          }
        }
      }

      const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
      nextNodes.push(...targets);
    }

    const deduped = [...new Set(nextNodes)];
    if (executionId && deduped.length > 0) {
      const fromLabel = completedNodes[completedNodes.length - 1] ?? 'START';
      this.log(executionId, {
        category: 'routing',
        node: fromLabel,
        message: `Routing to: ${deduped.join(', ')}`,
        data: { nextNodes: deduped },
      });
    }

    return deduped;
  }

  /**
   * Find the retry edge key targeting a given node, for trace attempt numbering.
   */
  private findRetryEdgeKey(nodeName: string, retryCounts: Record<string, number>): string | undefined {
    for (const key of Object.keys(retryCounts)) {
      if (key.endsWith(`→${nodeName}`)) {
        return key;
      }
    }
    return undefined;
  }

  private normalizeFrom(from: string | string[]): string {
    return Array.isArray(from) ? from[0] : from;
  }

  private waitForInput(
    executionId: string,
    node: string,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const key = `${executionId}:${node}`;
      this.pendingInputResolvers.set(key, { resolve, reject });
      // No timeout — waits indefinitely until submitted or execution is
      // cancelled (cancelExecution rejects this promise so the engine loop
      // can observe the cancel flag instead of staying parked).
    });
  }

  private emit(event: SSEEvent): void {
    this.config.emitter.emit(event);
  }

  private log(
    executionId: string,
    entry: { level?: LogLevel; category: LogCategory; node?: string; message: string; data?: unknown },
  ): void {
    const logEntry: ExecutionLog = {
      executionId,
      timestamp: new Date(),
      level: entry.level ?? 'info',
      category: entry.category,
      node: entry.node,
      message: entry.message,
      data: entry.data,
    };
    this.emit({ event: 'execution_log', data: logEntry as unknown as Record<string, unknown> });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Walk incoming edges backward from `nodeName` and collect every field
 * declared on an upstream human node. Stops at each human node on that
 * branch (further upstream is irrelevant — the user would have filled
 * the immediately-reachable human nodes first).
 *
 * Used by the clarify synthesizer so it knows which variable names the
 * user originally filled; picking those names makes the clarify answer
 * OVERWRITE the broken value on retry instead of adding a new state key.
 */
function collectUpstreamHumanFields(
  nodeName: string,
  workflow: WorkflowDef | undefined,
): Array<{ nodeName: string; name: string; type?: string; label?: string }> {
  if (!workflow) return [];
  const nodes = workflow.nodes ?? {};
  const edges = workflow.edges ?? [];
  const result: Array<{ nodeName: string; name: string; type?: string; label?: string }> = [];
  const seen = new Set<string>();
  const frontier: string[] = [nodeName];
  const MAX_NODES = 25; // defence-in-depth for pathological graphs
  while (frontier.length > 0 && seen.size < MAX_NODES) {
    const current = frontier.shift()!;
    for (const edge of edges) {
      if (edge.to !== current) continue;
      // Edges can have a string or string[] as `from` (join edges).
      // Normalize so we handle both uniformly.
      const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
      for (const from of froms) {
        if (!from || from === 'START' || seen.has(from)) continue;
        seen.add(from);
        const upstream = nodes[from] as NodeDef | undefined;
        if (upstream?.type === 'human' && Array.isArray(upstream.fields)) {
          for (const f of upstream.fields) {
            if (f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string') {
              result.push({
                nodeName: from,
                name: (f as { name: string }).name,
                type: (f as { type?: string }).type,
                label: (f as { label?: string }).label,
              });
            }
          }
          // Don't traverse past a human node — the user filled it;
          // anything further upstream is already reflected in that
          // node's outputs.
          continue;
        }
        frontier.push(from);
      }
    }
  }
  return result;
}

/**
 * After a clarify retry finishes successfully, delete state keys that
 * were introduced BY THAT clarify but are NOT declared workflow variables.
 * Keeps workflow-level keys (template placeholders, upstream human
 * fields, other nodes' outputs) and drops one-shot clarify helpers so
 * downstream nodes don't see stale context.
 *
 * A key is "persistent" — and thus NOT deleted — if any of these hold:
 *   - It's a template placeholder of the gate node (the node reads it).
 *   - It's an upstream human-node field (the user filled it legitimately).
 *   - It's declared as an output of ANY node in the workflow (some node
 *     produces it; deleting would break downstream templating).
 */
function cleanupEphemeralClarifyKeys(
  state: Record<string, unknown>,
  clarifyFieldNames: string[],
  gateNodeName: string,
  workflow: WorkflowDef | undefined,
): string[] {
  if (clarifyFieldNames.length === 0) return [];
  if (!workflow) return [];
  const nodes = workflow.nodes ?? {};
  const gateNode = nodes[gateNodeName] as NodeDef | undefined;
  const placeholderSet = new Set<string>();
  if (gateNode && typeof gateNode.prompt === 'string') {
    for (const p of collectPlaceholders(gateNode.prompt)) {
      // Templates can use dotted paths ("state.brand"); compare on the
      // first segment, which is the top-level state key.
      placeholderSet.add(p.split('.')[0]);
    }
  }
  const upstreamNames = new Set(
    collectUpstreamHumanFields(gateNodeName, workflow).map((f) => f.name),
  );
  const outputNames = new Set<string>();
  for (const def of Object.values(nodes)) {
    const outs = (def as NodeDef).outputs;
    if (outs && typeof outs === 'object') {
      for (const k of Object.keys(outs)) outputNames.add(k);
    }
  }
  const deleted: string[] = [];
  for (const name of clarifyFieldNames) {
    if (!name || name.startsWith('__')) continue;
    if (placeholderSet.has(name)) continue;
    if (upstreamNames.has(name)) continue;
    if (outputNames.has(name)) continue;
    if (name in state) {
      delete state[name];
      deleted.push(name);
    }
  }
  return deleted;
}
