import { describe, it, expect } from 'vitest';
import { applyCurrentNodesBackfill, buildTracesForTimeline } from './executionState';
import type { NodeState } from '../hooks/useExecution';

function makeMap(entries: Partial<NodeState>[]): Map<string, NodeState> {
  return new Map(entries.map(e => [e.name!, e as NodeState]));
}

describe('applyCurrentNodesBackfill', () => {
  it('marks a node with a failed trace as running when it is in currentNodes', () => {
    const map = makeMap([
      { name: 'node_a', status: 'failed', attempt: 1, streamText: '', activity: [] },
    ]);
    applyCurrentNodesBackfill(map, ['node_a'], []);
    expect(map.get('node_a')?.status).toBe('running');
  });

  it('overrides a completed trace when the node is currently running again', () => {
    const map = makeMap([
      { name: 'node_a', status: 'completed', attempt: 1, streamText: '', activity: [] },
    ]);
    applyCurrentNodesBackfill(map, ['node_a'], ['node_a']);
    expect(map.get('node_a')?.status).toBe('running');
    expect(map.get('node_a')?.attempt).toBe(2);
  });

  it('adds a running entry for a node not yet in the map', () => {
    const map = new Map<string, NodeState>();
    applyCurrentNodesBackfill(map, ['node_b'], []);
    expect(map.get('node_b')?.status).toBe('running');
    expect(map.get('node_b')?.attempt).toBe(1);
  });

  it('computes attempt = (prior completed occurrences) + 1', () => {
    const map = makeMap([
      { name: 'node_a', status: 'failed', attempt: 2, streamText: '', activity: [] },
    ]);
    // node_a has been completed once before (then failed on attempt 2)
    applyCurrentNodesBackfill(map, ['node_a'], ['node_a']);
    expect(map.get('node_a')?.attempt).toBe(2); // 1 prior completed + 1
  });

  it('skips the END sentinel', () => {
    const map = new Map<string, NodeState>();
    applyCurrentNodesBackfill(map, ['END'], []);
    expect(map.has('END')).toBe(false);
  });

  it('is a no-op when currentNodes is undefined', () => {
    const map = makeMap([
      { name: 'node_a', status: 'failed', attempt: 1, streamText: '', activity: [] },
    ]);
    applyCurrentNodesBackfill(map, undefined, []);
    expect(map.get('node_a')?.status).toBe('failed');
  });
});

describe('buildTracesForTimeline', () => {
  const completedTrace = {
    node: 'node_a',
    startedAt: new Date('2024-01-01T00:00:00Z'),
    durationMs: 5000,
    status: 'completed',
    attempt: 1,
  };

  it('adds synthetic running entry for a running node not in traces', () => {
    const states = new Map<string, Pick<NodeState, 'status' | 'attempt'>>([
      ['node_b', { status: 'running', attempt: 2 }],
    ]);
    const result = buildTracesForTimeline([completedTrace], states);
    const runningEntry = result.find(t => t.node === 'node_b');
    expect(runningEntry).toBeDefined();
    expect(runningEntry?.status).toBe('running');
    expect(runningEntry?.attempt).toBe(2);
    expect(runningEntry?.durationMs).toBe(0);
  });

  it('does not add entries for completed or failed nodes', () => {
    const states = new Map<string, Pick<NodeState, 'status' | 'attempt'>>([
      ['node_a', { status: 'completed', attempt: 1 }],
      ['node_c', { status: 'failed', attempt: 1 }],
    ]);
    const result = buildTracesForTimeline([completedTrace], states);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(completedTrace);
  });

  it('does not duplicate a running entry already in traces', () => {
    const runningTrace = {
      node: 'node_b',
      startedAt: new Date(),
      durationMs: 0,
      status: 'running',
      attempt: 1,
    };
    const states = new Map<string, Pick<NodeState, 'status' | 'attempt'>>([
      ['node_b', { status: 'running', attempt: 1 }],
    ]);
    const result = buildTracesForTimeline([completedTrace, runningTrace], states);
    expect(result.filter(t => t.node === 'node_b').length).toBe(1);
  });

  it('anchors running bar startedAt at the latest known end time', () => {
    const states = new Map<string, Pick<NodeState, 'status' | 'attempt'>>([
      ['node_b', { status: 'running', attempt: 1 }],
    ]);
    const result = buildTracesForTimeline([completedTrace], states);
    const runningEntry = result.find(t => t.node === 'node_b');
    // Should be anchored at completedTrace.startedAt + completedTrace.durationMs
    const expectedMs = new Date('2024-01-01T00:00:00Z').getTime() + 5000;
    expect(runningEntry?.startedAt.getTime()).toBe(expectedMs);
  });

  it('handles empty traces: uses Date.now() as fallback anchor', () => {
    const before = Date.now();
    const states = new Map<string, Pick<NodeState, 'status' | 'attempt'>>([
      ['node_a', { status: 'running', attempt: 1 }],
    ]);
    const result = buildTracesForTimeline([], states);
    const after = Date.now();
    expect(result.length).toBe(1);
    const startMs = result[0].startedAt.getTime();
    expect(startMs).toBeGreaterThanOrEqual(before);
    expect(startMs).toBeLessThanOrEqual(after);
  });
});
