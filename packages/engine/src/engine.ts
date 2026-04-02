import { randomUUID } from 'node:crypto';
import type {
  WorkflowDef,
  EdgeDef,
  NodeDef,
  ExecutionState,
  EngineEventEmitter,
  RoleDef,
  BuiltInFunction,
  NodeTrace,
  SSEEvent,
  Checkpoint,
} from './types.js';
import { executeNode, type NodeExecutorDeps, type NodeResult } from './node-executor.js';
import { evaluateCondition } from './condition-parser.js';
import { renderTemplate } from './template.js';
import { mergeParallelOutputs } from './parallel.js';
import { StateManager } from './state-manager.js';
import type { Db } from 'mongodb';

export interface EngineConfig {
  db: Db;
  roles: Record<string, RoleDef>;
  builtIns: Record<string, BuiltInFunction>;
  workflows: Record<string, WorkflowDef>;
  emitter: EngineEventEmitter;
  maxNestingDepth?: number;
}

export interface RunOptions {
  /** Externally-provided execution ID (for SSE wiring). Generated if omitted. */
  executionId?: string;
  /** Externally-provided workflowId (MongoDB _id). */
  workflowId?: string;
}

export class FlowForgeEngine {
  private stateManager: StateManager;
  private config: EngineConfig;
  private pendingInputResolvers = new Map<string, (data: Record<string, unknown>) => void>();
  private cancelledExecutions = new Set<string>();
  private pausedExecutions = new Set<string>();

  constructor(config: EngineConfig) {
    this.config = config;
    this.stateManager = new StateManager(config.db);
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

    await this.stateManager.createExecution(exec);
    this.emit({ event: 'execution_started', data: { executionId, workflowName: workflow.name } });

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

      this.emit({
        event: 'execution_completed',
        data: { executionId, durationMs: exec.durationMs, cost: exec.cost },
      });

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

      this.emit({
        event: 'execution_failed',
        data: { executionId, failedNode: exec.failedNode, error: message },
      });
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
      this.emit({
        event: 'execution_failed',
        data: { executionId, failedNode: exec.failedNode, error: message },
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
  }

  pauseExecution(executionId: string): void {
    this.pausedExecutions.add(executionId);
  }

  resumeExecution(executionId: string): void {
    this.pausedExecutions.delete(executionId);
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
      currentNodes = this.getNextNodes(exec.completedNodes, edges, exec.state, exec.retryCounts);
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
        state: exec.state,
        status: 'running',
      });

      // Check if current node triggers a parallel fork
      const parallelEdge = edges.find(
        e => e.parallel && Array.isArray(e.to) && currentNodes.length === 1 && currentNodes[0] === this.normalizeFrom(e.from),
      );

      if (parallelEdge && Array.isArray(parallelEdge.to)) {
        await this.executeParallelNodes(parallelEdge.to, parallelEdge, nodes, exec, nestingDepth);
        const nextNodes = this.getNextNodes(parallelEdge.to, edges, exec.state, exec.retryCounts);
        currentNodes = nextNodes;
      } else {
        for (const nodeName of currentNodes) {
          if (nodeName === 'END') continue;
          await this.executeSingleNode(nodeName, nodes[nodeName], exec, nestingDepth);
        }

        const completedSet = currentNodes.filter(n => n !== 'END');
        currentNodes = this.getNextNodes(completedSet, edges, exec.state, exec.retryCounts);
      }

      if (currentNodes.includes('END') || currentNodes.length === 0) {
        break;
      }
    }

    return exec.state;
  }

  // ── Single Node Execution ──────────────────────────────────────────────────

  private async executeSingleNode(
    nodeName: string,
    nodeDef: NodeDef | undefined,
    exec: ExecutionState,
    nestingDepth: number,
  ): Promise<void> {
    if (!nodeDef) {
      throw new Error(`Node definition not found: ${nodeName}`);
    }

    // Track retry count per node for trace attempt numbering
    const edgeRetryKey = this.findRetryEdgeKey(nodeName, exec.retryCounts);
    const attempt = edgeRetryKey ? (exec.retryCounts[edgeRetryKey] ?? 0) : 1;
    const traceStart = new Date();

    const deps: NodeExecutorDeps = {
      roles: this.config.roles,
      builtIns: this.config.builtIns,
      workflows: this.config.workflows,
      emitter: this.config.emitter,
      runWorkflow: (wf, input) => this.run(wf, input, nestingDepth + 1),
    };

    try {
      const result = await executeNode(nodeName, nodeDef, exec.state, exec.sessions, deps);

      // Handle human node waiting
      if (result.outputs.__waiting_for_input) {
        exec.status = 'waiting_for_input';
        await this.stateManager.updateExecution(exec.id, { status: 'waiting_for_input' });

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

        const humanData = await this.waitForInput(exec.id, nodeName, nodeDef.timeout);
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

      // Save trace
      const trace: NodeTrace = {
        node: nodeName,
        attempt,
        status: 'completed',
        type: nodeDef.type ?? 'agent',
        role: nodeDef.role,
        inputState: { ...exec.state },
        renderedPrompt: nodeDef.prompt ? renderTemplate(nodeDef.prompt, exec.state) : undefined,
        output: result.outputs,
        rawResponse: result.rawResponse,
        activity: [],
        sessionId: result.sessionId,
        cost: result.cost,
        durationMs: result.durationMs,
        startedAt: traceStart,
        completedAt: new Date(),
      };

      await this.stateManager.saveTrace({ ...trace, executionId: exec.id });

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
    } catch (err: unknown) {
      exec.failedNode = nodeName;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ event: 'node_failed', data: { node: nodeName, attempt, error: message } });
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

    // Snapshot state BEFORE parallel branches so they don't interfere
    const stateSnapshot = { ...exec.state };

    const deps: NodeExecutorDeps = {
      roles: this.config.roles,
      builtIns: this.config.builtIns,
      workflows: this.config.workflows,
      emitter: this.config.emitter,
      runWorkflow: (wf, input) => this.run(wf, input, nestingDepth + 1),
    };

    // For fail-fast / wait-any we need an abort mechanism
    const abortController = new AbortController();

    interface BranchResult {
      node: string;
      outputs: Record<string, unknown>;
      result: NodeResult;
      traceStart: Date;
    }

    const promises = nodeNames.map(async (nodeName): Promise<BranchResult> => {
      const nodeDef = nodes[nodeName];
      if (!nodeDef) throw new Error(`Node not found: ${nodeName}`);

      const traceStart = new Date();

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

      return { node: nodeName, outputs: result.outputs, result, traceStart };
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
        role: nodeDef?.role,
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
      };
      await this.stateManager.saveTrace({ ...trace, executionId: exec.id });

      this.emit({
        event: 'parallel_branch_done',
        data: { node: br.node, status: 'completed', remaining: 0 },
      });
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

  private getNextNodes(
    completedNodes: string[],
    edges: EdgeDef[],
    state: Record<string, unknown>,
    retryCounts: Record<string, number>,
  ): string[] {
    const nextNodes: string[] = [];

    for (const edge of edges) {
      const fromNodes = Array.isArray(edge.from) ? edge.from : [edge.from];
      if (fromNodes[0] === 'START') continue;

      const allFromCompleted = fromNodes.every(f => completedNodes.includes(f));
      if (!allFromCompleted) continue;

      if (edge.condition) {
        if (!evaluateCondition(edge.condition, state)) continue;
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

        if (edge.retry_context) {
          state.retry_context = renderTemplate(edge.retry_context, state);
        }

        this.emit({
          event: 'node_retrying',
          data: {
            node: Array.isArray(edge.to) ? edge.to[0] : edge.to,
            fromNode: fromNodes.join(','),
            attempt: count + 2,
            retryContext: state.retry_context,
          },
        });
      }

      const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
      nextNodes.push(...targets);
    }

    return [...new Set(nextNodes)];
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
    timeoutStr?: number | string,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const key = `${executionId}:${node}`;
      this.pendingInputResolvers.set(key, resolve);

      let timeoutMs = 24 * 60 * 60 * 1000; // default 24h
      if (typeof timeoutStr === 'number') {
        timeoutMs = timeoutStr * 1000;
      } else if (typeof timeoutStr === 'string') {
        const match = timeoutStr.match(/^(\d+)(h|m|s)$/);
        if (match) {
          const val = parseInt(match[1]);
          const unit = match[2];
          timeoutMs = val * (unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000);
        }
      }

      setTimeout(() => {
        if (this.pendingInputResolvers.has(key)) {
          this.pendingInputResolvers.delete(key);
          reject(new Error(`Human input timeout for node ${node}`));
        }
      }, timeoutMs);
    });
  }

  private emit(event: SSEEvent): void {
    this.config.emitter.emit(event);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
