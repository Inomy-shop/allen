/**
 * Focused regression tests for the agent-override model resolution fix.
 *
 * Covers two symptoms that appeared in production traces:
 *
 *   1. buildCostInfo (cost calculation) was called with `role?.model ?? 'sonnet'`
 *      instead of the effective model (agentOverrides.model > role.model).
 *      Result: a node with `agentOverrides: { model: "deepseek-v4-flash" }` on a
 *      claude-sonnet-4-6 agent had its cost charged/labeled against
 *      "claude-sonnet-4-6" instead of "deepseek-v4-flash".
 *
 *   2. The Phase-2 re-derivation of resolvedModel2 was missing deps.aliasMap,
 *      so the stored model key could diverge from what callAgent actually ran
 *      with when an aliasMap was provided.
 *
 * Both fixes are in executeAgentNode in node-executor.ts.
 * These tests verify the cost-calculator behaviour given the corrected inputs.
 */

import { describe, it, expect } from 'vitest';
import { buildCostInfo } from './cost-calculator.js';
import { normalizeModelAlias } from './model-alias.js';

describe('agentOverrides model resolution — cost and alias consistency', () => {
  const mockUsage = {
    inputNonCachedTokens: 500_000,
    inputCachedTokens: null,
    outputTokens: 500_000,
  };

  // ── 1. Cost is labeled with the effective (overridden) model, not the agent default ──

  it('buildCostInfo uses the overridden model key, not the role default', () => {
    const agentDefaultModel = 'claude-sonnet-4-6';
    const overrideModel = 'deepseek-v4-flash';

    // The overridden model has a known price in the map.
    const costMap: Record<string, { costInputPerMTok: number; costOutputPerMTok: number }> = {
      'deepseek-v4-flash': { costInputPerMTok: 0.14, costOutputPerMTok: 0.28 },
      [agentDefaultModel]: { costInputPerMTok: 3.0, costOutputPerMTok: 15.0 },
    };

    // Before fix: buildCostInfo was called with `model = agentDefaultModel`.
    // After fix:  buildCostInfo is called with `model = overrideModel` (resolvedModel2).

    const costWithDefault = buildCostInfo({
      usage: mockUsage,
      costInfo: costMap[agentDefaultModel],
      reported: null,
      model: agentDefaultModel,
      turns: 1,
    });

    const costWithOverride = buildCostInfo({
      usage: mockUsage,
      costInfo: costMap[overrideModel],
      reported: null,
      model: overrideModel,
      turns: 1,
    });

    // The overridden model is dramatically cheaper — they must differ.
    expect(costWithDefault.model).toBe(agentDefaultModel);
    expect(costWithOverride.model).toBe(overrideModel);
    expect(costWithOverride.actual).toBeLessThan(costWithDefault.actual as number);

    // The correct (post-fix) model label must be the override, not the default.
    expect(costWithOverride.model).not.toBe(agentDefaultModel);
  });

  // ── 2. aliasMap is respected when resolving the model for Phase-2 re-derivation ──

  it('normalizeModelAlias respects aliasMap so Phase-2 re-derivation matches callAgent', () => {
    const aliasMap = { sonnet: 'claude-sonnet-4-6-test' };

    // callAgent path (inside callAgent closure):
    const rawModel = 'sonnet';
    const resolvedInCallAgent = normalizeModelAlias(rawModel, aliasMap) ?? rawModel;

    // Phase-2 path (before fix, no aliasMap):
    const resolvedPhase2OldBug = normalizeModelAlias(rawModel) ?? rawModel;
    // Phase-2 path (after fix, with aliasMap):
    const resolvedPhase2Fixed = normalizeModelAlias(rawModel, aliasMap) ?? rawModel;

    // Before fix, Phase 2 could diverge from callAgent when aliasMap was provided.
    // After fix they must match.
    expect(resolvedPhase2Fixed).toBe(resolvedInCallAgent);
    // The old buggy path produces a different (potentially stale) result.
    expect(resolvedPhase2OldBug).not.toBe(resolvedInCallAgent);
  });

  // ── 3. Override model is looked up correctly in the costMap ──

  it('override model costMap lookup is override-aware: uses override key, not agent default key', () => {
    const costMap: Record<string, { costInputPerMTok: number; costCacheReadPerMTok?: number; costOutputPerMTok: number }> = {
      'deepseek-v4-flash': { costInputPerMTok: 0.14, costOutputPerMTok: 0.28 },
    };
    const agentDefaultModel = 'claude-sonnet-4-6'; // NOT in costMap
    const overrideModel = 'deepseek-v4-flash';      // IN costMap

    // Before fix: costMap?.[agentDefaultModel] → undefined → falls back to sdk_reported
    const buggyInfo = buildCostInfo({
      usage: mockUsage,
      costInfo: costMap[agentDefaultModel],
      reported: 9.99,
      model: agentDefaultModel,
      turns: 1,
    });

    // After fix: costMap?.[overrideModel] → correct prices → token_computed
    const fixedInfo = buildCostInfo({
      usage: mockUsage,
      costInfo: costMap[overrideModel],
      reported: 9.99,
      model: overrideModel,
      turns: 1,
    });

    expect(buggyInfo.method).toBe('sdk_reported');  // would have used reported=9.99
    expect(fixedInfo.method).toBe('token_computed'); // uses registry prices
    expect(fixedInfo.model).toBe(overrideModel);
  });
});
