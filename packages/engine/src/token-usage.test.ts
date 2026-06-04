import { describe, it, expect } from 'vitest';
import {
  normalizeCodexUsage, normalizeClaudeUsage, aggregateTokenUsage,
  tokenUsageFromChildMarkers, attachChildTokenUsageMarkers
} from './token-usage.js';

describe('normalizeCodexUsage', () => {
  it('returns null when usage is undefined', () => {
    expect(normalizeCodexUsage(undefined)).toBeNull();
  });
  it('returns null when all fields absent', () => {
    expect(normalizeCodexUsage({})).toBeNull();
  });
  it('full usage: computes non-cached as input_tokens - cached', () => {
    const r = normalizeCodexUsage({ input_tokens: 1000, output_tokens: 500, cached_input_tokens: 200 });
    expect(r).toEqual({ inputCachedTokens: 200, inputNonCachedTokens: 800, outputTokens: 500 });
  });
  it('missing cached: inputNonCachedTokens = input_tokens, inputCachedTokens = null', () => {
    const r = normalizeCodexUsage({ input_tokens: 1000, output_tokens: 500 });
    expect(r).toEqual({ inputCachedTokens: null, inputNonCachedTokens: 1000, outputTokens: 500 });
  });
  it('negative field: treated as null, not 0', () => {
    const r = normalizeCodexUsage({ input_tokens: -5, output_tokens: 100 });
    // input_tokens negative → null → inputNonCachedTokens null
    expect(r?.inputNonCachedTokens).toBeNull();
    expect(r?.outputTokens).toBe(100);
  });
  it('clamps to non-negative: cached cannot exceed input', () => {
    // max(1000 - 200, 0) = 800
    const r = normalizeCodexUsage({ input_tokens: 1000, cached_input_tokens: 200 });
    expect(r?.inputNonCachedTokens).toBe(800);
  });
});

describe('normalizeClaudeUsage', () => {
  it('returns null when usage is undefined', () => {
    expect(normalizeClaudeUsage(undefined)).toBeNull();
  });
  it('full usage with cache', () => {
    const r = normalizeClaudeUsage({
      input_tokens: 800, output_tokens: 300,
      cache_read_input_tokens: 200, cache_creation_input_tokens: 50
    });
    // inputNonCachedTokens = input_tokens + cache_creation = 850
    expect(r).toEqual({ inputCachedTokens: 200, inputNonCachedTokens: 850, outputTokens: 300 });
  });
  it('no cache fields: inputCachedTokens null', () => {
    const r = normalizeClaudeUsage({ input_tokens: 1000, output_tokens: 400 });
    expect(r?.inputCachedTokens).toBeNull();
    expect(r?.inputNonCachedTokens).toBe(1000);
  });
  it('missing input_tokens: inputNonCachedTokens null even if cache_creation present', () => {
    const r = normalizeClaudeUsage({ output_tokens: 400, cache_creation_input_tokens: 100 });
    expect(r?.inputNonCachedTokens).toBeNull();
    expect(r?.outputTokens).toBe(400);
  });
  it('all absent: returns null', () => {
    expect(normalizeClaudeUsage({})).toBeNull();
  });
});

describe('aggregateTokenUsage', () => {
  it('both null → null', () => {
    expect(aggregateTokenUsage(null, null)).toBeNull();
  });
  it('one null → returns the other without adding zeros', () => {
    const a = { inputCachedTokens: 100, inputNonCachedTokens: null, outputTokens: 50 };
    expect(aggregateTokenUsage(a, null)).toEqual(a);
    expect(aggregateTokenUsage(null, a)).toEqual(a);
  });
  it('both numbers → sum', () => {
    const a = { inputCachedTokens: 100, inputNonCachedTokens: 200, outputTokens: 50 };
    const b = { inputCachedTokens: 50, inputNonCachedTokens: 100, outputTokens: 25 };
    expect(aggregateTokenUsage(a, b)).toEqual({ inputCachedTokens: 150, inputNonCachedTokens: 300, outputTokens: 75 });
  });
  it('per-field: null + 5 = 5 (not 0+5=5)', () => {
    const a = { inputCachedTokens: null, inputNonCachedTokens: 500, outputTokens: null };
    const b = { inputCachedTokens: 100, inputNonCachedTokens: 300, outputTokens: null };
    const r = aggregateTokenUsage(a, b);
    expect(r?.inputCachedTokens).toBe(100);
    expect(r?.inputNonCachedTokens).toBe(800);
    expect(r?.outputTokens).toBeNull(); // null + null = null
  });
});

describe('child markers round-trip', () => {
  it('attach then read: preserves values including null sub-fields', () => {
    const usage = { inputCachedTokens: null, inputNonCachedTokens: 5000, outputTokens: 2000 };
    const out: Record<string, unknown> = {};
    attachChildTokenUsageMarkers(out, usage);
    const read = tokenUsageFromChildMarkers(out);
    expect(read).toEqual(usage);
  });
  it('attach null usage: no markers written', () => {
    const out: Record<string, unknown> = {};
    attachChildTokenUsageMarkers(out, null);
    expect(out.__token_usage_input_cached).toBeUndefined();
  });
  it('read with no markers: returns null', () => {
    expect(tokenUsageFromChildMarkers({})).toBeNull();
  });
});
