import { describe, expect, it } from 'vitest';
import type { RunStatus } from '../../services/api';
import type { ExecutionSnapshot } from '../../stores/executionStore';
import {
  reconcileChildAgentsWithSnapshots,
  reconcileRunContextWithSnapshot,
  runSeedFromSnapshot,
} from '../chatExecutionState';

function context(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    origin: 'chat',
    runType: 'workflow',
    title: 'Test workflow',
    status: 'running',
    execution: {
      id: 'exec-1', workflowName: 'test', status: 'running', revision: 1, runGeneration: 1,
      currentNodes: ['plan'], completedNodes: [],
    },
    progress: { completed: 0, total: 3, percent: 0, label: 'Working', currentStep: 'plan', phase: 'planning' },
    humanInput: { required: false },
    linear: null,
    workspace: null,
    pullRequest: null,
    childAgents: [],
    workflowSteps: [
      { id: 'plan', name: 'plan', index: 0, status: 'running', attempts: 1 },
      { id: 'build', name: 'build', index: 1, status: 'pending', attempts: 0 },
      { id: 'approve', name: 'approve', index: 2, status: 'pending', attempts: 0 },
    ],
    interventions: [],
    artifacts: [],
    activity: [],
    recentActivity: [],
    ...overrides,
  } as RunStatus;
}

function snapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    executionId: 'exec-1', workflowName: 'test', status: 'running', revision: 2, runGeneration: 1,
    updatedAt: '2026-07-17T00:00:00.000Z', currentNodes: ['build'], completedNodes: ['plan'],
    ...overrides,
  };
}

describe('reconcileRunContextWithSnapshot', () => {
  it('moves the visible running node and progress to the canonical snapshot', () => {
    const result = reconcileRunContextWithSnapshot(context(), snapshot());
    expect(result.workflowSteps.map(step => [step.name, step.status])).toEqual([
      ['plan', 'completed'], ['build', 'running'], ['approve', 'pending'],
    ]);
    expect(result.progress).toMatchObject({ completed: 1, total: 3, percent: 33, currentStep: 'build' });
    expect(result.execution).toMatchObject({ revision: 2, currentNodes: ['build'], completedNodes: ['plan'] });
  });

  it('marks the current node waiting and clears stale waiting state after resume', () => {
    const paused = reconcileRunContextWithSnapshot(
      context(),
      snapshot({ status: 'waiting_for_input', currentNodes: ['approve'], completedNodes: ['plan', 'build'] }),
    );
    expect(paused.humanInput.required).toBe(true);
    expect(paused.progress.phase).toBe('waiting_for_human');
    expect(paused.workflowSteps[2].status).toBe('waiting_for_input');

    const resumed = reconcileRunContextWithSnapshot(
      paused,
      snapshot({ revision: 3, runGeneration: 2, status: 'running', currentNodes: ['build'], completedNodes: ['plan'] }),
    );
    expect(resumed.humanInput.required).toBe(false);
    expect(resumed.workflowSteps.map(step => [step.name, step.status])).toEqual([
      ['plan', 'completed'], ['build', 'running'], ['approve', 'pending'],
    ]);
  });

  it('applies failed and terminal state without discarding rich step data', () => {
    const result = reconcileRunContextWithSnapshot(
      context(),
      snapshot({ status: 'failed', currentNodes: [], failedNode: 'build', errorMessage: 'boom' }),
    );
    expect(result.status).toBe('failed');
    expect(result.progress.phase).toBe('failed');
    expect(result.workflowSteps[1]).toMatchObject({ name: 'build', status: 'failed', attempts: 0 });
    expect(result.execution.errorMessage).toBe('boom');
  });

  it('keeps parallel current nodes running', () => {
    const result = reconcileRunContextWithSnapshot(
      context(),
      snapshot({ currentNodes: ['build', 'approve'] }),
    );
    expect(result.workflowSteps[1].status).toBe('running');
    expect(result.workflowSteps[2].status).toBe('running');
  });
});

describe('runSeedFromSnapshot', () => {
  it('creates a recoverable workflow card when a chat start event was missed', () => {
    expect(runSeedFromSnapshot(snapshot({ workflowId: 'wf-1', workflowName: 'release-flow' }))).toMatchObject({
      executionId: 'exec-1',
      agent: 'release-flow',
      status: 'running',
      kind: 'workflow',
    });
  });

  it('falls back to the current node for direct agent executions', () => {
    expect(runSeedFromSnapshot(snapshot({ workflowId: null, workflowName: '', source: 'chat_agent' }))).toMatchObject({
      agent: 'build',
      kind: 'agent',
    });
  });
});

describe('reconcileChildAgentsWithSnapshots', () => {
  it('updates an embedded child that completed outside the parent stream', () => {
    const parent = context({
      childAgents: [{ executionId: 'child-1', agentName: 'builder', status: 'running', currentStep: 'build' }],
    });
    const result = reconcileChildAgentsWithSnapshots(parent, {
      'child-1': snapshot({ executionId: 'child-1', status: 'completed', currentNodes: [], completedNodes: ['build'] }),
    });
    expect(result.childAgents[0]).toMatchObject({ executionId: 'child-1', status: 'completed', currentStep: null });
  });

  it('adds a newly observed direct child to the parent context', () => {
    const parent = context();
    const result = reconcileChildAgentsWithSnapshots(parent, {
      'child-2': snapshot({ executionId: 'child-2', parentExecutionId: 'exec-1', workflowName: 'qa-agent' }),
    });
    expect(result.childAgents).toEqual([
      expect.objectContaining({ executionId: 'child-2', agentName: 'qa-agent', status: 'running' }),
    ]);
  });

  it('preserves object identity when child display state did not change', () => {
    const parent = context({
      childAgents: [{ executionId: 'child-1', agentName: 'builder', status: 'running', currentStep: 'build', errorMessage: null }],
    });
    expect(reconcileChildAgentsWithSnapshots(parent, {
      'child-1': snapshot({ executionId: 'child-1', currentNodes: ['build'], errorMessage: null }),
    })).toBe(parent);
  });
});
