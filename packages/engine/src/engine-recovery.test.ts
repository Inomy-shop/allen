import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AllenEngine } from './engine.js';
import type { BuiltInFunction, WorkflowDef } from './types.js';

// ── In-Memory Mongo Shims (mirrored from engine-current-nodes.test.ts) ──

class MemoryCursor {
  constructor(private rows: Record<string, unknown>[]) {}
  sort(_spec: Record<string, number>) { return this; }
  limit(_n: number) { return this; }
  skip(_n: number) { return this; }
  toArray() { return Promise.resolve([...this.rows]); }
}

class MemoryCollection {
  rows: Record<string, unknown>[] = [];
  async insertOne(doc: Record<string, unknown>) {
    const inserted = { ...doc, _id: doc._id ?? `${this.rows.length + 1}` };
    this.rows.push(inserted);
    return { insertedId: inserted._id };
  }
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
    const row = this.rows.find(item => matches(item, filter));
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set && typeof update.$set === 'object') {
      Object.assign(row, update.$set);
    }
    if (update.$unset && typeof update.$unset === 'object') {
      for (const key of Object.keys(update.$unset as Record<string, unknown>)) {
        delete row[key];
      }
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async findOne(filter: Record<string, unknown>) {
    return this.rows.find(item => matches(item, filter)) ?? null;
  }
  find(filter: Record<string, unknown> = {}) {
    return new MemoryCursor(this.rows.filter(item => matches(item, filter)));
  }
  async countDocuments(filter: Record<string, unknown> = {}) {
    return this.rows.filter(item => matches(item, filter)).length;
  }
}

class MemoryDb {
  collections = new Map<string, MemoryCollection>();
  collection(name: string) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name)!;
  }
}

function matches(row: Record<string, unknown>, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

// ── Test Helpers ─────────────────────────────────────────────────────────

function makeEngine(
  builtIns: Record<string, BuiltInFunction>,
  db?: MemoryDb,
) {
  const realDb = db ?? new MemoryDb();
  return {
    engine: new AllenEngine({
      db: realDb as unknown as any,
      agents: {},
      builtIns,
      workflows: {},
      emitter: { emit: () => {} },
    }),
    db: realDb,
  };
}

/**
 * A built-in function that fails the first N times with a recoverable
 * error (429 rate limit), then succeeds on the (N+1)th call.
 */
function recoverableFailThenSucceed(failCount: number): BuiltInFunction & { callCount: () => number } {
  let calls = 0;
  const fn: BuiltInFunction & { callCount: () => number } = async (_config, _state, _ctx) => {
    calls += 1;
    if (calls <= failCount) {
      const err = new Error(`Rate limit exhausted for model claude-sonnet-4-6 (attempt ${calls})`);
      (err as any).status = 429;
      throw err;
    }
    return { ok: true, result: 'success' };
  };
  fn.callCount = () => calls;
  return fn;
}

/** A built-in function that always fails with a non-recoverable error. */
function nonRecoverableFail(): BuiltInFunction & { callCount: () => number } {
  let calls = 0;
  const fn: BuiltInFunction & { callCount: () => number } = async () => {
    calls += 1;
    throw new Error('Agent task failed: could not complete the analysis');
  };
  fn.callCount = () => calls;
  return fn;
}

/** Simple successful code node. */
function succeed(): BuiltInFunction {
  return async () => ({ ok: true, result: 'success' });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AllenEngine model recovery — single node', () => {

  it('recoverable error creates waiting_for_input with __recovery_state', async () => {
    const fn = recoverableFailThenSucceed(1);
    const { engine, db } = makeEngine({ fail_once: fn, done: succeed() });

    const workflow: WorkflowDef = {
      name: 'recovery-test-1',
      version: 1,
      nodes: {
        first: { type: 'code', function: 'fail_once', outputs: { ok: 'done' } },
        second: { type: 'code', function: 'done', outputs: { done: 'ok' } },
      },
      edges: [
        { from: 'START', to: 'first' },
        { from: 'first', to: 'second' },
        { from: 'second', to: 'END' },
      ],
    };

    // Run the workflow — first node enters recovery
    const runPromise = engine.run(workflow, {}, 0, { executionId: 'exec-rec-single' });

    // Let the engine process the first failure
    await new Promise(r => setTimeout(r, 50));

    // Check that execution is waiting_for_input with recovery state
    const execution = await db.collection('executions').findOne({ id: 'exec-rec-single' });
    expect(execution).toBeTruthy();
    expect(execution!.status).toBe('waiting_for_input');

    const state = execution!.state as Record<string, unknown>;
    expect(state.__recovery_state).toBeTruthy();
    const recoveryState = state.__recovery_state as Record<string, unknown>;
    expect(recoveryState.nodeName).toBe('first');
    expect(recoveryState.failureCategory).toBe('rate_limit_exhausted');
    expect(recoveryState.attempt).toBe(1);
    expect(recoveryState.maxAttempts).toBe(3);

    // Submit input to continue the recovery
    const submitted = engine.submitInput('exec-rec-single', 'first', {
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });
    expect(submitted).toBe(true);

    // Wait for workflow to complete
    const result = await runPromise;

    // Check that the workflow completed
    const finalExec = await db.collection('executions').findOne({ id: 'exec-rec-single' });
    expect(finalExec!.status).toBe('completed');
    expect(result.ok).toBe(true);
  });

  it('non-recoverable error does NOT enter recovery — terminal failure', async () => {
    const fn = nonRecoverableFail();
    const { engine } = makeEngine({ always_fail: fn });

    const workflow: WorkflowDef = {
      name: 'recovery-test-nr',
      version: 1,
      nodes: {
        first: { type: 'code', function: 'always_fail', outputs: { ok: 'done' } },
      },
      edges: [
        { from: 'START', to: 'first' },
      ],
    };

    await expect(
      engine.run(workflow, {}, 0, { executionId: 'exec-rec-nr' })
    ).rejects.toThrow();
  });

  it('recovers with submitted provider/model override', async () => {
    const fn = recoverableFailThenSucceed(1);
    const { engine, db } = makeEngine({ fail_once: fn, done: succeed() });

    const workflow: WorkflowDef = {
      name: 'recovery-test-override',
      version: 1,
      nodes: {
        my_node: { type: 'code', function: 'fail_once', outputs: { ok: 'done' } },
        after: { type: 'code', function: 'done', outputs: { done: 'ok' } },
      },
      edges: [
        { from: 'START', to: 'my_node' },
        { from: 'my_node', to: 'after' },
        { from: 'after', to: 'END' },
      ],
    };

    const runPromise = engine.run(workflow, {}, 0, { executionId: 'exec-rec-override' });

    await new Promise(r => setTimeout(r, 50));

    // Submit with a different model
    const submitted = engine.submitInput('exec-rec-override', 'my_node', {
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning_effort: 'high',
    });
    expect(submitted).toBe(true);

    const result = await runPromise;

    expect(result.ok).toBe(true);

    // Verify __model_overrides was recorded
    const execution = await db.collection('executions').findOne({ id: 'exec-rec-override' });
    const state = execution!.state as Record<string, unknown>;
    expect(state.__model_overrides).toBeTruthy();
    const overrides = state.__model_overrides as Record<string, unknown[]>;
    expect(overrides.my_node).toHaveLength(1);
    expect(overrides.my_node[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
    });
  });

  it('exhausts maxAttempts and fails terminally', async () => {
    // A function that always fails with recoverable error
    let calls = 0;
    const alwaysFail: BuiltInFunction = async () => {
      calls += 1;
      const err = new Error(`Rate limit exhausted for model (attempt ${calls})`);
      (err as any).status = 429;
      throw err;
    };
    const { engine, db } = makeEngine({ fail_always: alwaysFail });

    const workflow: WorkflowDef = {
      name: 'recovery-test-exhaust',
      version: 1,
      nodes: {
        my_node: { type: 'code', function: 'fail_always', outputs: { ok: 'done' } },
      },
      edges: [
        { from: 'START', to: 'my_node' },
      ],
    };

    const runPromise = engine.run(workflow, {}, 0, { executionId: 'exec-rec-exhaust' });

    // First failure → recovery prompt
    await new Promise(r => setTimeout(r, 50));
    const exec1 = await db.collection('executions').findOne({ id: 'exec-rec-exhaust' });
    expect(exec1!.status).toBe('waiting_for_input');

    engine.submitInput('exec-rec-exhaust', 'my_node', { provider: 'claude', model: 'sonnet' });

    // Second failure → recovery prompt again
    await new Promise(r => setTimeout(r, 50));

    const exec2 = await db.collection('executions').findOne({ id: 'exec-rec-exhaust' });
    // Should be waiting again after 2nd failure
    expect(exec2!.status).toBe('waiting_for_input');

    // Submit another override
    engine.submitInput('exec-rec-exhaust', 'my_node', { provider: 'codex', model: 'gpt-5' });

    // Third failure → recovery prompt again
    await new Promise(r => setTimeout(r, 50));

    const exec3 = await db.collection('executions').findOne({ id: 'exec-rec-exhaust' });
    expect(exec3!.status).toBe('waiting_for_input');

    // Submit third override — should fail terminally (max attempts = 3, so this is 4th attempt)
    engine.submitInput('exec-rec-exhaust', 'my_node', { provider: 'openai', model: 'gpt-4' });

    // Wait for terminal failure
    await expect(runPromise).rejects.toThrow();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('recovers and continues to downstream node', async () => {
    let downstreamRan = false;
    const downstream: BuiltInFunction = async () => {
      downstreamRan = true;
      return { downstream: 'complete' };
    };

    const fn = recoverableFailThenSucceed(1);
    const { engine, db } = makeEngine({ fail_once: fn, downstream, done: succeed() });

    const workflow: WorkflowDef = {
      name: 'recovery-test-downstream',
      version: 1,
      nodes: {
        first: { type: 'code', function: 'fail_once', outputs: { ok: 'done' } },
        next: { type: 'code', function: 'downstream', outputs: { downstream: 'done' } },
      },
      edges: [
        { from: 'START', to: 'first' },
        { from: 'first', to: 'next' },
        { from: 'next', to: 'END' },
      ],
    };

    const runPromise = engine.run(workflow, {}, 0, { executionId: 'exec-rec-down' });

    await new Promise(r => setTimeout(r, 50));
    engine.submitInput('exec-rec-down', 'first', { provider: 'claude', model: 'sonnet' });

    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(downstreamRan).toBe(true);
    expect(result.downstream).toBe('complete');
  });

  it('__model_overrides persisted on execution state', async () => {
    const fn = recoverableFailThenSucceed(1);
    const { engine, db } = makeEngine({ fail_once: fn, done: succeed() });

    const workflow: WorkflowDef = {
      name: 'recovery-test-persist',
      version: 1,
      nodes: {
        my_node: { type: 'code', function: 'fail_once', outputs: { ok: 'done' } },
        after: { type: 'code', function: 'done', outputs: { done: 'ok' } },
      },
      edges: [
        { from: 'START', to: 'my_node' },
        { from: 'my_node', to: 'after' },
        { from: 'after', to: 'END' },
      ],
    };

    const runPromise = engine.run(workflow, {}, 0, { executionId: 'exec-rec-persist' });

    await new Promise(r => setTimeout(r, 50));
    engine.submitInput('exec-rec-persist', 'my_node', { provider: 'codex', model: 'gpt-5.5' });

    const result = await runPromise;
    expect(result.ok).toBe(true);

    // Verify persistence on the execution row
    const execution = await db.collection('executions').findOne({ id: 'exec-rec-persist' });
    const state = execution!.state as Record<string, unknown>;
    const overrides = state.__model_overrides as Record<string, unknown[]>;
    expect(overrides.my_node).toBeDefined();
    expect(overrides.my_node.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AllenEngine model recovery — trace fields', () => {
  it('recovery attempt recorded on NodeTrace', async () => {
    const fn = recoverableFailThenSucceed(1);
    const { engine, db } = makeEngine({ fail_once: fn, done: succeed() });

    const workflow: WorkflowDef = {
      name: 'recovery-trace-test',
      version: 1,
      nodes: {
        my_node: { type: 'code', function: 'fail_once', outputs: { ok: 'done' } },
        done: { type: 'code', function: 'done', outputs: { ok: 'ok' } },
      },
      edges: [
        { from: 'START', to: 'my_node' },
        { from: 'my_node', to: 'done' },
        { from: 'done', to: 'END' },
      ],
    };

    const runPromise = engine.run(workflow, {}, 0, { executionId: 'exec-rec-trace' });

    await new Promise(r => setTimeout(r, 50));
    engine.submitInput('exec-rec-trace', 'my_node', { provider: 'claude', model: 'sonnet' });

    await runPromise;

    // Check that traces were recorded
    const traces = await db.collection('execution_traces').find({}).toArray();
    // Should have at least 2 traces: one failed (recovery attempt) and one completed
    const failedTraces = traces.filter((t: any) => t.status === 'failed');
    expect(failedTraces.length).toBeGreaterThanOrEqual(1);

    // The failed trace should have a modelRecoveryAttempt
    const recoveryTrace = failedTraces.find((t: any) => t.modelRecoveryAttempt);
    expect(recoveryTrace).toBeTruthy();
    expect(recoveryTrace!.modelRecoveryAttempt.failureCategory).toBe('rate_limit_exhausted');
    expect(recoveryTrace!.modelRecoveryAttempt.recoveryAttempt).toBe(1);
  });
});
