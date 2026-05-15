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
});
