/**
 * Normalize model aliases to fully-qualified canonical model IDs.
 *
 * Post-migration, the DB stores fullIds (e.g. `claude-sonnet-4-6`, `gpt-5.5`)
 * and this function resolves legacy aliases at the engine boundary so the
 * CLI/SDK always receives a valid, canonical model identifier.
 *
 * Resolution order:
 *   1. Env override: `ALLEN_MODEL_<MODEL>` (highest precedence).
 *   2. Registry alias map (caller-provided, second precedence).
 *   3. Legacy alias lookup: known legacy alias (e.g. `sonnet`) → fullId.
 *   4. Known fullId → pass through unchanged.
 *   5. Unknown string → pass through unchanged (let the CLI decide).
 *
 * Override any mapping at deploy time via env:
 *   ALLEN_MODEL_FABLE=claude-fable-5
 *   ALLEN_MODEL_SONNET=claude-sonnet-4-6
 *   ALLEN_MODEL_OPUS=claude-opus-4-7
 *   ALLEN_MODEL_HAIKU=claude-haiku-4-5-20251001
 */

const LEGACY_ALIAS_LOOKUP_MAP: Record<string, string> = {
  // claude-cli aliases (alias ≠ fullId)
  'fable': 'claude-fable-5',
  'sonnet': 'claude-sonnet-4-6',
  'opus': 'claude-opus-4-7',
  'haiku': 'claude-haiku-4-5-20251001',
  // Identity entries (alias === fullId) needed for read-time resolution
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'gpt-5.2-codex': 'gpt-5.2-codex',
  'gpt-5.1-codex-max': 'gpt-5.1-codex-max',
  'gpt-5.2': 'gpt-5.2',
  'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
  'o3': 'o3',
  'o4-mini': 'o4-mini',
  'codex-mini': 'codex-mini',
  'deepseek-v4-pro[1m]': 'deepseek-v4-pro[1m]',
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'mimo-v2.5-pro': 'mimo-v2.5-pro',
  'kimi-k2.6': 'kimi-k2.6',
  'kimi-k2.5': 'kimi-k2.5',
};

const KNOWN_FULL_IDS: Set<string> = new Set(Object.values(LEGACY_ALIAS_LOOKUP_MAP));

export function normalizeModelAlias(
  model: string | undefined,
  aliasMap?: Record<string, string>,
): string | undefined {
  if (!model) return model;
  const lower = model.toLowerCase().trim();
  // Env override takes highest precedence (per-deployment pinning).
  const envKey = `ALLEN_MODEL_${lower.toUpperCase()}`;
  const envOverride = process.env[envKey];
  if (envOverride) return envOverride;
  // Registry alias map (second precedence)
  if (aliasMap && aliasMap[lower]) return aliasMap[lower];
  // Legacy lookup: known alias → fullId
  const legacyResolved = LEGACY_ALIAS_LOOKUP_MAP[lower];
  if (legacyResolved) return legacyResolved;
  // Known fullId → passthrough
  if (KNOWN_FULL_IDS.has(lower)) return model;
  // Unknown → passthrough unchanged
  return model;
}
