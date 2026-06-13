/**
 * Token-based cost calculation from model registry prices.
 * Central module — all executors and server-side cost paths import from here.
 *
 * The authoritative cost is computed from STORED per-MTok prices × actual
 * token counts, never from the provider-reported figure. The provider's
 * total_cost_usd is kept on CostInfo.reported for audit/reconciliation and is
 * used only as a fallback when the registry has no prices for the model.
 */

import type { TokenUsageInfo } from './token-usage.js';
import type { CostInfo, ModelCostInfo } from './types.js';

export interface ComputedCost {
  /** USD amount = Σ(tokens × pricePerMTok) / 1_000_000 across components. */
  amount: number;
  /** False when some token spend existed but had no stored price. */
  complete: boolean;
}

/**
 * Price normalized token usage with registry per-MTok prices.
 *
 * Component rules (REQ-020):
 *  - tokens === null  → dimension not reported by provider; contributes nothing
 *  - tokens === 0     → nothing to price; contributes 0
 *  - tokens > 0, price set   → tokens × price / 1e6
 *  - tokens > 0, price null  → unpriced spend; result marked complete: false
 *
 * Returns null when the provider reported no usage at all, or when spend
 * exists but not a single component could be priced (callers then fall back
 * to the provider-reported figure).
 *
 * Note: cache-WRITE tokens are folded into inputNonCachedTokens by
 * token-usage.ts normalization and are therefore priced at the input rate
 * (Anthropic bills them at 1.25× input — accepted approximation until a
 * costCacheWritePerMTok field exists).
 */
export function computeCostFromUsage(
  usage: TokenUsageInfo | null | undefined,
  cost: ModelCostInfo | null | undefined,
): ComputedCost | null {
  if (!usage) return null;

  const components: Array<[number | null, number | null | undefined]> = [
    [usage.inputNonCachedTokens, cost?.costInputPerMTok],
    [usage.inputCachedTokens, cost?.costCacheReadPerMTok],
    [usage.outputTokens, cost?.costOutputPerMTok],
  ];

  let amount = 0;
  let sawReported = false;
  let pricedSome = false;
  let unpricedSpend = false;

  for (const [tokens, price] of components) {
    if (tokens === null) continue;
    sawReported = true;
    if (tokens === 0) continue;
    if (price === null || price === undefined) {
      unpricedSpend = true;
      continue;
    }
    amount += (tokens * price) / 1_000_000;
    pricedSome = true;
  }

  if (!sawReported) return null;
  if (!pricedSome && unpricedSpend) return null;
  return { amount, complete: !unpricedSpend };
}

/**
 * Assemble the CostInfo for a completed node/turn.
 *
 * Fallback chain (REQ-021): token_computed → sdk_reported → unavailable.
 * `estimated` is legacy and always 0 on new records; `reported` always
 * carries the raw provider figure for reconciliation.
 */
export function buildCostInfo(opts: {
  usage: TokenUsageInfo | null | undefined;
  costInfo: ModelCostInfo | null | undefined;
  reported: number | null | undefined;
  model?: string;
  turns?: number;
}): CostInfo {
  const reported = opts.reported ?? null;
  const computed = computeCostFromUsage(opts.usage, opts.costInfo);
  if (computed) {
    return {
      actual: computed.amount,
      estimated: 0,
      model: opts.model,
      turns: opts.turns,
      method: 'token_computed',
      reported,
      complete: computed.complete,
    };
  }
  if (reported !== null) {
    return {
      actual: reported,
      estimated: 0,
      model: opts.model,
      turns: opts.turns,
      method: 'sdk_reported',
      reported,
    };
  }
  return {
    actual: null,
    estimated: 0,
    model: opts.model,
    turns: opts.turns,
    method: 'unavailable',
    reported: null,
  };
}
