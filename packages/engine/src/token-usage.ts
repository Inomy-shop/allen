/**
 * Token usage normalization and aggregation helpers.
 * Central module — all executors and engine import from here.
 */

/**
 * Normalized token usage across providers (Codex, Claude SDK).
 *
 * Each sub-field is INDEPENDENTLY NULLABLE:
 *   - `number` (integer ≥ 0) — the provider explicitly reported this many tokens
 *   - `null` — the provider did NOT report this dimension
 *   NEVER substitute null with 0. A null sub-field must NEVER be persisted as 0.
 */
export interface TokenUsageInfo {
  inputCachedTokens: number | null;
  inputNonCachedTokens: number | null;
  outputTokens: number | null;
}

/** Clamp to non-negative integer. Returns null for non-finite or negative. */
function clampToNonNeg(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n < 0) return null; // warn caller
  return Math.trunc(n);
}

/**
 * Normalize Codex turn.completed usage event.
 * Returns null when ALL three sub-fields would be null (provider reported nothing).
 * REQ-002.
 */
export function normalizeCodexUsage(usage: {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_input_tokens?: unknown;
} | undefined | null): TokenUsageInfo | null {
  if (!usage) return null;

  const rawInput = clampToNonNeg(usage.input_tokens);
  const rawOutput = clampToNonNeg(usage.output_tokens);
  const rawCached = clampToNonNeg(usage.cached_input_tokens);

  const inputCachedTokens = rawCached;
  const inputNonCachedTokens = rawInput != null
    ? Math.max(rawInput - (rawCached ?? 0), 0)
    : null;
  const outputTokens = rawOutput;

  if (inputCachedTokens === null && inputNonCachedTokens === null && outputTokens === null) {
    return null;
  }
  return { inputCachedTokens, inputNonCachedTokens, outputTokens };
}

/**
 * Normalize Anthropic Claude SDK result.usage object.
 * Authoritative mapping per TDD §1.1.1:
 *   inputCachedTokens    = cache_read_input_tokens (if present)
 *   inputNonCachedTokens = input_tokens + (cache_creation_input_tokens >= 0 ? that : 0) (if input_tokens present)
 *   outputTokens         = output_tokens (if present)
 * Returns null when ALL three sub-fields would be null.
 * REQ-003.
 */
export function normalizeClaudeUsage(usage: {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
} | undefined | null): TokenUsageInfo | null {
  if (!usage) return null;

  const rawInput = clampToNonNeg(usage.input_tokens);
  const rawOutput = clampToNonNeg(usage.output_tokens);
  const rawCacheRead = clampToNonNeg(usage.cache_read_input_tokens);
  const rawCacheCreate = clampToNonNeg(usage.cache_creation_input_tokens);

  const inputCachedTokens = rawCacheRead; // null if not present
  const inputNonCachedTokens = rawInput != null
    ? rawInput + (rawCacheCreate != null ? rawCacheCreate : 0)
    : null;
  const outputTokens = rawOutput;

  if (inputCachedTokens === null && inputNonCachedTokens === null && outputTokens === null) {
    return null;
  }
  return { inputCachedTokens, inputNonCachedTokens, outputTokens };
}

/**
 * Per-field null-aware sum of two TokenUsageInfo carriers.
 * Rules per TDD §1.6:
 *   - both null/undefined → result null
 *   - one null → result equals the other (null does NOT contribute zero)
 *   - both numbers → sum
 * REQ-001, REQ-005.
 */
export function aggregateTokenUsage(
  a?: TokenUsageInfo | null,
  b?: TokenUsageInfo | null,
): TokenUsageInfo | null {
  if (a == null && b == null) return null;
  if (a == null) return b!;
  if (b == null) return a;

  const sumField = (x: number | null, y: number | null): number | null => {
    if (x === null && y === null) return null;
    if (x === null) return y;
    if (y === null) return x;
    return x + y;
  };

  return {
    inputCachedTokens: sumField(a.inputCachedTokens, b.inputCachedTokens),
    inputNonCachedTokens: sumField(a.inputNonCachedTokens, b.inputNonCachedTokens),
    outputTokens: sumField(a.outputTokens, b.outputTokens),
  };
}

/**
 * Read __token_usage_* markers from a child output map back into TokenUsageInfo.
 * Returns null if no markers are present.
 * Marker value null → sub-field stays null (NOT converted to 0).
 * REQ-006.
 */
export function tokenUsageFromChildMarkers(out: Record<string, unknown>): TokenUsageInfo | null {
  const hasCached = '__token_usage_input_cached' in out;
  const hasNonCached = '__token_usage_input_non_cached' in out;
  const hasOutput = '__token_usage_output' in out;
  if (!hasCached && !hasNonCached && !hasOutput) return null;

  const inputCachedTokens = clampToNonNeg(out.__token_usage_input_cached);
  const inputNonCachedTokens = clampToNonNeg(out.__token_usage_input_non_cached);
  const outputTokens = clampToNonNeg(out.__token_usage_output);

  if (inputCachedTokens === null && inputNonCachedTokens === null && outputTokens === null) {
    return null;
  }
  return { inputCachedTokens, inputNonCachedTokens, outputTokens };
}

/**
 * Write __token_usage_* markers onto a result map.
 * Skipped entirely when usage is null (no-op). REQ-006.
 * Null sub-fields are written as null (so parent reads them as null, not absent).
 */
export function attachChildTokenUsageMarkers(
  out: Record<string, unknown>,
  usage: TokenUsageInfo | null | undefined,
): void {
  if (usage == null) return;
  out.__token_usage_input_cached = usage.inputCachedTokens;
  out.__token_usage_input_non_cached = usage.inputNonCachedTokens;
  out.__token_usage_output = usage.outputTokens;
}
