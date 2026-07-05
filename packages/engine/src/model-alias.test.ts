import { describe, expect, it, vi, beforeEach } from 'vitest';
import { normalizeModelAlias } from './model-alias.js';
import { buildCostInfo } from './cost-calculator.js';

describe('normalizeModelAlias', () => {
  beforeEach(() => {
    // Clean any env overrides that would affect tests
    for (const key of ['ALLEN_MODEL_HAIKU', 'ALLEN_MODEL_SONNET', 'ALLEN_MODEL_OPUS', 'ALLEN_MODEL_FABLE']) {
      delete process.env[key];
    }
  });

  // ── FR-4.1: Full ID passthrough ──

  it('passes known fullId through unchanged', () => {
    expect(normalizeModelAlias('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('passes Claude Sonnet 5 fullId through unchanged', () => {
    expect(normalizeModelAlias('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  // ── Legacy alias resolution ──

  it('resolves legacy "sonnet" alias to fullId', () => {
    expect(normalizeModelAlias('sonnet')).toBe('claude-sonnet-4-6');
  });

  it('resolves legacy "opus" alias to fullId', () => {
    expect(normalizeModelAlias('opus')).toBe('claude-opus-4-7');
  });

  it('resolves legacy "fable" alias to fullId', () => {
    expect(normalizeModelAlias('fable')).toBe('claude-fable-5');
  });

  it('resolves legacy "haiku" alias to fullId', () => {
    expect(normalizeModelAlias('haiku')).toBe('claude-haiku-4-5-20251001');
  });

  // ── Identity alias (same string for both alias and fullId) ──

  it('passes through identity alias "gpt-5.5" unchanged', () => {
    expect(normalizeModelAlias('gpt-5.5')).toBe('gpt-5.5');
  });

  it('passes through identity alias "deepseek-v4-pro[1m]" unchanged', () => {
    expect(normalizeModelAlias('deepseek-v4-pro[1m]')).toBe('deepseek-v4-pro[1m]');
  });

  // ── Z.AI / GLM identity passthrough ──

  it('passes through Z.AI model "glm-5.2[1m]" unchanged', () => {
    expect(normalizeModelAlias('glm-5.2[1m]')).toBe('glm-5.2[1m]');
  });

  it('passes through Z.AI model "glm-4.7" unchanged', () => {
    expect(normalizeModelAlias('glm-4.7')).toBe('glm-4.7');
  });

  it('passes through Z.AI model "glm-4.5-flash" unchanged', () => {
    expect(normalizeModelAlias('glm-4.5-flash')).toBe('glm-4.5-flash');
  });

  // ── Registry aliasMap resolution ──

  it('resolves alias via aliasMap when provided', () => {
    const aliasMap = { sonnet: 'claude-sonnet-4-6-via-map' };
    expect(normalizeModelAlias('sonnet', aliasMap)).toBe('claude-sonnet-4-6-via-map');
  });

  it('aliasMap takes precedence over legacy lookup', () => {
    const aliasMap = { sonnet: 'claude-sonnet-custom' };
    expect(normalizeModelAlias('sonnet', aliasMap)).toBe('claude-sonnet-custom');
  });

  // ── Unknown string passthrough ──

  it('passes through unknown string unchanged (REQ-015)', () => {
    expect(normalizeModelAlias('claude-future-model-7')).toBe('claude-future-model-7');
  });

  it('passes through unknown string with aliasMap', () => {
    const aliasMap = { opus: 'claude-opus-4-7' };
    expect(normalizeModelAlias('nonexistent', aliasMap)).toBe('nonexistent');
  });

  it('passes through unknown string without aliasMap', () => {
    expect(normalizeModelAlias('custom-model-123')).toBe('custom-model-123');
  });

  // ── Env override precedence ──

  it('env override takes precedence over legacy lookup', () => {
    process.env.ALLEN_MODEL_OPUS = 'claude-opus-env-override';
    expect(normalizeModelAlias('opus')).toBe('claude-opus-env-override');
  });

  it('env override takes precedence over aliasMap', () => {
    process.env.ALLEN_MODEL_OPUS = 'claude-opus-env-override';
    const aliasMap = { opus: 'claude-opus-4-7' };
    expect(normalizeModelAlias('opus', aliasMap)).toBe('claude-opus-env-override');
  });

  it('env override works for custom model name', () => {
    process.env.ALLEN_MODEL_SONNET = 'claude-custom-1';
    expect(normalizeModelAlias('sonnet')).toBe('claude-custom-1');
  });

  // ── Edge cases ──

  it('returns undefined when input is undefined', () => {
    expect(normalizeModelAlias(undefined)).toBeUndefined();
  });

  it('returns empty string when input is empty string', () => {
    expect(normalizeModelAlias('')).toBe('');
  });
});

// ── REQ-016: Cost resolution tests ──

describe('cost resolution (REQ-016)', () => {
  /**
   * Node cost is token-computed from registry per-MTok prices via
   * buildCostInfo (cost-calculator.ts); the provider-reported figure is a
   * fallback only. Detailed pricing math is covered by cost-calculator.test.ts;
   * this verifies the costMap-driven precedence the executor relies on.
   */
  const usage = { inputNonCachedTokens: 1_000_000, inputCachedTokens: null, outputTokens: 1_000_000 };

  it('prices from costMap per-MTok rates and ignores the reported figure (REQ-016)', () => {
    const costMap = { 'claude-opus-4-7': { costInputPerMTok: 15, costOutputPerMTok: 75 } };
    const info = buildCostInfo({ usage, costInfo: costMap['claude-opus-4-7'], reported: 1.23, model: 'claude-opus-4-7', turns: 2 });
    expect(info.method).toBe('token_computed');
    expect(info.actual).toBeCloseTo(90);
    expect(info.reported).toBe(1.23);
    expect(info.estimated).toBe(0);
  });

  it('falls back to the provider-reported figure when the model has no prices (REQ-016)', () => {
    const info = buildCostInfo({ usage, costInfo: undefined, reported: 0.42, model: 'unknown-model', turns: 1 });
    expect(info.method).toBe('sdk_reported');
    expect(info.actual).toBe(0.42);
  });

  it('is unavailable when there are no prices and no reported figure (REQ-016)', () => {
    const info = buildCostInfo({ usage: null, costInfo: undefined, reported: null, model: 'unknown-model', turns: 1 });
    expect(info.method).toBe('unavailable');
    expect(info.actual).toBeNull();
  });
});
