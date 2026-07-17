import { beforeEach, describe, expect, it } from 'vitest';
import { isNewerSnapshot, useExecutionStore, type ExecutionSnapshot } from './executionStore';

function snapshot(revision: number, runGeneration = 1, status = 'running'): ExecutionSnapshot {
  return {
    executionId: 'exec-1',
    workflowName: 'test',
    status,
    revision,
    runGeneration,
    updatedAt: new Date(revision * 1000).toISOString(),
    currentNodes: status === 'running' ? ['work'] : [],
    completedNodes: status === 'completed' ? ['work'] : [],
  };
}

describe('executionStore revision ordering', () => {
  beforeEach(() => useExecutionStore.getState().clear());

  it('ignores duplicate and out-of-order revisions', () => {
    expect(useExecutionStore.getState().ingest(snapshot(4))).toBe(true);
    expect(useExecutionStore.getState().ingest(snapshot(2, 1, 'failed'))).toBe(false);
    expect(useExecutionStore.getState().ingest(snapshot(4, 1, 'completed'))).toBe(false);
    expect(useExecutionStore.getState().entities['exec-1']?.status).toBe('running');
  });

  it('accepts a newer run generation even when its revision is lower', () => {
    useExecutionStore.getState().ingest(snapshot(20, 1, 'failed'));
    expect(useExecutionStore.getState().ingest(snapshot(1, 2, 'running'))).toBe(true);
    expect(useExecutionStore.getState().entities['exec-1']).toMatchObject({
      runGeneration: 2,
      revision: 1,
      status: 'running',
    });
  });

  it('rejects a stale generation regardless of revision', () => {
    expect(isNewerSnapshot(snapshot(3, 3), snapshot(100, 2))).toBe(false);
  });

  it('normalizes the backend canceled alias before publishing state', () => {
    useExecutionStore.getState().ingest(snapshot(1, 1, 'canceled'));
    expect(useExecutionStore.getState().entities['exec-1']?.status).toBe('cancelled');
  });
});
