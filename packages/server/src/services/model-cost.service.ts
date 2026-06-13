/**
 * Server-side model cost lookup (REQ-024).
 *
 * Chat turns and scanner runs are priced from the model_registry per-MTok
 * prices — never from the provider-reported total_cost_usd, which the Claude
 * CLI computes with Anthropic's price table even for Claude-compatible
 * providers (DeepSeek, Kimi, MiMo). The reported figure is used only as a
 * fallback when the registry has no prices for the model.
 *
 * A short-TTL per-process cache keeps this off the per-message hot path; the
 * model-registry routes invalidate it on every mutation.
 */

import type { Db } from 'mongodb';
import { computeCostFromUsage, type ModelCostInfo, type TokenUsageInfo } from '@allen/engine';
import { LEGACY_ALIAS_LOOKUP_MAP } from './model-registry.service.js';

const CACHE_TTL_MS = 30_000;

let cache: { at: number; map: Record<string, ModelCostInfo> } | null = null;

export function invalidateModelCostCache(): void {
  cache = null;
}

/**
 * Cost info for every active registry model, keyed by BOTH alias and fullId
 * so callers can look up with whichever identifier they hold (REQ-023).
 */
export async function getModelCostMap(db: Db): Promise<Record<string, ModelCostInfo>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  const models = await db
    .collection('model_registry')
    .find({ isActive: true })
    .toArray();
  const map: Record<string, ModelCostInfo> = {};
  for (const m of models) {
    const info: ModelCostInfo = {
      costInputPerMTok: (m.costInputPerMTok as number | null) ?? undefined,
      costOutputPerMTok: (m.costOutputPerMTok as number | null) ?? undefined,
      costCacheReadPerMTok: (m.costCacheReadPerMTok as number | null) ?? undefined,
    };
    if (typeof m.alias === 'string') map[m.alias] = info;
    if (typeof m.fullId === 'string') map[m.fullId] = info;
  }
  cache = { at: Date.now(), map };
  return map;
}

/**
 * Authoritative USD cost for one chat turn / scanner run.
 * token_computed from registry prices when possible, else the provider-
 * reported figure (REQ-021 fallback chain; chat documents store a plain
 * number, so `unavailable` collapses to the reported default of 0).
 */
export async function resolveCostUsd(
  db: Db,
  model: string | undefined,
  usage: TokenUsageInfo | null | undefined,
  reportedCostUsd: number,
): Promise<{ amount: number; method: 'token_computed' | 'sdk_reported' }> {
  if (model) {
    try {
      const map = await getModelCostMap(db);
      let costInfo = map[model];
      // Legacy alias fallback for pre-migration execution traces (FR-3.3).
      if (!costInfo) {
        const resolvedFullId = LEGACY_ALIAS_LOOKUP_MAP[model];
        if (resolvedFullId && resolvedFullId !== model) {
          costInfo = map[resolvedFullId];
          if (costInfo) console.warn(`[model-cost] Legacy alias lookup used for "${model}" → "${resolvedFullId}"`);
        }
      }
      const computed = computeCostFromUsage(usage, costInfo);
      if (computed) return { amount: computed.amount, method: 'token_computed' };
    } catch {
      // Registry unreachable — fall back to the provider-reported figure.
    }
  }
  return { amount: reportedCostUsd, method: 'sdk_reported' };
}
