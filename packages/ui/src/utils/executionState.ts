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
): void {
  if (!Array.isArray(currentNodes)) return;
  for (const name of currentNodes) {
    if (name === 'END') continue;
    const priorAttempts = (completedNodes ?? []).filter((n: string) => n === name).length;
    map.set(name, {
      name,
      status: 'running',
      attempt: priorAttempts + 1,
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
  nodeStates: Map<string, Pick<NodeState, 'status' | 'attempt'>>,
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
    if (state.status !== 'running') continue;
    // Don't duplicate a running entry if one already exists in traces
    if (result.some(t => t.node === name && t.status === 'running')) continue;
    result.push({
      node: name,
      startedAt: new Date(latestEndMs),
      durationMs: 0,
      status: 'running',
      attempt: state.attempt,
    });
  }

  return result;
}
