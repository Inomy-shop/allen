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
  SSEEvent,
  Checkpoint,
  ExecutionLog,
  LogCategory,
  LogLevel,
} from './types.js';
import { executeNode, type NodeExecutorDeps, type NodeResult } from './node-executor.js';
import { evaluateCondition } from './condition-parser.js';
import { renderTemplate, renderTemplateWithBindings, collectPlaceholders } from './template.js';
import { mergeParallelOutputs } from './parallel.js';
import { extractAutoGateFields, buildNodeContext } from './output-extractor.js';
import { needsSynthesis, synthesizeClarifyContext } from './clarify-synthesizer.js';
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
}

export interface RunOptions {
  /** Externally-provided execution ID (for SSE wiring). Generated if omitted. */
  executionId?: string;
  /** Externally-provided workflowId (MongoDB _id). */
  workflowId?: string;
}

export class AllenEngine {
  private stateManager: StateManager;
  private learningManager: LearningManager;
  private config: EngineConfig;
  private pendingInputResolvers = new Map<string, (data: Record<string, unknown>) => void>();
  private cancelledExecutions = new Set<string>();
  private pausedExecutions = new Set<string>();
  private abortControllers = new Map<string, AbortController>();

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
      state: { ...input },
      sessions: {},
      retryCounts: {},
      currentNodes: [],
      completedNodes: [],
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
      await this.stateManager.updateExecution(executionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
        completedNodes: exec.completedNodes,
      });

      this.log(executionId, { category: 'system', message: `Execution completed in ${(exec.durationMs / 1000).toFixed(1)}s` });
      this.emit({
        event: 'execution_completed',
        data: { executionId, durationMs: exec.durationMs, cost: exec.cost },
      });

      // Post-execution review: fire-and-forget (never delays result)
      this.triggerPostExecutionReview(exec).catch(() => {});

      // Inject cost info into result so parent workflow nodes can access it
      result.__cost_estimated = exec.cost.estimated;
      result.__cost_actual = exec.cost.actual;

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

    const exec: ExecutionState = {
      id: executionId,
      workflowId: '',
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? 1,
      status: 'running',
      input: {},
      state: { ...checkpoint.state } as Record<string, unknown>,
      sessions: { ...checkpoint.sessions },
      retryCounts: { ...checkpoint.retryCounts },
      currentNodes: [],
      completedNodes: [...checkpoint.completedNodes],
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    };

    await this.stateManager.updateExecution(executionId, {
      status: 'running',
      state: exec.state,
      sessions: exec.sessions,
      retryCounts: exec.retryCounts,
      completedNodes: exec.completedNodes,
    });

    this.emit({ event: 'execution_started', data: { executionId, workflowName: workflow.name } });

    try {
      const result = await this.executeGraph(workflow, exec, 0);

      exec.status = 'completed';
      exec.completedAt = new Date();
      exec.durationMs = Date.now() - exec.startedAt.getTime();
      await this.stateManager.updateExecution(executionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
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
    // Get all checkpoints and find one before the target node
    const checkpoint = await this.stateManager.getCheckpointBefore(executionId, nodeName);
    if (!checkpoint) {
      throw new Error(`No checkpoint found before node ${nodeName} for execution ${executionId}`);
    }

    // Remove the target node and everything after it from completedNodes
    const nodeIdx = checkpoint.completedNodes.indexOf(nodeName);
    const completedNodes = nodeIdx >= 0
      ? checkpoint.completedNodes.slice(0, nodeIdx)
      : [...checkpoint.completedNodes];

    // Carry `input` forward from the existing execution record so any node
    // that reads `${input.*}` templates still resolves correctly on retry.
    // The previous behavior reset to `{}` which silently broke such templates.
    const existing = await this.stateManager.getExecution(executionId);
    const exec: ExecutionState = {
      id: executionId,
      workflowId: existing?.workflowId ?? '',
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? 1,
      status: 'running',
      input: existing?.input ?? {},
      state: { ...checkpoint.state } as Record<string, unknown>,
      sessions: { ...checkpoint.sessions },
      retryCounts: { ...checkpoint.retryCounts },
      currentNodes: [],
      completedNodes,
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    };

    await this.stateManager.updateExecution(executionId, {
      status: 'running',
      state: exec.state,
      completedNodes,
    });

    this.emit({ event: 'execution_started', data: { executionId, workflowName: workflow.name } });

    try {
      const result = await this.executeGraph(workflow, exec, 0);
      exec.status = 'completed';
      exec.completedAt = new Date();
      exec.durationMs = Date.now() - exec.startedAt.getTime();
      await this.stateManager.updateExecution(executionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
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
    const exec: ExecutionState = {
      id: executionId,
      workflowId: existing?.workflowId ?? '',
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? 1,
      status: 'running',
      input: existing?.input ?? {},
      state: { ...checkpoint.state } as Record<string, unknown>,
      sessions: { ...checkpoint.sessions },
      retryCounts: { ...checkpoint.retryCounts },
      currentNodes: [],
      completedNodes: [...checkpoint.completedNodes],
      cost: { actual: null, estimated: 0 },
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
      await this.stateManager.updateExecution(executionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
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
      sessions: { ...checkpoint.sessions },
      retryCounts: { ...checkpoint.retryCounts },
      currentNodes: [],
      completedNodes: [...checkpoint.completedNodes],
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
      await this.stateManager.updateExecution(newExecutionId, {
        status: 'completed',
        completedAt: exec.completedAt,
        durationMs: exec.durationMs,
        state: exec.state,
        cost: exec.cost,
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
      resolver(data);
      this.pendingInputResolvers.delete(key);
      return true;
    }
    return false;
  }

  cancelExecution(executionId: string): void {
    this.cancelledExecutions.add(executionId);
    // Abort the running node's process immediately
    const ac = this.abortControllers.get(executionId);
    if (ac) { ac.abort(); this.abortControllers.delete(executionId); }
  }

  pauseExecution(executionId: string): void {
    this.pausedExecutions.add(executionId);
  }

  resumeExecution(executionId: string): void {
    this.pausedExecutions.delete(executionId);
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
        await this.stateManager.updateExecution(exec.id, { status: 'waiting_for_input' });
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

      if (parallelEdge && Array.isArray(parallelEdge.to)) {
        await this.executeParallelNodes(parallelEdge.to, parallelEdge, nodes, exec, nestingDepth);
        const parallelJustFinished = parallelEdge.to as string[];
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
            const fields = Array.isArray(clarifyFields) && clarifyFields.length > 0
              ? clarifyFields
              : [{ name: 'clarification', type: 'text', label: 'Your response', required: true, placeholder: 'Type your answer here...' }];
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
            });

            this.emit({
              event: 'input_required',
              data: {
                node: nodeName,
                prompt: reason,
                fields,
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
            Object.assign(exec.state, humanData);

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
              // Build retry context from all human-provided fields
              const clarificationParts = Object.entries(humanData)
                .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join('\n');
              exec.state.retry_context = `Human provided:\n${clarificationParts}`;
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
                  exec.state.retry_context as string | undefined,
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
        currentNodes = this.getNextNodes(exec.completedNodes, edges, exec.state, exec.retryCounts, exec.id, justFinished);
      }

      if (currentNodes.includes('END') || currentNodes.length === 0) {
        break;
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

    // Track retry count per node for trace attempt numbering
    // Count how many times this node has already been traced (completed traces for this node)
    const edgeRetryKey = this.findRetryEdgeKey(nodeName, exec.retryCounts);
    const previousAttempts = exec.completedNodes.filter(n => n === nodeName).length;
    const attempt = previousAttempts + 1;
    const traceStart = new Date();

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
    let nodeContext = nodeType === 'agent' && workflow
      ? buildNodeContext(
          nodeName,
          { nodes: workflow.nodes as Record<string, unknown>, edges: workflow.edges as unknown as Array<Record<string, unknown>> },
          upstreamArtifacts,
        )
      : '';

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
          nodeContext += this.learningManager.buildLearningsPrompt(learnings);
          injectedLearningIds = learnings.map(l => l._id).filter(Boolean);
          learningsInjectedTrace = learnings.map((l) => ({
            id: l._id ? String(l._id) : undefined,
            content: (l.content ?? '').slice(0, 500),
            contextTags: (l as unknown as { contextTags?: string[] }).contextTags,
          }));
          const totalTokens = learnings.reduce((sum, l) => sum + l.tokenCount, 0);
          const previews = learnings.map(l => `"${l.content.slice(0, 50)}..."`).join(', ');
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

    // Create abort controller for this node — cancelled via cancelExecution()
    const ac = new AbortController();
    this.abortControllers.set(exec.id, ac);

    const deps: NodeExecutorDeps = {
      agents: this.config.agents,
      builtIns: this.config.builtIns,
      workflows: this.config.workflows,
      emitter: this.config.emitter,
      runWorkflow: (wf, input) => this.run(wf, input, nestingDepth + 1),
      executionId: exec.id,
      nodeContext,
      db: this.config.db,
      services: this.config.services,
      abortSignal: ac.signal,
    };
    this.log(exec.id, {
      category: 'system',
      node: nodeName,
      message: `Node started (type: ${nodeType}${nodeDef.agent ? `, role: ${nodeDef.agent}` : ''}${nodeDef.agent && deps.agents[nodeDef.agent]?.model ? `, model: ${deps.agents[nodeDef.agent].model}` : ''})`,
    });

    try {
      const result = await executeNode(nodeName, nodeDef, exec.state, exec.sessions, deps);
      this.abortControllers.delete(exec.id); // Clean up after node completes

      // Handle human node waiting
      if (result.outputs.__waiting_for_input) {
        exec.status = 'waiting_for_input';
        await this.stateManager.updateExecution(exec.id, {
          status: 'waiting_for_input',
          completedNodes: exec.completedNodes,
          state: exec.state,
        });

        // Save checkpoint before waiting
        await this.stateManager.saveCheckpoint({
          executionId: exec.id,
          afterNode: nodeName,
          state: { ...exec.state },
          sessions: { ...exec.sessions },
          retryCounts: { ...exec.retryCounts },
          completedNodes: [...exec.completedNodes],
          createdAt: new Date(),
        });

        const humanData = await this.waitForInput(exec.id, nodeName);
        this.emit({ event: 'input_received', data: { node: nodeName, data: humanData } });

        // Merge human input into state and outputs
        Object.assign(exec.state, humanData);
        Object.assign(result.outputs, humanData);
        delete result.outputs.__waiting_for_input;
        delete result.outputs.__node;

        exec.status = 'running';
        await this.stateManager.updateExecution(exec.id, { status: 'running' });
      }

      // Update state with outputs
      Object.assign(exec.state, result.outputs);

      // If this node ran as the target of a retry edge, consume the retry
      // payload (retry_context + flags) so forward-path nodes downstream
      // don't see stale feedback. The engine is the single source of truth
      // for retry plumbing — workflow authors never manage this manually.
      const retryTargets = exec.state.__retry_target as string[] | undefined;
      if (Array.isArray(retryTargets) && retryTargets.includes(nodeName)) {
        delete exec.state.retry_context;
        delete exec.state.__retry_target;
        delete exec.state.__retry_attempt;
        delete exec.state.__retry_source;
      }

      // Track session for resume
      if (result.sessionId) {
        exec.sessions[nodeName] = result.sessionId;
      }

      // Update cost (sequential — no race condition)
      exec.cost.estimated += result.cost.estimated;
      if (result.cost.actual != null) {
        exec.cost.actual = (exec.cost.actual ?? 0) + result.cost.actual;
      }

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
        attempt,
        status: 'completed',
        type: nodeDef.type ?? 'agent',
        agent: nodeDef.agent,
        inputState: { ...exec.state },
        renderedPrompt: promptRender?.rendered,
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
        runtimeContext: resultExt.runtimeContext,
        agentOverrides: resultExt.agentOverrides,
        toolsAvailable: resultExt.toolsAvailable,
        tokenUsagePerTool: resultExt.tokenUsagePerTool,
        gateDecision: resultExt.gateDecision,
      };

      await this.stateManager.saveTrace({ ...trace, executionId: exec.id });

      // Auto-capture eligible outputs as user-visible artifacts so the
      // user can browse plans / PRDs / JSON configs from the execution
      // page without the workflow author having to scaffold uploads.
      // Best-effort — failures here never block the run.
      if (this.config.services?.artifacts) {
        autoCaptureArtifacts({
          save: this.config.services.artifacts.save,
          outputs: result.outputs,
          nodeName,
          nodeAgent: nodeDef.agent,
          rootId: (process.env.ALLEN_ARTIFACT_ROOT_ID || exec.id),
          attempt,
        }).catch((err) => {
          this.log(exec.id, {
            category: 'system',
            node: nodeName,
            level: 'debug',
            message: `Artifact auto-capture skipped: ${(err as Error).message}`,
          });
        });
      }

      // Save checkpoint
      await this.stateManager.saveCheckpoint({
        executionId: exec.id,
        afterNode: nodeName,
        state: { ...exec.state },
        sessions: { ...exec.sessions },
        retryCounts: { ...exec.retryCounts },
        completedNodes: [...exec.completedNodes],
        createdAt: new Date(),
      });

      const costStr = result.cost.actual != null ? `$${result.cost.actual.toFixed(4)}` : `~$${result.cost.estimated.toFixed(4)}`;
      this.log(exec.id, {
        category: 'system',
        node: nodeName,
        message: `Node completed in ${(result.durationMs / 1000).toFixed(1)}s — cost: ${costStr}`,
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
      exec.failedNode = nodeName;
      const message = err instanceof Error ? err.message : String(err);
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

    // For fail-fast / wait-any we need an abort mechanism
    const abortController = new AbortController();

    interface BranchResult {
      node: string;
      outputs: Record<string, unknown>;
      result: NodeResult;
      traceStart: Date;
      injectedLearningIds: any[];
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

      const retryAc = new AbortController();
      this.abortControllers.set(exec.id, retryAc);
      const deps: NodeExecutorDeps = {
        agents: this.config.agents,
        builtIns: this.config.builtIns,
        workflows: this.config.workflows,
        emitter: this.config.emitter,
        runWorkflow: (wf, input) => this.run(wf, input, nestingDepth + 1),
        executionId: exec.id,
        nodeContext,
        db: this.config.db,
        services: this.config.services,
        abortSignal: retryAc.signal,
      };

      // Each branch reads from the snapshot, not the live state
      const result = await executeNode(nodeName, nodeDef, stateSnapshot, exec.sessions, deps);

      // Check if abort was signaled
      if (abortController.signal.aborted) {
        throw new Error('Branch cancelled by join policy');
      }

      // Track session (safe — different keys per branch)
      if (result.sessionId) {
        exec.sessions[nodeName] = result.sessionId;
      }

      return { node: nodeName, outputs: result.outputs, result, traceStart, injectedLearningIds: branchLearningIds };
    });

    let branchResults: BranchResult[];

    if (joinPolicy === 'wait-any') {
      // Take first to complete, let others finish in background
      const first = await Promise.race(promises);
      branchResults = [first];
      // Don't abort others — let them complete silently, but we only use the first result

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
      if (errors.length > 0) {
        throw errors[0];
      }
    }

    // Aggregate costs AFTER all branches complete (no race condition)
    for (const br of branchResults) {
      exec.cost.estimated += br.result.cost.estimated;
      if (br.result.cost.actual != null) {
        exec.cost.actual = (exec.cost.actual ?? 0) + br.result.cost.actual;
      }
      exec.completedNodes.push(br.node);

      // Save trace for each parallel branch
      const nodeDef = nodes[br.node];
      const trace: NodeTrace = {
        node: br.node,
        attempt: 1,
        status: 'completed',
        type: nodeDef?.type ?? 'agent',
        agent: nodeDef?.agent,
        inputState: stateSnapshot,
        renderedPrompt: nodeDef?.prompt ? renderTemplate(nodeDef.prompt, stateSnapshot) : undefined,
        output: br.outputs,
        rawResponse: br.result.rawResponse,
        activity: [],
        sessionId: br.result.sessionId,
        cost: br.result.cost,
        durationMs: br.result.durationMs,
        startedAt: br.traceStart,
        completedAt: new Date(),
        toolCalls: br.result.toolCalls,
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

      // Retry edges: only fire when at least one source is in the just-finished
      // set. Without this, a retry edge like `clarify → requirements if revise`
      // would keep firing on every subsequent iteration because `clarify` stays
      // in historical completedNodes and `approved` state doesn't auto-reset.
      if (edge.max_retries != null && justFinishedSet) {
        const anyJustFinished = fromNodes.some(f => justFinishedSet.has(f));
        if (!anyJustFinished) continue;
      }

      // For forward (non-retry) edges: skip if ALL targets are already
      // completed. This prevents re-routing to already-visited nodes on
      // subsequent iterations (e.g. edge 3 `[req, ux] → threat-model` firing
      // again after threat-model already ran). Retry edges intentionally
      // re-route and are exempt.
      if (edge.max_retries == null) {
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

      // Check retry limit for backward edges
      if (edge.max_retries != null) {
        const edgeKey = `${fromNodes.join(',')}→${Array.isArray(edge.to) ? edge.to.join(',') : edge.to}`;
        const count = retryCounts[edgeKey] ?? 0;
        if (count >= edge.max_retries) {
          throw new Error(
            `Max retries (${edge.max_retries}) exceeded for edge ${edgeKey}`,
          );
        }
        retryCounts[edgeKey] = count + 1;

        // Build the feedback payload the engine will auto-inject into the
        // target node's prompt. Every retry edge gets one, even if no
        // retry_context template was declared — in that case we synthesise
        // a summary from the source node's outputs so the workflow author
        // never has to scaffold `{{retry_context}}` manually.
        const rendered = edge.retry_context
          ? renderTemplate(edge.retry_context, state)
          : this.synthesiseRetryContext(fromNodes, state);
        state.retry_context = rendered;

        const targetNodes = Array.isArray(edge.to) ? edge.to : [edge.to];
        // Scope the retry payload to the immediate target(s) so forward-path
        // nodes downstream of the retry target don't accidentally see stale
        // retry_context on their next run.
        state.__retry_target = targetNodes;
        state.__retry_attempt = count + 2;
        state.__retry_source = fromNodes.join(',');

        const targetNode = targetNodes[0];
        if (executionId) {
          this.log(executionId, {
            category: 'routing',
            node: targetNode,
            level: 'warn',
            message: `Retry attempt ${count + 2}/${edge.max_retries}`,
            data: { attempt: count + 2, maxRetries: edge.max_retries, retryContext: state.retry_context },
          });
        }

        this.emit({
          event: 'node_retrying',
          data: {
            node: targetNode,
            fromNode: fromNodes.join(','),
            attempt: count + 2,
            retryContext: state.retry_context,
          },
        });

        // Rewind downstream: remove every node reachable forward from the
        // retry targets from completedNodes. This ensures that after the
        // retry runs, the forward edges will fire again (instead of being
        // blocked by the "all targets already completed" filter above).
        const downstream = this.findDownstreamNodes(targetNodes, edges);
        if (downstream.size > 0) {
          for (let i = completedNodes.length - 1; i >= 0; i--) {
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
    return new Promise((resolve) => {
      const key = `${executionId}:${node}`;
      this.pendingInputResolvers.set(key, resolve);
      // No timeout — waits indefinitely until submitted or execution is cancelled
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
 * Decide which output keys from a node should be auto-saved as artifacts
 * and write them through the host-supplied save hook.
 *
 * Heuristic (keep it conservative — false positives clutter the artifact list):
 *   - Key ends with `_markdown` AND value is a non-empty string → save as .md
 *   - Key ends with `_json` AND value is an object (or parseable JSON string) → save as .json
 *   - Key ends with `_csv` AND value is a string → save as .csv
 *   - Key ends with `_url` or `_id` → never capture (it's a reference, not content)
 *   - __-prefixed keys → never capture (engine-internal)
 */
async function autoCaptureArtifacts(args: {
  save: NonNullable<NonNullable<EngineServices>['artifacts']>['save'];
  outputs: Record<string, unknown>;
  nodeName: string;
  nodeAgent?: string;
  rootId: string;
  attempt: number;
}): Promise<void> {
  const rootType = (process.env.ALLEN_ARTIFACT_ROOT_TYPE as 'workflow' | 'chat' | 'agent' | undefined) ?? 'workflow';
  const suffix = args.attempt > 1 ? `-attempt-${args.attempt}` : '';
  for (const [key, value] of Object.entries(args.outputs)) {
    if (!key || key.startsWith('__')) continue;
    if (key.endsWith('_url') || key.endsWith('_id')) continue;

    let filename: string | undefined;
    let content: string | undefined;
    let contentType: 'markdown' | 'json' | 'csv' | 'text' | undefined;

    if (key.endsWith('_markdown') && typeof value === 'string' && value.trim().length > 0) {
      filename = `${args.nodeName}/${key.replace(/_markdown$/, '')}${suffix}.md`;
      content = value;
      contentType = 'markdown';
    } else if (key.endsWith('_json')) {
      if (typeof value === 'string') {
        try { JSON.parse(value); } catch { continue; }
        content = value;
      } else if (value !== null && typeof value === 'object') {
        content = JSON.stringify(value, null, 2);
      } else continue;
      filename = `${args.nodeName}/${key.replace(/_json$/, '')}${suffix}.json`;
      contentType = 'json';
    } else if (key.endsWith('_csv') && typeof value === 'string' && value.trim().length > 0) {
      filename = `${args.nodeName}/${key.replace(/_csv$/, '')}${suffix}.csv`;
      content = value;
      contentType = 'csv';
    } else {
      continue;
    }

    if (!filename || content == null) continue;
    try {
      await args.save({
        rootType,
        rootId: args.rootId,
        filename,
        content,
        contentType,
        overwrite: true, // attempts can rewrite earlier rounds
        description: `Auto-captured from ${args.nodeName} (${key})`,
        spawnContext: {
          originType: 'workflow_node',
          nodeName: args.nodeName,
          agentName: args.nodeAgent,
        },
      });
    } catch {
      // Best-effort — one failing output shouldn't block the rest.
    }
  }
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
