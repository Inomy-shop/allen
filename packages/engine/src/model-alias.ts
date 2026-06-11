/**
 * Normalize model aliases to fully-qualified Anthropic model IDs.
 *
 * Background: Claude Code CLI ships alias tables like `haiku` → a specific
 * model version. When those tables grow stale (e.g. `haiku` still resolving
 * to `claude-3-5-haiku-20241022` after the 3-5 series gets retired), spawn
 * hits a 404 from the API.
 *
 * Rather than depending on every Claude Code CLI install having a fresh
 * alias table, we pin the current canonical IDs here and translate any
 * known-stale alias before passing the model through to the SDK or CLI.
 *
 * Full model IDs pass through unchanged. Unknown aliases also pass through
 * unchanged (let the CLI decide — we only override when we know better).
 *
 * Override any mapping at deploy time via env:
 *   ALLEN_MODEL_HAIKU=claude-haiku-4-5-20251001
 *   ALLEN_MODEL_SONNET=claude-sonnet-4-6
 *   ALLEN_MODEL_OPUS=claude-opus-4-7
 *   ALLEN_MODEL_FABLE=claude-fable-5
 */

const DEFAULTS: Record<string, string> = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-7',
  fable:  'claude-fable-5',
};

export function normalizeModelAlias(model: string | undefined): string | undefined {
  if (!model) return model;
  const lower = model.toLowerCase().trim();
  // Already a full ID — pass through.
  if (lower.startsWith('claude-')) return model;
  // Env override takes precedence (per-deployment pinning).
  const envKey = `ALLEN_MODEL_${lower.toUpperCase()}`;
  const envOverride = process.env[envKey];
  if (envOverride) return envOverride;
  const mapped = DEFAULTS[lower];
  return mapped ?? model;
}
