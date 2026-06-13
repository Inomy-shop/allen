/**
 * Tests for model-cost.service.ts — server-side cost resolution with legacy
 * alias fallback for pre-migration executions (AC-006).
 *
 * AC-006: Cost figures on pre-migration executions are unchanged. The
 * resolveCostUsd function must fall back to LEGACY_ALIAS_LOOKUP_MAP when a
 * model value is a short alias (e.g. "sonnet") rather than a fullId, and
 * token-compute the same cost as if it had been stored as the fullId.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getModelCostMap,
  resolveCostUsd,
  invalidateModelCostCache,
} from '../model-cost.service';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockDb(registryModels: Array<{
  provider: string;
  fullId: string;
  alias?: string;
  costInputPerMTok?: number | null;
  costOutputPerMTok?: number | null;
  costCacheReadPerMTok?: number | null;
  isActive?: boolean;
}> = []) {
  const store = registryModels.map((m, i) => ({
    _id: `id-${i}`,
    provider: m.provider,
    fullId: m.fullId,
    ...(m.alias ? { alias: m.alias } : {}),
    costInputPerMTok: m.costInputPerMTok ?? null,
    costOutputPerMTok: m.costOutputPerMTok ?? null,
    costCacheReadPerMTok: m.costCacheReadPerMTok ?? null,
    isActive: m.isActive ?? true,
  }));

  return {
    store,
    collection: (name: string) => ({
      find: (query: Record<string, unknown>) => {
        let results = [...store];
        if (query.isActive === true) results = results.filter((r) => r.isActive);
        return {
          toArray: async () => results.map((r) => ({ ...r })),
          sort: () => ({
            toArray: async () => results.map((r) => ({ ...r })),
          }),
        };
      },
    }),
  } as any;
}

describe('getModelCostMap (AC-006)', () => {
  beforeEach(() => {
    invalidateModelCostCache();
  });

  it('creates map entries keyed by both fullId and alias when alias exists', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 3,
        costOutputPerMTok: 15,
      },
    ]);
    const map = await getModelCostMap(db);
    // FullId key exists
    expect(map['claude-sonnet-4-6']).toBeDefined();
    expect(map['claude-sonnet-4-6'].costInputPerMTok).toBe(3);
    expect(map['claude-sonnet-4-6'].costOutputPerMTok).toBe(15);
    // Alias key exists too — pre-migration traces can reference either
    expect(map['sonnet']).toBeDefined();
    expect(map['sonnet'].costInputPerMTok).toBe(3);
  });

  it('only creates fullId key when no alias field exists', async () => {
    const db = makeMockDb([
      {
        provider: 'codex',
        fullId: 'gpt-5.5',
        costInputPerMTok: 5,
        costOutputPerMTok: 30,
      },
    ]);
    const map = await getModelCostMap(db);
    expect(map['gpt-5.5']).toBeDefined();
    expect(map['gpt-5.5'].costInputPerMTok).toBe(5);
  });

  it('includes costCacheReadPerMTok when present', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-opus-4-7',
        alias: 'opus',
        costInputPerMTok: 5,
        costOutputPerMTok: 25,
        costCacheReadPerMTok: 0.5,
      },
    ]);
    const map = await getModelCostMap(db);
    expect(map['claude-opus-4-7'].costCacheReadPerMTok).toBe(0.5);
    expect(map['opus'].costCacheReadPerMTok).toBe(0.5);
  });

  it('excludes inactive models from the map', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 3,
        isActive: false,
      },
    ]);
    const map = await getModelCostMap(db);
    expect(map['claude-sonnet-4-6']).toBeUndefined();
    expect(map['sonnet']).toBeUndefined();
  });

  it('returns price=undefined for null cost fields', async () => {
    const db = makeMockDb([
      {
        provider: 'codex',
        fullId: 'codex-mini',
        costInputPerMTok: null,
        costOutputPerMTok: null,
      },
    ]);
    const map = await getModelCostMap(db);
    expect(map['codex-mini'].costInputPerMTok).toBeUndefined();
    expect(map['codex-mini'].costOutputPerMTok).toBeUndefined();
  });
});

describe('resolveCostUsd legacy alias fallback (AC-006)', () => {
  beforeEach(() => {
    invalidateModelCostCache();
  });

  it('resolves cost via direct fullId lookup', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 3,
        costOutputPerMTok: 15,
      },
    ]);
    const result = await resolveCostUsd(
      db,
      'claude-sonnet-4-6',
      { inputNonCachedTokens: 1_000_000, inputCachedTokens: null, outputTokens: 1_000_000 },
      1.23,
    );
    expect(result.amount).toBeCloseTo(18);
    expect(result.method).toBe('token_computed');
  });

  it('resolves cost via LEGACY_ALIAS_LOOKUP_MAP for alias values (AC-006)', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 3,
        costOutputPerMTok: 15,
      },
    ]);
    // Pre-migration execution stored "sonnet" as the model value
    const result = await resolveCostUsd(
      db,
      'sonnet',
      { inputNonCachedTokens: 1_000_000, inputCachedTokens: null, outputTokens: 1_000_000 },
      99.99,
    );
    // Cost is token-computed from registry, NOT the provider-reported fallback
    expect(result.amount).toBeCloseTo(18);
    expect(result.method).toBe('token_computed');
  });

  it('resolves cost for "opus" alias via legacy lookup', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-opus-4-7',
        alias: 'opus',
        costInputPerMTok: 5,
        costOutputPerMTok: 25,
      },
    ]);
    const result = await resolveCostUsd(
      db,
      'opus',
      { inputNonCachedTokens: 1_000_000, inputCachedTokens: null, outputTokens: 1_000_000 },
      50,
    );
    expect(result.amount).toBeCloseTo(30);
    expect(result.method).toBe('token_computed');
  });

  it('resolves cost for "haiku" alias via legacy lookup', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-haiku-4-5-20251001',
        alias: 'haiku',
        costInputPerMTok: 1,
        costOutputPerMTok: 5,
      },
    ]);
    const result = await resolveCostUsd(
      db,
      'haiku',
      { inputNonCachedTokens: 1_000_000, inputCachedTokens: null, outputTokens: 1_000_000 },
      10,
    );
    expect(result.amount).toBeCloseTo(6);
    expect(result.method).toBe('token_computed');
  });

  it('resolves cost for "fable" alias via legacy lookup', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-fable-5',
        alias: 'fable',
        costInputPerMTok: 10,
        costOutputPerMTok: 50,
      },
    ]);
    const result = await resolveCostUsd(
      db,
      'fable',
      { inputNonCachedTokens: 1_000_000, inputCachedTokens: null, outputTokens: 1_000_000 },
      100,
    );
    expect(result.amount).toBeCloseTo(60);
    expect(result.method).toBe('token_computed');
  });

  it('falls back to sdk_reported when legacy alias is not in the cost map', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 3,
      },
    ]);
    const result = await resolveCostUsd(
      db,
      'unknown-model',
      { inputNonCachedTokens: 1_000_000, inputCachedTokens: null, outputTokens: 1_000_000 },
      0.42,
    );
    expect(result.amount).toBe(0.42);
    expect(result.method).toBe('sdk_reported');
  });

  it('falls back to sdk_reported when model is undefined', async () => {
    const db = makeMockDb();
    const result = await resolveCostUsd(db, undefined, null, 0.01);
    expect(result.amount).toBe(0.01);
    expect(result.method).toBe('sdk_reported');
  });

  it('returns token_computed=0 when usage has no tokens but all costs are set', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 3,
        costOutputPerMTok: 15,
      },
    ]);
    const result = await resolveCostUsd(
      db,
      'claude-sonnet-4-6',
      { inputNonCachedTokens: 0, inputCachedTokens: null, outputTokens: 0 },
      0,
    );
    expect(result.amount).toBe(0);
    expect(result.method).toBe('token_computed');
  });

  it('falls back to sdk_reported when usage is null', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 3,
      },
    ]);
    const result = await resolveCostUsd(db, 'claude-sonnet-4-6', null, 5.00);
    expect(result.amount).toBe(5.00);
    expect(result.method).toBe('sdk_reported');
  });
});

describe('cost cache invalidation', () => {
  beforeEach(() => {
    invalidateModelCostCache();
  });

  it('invalidateModelCostCache clears cached map', async () => {
    const db = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 3,
      },
    ]);
    const map1 = await getModelCostMap(db);
    expect(map1['sonnet']).toBeDefined();

    // Invalidate and verify fresh fetch
    invalidateModelCostCache();

    const db2 = makeMockDb([
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        alias: 'sonnet',
        costInputPerMTok: 5,
      },
    ]);
    const map2 = await getModelCostMap(db2);
    expect(map2['sonnet'].costInputPerMTok).toBe(5);
  });
});
