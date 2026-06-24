import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRegistryService, type ModelRegistryEntry, type ModelRegistryInput, LEGACY_ALIAS_LOOKUP_MAP } from '../model-registry.service.js';
import { ObjectId } from 'mongodb';

function makeMockDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const store: Record<string, Record<string, unknown>[]> = {
    model_registry: [],
    ...seed,
  };

  /** Resolve a dotted path (e.g. 'agentOverrides.model') on an object.
   *  Supports array traversal: for nested paths through arrays, returns the
   *  value from the first matching element (mimics MongoDB's array-field
   *  query matching for `{ 'arrayField.nested': value }`). */
  function resolvePath(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce((acc: unknown, part: string) => {
      if (acc === null || acc === undefined) return undefined;
      if (Array.isArray(acc)) {
        const results = acc
          .filter((item) => item && typeof item === 'object')
          .map((item) => (item as Record<string, unknown>)[part])
          .filter((v) => v !== undefined);
        return results.length > 0 ? results[0] : undefined;
      }
      if (acc && typeof acc === 'object' && !Array.isArray(acc)) return (acc as Record<string, unknown>)[part];
      return undefined;
    }, obj);
  }

  /** Set a dotted path on an object in-place (mimics MongoDB $set with dot
   *  notation). When the path traverses an array, updates the first element
   *  only — mirrors the positional `$` operator used in production migration
   *  code (which sets on the matched array element). */
  function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur === null || cur === undefined) return;
      if (Array.isArray(cur)) {
        // Migrate through the first array element (positional `$` semantics)
        if (cur.length > 0 && cur[0] && typeof cur[0] === 'object') {
          cur = (cur[0] as Record<string, unknown>)[parts[i]];
          continue;
        }
        return;
      }
      if (!(cur as Record<string, unknown>)[parts[i]] || typeof (cur as Record<string, unknown>)[parts[i]] !== 'object') {
        (cur as Record<string, unknown>)[parts[i]] = {} as Record<string, unknown>;
      }
      cur = (cur as Record<string, unknown>)[parts[i]];
    }
    if (cur !== null && cur !== undefined && typeof cur === 'object') {
      (cur as Record<string, unknown>)[parts[parts.length - 1]] = value;
    }
  }

  function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
    return Object.entries(query).every(([key, value]) => {
      if (key === '_id' && value instanceof ObjectId) {
        return (doc._id as ObjectId).equals(value);
      }
      return resolvePath(doc, key) === value;
    });
  }

  let insertIndex = 0;

  // Cache collection objects so callers can patch methods on them
  const collectionCache = new Map<string, Record<string, any>>();

  function buildCollection(name: string) {
    const collection = {
      find: (query: Record<string, unknown> = {}) => {
        let results = store[name] ?? [];
        for (const [key, value] of Object.entries(query)) {
          results = results.filter((doc) => resolvePath(doc, key) === value || resolvePath(doc, key)?.toString?.() === String(value));
        }
        const cursor = {
          sort: () => cursor,
          project: () => cursor,
          toArray: async () => [...results],
        };
        return cursor;
      },
      findOne: async (query: Record<string, unknown>) => {
        return (store[name] ?? []).find((doc) => matches(doc, query)) ?? null;
      },
      findOneAndUpdate: async (
        query: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: { returnDocument?: string },
      ) => {
        const idx = (store[name] ?? []).findIndex((doc) => matches(doc, query));
        if (idx === -1) return null;
        const $set = (update as any).$set ?? {};
        store[name][idx] = { ...store[name][idx], ...$set };
        return options?.returnDocument === 'after' ? store[name][idx] : null;
      },
      insertOne: async (doc: Record<string, unknown>) => {
        // Simulate the unique index on (provider, fullId)
        const existing = (store[name] ?? []).find(
          (d) => d.provider === doc.provider && d.fullId === doc.fullId,
        );
        if (existing) {
          const err = new Error('E11000 duplicate key error') as any;
          err.code = 11000;
          throw err;
        }
        (store[name] = store[name] ?? []).push({ ...doc });
        insertIndex++;
        return { insertedId: doc._id ?? `${name}-${insertIndex}` };
      },
      insertMany: async (docs: Record<string, unknown>[]) => {
        (store[name] = store[name] ?? []).push(...docs);
      },
      countDocuments: async () => store[name]?.length ?? 0,
      updateOne: async (
        query: Record<string, unknown>,
        update: Record<string, unknown>,
      ) => {
        const doc = (store[name] ?? []).find((d) => matches(d, query));
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        const $set = (update as any).$set ?? {};
        const $unset = (update as any).$unset ?? {};
        for (const [setKey, setVal] of Object.entries($set)) {
          setPath(doc as Record<string, unknown>, setKey, setVal);
        }
        for (const key of Object.keys($unset)) delete doc[key];
        return { matchedCount: 1, modifiedCount: 1 };
      },
      deleteOne: async (query: Record<string, unknown>) => {
        const idx = (store[name] ?? []).findIndex((d) => matches(d, query));
        if (idx === -1) return { deletedCount: 0 };
        store[name].splice(idx, 1);
        return { deletedCount: 1 };
      },
      updateMany: async (
        query: Record<string, unknown>,
        update: Record<string, unknown>,
      ) => {
        let modifiedCount = 0;
        const $set = (update as any).$set ?? {};
        const $unset = (update as any).$unset ?? {};
        for (const doc of store[name] ?? []) {
          const hit = Object.entries(query).every(([key, value]) =>
            value && typeof value === 'object' && '$exists' in (value as object)
              ? resolvePath(doc, key) !== undefined === (value as { $exists: boolean }).$exists
              : resolvePath(doc, key) === value,
          );
          if (!hit) continue;
          for (const [setKey, setVal] of Object.entries($set)) {
            setPath(doc as Record<string, unknown>, setKey, setVal);
          }
          for (const key of Object.keys($unset)) {
            // Unset only top-level keys for simplicity
            if (key in doc) { delete doc[key]; modifiedCount++; }
          }
          if (Object.keys($set).length > 0) modifiedCount++;
        }
        return { modifiedCount };
      },
    };
    collectionCache.set(name, collection);
    return collection;
  }

  return {
    store,
    collection: (name: string) => {
      const existing = collectionCache.get(name);
      if (existing) return existing;
      return buildCollection(name);
    },
  };
}

describe('ModelRegistryService', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let service: ModelRegistryService;

  beforeEach(() => {
    mockDb = makeMockDb();
    service = new ModelRegistryService(mockDb as any);
  });

  // ── AC-001: syncSeedModels (boot-time seed sync) ──

  describe('syncSeedModels (AC-001)', () => {
    it('seeds all models into an empty collection with seededWith snapshots', async () => {
      const result = await service.syncSeedModels();
      expect(result.inserted).toBe(35);
      expect(result.refreshed).toBe(0);
      const all = await service.list({ includeInactive: true });
      expect(all).toHaveLength(35);
      expect(all.every((m) => (m as any).seededWith)).toBe(true);
    });

    it('is idempotent — a second boot changes nothing', async () => {
      await service.syncSeedModels();
      const second = await service.syncSeedModels();
      expect(second).toEqual({ inserted: 0, refreshed: 0, preserved: 0 });
      expect(mockDb.store.model_registry).toHaveLength(35);
    });

    it('refreshes untouched rows when the seed catalog prices change', async () => {
      await service.syncSeedModels();
      // Simulate a row seeded by an OLDER catalog: stale price, matching snapshot
      const opus = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-opus-4-7') as any;
      opus.costInputPerMTok = 15;
      opus.costOutputPerMTok = 75;
      opus.seededWith = { ...opus.seededWith, costInputPerMTok: 15, costOutputPerMTok: 75 };

      const result = await service.syncSeedModels();
      expect(result.refreshed).toBe(1);
      expect(opus.costInputPerMTok).toBe(5);
      expect(opus.costOutputPerMTok).toBe(25);
    });

    it('preserves rows an admin has customized', async () => {
      await service.syncSeedModels();
      const sonnet = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-sonnet-4-6') as any;
      sonnet.costInputPerMTok = 99; // admin edit — diverges from seededWith

      const result = await service.syncSeedModels();
      expect(result.preserved).toBe(1);
      expect(sonnet.costInputPerMTok).toBe(99);
    });

    it('adopts active legacy rows without a snapshot (refreshes to current catalog)', async () => {
      mockDb.store.model_registry.push({
        _id: new ObjectId(),
        provider: 'claude',
        fullId: 'claude-opus-4-7',
        costInputPerMTok: 15,
        costOutputPerMTok: 75,
        costPerTurn: 0.15, // legacy field — must also be scrubbed
        isActive: true,
        sortOrder: 1,
      });
      const result = await service.syncSeedModels();
      const opus = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-opus-4-7') as any;
      expect(result.refreshed).toBe(1);
      expect(result.inserted).toBe(34); // the other 34 seed rows
      expect(opus.costInputPerMTok).toBe(5);
      expect('costPerTurn' in opus).toBe(false);
      expect(opus.seededWith).toBeTruthy();
    });

    it('never resurrects a legacy row an admin deactivated', async () => {
      mockDb.store.model_registry.push({
        _id: new ObjectId(),
        provider: 'kimi',
        fullId: 'kimi-k2.5',
        isActive: false,
        sortOrder: 1,
      });
      const result = await service.syncSeedModels();
      const row = mockDb.store.model_registry.find((m: any) => m.fullId === 'kimi-k2.5') as any;
      expect(result.preserved).toBe(1);
      expect(row.isActive).toBe(false);
      // Marked customized-as-is so future boots keep preserving it
      expect(row.seededWith.isActive).toBe(false);
    });

    it('leaves admin-created models that are not in the seed catalog untouched', async () => {
      await service.syncSeedModels();
      const custom = await service.create({
        provider: 'claude',
        fullId: 'claude-custom-1',
        displayName: 'My Custom',
        providerDisplayName: 'Claude',
        sortOrder: 99,
      });
      const result = await service.syncSeedModels();
      expect(result).toEqual({ inserted: 0, refreshed: 0, preserved: 0 });
      const row = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-custom-1') as any;
      expect(row.fullId).toBe('claude-custom-1');
      expect(String(row._id)).toBe(String(custom._id));
    });

    it('refreshes legacy rows with empty seededWith and null displayName to current catalog values', async () => {
      // Simulate a broken legacy row: seededWith={}, displayName=null,
      // providerDisplayName=null, but still active.
      mockDb.store.model_registry.push({
        _id: new ObjectId(),
        provider: 'claude',
        fullId: 'claude-opus-4-7',
        displayName: null,
        providerDisplayName: null,
        costInputPerMTok: 15,
        costOutputPerMTok: 75,
        isActive: true,
        sortOrder: 1,
        seededWith: {},
      });
      const result = await service.syncSeedModels();
      const opus = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-opus-4-7') as any;
      expect(result.refreshed).toBe(1);
      // displayName and providerDisplayName should be refreshed from seed
      expect(opus.displayName).toBe('Opus 4.7');
      expect(opus.providerDisplayName).toBe('Claude');
      // Cost fields should be refreshed from seed too
      expect(opus.costInputPerMTok).toBe(5);
      expect(opus.costOutputPerMTok).toBe(25);
      // seededWith should be replaced with a complete snapshot
      expect(opus.seededWith).not.toEqual({});
      expect(opus.seededWith.displayName).toBe('Opus 4.7');
      expect(opus.seededWith.providerDisplayName).toBe('Claude');
    });

    it('refreshes legacy rows with null displayName to seed values', async () => {
      mockDb.store.model_registry.push({
        _id: new ObjectId(),
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: null,
        providerDisplayName: 'Claude',
        isActive: true,
        sortOrder: 1,
        seededWith: {},
      });
      const result = await service.syncSeedModels();
      const sonnet = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-sonnet-4-6') as any;
      expect(result.refreshed).toBe(1);
      expect(sonnet.displayName).toBe('Sonnet 4.6');
      expect(sonnet.providerDisplayName).toBe('Claude');
    });

    it('refreshes legacy rows with blank providerDisplayName to current catalog values', async () => {
      // Simulate a row where providerDisplayName is whitespace-only, which
      // the sync code treats as broken (providerDisplayNameBroken path).
      mockDb.store.model_registry.push({
        _id: new ObjectId(),
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        providerDisplayName: '   ',
        isActive: true,
        sortOrder: 1,
        seededWith: {},
      });
      const result = await service.syncSeedModels();
      const sonnet = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-sonnet-4-6') as any;
      expect(result.refreshed).toBe(1);
      // providerDisplayName should be refreshed from seed
      expect(sonnet.providerDisplayName).toBe('Claude');
      expect(sonnet.displayName).toBe('Sonnet 4.6');
      // seededWith should be replaced with a complete snapshot
      expect(sonnet.seededWith.providerDisplayName).toBe('Claude');
    });

    it('refreshes claude-cli legacy rows to canonical claude provider after rename + sync', async () => {
      const { runProviderRenameMigration } = await import('../model-registry.service.js');
      // Simulate a legacy row under the old provider id (claude-cli) with
      // broken displayName and empty seededWith — as found in the wild.
      mockDb.store.model_registry.push({
        _id: new ObjectId(),
        provider: 'claude-cli',
        fullId: 'claude-opus-4-7',
        displayName: null,
        providerDisplayName: null,
        isActive: true,
        sortOrder: 1,
        seededWith: {},
      });
      // Step 1: provider rename migration runs first (boot order)
      const rename = await runProviderRenameMigration(mockDb as any);
      expect(rename.registryUpdated).toBe(1);
      // Step 2: sync seed models
      const result = await service.syncSeedModels();
      const opus = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-opus-4-7') as any;
      // The row should be refreshed with canonical claude provider and seed data
      expect(opus.provider).toBe('claude');
      expect(opus.displayName).toBe('Opus 4.7');
      expect(opus.providerDisplayName).toBe('Claude');
      expect(result.refreshed).toBe(1);
      // seededWith should be complete
      expect(opus.seededWith.displayName).toBe('Opus 4.7');
      expect(opus.seededWith.providerDisplayName).toBe('Claude');
    });

    it('syncSeedModels canonicalizes claude-cli legacy rows directly without prior migration', async () => {
      // Simulate a legacy row under the old provider id with broken labels
      // and empty seededWith — no canonical claude row exists yet.
      mockDb.store.model_registry.push({
        _id: new ObjectId(),
        provider: 'claude-cli',
        fullId: 'claude-sonnet-4-6',
        displayName: null,
        providerDisplayName: null,
        isActive: true,
        sortOrder: 1,
        seededWith: {},
      });
      const result = await service.syncSeedModels();
      const sonnet = mockDb.store.model_registry.find((m: any) => m.fullId === 'claude-sonnet-4-6') as any;
      // Provider canonicalized, display labels refreshed from seed
      expect(sonnet.provider).toBe('claude');
      expect(sonnet.displayName).toBe('Sonnet 4.6');
      expect(sonnet.providerDisplayName).toBe('Claude');
      expect(result.refreshed).toBe(1);
      expect(sonnet.seededWith.displayName).toBe('Sonnet 4.6');
      expect(sonnet.seededWith.providerDisplayName).toBe('Claude');
    });

    it('syncSeedModels drops claude-cli legacy row when canonical claude row already exists (conflict)', async () => {
      // Both a claude-cli legacy row AND a canonical claude row exist for
      // the same fullId — the legacy duplicate must be dropped and the
      // canonical row's data preserved without corruption.
      mockDb.store.model_registry.push(
        {
          _id: new ObjectId(),
          provider: 'claude-cli',
          fullId: 'claude-sonnet-4-6',
          displayName: null,
          providerDisplayName: null,
          isActive: true,
          sortOrder: 1,
          seededWith: {},
        },
        {
          _id: new ObjectId(),
          provider: 'claude',
          fullId: 'claude-sonnet-4-6',
          displayName: 'Sonnet 4.6',
          providerDisplayName: 'Claude',
          isActive: true,
          sortOrder: 5,
          seededWith: { displayName: 'Sonnet 4.6', providerDisplayName: 'Claude', fullId: 'claude-sonnet-4-6', tier: null, costInputPerMTok: null, costOutputPerMTok: null, costCacheReadPerMTok: null, isActive: true },
        },
      );
      const result = await service.syncSeedModels();
      // The claude-cli row should have been dropped; only the canonical
      // claude row should remain with correct data.
      const rows = mockDb.store.model_registry
        .filter((m: any) => m.fullId === 'claude-sonnet-4-6');
      expect(rows).toHaveLength(1);
      expect(rows[0].provider).toBe('claude');
      expect(rows[0].displayName).toBe('Sonnet 4.6');
      expect(rows[0].sortOrder).toBeGreaterThanOrEqual(1);
    });

    it('seed data includes models from seeded providers only; OpenRouter is manual-only', async () => {
      await service.syncSeedModels();
      const all = await service.list({ includeInactive: true });
      expect(all.filter((m) => m.provider === 'claude')).toHaveLength(5);
      expect(all.filter((m) => m.provider === 'codex')).toHaveLength(10);
      expect(all.filter((m) => m.provider === 'deepseek')).toHaveLength(2);
      expect(all.filter((m) => m.provider === 'xiaomi-mimo')).toHaveLength(1);
      expect(all.filter((m) => m.provider === 'kimi')).toHaveLength(2);
      expect(all.filter((m) => m.provider === 'zai')).toHaveLength(15);
      expect(all.filter((m) => m.provider === 'openrouter')).toHaveLength(0);
    });

    // ── REQ-005 / R1, R5, R6: Z.AI seed models ──

    describe('Z.AI seed models (R1, R5, R6)', () => {
      it('all 15 ZAI fullIds are present with provider zai and providerDisplayName GLM/Z.AI', async () => {
        await service.syncSeedModels();
        const zaiModels = await service.list({ provider: 'zai', includeInactive: true });
        expect(zaiModels).toHaveLength(15);
        const fullIds = zaiModels.map((m) => m.fullId);
        expect(fullIds).toContain('glm-5.2[1m]');
        expect(fullIds).toContain('glm-5.2');
        expect(fullIds).toContain('glm-5.1');
        expect(fullIds).toContain('glm-5');
        expect(fullIds).toContain('glm-5-turbo');
        expect(fullIds).toContain('glm-4.7');
        expect(fullIds).toContain('glm-4.7-flashx');
        expect(fullIds).toContain('glm-4.7-flash');
        expect(fullIds).toContain('glm-4.6');
        expect(fullIds).toContain('glm-4.5');
        expect(fullIds).toContain('glm-4.5-x');
        expect(fullIds).toContain('glm-4.5-air');
        expect(fullIds).toContain('glm-4.5-airx');
        expect(fullIds).toContain('glm-4.5-flash');
        expect(fullIds).toContain('glm-4-32b-0414-128k');
        expect(zaiModels.every((m) => m.provider === 'zai')).toBe(true);
        expect(zaiModels.every((m) => m.providerDisplayName === 'GLM/Z.AI')).toBe(true);
      });

      it('glm-5.2[1m] has correct costs and tier default', async () => {
        await service.syncSeedModels();
        const all = await service.list({ includeInactive: true });
        const m = all.find((x) => x.fullId === 'glm-5.2[1m]')!;
        expect(m.costInputPerMTok).toBe(1.40);
        expect(m.costCacheReadPerMTok).toBe(0.26);
        expect(m.costOutputPerMTok).toBe(4.40);
        expect(m.tier).toBe('default');
      });

      it('glm-4.7 has correct costs and tier flash', async () => {
        await service.syncSeedModels();
        const all = await service.list({ includeInactive: true });
        const m = all.find((x) => x.fullId === 'glm-4.7')!;
        expect(m.costInputPerMTok).toBe(0.60);
        expect(m.costOutputPerMTok).toBe(2.20);
        expect(m.tier).toBe('flash');
      });

      it('glm-4.7-flash and glm-4.5-flash have all zero costs', async () => {
        await service.syncSeedModels();
        const all = await service.list({ includeInactive: true });
        for (const id of ['glm-4.7-flash', 'glm-4.5-flash']) {
          const m = all.find((x) => x.fullId === id)!;
          expect(m.costInputPerMTok).toBe(0);
          expect(m.costCacheReadPerMTok).toBe(0);
          expect(m.costOutputPerMTok).toBe(0);
        }
      });

      it('glm-4-32b-0414-128k has costCacheReadPerMTok null (unavailable — R6)', async () => {
        await service.syncSeedModels();
        const all = await service.list({ includeInactive: true });
        const m = all.find((x) => x.fullId === 'glm-4-32b-0414-128k')!;
        expect(m.costInputPerMTok).toBe(0.10);
        expect(m.costCacheReadPerMTok).toBeNull();
        expect(m.costOutputPerMTok).toBe(0.10);
      });

      it('re-running syncSeedModels keeps registry count at 35 (idempotent)', async () => {
        await service.syncSeedModels();
        const second = await service.syncSeedModels();
        expect(second).toEqual({ inserted: 0, refreshed: 0, preserved: 0 });
        const all = await service.list({ includeInactive: true });
        expect(all).toHaveLength(35);
      });
    });
  });

  // ── REQ-008: create validation ──

  describe('create validation (REQ-008)', () => {
    const validInput: ModelRegistryInput = {
      provider: 'codex',
      fullId: 'gpt-5.5',
      displayName: 'GPT 5.5',
      providerDisplayName: 'Codex',
      costInputPerMTok: 1.50,
      costOutputPerMTok: 7.50,
      costCacheReadPerMTok: null,
      tier: 'default',
      sortOrder: 1,
    };

    it('accepts known provider: claude-cli', async () => {
      const model = await service.create({ ...validInput, provider: 'claude', fullId: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', providerDisplayName: 'Claude' });
      expect(model.provider).toBe('claude');
    });

    it('accepts known provider: codex', async () => {
      const model = await service.create({ ...validInput, provider: 'codex' });
      expect(model.provider).toBe('codex');
    });

    it('accepts known provider: deepseek', async () => {
      const model = await service.create({ ...validInput, provider: 'deepseek', fullId: 'deepseek-v4', displayName: 'DeepSeek V4', providerDisplayName: 'DeepSeek' });
      expect(model.provider).toBe('deepseek');
    });

    it('accepts known provider: xiaomi-mimo', async () => {
      const model = await service.create({ ...validInput, provider: 'xiaomi-mimo', fullId: 'mimo', displayName: 'MiMo', providerDisplayName: 'Xiaomi MiMo' });
      expect(model.provider).toBe('xiaomi-mimo');
    });

    it('accepts known provider: kimi', async () => {
      const model = await service.create({ ...validInput, provider: 'kimi', fullId: 'kimi', displayName: 'Kimi', providerDisplayName: 'Kimi' });
      expect(model.provider).toBe('kimi');
    });

    it('accepts known provider: openrouter', async () => {
      const model = await service.create({ ...validInput, provider: 'openrouter', fullId: 'openrouter/custom-model', displayName: 'Custom OpenRouter Model', providerDisplayName: 'OpenRouter' });
      expect(model.provider).toBe('openrouter');
    });

    it('rejects unknown provider', async () => {
      await expect(service.create({ ...validInput, provider: 'unknown-provider' })).rejects.toThrow('UNKNOWN_PROVIDER');
    });

    it('validates displayName is non-empty string', async () => {
      await expect(service.create({ ...validInput, displayName: '' })).rejects.toThrow('DISPLAY_NAME_REQUIRED');
    });

    it('validates providerDisplayName is non-empty string', async () => {
      await expect(service.create({ ...validInput, providerDisplayName: '' })).rejects.toThrow('PROVIDER_DISPLAY_NAME_REQUIRED');
    });

    it('validates costInputPerMTok is null or >= 0', async () => {
      await expect(service.create({ ...validInput, costInputPerMTok: -0.01 })).rejects.toThrow('INVALID_COSTINPUTPERMTOK');
      const model = await service.create({ ...validInput, costInputPerMTok: 0 });
      expect(model.costInputPerMTok).toBe(0);
    });

    it('validates costOutputPerMTok >= 0', async () => {
      await expect(service.create({ ...validInput, costOutputPerMTok: -5 })).rejects.toThrow('INVALID_COSTOUTPUTPERMTOK');
    });

    it('validates costCacheReadPerMTok >= 0', async () => {
      await expect(service.create({ ...validInput, costCacheReadPerMTok: -0.5 })).rejects.toThrow('INVALID_COSTCACHEREADPERMTOK');
    });

    it('validates tier is null, default, opus, or flash', async () => {
      await expect(service.create({ ...validInput, tier: 'invalid-tier' as any })).rejects.toThrow('INVALID_TIER');
      const modelDefault = await service.create({ ...validInput, fullId: 'test-a', displayName: 'Test A', providerDisplayName: 'Codex', tier: 'default' });
      expect(modelDefault.tier).toBe('default');
      const modelOpus = await service.create({ ...validInput, fullId: 'test-b', displayName: 'Test B', providerDisplayName: 'Codex', tier: 'opus' });
      expect(modelOpus.tier).toBe('opus');
      const modelFlash = await service.create({ ...validInput, fullId: 'test-c', displayName: 'Test C', providerDisplayName: 'Codex', tier: 'flash' });
      expect(modelFlash.tier).toBe('flash');
      const modelNull = await service.create({ ...validInput, fullId: 'test-d', displayName: 'Test D', providerDisplayName: 'Codex', tier: null });
      expect(modelNull.tier).toBeNull();
    });

    it('validates fullId is required', async () => {
      await expect(service.create({ ...validInput, fullId: '' })).rejects.toThrow('FULL_ID_REQUIRED');
    });
  });

  // ── REQ-001: duplicate rejection ──

  describe('duplicate detection (REQ-001)', () => {
    it('rejects duplicate (provider, fullId) with DUPLICATE_PROVIDER_FULL_ID', async () => {
      // First insert should succeed
      await service.create({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT 5.5',
        providerDisplayName: 'Codex',
      });

      // Second insert with same (provider, fullId) should throw DUPLICATE_PROVIDER_FULL_ID
      await expect(service.create({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT 5.5',
        providerDisplayName: 'Codex',
      })).rejects.toThrow('DUPLICATE_PROVIDER_FULL_ID');
    });
  });

  // ── AC-006 / REQ-009: softDelete ──

  describe('softDelete (AC-006 / REQ-009)', () => {
    it('sets isActive=false on soft delete', async () => {
      const model = await service.create({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT 5.5',
        providerDisplayName: 'Codex',
      });
      const deleted = await service.softDelete(String(model._id));
      expect(deleted).not.toBeNull();
      expect(deleted!.isActive).toBe(false);
    });

    it('returns null when model not found', async () => {
      const result = await service.softDelete(new ObjectId().toHexString());
      expect(result).toBeNull();
    });
  });

  // ── AC-006 / REQ-009: list ──

  describe('list (AC-006 / REQ-009)', () => {
    it('filters active only by default', async () => {
      await service.create({ provider: 'codex', fullId: 'a', displayName: 'A', providerDisplayName: 'Codex' });
      const modelB = await service.create({ provider: 'codex', fullId: 'b', displayName: 'B', providerDisplayName: 'Codex' });
      await service.softDelete(String(modelB._id));

      const active = await service.list();
      expect(active).toHaveLength(1);
      expect(active[0].fullId).toBe('a');
    });

    it('with includeInactive=true returns all including deactivated', async () => {
      await service.create({ provider: 'codex', fullId: 'a', displayName: 'A', providerDisplayName: 'Codex' });
      const modelB = await service.create({ provider: 'codex', fullId: 'b', displayName: 'B', providerDisplayName: 'Codex' });
      await service.softDelete(String(modelB._id));

      const all = await service.list({ includeInactive: true });
      expect(all).toHaveLength(2);
    });

    it('filters by provider when specified', async () => {
      await service.create({ provider: 'codex', fullId: 'a', displayName: 'A', providerDisplayName: 'Codex' });
      await service.create({ provider: 'claude', fullId: 'b', displayName: 'B', providerDisplayName: 'Claude' });

      const codexModels = await service.list({ provider: 'codex' });
      expect(codexModels).toHaveLength(1);
      expect(codexModels[0].provider).toBe('codex');
    });
  });

  // ── REQ-006: update ──

  describe('update (REQ-006)', () => {
    it('partially updates allowed fields', async () => {
      const model = await service.create({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'Old Name',
        providerDisplayName: 'Codex',
        costInputPerMTok: 1.50,
        tier: 'default',
      });

      const updated = await service.update(String(model._id), {
        displayName: 'New Name',
        costInputPerMTok: 2.50,
        tier: 'opus',
      });

      expect(updated).not.toBeNull();
      expect(updated!.displayName).toBe('New Name');
      expect(updated!.costInputPerMTok).toBe(2.50);
      expect(updated!.tier).toBe('opus');
      // Immutable fields unchanged
      expect(updated!.provider).toBe('codex');
      expect(updated!.fullId).toBe('gpt-5.5');
    });

    it('does not change provider or fullId (immutable by contract)', async () => {
      const model = await service.create({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT 5.5',
        providerDisplayName: 'Codex',
      });

      // The service implementation ignores provider/fullId in patch through
      // the code — it only copies specific fields. Verify by updating displayName.
      const updated = await service.update(String(model._id), { displayName: 'New Name' });
      expect(updated!.provider).toBe('codex');
      expect(updated!.fullId).toBe('gpt-5.5');
    });

    it('returns null when model not found', async () => {
      const result = await service.update(new ObjectId().toHexString(), { displayName: 'Nope' });
      expect(result).toBeNull();
    });
  });

  // ── LEGACY_ALIAS_LOOKUP_MAP ──

  describe('LEGACY_ALIAS_LOOKUP_MAP', () => {
    it('contains all 35 seed entries and no OpenRouter defaults', () => {
      const keys = Object.keys(LEGACY_ALIAS_LOOKUP_MAP);
      expect(keys).toHaveLength(35);
      expect(keys).toContain('fable');
      expect(keys).toContain('sonnet');
      expect(keys).toContain('opus');
      expect(keys).toContain('haiku');
      expect(keys).toContain('claude-opus-4-8');
      expect(keys).toContain('gpt-5.5');
      expect(keys).toContain('kimi-k2.5');
      expect(keys).toContain('deepseek-v4-pro[1m]');
      expect(keys).not.toContain('anthropic/claude-sonnet-4-6');
      expect(keys).not.toContain('google/gemini-2.5-pro');
    });
  });

  // ── runAliasToFullIdMigration (AC-005: idempotency) ──

  describe('runAliasToFullIdMigration', () => {
    it('is idempotent — second call returns 0 for all counts (empty DB)', async () => {
      const { runAliasToFullIdMigration } = await import('../model-registry.service.js');
      // First call on empty collections — no docs have alias values
      const first = await runAliasToFullIdMigration(mockDb as any);
      expect(first.agentsUpdated).toBe(0);
      expect(first.sessionsUpdated).toBe(0);
      expect(first.overridesUpdated).toBe(0);
      expect(first.workflowNodesUpdated).toBe(0);
      // Second call — also 0
      const second = await runAliasToFullIdMigration(mockDb as any);
      expect(second).toEqual(first);
    });

    it('migrates legacy alias values in agents collection (AC-005)', async () => {
      const { runAliasToFullIdMigration } = await import('../model-registry.service.js');
      const db = makeMockDb({
        agents: [
          { _id: new ObjectId(), model: 'sonnet', name: 'agent-a' },
          { _id: new ObjectId(), model: 'sonnet', name: 'agent-b' },
          { _id: new ObjectId(), model: 'opus', name: 'agent-c' },
          { _id: new ObjectId(), model: 'claude-sonnet-4-6', name: 'agent-d' },
        ],
      });
      const result = await runAliasToFullIdMigration(db as any);
      expect(result.agentsUpdated).toBe(3);
      expect(db.store.agents.find((a: any) => a.name === 'agent-a').model).toBe('claude-sonnet-4-6');
      expect(db.store.agents.find((a: any) => a.name === 'agent-b').model).toBe('claude-sonnet-4-6');
      expect(db.store.agents.find((a: any) => a.name === 'agent-c').model).toBe('claude-opus-4-7');
      expect(db.store.agents.find((a: any) => a.name === 'agent-d').model).toBe('claude-sonnet-4-6');
    });

    it('migrates legacy alias values in chat_sessions (model field)', async () => {
      const { runAliasToFullIdMigration } = await import('../model-registry.service.js');
      const db = makeMockDb({
        chat_sessions: [
          { _id: new ObjectId(), model: 'haiku', sessionId: 's1' },
          { _id: new ObjectId(), model: 'fable', sessionId: 's2' },
          { _id: new ObjectId(), model: 'claude-opus-4-7', sessionId: 's3' },
        ],
      });
      const result = await runAliasToFullIdMigration(db as any);
      expect(result.sessionsUpdated).toBe(2);
      expect(db.store.chat_sessions.find((s: any) => s.sessionId === 's1').model).toBe('claude-haiku-4-5-20251001');
      expect(db.store.chat_sessions.find((s: any) => s.sessionId === 's2').model).toBe('claude-fable-5');
      expect(db.store.chat_sessions.find((s: any) => s.sessionId === 's3').model).toBe('claude-opus-4-7');
    });

    it('migrates legacy alias in agentOverrides inside chat_sessions', async () => {
      const { runAliasToFullIdMigration } = await import('../model-registry.service.js');
      const db = makeMockDb({
        chat_sessions: [
          {
            _id: new ObjectId(),
            model: 'claude-sonnet-4-6',
            agentOverrides: { model: 'sonnet' },
            sessionId: 's1',
          },
          {
            _id: new ObjectId(),
            model: 'claude-sonnet-4-6',
            agentOverrides: { model: 'opus' },
            sessionId: 's2',
          },
          {
            _id: new ObjectId(),
            model: 'claude-sonnet-4-6',
            agentOverrides: { model: 'claude-opus-4-7' },
            sessionId: 's3',
          },
        ],
      });
      const result = await runAliasToFullIdMigration(db as any);
      expect(result.overridesUpdated).toBe(2);
      expect(db.store.chat_sessions.find((s: any) => s.sessionId === 's1').agentOverrides.model).toBe('claude-sonnet-4-6');
      expect(db.store.chat_sessions.find((s: any) => s.sessionId === 's2').agentOverrides.model).toBe('claude-opus-4-7');
      expect(db.store.chat_sessions.find((s: any) => s.sessionId === 's3').agentOverrides.model).toBe('claude-opus-4-7');
    });

    it('migrates legacy alias in workflow nodes.agentOverrides.model', async () => {
      const { runAliasToFullIdMigration } = await import('../model-registry.service.js');
      const db = makeMockDb({
        workflows: [
          {
            _id: new ObjectId(),
            name: 'wf-1',
            nodes: [
              { agentOverrides: { model: 'sonnet' } },
              { agentOverrides: { model: 'claude-opus-4-7' } },
            ],
          },
          {
            _id: new ObjectId(),
            name: 'wf-2',
            nodes: [
              { agentOverrides: { model: 'haiku' } },
            ],
          },
        ],
      });
      const result = await runAliasToFullIdMigration(db as any);
      expect(result.workflowNodesUpdated).toBe(2);
      expect(db.store.workflows.find((w: any) => w.name === 'wf-1').nodes[0].agentOverrides.model).toBe('claude-sonnet-4-6');
      expect(db.store.workflows.find((w: any) => w.name === 'wf-1').nodes[1].agentOverrides.model).toBe('claude-opus-4-7');
      expect(db.store.workflows.find((w: any) => w.name === 'wf-2').nodes[0].agentOverrides.model).toBe('claude-haiku-4-5-20251001');
    });

    it('second bootstrap run produces zero writes after migration (AC-005 idempotency)', async () => {
      const { runAliasToFullIdMigration } = await import('../model-registry.service.js');
      const db = makeMockDb({
        agents: [
          { _id: new ObjectId(), model: 'sonnet', name: 'agent-a' },
          { _id: new ObjectId(), model: 'opus', name: 'agent-b' },
          { _id: new ObjectId(), model: 'fable', name: 'agent-c' },
        ],
        chat_sessions: [
          { _id: new ObjectId(), model: 'haiku', sessionId: 's1' },
          { _id: new ObjectId(), model: 'sonnet', sessionId: 's2', agentOverrides: { model: 'opus' } },
        ],
        workflows: [
          {
            _id: new ObjectId(),
            name: 'wf-1',
            nodes: [{ agentOverrides: { model: 'fable' } }],
          },
        ],
      });

      // First boot migration — should update everything
      const first = await runAliasToFullIdMigration(db as any);
      expect(first.agentsUpdated).toBe(3);
      expect(first.sessionsUpdated).toBe(2);
      expect(first.overridesUpdated).toBe(1);
      expect(first.workflowNodesUpdated).toBe(1);

      // All docs now hold fullIds
      expect(db.store.agents[0].model).toBe('claude-sonnet-4-6');
      expect(db.store.agents[1].model).toBe('claude-opus-4-7');
      expect(db.store.agents[2].model).toBe('claude-fable-5');
      expect(db.store.chat_sessions[0].model).toBe('claude-haiku-4-5-20251001');
      expect(db.store.chat_sessions[1].model).toBe('claude-sonnet-4-6');
      expect(db.store.chat_sessions[1].agentOverrides.model).toBe('claude-opus-4-7');
      expect(db.store.workflows[0].nodes[0].agentOverrides.model).toBe('claude-fable-5');

      // Second boot — zero writes (AC-005: migration is idempotent)
      const second = await runAliasToFullIdMigration(db as any);
      expect(second.agentsUpdated).toBe(0);
      expect(second.sessionsUpdated).toBe(0);
      expect(second.overridesUpdated).toBe(0);
      expect(second.workflowNodesUpdated).toBe(0);
    });
  });

  describe('runProviderRenameMigration (claude-cli → claude)', () => {
    it('renames the provider across registry, agents, sessions, overrides, and workflow nodes', async () => {
      const { runProviderRenameMigration } = await import('../model-registry.service.js');
      const db = makeMockDb({
        model_registry: [
          { _id: new ObjectId(), provider: 'claude-cli', fullId: 'claude-sonnet-4-6' },
          { _id: new ObjectId(), provider: 'claude-cli', fullId: 'claude-custom-1' },
          // Already exists under the new id — the legacy duplicate must be dropped.
          { _id: new ObjectId(), provider: 'claude', fullId: 'claude-sonnet-4-6' },
        ],
        agents: [
          { name: 'a', provider: 'claude-cli', model: 'claude-sonnet-4-6' },
          { name: 'b', provider: 'codex', model: 'gpt-5.5' },
        ],
        chat_sessions: [
          { sessionId: 's1', provider: 'claude-cli' },
          { sessionId: 's2', provider: 'deepseek', agentOverrides: { provider: 'claude-cli' } },
        ],
        workflows: [
          {
            _id: new ObjectId(),
            name: 'wf-1',
            parsed: { nodes: { plan: { agentOverrides: { provider: 'claude-cli', model: 'claude-opus-4-7' } }, build: { agent: 'x' } } },
          },
        ],
      });

      const first = await runProviderRenameMigration(db as any);
      expect(first.registryUpdated).toBe(2);
      expect(first.agentsUpdated).toBe(1);
      expect(first.sessionsUpdated).toBe(1);
      expect(first.overridesUpdated).toBe(1);
      expect(first.workflowsUpdated).toBe(1);

      // Registry: duplicate dropped, unique custom row renamed.
      const registryProviders = db.store.model_registry.map((m: any) => m.provider);
      expect(registryProviders).not.toContain('claude-cli');
      expect(db.store.model_registry).toHaveLength(2);
      expect(db.store.model_registry.find((m: any) => m.fullId === 'claude-custom-1')?.provider).toBe('claude');

      expect(db.store.agents[0].provider).toBe('claude');
      expect(db.store.agents[1].provider).toBe('codex');
      expect(db.store.chat_sessions[0].provider).toBe('claude');
      expect(db.store.chat_sessions[1].agentOverrides.provider).toBe('claude');
      expect(db.store.workflows[0].parsed.nodes.plan.agentOverrides.provider).toBe('claude');
      // Untouched fields stay untouched.
      expect(db.store.workflows[0].parsed.nodes.plan.agentOverrides.model).toBe('claude-opus-4-7');

      // Second boot — zero writes (idempotent).
      const second = await runProviderRenameMigration(db as any);
      expect(second.registryUpdated).toBe(0);
      expect(second.agentsUpdated).toBe(0);
      expect(second.sessionsUpdated).toBe(0);
      expect(second.overridesUpdated).toBe(0);
      expect(second.workflowsUpdated).toBe(0);
    });
  });
});
