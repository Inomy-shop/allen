import { describe, expect, it } from 'vitest';
import { AllenEngine } from './engine.js';
import type { BuiltInFunction, WorkflowDef } from './types.js';

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

  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>[]) {
    const row = this.rows.find(item => matches(item, filter));
    if (!row) return null;
    for (const stage of update) {
      const set = stage.$set as Record<string, any> | undefined;
      for (const [key, value] of Object.entries(set ?? {})) {
        if (value && typeof value === 'object' && '$literal' in value) row[key] = value.$literal;
        else if (key === 'revision') row[key] = Number(row[key] ?? 0) + 1;
        else if (key === 'runGeneration') row[key] = value && typeof value === 'object' && '$add' in value
          ? Number(row[key] ?? 1) + 1
          : Number(row[key] ?? 1);
        else if (value === '$$NOW') row[key] = new Date();
      }
      const unset = stage.$unset;
      for (const key of Array.isArray(unset) ? unset : typeof unset === 'string' ? [unset] : []) delete row[key];
    }
    return row;
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
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$and') return (value as Record<string, unknown>[]).every(item => matches(row, item));
    if (key === '$or') return (value as Record<string, unknown>[]).some(item => matches(row, item));
    if (value && typeof value === 'object' && '$exists' in value) return (row[key] !== undefined) === Boolean((value as any).$exists);
    if (value && typeof value === 'object' && '$nin' in value) return !(value as any).$nin.includes(row[key]);
    return row[key] === value;
  });
}

describe('AllenEngine human approval handoff', () => {
  it('hands the latest scoped approval decision to a downstream mutation node', async () => {
    const db = new MemoryDb();
    let mutationDecision: unknown;
    let resolveInputRequired!: () => void;
    const inputRequired = new Promise<void>((resolve) => {
      resolveInputRequired = resolve;
    });
    const prepare: BuiltInFunction = async () => ({ decision: 'pending_human_review' });
    const mutate: BuiltInFunction = async (_config, state) => {
      mutationDecision = state.decision;
      if (mutationDecision !== 'approve') throw new Error('human_not_approved');
      return { mutated: true };
    };
    const workflow: WorkflowDef = {
      name: 'human-approval-handoff-test',
      version: 1,
      nodes: {
        prepare: { type: 'code', function: 'prepare' },
        human_approval: {
          type: 'human',
          human: { kind: 'review', widget: 'approval_gate' },
        },
        mutate: { type: 'code', function: 'mutate' },
      },
      edges: [
        { from: 'START', to: 'prepare' },
        { from: 'prepare', to: 'human_approval' },
        { from: 'human_approval', to: 'mutate' },
        { from: 'mutate', to: 'END' },
      ],
    };
    const engine = new AllenEngine({
      db: db as unknown as any,
      agents: {},
      builtIns: { prepare, mutate },
      workflows: {},
      emitter: {
        emit: (event) => {
          if (event.event === 'input_required' && event.data.node === 'human_approval') {
            setTimeout(resolveInputRequired, 0);
          }
        },
      },
    });

    const runPromise = engine.run(workflow, {}, 0, { executionId: 'exec-human-approval-handoff' });
    await inputRequired;
    expect(engine.submitInput('exec-human-approval-handoff', 'human_approval', {
      __human_meta: { actionId: 'approve', decision: 'approve' },
    })).toBe(true);

    await expect(runPromise).resolves.toMatchObject({ mutated: true });
    expect(mutationDecision).toBe('approve');
    const execution = await db.collection('executions').findOne({ id: 'exec-human-approval-handoff' });
    expect(execution?.state).toMatchObject({
      decision: 'approve',
      human: {
        human_approval: {
          latest: { decision: 'approve' },
        },
      },
    });
  });
});

describe('AllenEngine currentNodes persistence', () => {
  it('clears currentNodes when a workflow reaches END', async () => {
    const db = new MemoryDb();
    const complete: BuiltInFunction = async () => ({ ok: true });
    const workflow: WorkflowDef = {
      name: 'terminal-current-nodes-test',
      version: 1,
      nodes: {
        finish: {
          type: 'code',
          function: 'complete',
          outputs: { ok: 'done' },
        },
      },
      edges: [
        { from: 'START', to: 'finish' },
        { from: 'finish', to: 'END' },
      ],
    };
    const engine = new AllenEngine({
      db: db as unknown as any,
      agents: {},
      builtIns: { complete },
      workflows: {},
      emitter: { emit: () => {} },
    });

    await engine.run(workflow, {}, 0, { executionId: 'exec-terminal-current-nodes' });

    const execution = await db.collection('executions').findOne({ id: 'exec-terminal-current-nodes' });
    expect(execution).toMatchObject({
      status: 'completed',
      currentNodes: [],
      completedNodes: ['finish'],
    });
  });

  it('allows a milestone-style pass edge to revisit an already-completed selector when opted in', async () => {
    const db = new MemoryDb();
    let selectRuns = 0;
    let implementRuns = 0;
    let validatorRuns = 0;
    const selectNext: BuiltInFunction = async () => {
      selectRuns += 1;
      return {
        milestone_selection_status: selectRuns < 3 ? 'pending' : 'all_complete',
      };
    };
    const implement: BuiltInFunction = async () => {
      implementRuns += 1;
      return {
        implementer_status: 'ready_for_validation',
      };
    };
    const validate: BuiltInFunction = async () => {
      validatorRuns += 1;
      return {
        milestone_validation_passed: true,
      };
    };
    const workflow: WorkflowDef = {
      name: 'allow-revisit-selector-test',
      version: 1,
      nodes: {
        select_next_milestone: { type: 'code', function: 'selectNext' },
        milestone_implementer: { type: 'code', function: 'implement' },
        milestone_validator: { type: 'code', function: 'validate' },
      },
      edges: [
        { from: 'START', to: 'select_next_milestone' },
        {
          from: 'select_next_milestone',
          to: 'milestone_implementer',
          condition: "milestone_selection_status == 'pending'",
          allow_revisit: true,
        },
        {
          from: 'select_next_milestone',
          to: 'END',
          condition: "milestone_selection_status == 'all_complete'",
        },
        {
          from: 'milestone_implementer',
          to: 'milestone_validator',
          condition: "implementer_status == 'ready_for_validation'",
          allow_revisit: true,
        },
        {
          from: 'milestone_validator',
          to: 'select_next_milestone',
          condition: 'milestone_validation_passed == true',
          allow_revisit: true,
        },
      ],
    };
    const engine = new AllenEngine({
      db: db as unknown as any,
      agents: {},
      builtIns: { selectNext, implement, validate },
      workflows: {},
      emitter: { emit: () => {} },
    });

    await engine.run(workflow, {}, 0, { executionId: 'exec-allow-revisit-selector' });

    const execution = await db.collection('executions').findOne({ id: 'exec-allow-revisit-selector' });
    expect(selectRuns).toBe(3);
    expect(implementRuns).toBe(2);
    expect(validatorRuns).toBe(2);
    expect(execution).toMatchObject({
      status: 'completed',
      currentNodes: [],
      completedNodes: [
        'select_next_milestone',
        'milestone_implementer',
        'milestone_validator',
        'select_next_milestone',
        'milestone_implementer',
        'milestone_validator',
        'select_next_milestone',
      ],
    });
  });

  it('skips stale plain edges to completed targets when allow_revisit is not set', async () => {
    const db = new MemoryDb();
    let targetRuns = 0;
    const source: BuiltInFunction = async () => ({
      stale_condition: true,
      continue_condition: true,
    });
    const target: BuiltInFunction = async () => {
      targetRuns += 1;
      return { target_done: true };
    };
    const after: BuiltInFunction = async () => ({ after_done: true });
    const workflow: WorkflowDef = {
      name: 'stale-plain-edge-skip-test',
      version: 1,
      nodes: {
        source: { type: 'code', function: 'source' },
        target: { type: 'code', function: 'target' },
        after: { type: 'code', function: 'after' },
      },
      edges: [
        { from: 'START', to: 'target' },
        { from: 'target', to: 'source' },
        { from: 'source', to: 'target', condition: 'stale_condition == true' },
        { from: 'source', to: 'after', condition: 'continue_condition == true' },
        { from: 'after', to: 'END' },
      ],
    };
    const engine = new AllenEngine({
      db: db as unknown as any,
      agents: {},
      builtIns: { source, target, after },
      workflows: {},
      emitter: { emit: () => {} },
    });

    await engine.run(workflow, {}, 0, { executionId: 'exec-stale-plain-edge-skip' });

    const execution = await db.collection('executions').findOne({ id: 'exec-stale-plain-edge-skip' });
    expect(targetRuns).toBe(1);
    expect(execution).toMatchObject({
      status: 'completed',
      completedNodes: ['target', 'source', 'after'],
    });
  });

  it('keeps retry counters, retry_context, and retry exhaustion behavior unchanged', async () => {
    const db = new MemoryDb();
    const retryingEvents: Record<string, unknown>[] = [];
    const implementRetryContexts: unknown[] = [];
    let validatorRuns = 0;
    const implement: BuiltInFunction = async (_config, state) => {
      implementRetryContexts.push(state.retry_context);
      return { implementer_status: 'ready_for_validation' };
    };
    const validate: BuiltInFunction = async () => {
      validatorRuns += 1;
      return {
        validation_passed: false,
        failure: `failure-${validatorRuns}`,
      };
    };
    const escalation: BuiltInFunction = async () => ({ escalated: true });
    const workflow: WorkflowDef = {
      name: 'retry-behavior-unchanged-test',
      version: 1,
      nodes: {
        implement: { type: 'code', function: 'implement' },
        validate: { type: 'code', function: 'validate' },
        escalation: { type: 'code', function: 'escalation' },
      },
      edges: [
        { from: 'START', to: 'implement' },
        {
          from: 'implement',
          to: 'validate',
          condition: "implementer_status == 'ready_for_validation'",
        },
        {
          from: 'validate',
          to: 'implement',
          condition: 'validation_passed != true',
          max_retries: 2,
          retry_context: 'Retry because {{failure}}',
        },
        {
          from: 'validate',
          to: 'escalation',
          condition: "validation_passed != true AND __retry_exhausted_from == 'validate'",
        },
        { from: 'escalation', to: 'END' },
      ],
    };
    const engine = new AllenEngine({
      db: db as unknown as any,
      agents: {},
      builtIns: { implement, validate, escalation },
      workflows: {},
      emitter: {
        emit: (event) => {
          if (event.event === 'node_retrying') retryingEvents.push(event.data);
        },
      },
    });

    await engine.run(workflow, {}, 0, { executionId: 'exec-retry-unchanged' });

    const execution = await db.collection('executions').findOne({ id: 'exec-retry-unchanged' });
    expect(validatorRuns).toBe(3);
    expect(implementRetryContexts).toEqual([
      undefined,
      'Retry because failure-1',
      'Retry because failure-2',
    ]);
    expect(retryingEvents).toHaveLength(2);
    expect(execution).toMatchObject({
      status: 'completed',
      retryCounts: { 'validate→implement': 2 },
      state: {
        __retry_exhausted_from: 'validate',
        escalated: true,
      },
      completedNodes: ['implement', 'implement', 'implement', 'validate', 'escalation'],
    });
    expect((execution?.state as Record<string, unknown>).retry_context).toBeUndefined();
  });
});
