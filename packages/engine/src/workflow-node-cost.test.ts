import { describe, it, expect } from 'vitest';
import { executeNode, type NodeExecutorDeps } from './node-executor.js';
import type { WorkflowDef } from './types.js';

/**
 * Cost singularity: a workflow-type node must NOT copy its child workflow's
 * cost/tokens onto its own trace. The child's spend lives on the child
 * execution's own traces; the parent node records zero cost, method
 * 'child_execution', and the childExecutionId tree link.
 */
describe('executeWorkflowNode cost singularity', () => {
  const childWorkflow: WorkflowDef = {
    name: 'child-wf',
    version: 1,
    nodes: {},
  } as unknown as WorkflowDef;

  function makeDeps(childOutput: Record<string, unknown>): NodeExecutorDeps {
    return {
      agents: {},
      builtIns: {},
      workflows: { 'child-wf': childWorkflow },
      emitter: { emit: () => {} },
      runWorkflow: async () => childOutput,
      executionId: 'parent-exec',
    } as unknown as NodeExecutorDeps;
  }

  it('records zero cost with method child_execution and links the child', async () => {
    const result = await executeNode(
      'run_child',
      { type: 'workflow', workflow: 'child-wf', output_map: { answer: 'child_answer' } },
      {},
      {},
      makeDeps({
        answer: 42,
        // What engine.run() injects for the parent: the child id — never cost.
        __child_execution_id: 'child-exec-123',
      }),
    );

    expect(result.cost).toEqual({ actual: null, estimated: 0, method: 'child_execution' });
    expect(result.childExecutionId).toBe('child-exec-123');
    expect(result.tokenUsage).toBeUndefined();
    expect(result.outputs.child_answer).toBe(42);
  });

  it('ignores legacy child cost markers if present', async () => {
    const result = await executeNode(
      'run_child',
      { type: 'workflow', workflow: 'child-wf' },
      {},
      {},
      makeDeps({
        __cost_estimated: 1.23,
        __cost_actual: 4.56,
        __child_tokens_output: 999,
      }),
    );

    expect(result.cost.actual).toBeNull();
    expect(result.cost.estimated).toBe(0);
    expect(result.cost.method).toBe('child_execution');
    expect(result.tokenUsage).toBeUndefined();
  });
});
