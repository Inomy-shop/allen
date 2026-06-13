import { vi } from 'vitest';
import type { Db } from 'mongodb';

/**
 * C10: shared in-memory Mongo mocks for service tests.
 *
 * Unifies the `makeCollection`/`makeDb`/`matchesFilter` helpers that were
 * previously duplicated between repo-context-setup.service.test.ts and
 * repo-mandatory-context.service.test.ts.
 *
 * Supported behavior (union of both originals, plus $push):
 * - filters: equality (with ObjectId-like normalization), $in, $nin, $ne,
 *   and dot-notation paths
 * - updates: $set (incl. dot-notation paths), $unset (deletes the field,
 *   incl. dot-notation paths), $push (appends to a possibly missing array,
 *   incl. dot-notation paths), $setOnInsert on upsert
 * - updateOne upserts only when `{ upsert: true }` is passed in options
 *   (matching the real driver signature)
 * - bulkWrite with updateOne/updateMany ops
 */

/** Normalize ObjectId-like objects (BSON ObjectId or mock) to their hex string. */
function toComparable(val: unknown): unknown {
  if (val && typeof val === 'object') {
    if ('toHexString' in (val as Record<string, unknown>)) {
      return (val as { toHexString(): string }).toHexString();
    }
    if (typeof (val as { toString?: unknown }).toString === 'function') {
      const s = String(val);
      // Only coerce if it looks like an ObjectId hex (24 hex chars)
      if (/^[0-9a-f]{24}$/i.test(s)) return s;
    }
  }
  return val;
}

function getPath(doc: Record<string, unknown>, path: string): unknown {
  let current: unknown = doc;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let obj: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) {
      obj[parts[i]] = {};
    }
    obj = obj[parts[i]] as Record<string, unknown>;
  }
  obj[parts[parts.length - 1]] = value;
}

export function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown> = {}): boolean {
  for (const [key, val] of Object.entries(filter)) {
    // Top-level operators ($or, $and, …) are not supported by this mock — ignore.
    if (key.startsWith('$')) continue;
    const docVal = key.includes('.') ? getPath(doc, key) : doc[key];
    if (val && typeof val === 'object' && '$in' in (val as Record<string, unknown>)) {
      const arr = (val as { $in: unknown[] }).$in;
      if (!arr.map(toComparable).includes(toComparable(docVal))) return false;
    } else if (val && typeof val === 'object' && '$nin' in (val as Record<string, unknown>)) {
      const arr = (val as { $nin: unknown[] }).$nin;
      if (arr.map(toComparable).includes(toComparable(docVal))) return false;
    } else if (val && typeof val === 'object' && '$ne' in (val as Record<string, unknown>)) {
      // Support $ne operator (used by notDeletedFilter: { isDeleted: { $ne: true } })
      if (toComparable(docVal) === toComparable((val as Record<string, unknown>).$ne)) return false;
    } else {
      // Compare with ObjectId normalization so `new ObjectId(hex)` matches `{ toString: () => hex }`
      if (toComparable(docVal) !== toComparable(val)) return false;
    }
  }
  return true;
}

function unsetPath(doc: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let obj: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) return;
    obj = obj[parts[i]] as Record<string, unknown>;
  }
  delete obj[parts[parts.length - 1]];
}

/** Apply $set (dot-notation aware), $unset (field delete), and $push (array append) to a doc in place. */
function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  const $set = (update.$set ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries($set)) {
    setPath(doc, key, value);
  }
  const $unset = (update.$unset ?? {}) as Record<string, unknown>;
  for (const key of Object.keys($unset)) {
    unsetPath(doc, key);
  }
  const $push = (update.$push ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries($push)) {
    const existing = getPath(doc, key);
    const arr = Array.isArray(existing) ? existing : [];
    arr.push(value);
    setPath(doc, key, arr);
  }
}

export function makeCollection(docs: Record<string, unknown>[] = []) {
  const store: Record<string, unknown>[] = [...docs];
  return {
    _store: store,
    findOne: vi.fn(async (filter: Record<string, unknown> = {}) => {
      return store.find((d) => matchesFilter(d, filter)) ?? null;
    }),
    find: vi.fn((filter: Record<string, unknown> = {}) => ({
      toArray: async () => store.filter((d) => matchesFilter(d, filter)),
      sort: function () { return this; },
      limit: function () { return this; },
    })),
    insertOne: vi.fn(async (doc: Record<string, unknown>) => {
      store.push(doc);
      return { insertedId: doc._id ?? doc.setupRunId ?? doc.mappingId ?? doc.proposalId };
    }),
    updateOne: vi.fn(async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: { upsert?: boolean },
    ) => {
      const idx = store.findIndex((d) => matchesFilter(d, filter));
      if (idx >= 0) {
        applyUpdate(store[idx], update);
        return { modifiedCount: 1, upsertedCount: 0 };
      }
      if (options?.upsert) {
        const newDoc: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(filter)) {
          // Seed only plain equality filter fields into the upserted doc
          if (!key.startsWith('$') && (value === null || typeof value !== 'object')) {
            setPath(newDoc, key, value);
          }
        }
        applyUpdate(newDoc, update);
        const $setOnInsert = (update.$setOnInsert ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries($setOnInsert)) {
          setPath(newDoc, key, value);
        }
        store.push(newDoc);
        return { modifiedCount: 0, upsertedCount: 1 };
      }
      return { modifiedCount: 0, upsertedCount: 0 };
    }),
    updateMany: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      let count = 0;
      for (const doc of store) {
        if (matchesFilter(doc, filter)) {
          applyUpdate(doc, update);
          count++;
        }
      }
      return { modifiedCount: count };
    }),
    findOneAndUpdate: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const idx = store.findIndex((d) => matchesFilter(d, filter));
      if (idx >= 0) {
        applyUpdate(store[idx], update);
        return store[idx];
      }
      return null;
    }),
    deleteMany: vi.fn(async (filter: Record<string, unknown> = {}) => {
      let count = 0;
      for (let i = store.length - 1; i >= 0; i--) {
        if (matchesFilter(store[i], filter)) {
          store.splice(i, 1);
          count++;
        }
      }
      return { deletedCount: count };
    }),
    countDocuments: vi.fn(async (filter: Record<string, unknown> = {}) => {
      return store.filter((d) => matchesFilter(d, filter)).length;
    }),
    bulkWrite: vi.fn(async (ops: Array<Record<string, unknown>>) => {
      let modifiedCount = 0;
      for (const op of ops) {
        if (op.updateOne) {
          const { filter, update } = op.updateOne as { filter: Record<string, unknown>; update: Record<string, unknown> };
          const idx = store.findIndex((d) => matchesFilter(d, filter));
          if (idx >= 0) {
            applyUpdate(store[idx], update);
            modifiedCount++;
          }
        } else if (op.updateMany) {
          const { filter, update } = op.updateMany as { filter: Record<string, unknown>; update: Record<string, unknown> };
          for (const doc of store) {
            if (matchesFilter(doc, filter)) {
              applyUpdate(doc, update);
              modifiedCount++;
            }
          }
        }
      }
      return { modifiedCount };
    }),
  };
}

export type MockCollection = ReturnType<typeof makeCollection>;

export function makeDb(collections: Record<string, MockCollection> = {}): Db {
  return {
    collection: (name: string) => collections[name] ?? makeCollection(),
    admin: () => ({ command: async () => ({ setName: null, ismaster: false }) }),
    client: {
      startSession: () => ({
        withTransaction: async (fn: () => Promise<void>) => fn(),
        endSession: async () => {},
      }),
    },
  } as unknown as Db;
}
