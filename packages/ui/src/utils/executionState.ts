import type { NodeState } from '../hooks/useExecution';

/**
 * Backfill running state for nodes that are currently executing (in
 * `currentNodes`) but whose traces still show a prior terminal state.
 *
 * `currentNodes` is authoritative for live executions. A node may already
 * have a completed trace from an earlier loop/retry, so completed traces must
 * still be promoted to `running` when the engine reports a new active attempt.
 *
 * Mutates `map` in place.
 */
export function applyCurrentNodesBackfill(
  map: Map<string, NodeState>,
  currentNodes: string[] | undefined,
  completedNodes: string[] | undefined,
  executionStatus?: string,
  startedAtByNode: Map<string, Date | string> = new Map(),
): void {
  if (!Array.isArray(currentNodes)) return;
  const liveStatus = executionStatus === 'waiting_for_input' ? 'waiting_for_input' : 'running';
  for (const name of currentNodes) {
    if (name === 'END') continue;
    const existing = map.get(name);
    const priorAttempts = (completedNodes ?? []).filter((n: string) => n === name).length;
    const traceBasedAttempt = existing?.status === 'completed'
      ? (existing.attempt ?? 0) + 1
      : (existing?.attempt ?? 0);
    const nextAttempt = Math.max(priorAttempts + 1, traceBasedAttempt);
    const startedAt = existing?.startedAt
      ?? existing?.completedAt
      ?? startedAtByNode.get(name)
      ?? new Date();
    const startedMs = new Date(startedAt).getTime();
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : existing?.durationMs;
    map.set(name, {
      name,
      status: liveStatus as NodeState['status'],
      attempt: nextAttempt,
      startedAt,
      completedAt: null,
      durationMs,
      streamText: '',
      activity: [],
    });
  }
}

/**
 * Augment a traces array with synthetic 'running' entries for nodes that
 * are currently executing in `nodeStates`.
 *
 * Traces are only persisted after a node finishes, so without this a live
 * running node is invisible in the Gantt timeline. The synthetic entry uses
 * the latest known end-time from existing traces as its `startedAt` so the
 * chart scale doesn't stretch to "now" if the execution ran a while ago.
 *
 * Returns a new array (does not mutate the input).
 */
export function buildTracesForTimeline(
  traces: any[],
  nodeStates: Map<string, Pick<NodeState, 'status' | 'attempt' | 'startedAt' | 'durationMs'>>,
): any[] {
  const result = [...traces];

  // Find the latest "end time" among existing traces to anchor running bars
  // at the right edge of the chart without distorting the time scale.
  let latestEndMs = 0;
  for (const t of result) {
    const start = new Date(t.startedAt).getTime();
    if (!isNaN(start)) {
      latestEndMs = Math.max(latestEndMs, start + (t.durationMs ?? 0));
    }
  }
  if (latestEndMs === 0) latestEndMs = Date.now();

  for (const [name, state] of nodeStates) {
    if (state.status !== 'running' && state.status !== 'waiting_for_input') continue;
    // Don't duplicate a running entry if one already exists in traces
    if (result.some(t => t.node === name && (t.status === 'running' || t.status === 'waiting_for_input'))) continue;
    const stateStartedMs = state.startedAt ? new Date(state.startedAt).getTime() : NaN;
    const startedMs = Number.isFinite(stateStartedMs) ? stateStartedMs : latestEndMs;
    const durationMs = state.durationMs ?? Math.max(0, Date.now() - startedMs);
    result.push({
      node: name,
      startedAt: new Date(startedMs),
      durationMs,
      status: state.status,
      attempt: state.attempt,
    });
  }

  return result;
}
