import { describe, it, expect } from 'vitest';
import { computeCostFromUsage, buildCostInfo } from './cost-calculator.js';
import type { TokenUsageInfo } from './token-usage.js';
import type { ModelCostInfo } from './types.js';

const FULL_PRICES: ModelCostInfo = {
  costInputPerMTok: 3,
  costOutputPerMTok: 15,
  costCacheReadPerMTok: 0.3,
};

const usage = (
  nonCached: number | null,
  cached: number | null,
  output: number | null,
): TokenUsageInfo => ({
  inputNonCachedTokens: nonCached,
  inputCachedTokens: cached,
  outputTokens: output,
});

describe('computeCostFromUsage', () => {
  it('prices all three components from per-MTok rates', () => {
    const result = computeCostFromUsage(usage(1_000_000, 2_000_000, 500_000), FULL_PRICES);
    expect(result).toEqual({
      amount: 3 + 2 * 0.3 + 0.5 * 15,
      complete: true,
    });
  });

  it('returns null when usage is absent', () => {
    expect(computeCostFromUsage(null, FULL_PRICES)).toBeNull();
    expect(computeCostFromUsage(undefined, FULL_PRICES)).toBeNull();
  });

  it('returns null when all token fields are null (provider reported nothing)', () => {
    expect(computeCostFromUsage(usage(null, null, null), FULL_PRICES)).toBeNull();
  });

  it('returns null when spend exists but no prices are stored at all', () => {
    expect(computeCostFromUsage(usage(100, 200, 300), {})).toBeNull();
    expect(computeCostFromUsage(usage(100, 200, 300), null)).toBeNull();
  });

  it('returns zero, complete, for explicit zero usage', () => {
    expect(computeCostFromUsage(usage(0, 0, 0), {})).toEqual({ amount: 0, complete: true });
  });

  it('skips null token dimensions without marking incomplete', () => {
    // Codex commonly reports no cache dimension
    const result = computeCostFromUsage(usage(1_000_000, null, 1_000_000), FULL_PRICES);
    expect(result).toEqual({ amount: 3 + 15, complete: true });
  });

  it('marks incomplete when spend exists for an unpriced component', () => {
    const result = computeCostFromUsage(usage(1_000_000, 500_000, 1_000_000), {
      costInputPerMTok: 3,
      costOutputPerMTok: 15,
      // no cache-read price
    });
    expect(result).toEqual({ amount: 3 + 15, complete: false });
  });

  it('does not mark incomplete when the unpriced component has zero tokens', () => {
    const result = computeCostFromUsage(usage(1_000_000, 0, 1_000_000), {
      costInputPerMTok: 3,
      costOutputPerMTok: 15,
    });
    expect(result).toEqual({ amount: 3 + 15, complete: true });
  });

  it('prices with zero-rate prices (free models) as complete', () => {
    const result = computeCostFromUsage(usage(1_000_000, null, 1_000_000), {
      costInputPerMTok: 0,
      costOutputPerMTok: 0,
    });
    expect(result).toEqual({ amount: 0, complete: true });
  });
});

describe('buildCostInfo', () => {
  it('prefers token-computed over the provider-reported figure', () => {
    const info = buildCostInfo({
      usage: usage(1_000_000, null, 1_000_000),
      costInfo: FULL_PRICES,
      reported: 99.99,
      model: 'sonnet',
      turns: 3,
    });
    expect(info.method).toBe('token_computed');
    expect(info.actual).toBeCloseTo(18);
    expect(info.reported).toBe(99.99);
    expect(info.estimated).toBe(0);
    expect(info.complete).toBe(true);
    expect(info.model).toBe('sonnet');
    expect(info.turns).toBe(3);
  });

  it('falls back to sdk_reported when nothing can be priced', () => {
    const info = buildCostInfo({
      usage: usage(100, null, 100),
      costInfo: {},
      reported: 0.42,
    });
    expect(info.method).toBe('sdk_reported');
    expect(info.actual).toBe(0.42);
    expect(info.reported).toBe(0.42);
  });

  it('is unavailable when there are no prices and no reported cost', () => {
    const info = buildCostInfo({ usage: null, costInfo: null, reported: null });
    expect(info.method).toBe('unavailable');
    expect(info.actual).toBeNull();
    expect(info.reported).toBeNull();
    expect(info.estimated).toBe(0);
  });

  it('treats reported: 0 as a real reported figure, not absence', () => {
    const info = buildCostInfo({ usage: null, costInfo: FULL_PRICES, reported: 0 });
    expect(info.method).toBe('sdk_reported');
    expect(info.actual).toBe(0);
  });
});
