import type { RunPhase, RunStatus } from '../services/api';
import { mergeExecutionSnapshot, type ExecutionSnapshot } from '../stores/executionStore';

export type SnapshotRunSeed = {
  executionId: string;
  parentExecutionId?: string | null;
  agent: string;
  prompt: string;
  status: string;
  activity: [];
  kind: 'agent' | 'workflow';
};

const RESETTABLE_STEP_STATUSES = new Set([
  'running',
  'in_progress',
  'waiting',
  'waiting_for_input',
  'failed',
  'failure',
  'error',
  'errored',
  'cancelled',
  'canceled',
]);

function phaseForSnapshot(status: string, current: RunPhase): RunPhase {
  switch (status.toLowerCase()) {
    case 'waiting_for_input': return 'waiting_for_human';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'queued': return 'queued';
    case 'running':
      return ['completed', 'failed', 'cancelled', 'waiting_for_human', 'queued'].includes(current)
        ? 'running'
        : current;
    default: return current;
  }
}

/**
 * Overlay the canonical execution snapshot onto the richer, cached chat
 * context. Snapshot fields own lifecycle and node state; the cached context
 * continues to own descriptive data such as node IO, artifacts, and costs.
 */
export function reconcileRunContextWithSnapshot(
  context: RunStatus,
  snapshot: ExecutionSnapshot,
): RunStatus {
  const completedNodes = new Set(snapshot.completedNodes);
  const currentNodes = new Set(snapshot.currentNodes);
  const waiting = snapshot.status === 'waiting_for_input';

  const workflowSteps = context.workflowSteps.map((step) => {
    let status = step.status;
    if (completedNodes.has(step.name)) status = 'completed';
    else if (snapshot.failedNode === step.name) status = 'failed';
    else if (currentNodes.has(step.name)) status = waiting ? 'waiting_for_input' : 'running';
    else if (RESETTABLE_STEP_STATUSES.has(String(step.status).toLowerCase())) status = 'pending';
    return status === step.status ? step : { ...step, status };
  });

  const total = context.progress.total || workflowSteps.length;
  const completed = Math.min(
    total,
    workflowSteps.filter(step => ['completed', 'skipped'].includes(String(step.status).toLowerCase())).length,
  );
  const currentStep = snapshot.currentNodes[0] ?? null;

  return {
    ...context,
    status: snapshot.status,
    execution: mergeExecutionSnapshot(
      context.execution as unknown as Record<string, unknown>,
      snapshot,
    ) as unknown as RunStatus['execution'],
    workflowSteps,
    progress: {
      ...context.progress,
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : context.progress.percent,
      currentStep,
      phase: phaseForSnapshot(snapshot.status, context.progress.phase),
    },
    humanInput: {
      ...context.humanInput,
      required: waiting,
    },
  };
}

/** Minimal card data used when the lifecycle stream arrives before (or
 * instead of) the chat-specific start event. Rich context is hydrated by the
 * persisted execution reconciliation path when available. */
export function runSeedFromSnapshot(snapshot: ExecutionSnapshot): SnapshotRunSeed {
  const workflow = Boolean(snapshot.workflowId) || snapshot.source === 'workflow';
  return {
    executionId: snapshot.executionId,
    parentExecutionId: snapshot.parentExecutionId,
    agent: snapshot.workflowName || snapshot.currentNodes[0] || (workflow ? 'Workflow run' : 'Agent run'),
    prompt: '',
    status: snapshot.status,
    activity: [],
    kind: workflow ? 'workflow' : 'agent',
  };
}

/** Keep the parent card's embedded child list aligned with the same canonical
 * snapshots used by standalone execution cards. */
export function reconcileChildAgentsWithSnapshots(
  context: RunStatus,
  snapshots: Record<string, ExecutionSnapshot>,
): RunStatus {
  let changed = false;
  const known = new Set(context.childAgents.map(child => child.executionId));
  const childAgents = context.childAgents.map((child) => {
    const snapshot = snapshots[child.executionId];
    if (!snapshot) return child;
    const currentStep = snapshot.currentNodes[0] ?? null;
    if (
      child.status === snapshot.status
      && child.currentStep === currentStep
      && child.errorMessage === (snapshot.errorMessage ?? null)
    ) return child;
    changed = true;
    return {
      ...child,
      status: snapshot.status,
      currentStep,
      errorMessage: snapshot.errorMessage ?? null,
    };
  });

  for (const snapshot of Object.values(snapshots)) {
    if (snapshot.parentExecutionId !== context.execution.id || known.has(snapshot.executionId)) continue;
    childAgents.push({
      executionId: snapshot.executionId,
      agentName: snapshot.workflowName || snapshot.currentNodes[0] || 'Agent run',
      status: snapshot.status,
      currentStep: snapshot.currentNodes[0] ?? null,
      errorMessage: snapshot.errorMessage ?? null,
    });
    known.add(snapshot.executionId);
    changed = true;
  }

  return changed ? { ...context, childAgents } : context;
}
