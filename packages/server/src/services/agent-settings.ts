/**
 * Agent settings resolver — single source of truth for model / reasoning-effort / plan-mode.
 *
 * Non-destructive overrides: workflow-node overrides and chat-session overrides are
 * ephemeral. They never mutate the agent document. At spawn time we evaluate layers
 * in priority order (node > session > agent default), produce a `ResolvedSettings`
 * object, and translate it into provider-specific CLI flags.
 *
 * This module is the ONLY place that:
 *   1. Decides the effective model/effort/planMode for a spawn
 *   2. Enforces validation (plan mode claude-only, effort=max opus-only)
 *   3. Translates the result to CLI flags
 */

export type ChatProvider = 'claude-cli' | 'codex' | 'deepseek';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

/** Fields every agent owns as its default identity. */
export interface AgentLike {
  name: string;
  provider?: string;           // 'claude-cli' | 'codex' | other
  model?: string;
  reasoningEffort?: ReasoningEffort;
  planMode?: boolean;
}

/** A per-layer override. All fields optional; `null` means "explicitly inherit parent". */
export interface AgentOverrides {
  provider?: ChatProvider | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  planMode?: boolean | null;
}

/** The effective values used to spawn the agent right now. */
export interface ResolvedSettings {
  provider: ChatProvider;
  model: string;
  reasoningEffort: ReasoningEffort | undefined;  // undefined = "not set, use CLI default"
  planMode: boolean;
}

/** Custom error class so callers can catch by `.code`. */
export class AgentSettingsValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AgentSettingsValidationError';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isClaudeProvider(p: string | undefined): p is 'claude-cli' {
  return p === 'claude-cli' || p === 'claude';
}

function looksLikeOpus(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return m.includes('opus') || m === 'opus';
}

function normalizeProvider(p: string | undefined): ChatProvider {
  if (isClaudeProvider(p)) return 'claude-cli';
  if (p === 'deepseek') return 'deepseek';
  return 'codex';
}

/**
 * Pick the first non-null/undefined value from a sequence of override layers,
 * falling back to the agent default. This is the single merge rule used for
 * every field that can be overridden.
 */
function pick<T>(
  layers: ReadonlyArray<AgentOverrides | undefined>,
  field: keyof AgentOverrides,
  agentDefault: T | undefined,
): T | undefined {
  for (const layer of layers) {
    if (!layer) continue;
    const v = layer[field];
    if (v !== null && v !== undefined) return v as unknown as T;
  }
  return agentDefault;
}

// ── Resolver ───────────────────────────────────────────────────────────────

/**
 * Merge the agent's default identity with zero or more override layers.
 * `layers[0]` is the highest-priority layer (usually the workflow-node override).
 * `layers[1]` is next (usually the chat-session override). More layers are allowed
 * for future extensibility.
 *
 * Throws `AgentSettingsValidationError` on forbidden combinations.
 */
export function resolveAgentSettings(
  agent: AgentLike,
  layers: ReadonlyArray<AgentOverrides | undefined> = [],
): ResolvedSettings {
  const provider = normalizeProvider(pick<string>(layers, 'provider', agent.provider));
  const model = pick<string>(layers, 'model', agent.model) ?? '';
  const effortRaw = pick<ReasoningEffort>(layers, 'reasoningEffort', agent.reasoningEffort);
  const planRaw = pick<boolean>(layers, 'planMode', agent.planMode);

  // Normalize effort: 'off' stays 'off' (explicit disable), undefined = "inherit CLI default"
  const reasoningEffort: ReasoningEffort | undefined = effortRaw;
  const planMode = planRaw === true;

  // ── Validation ────────────────────────────────────────────────────────
  if (planMode && provider !== 'claude-cli') {
    throw new AgentSettingsValidationError(
      'plan_mode_claude_only',
      `Plan mode is only supported for Claude agents (got provider=${provider}).`,
    );
  }

  if (reasoningEffort === 'max' && provider !== 'claude-cli') {
    throw new AgentSettingsValidationError(
      'effort_max_claude_only',
      `reasoningEffort="max" is only supported for Claude agents (got provider=${provider}).`,
    );
  }

  if (reasoningEffort === 'max' && !looksLikeOpus(model)) {
    throw new AgentSettingsValidationError(
      'effort_max_requires_opus',
      `reasoningEffort="max" requires a Claude Opus model (got model="${model || '(none)'}").`,
    );
  }

  return { provider, model, reasoningEffort, planMode };
}

// ── Translators ────────────────────────────────────────────────────────────

/**
 * Claude Code SDK options fragment. Caller merges this into the full sdkOptions
 * object passed to `query(...)`.
 *
 * CRITICAL: The Claude Code SDK's bundled `cli.js` does NOT support `--effort`
 * in any published version as of 2.1.105 — that flag only exists on the
 * user-facing `claude` binary, which is a different artifact. Passing `effort`
 * via `extraArgs` makes the SDK spawn fail with `unknown option '--effort'`.
 *
 * Workaround: use Anthropic's documented natural-language trigger keywords.
 * When the caller prepends one of these to the user prompt, Claude allocates
 * a larger thinking budget for the response:
 *
 *   think        ≈  4,000 tokens
 *   think hard   ≈ 10,000 tokens
 *   ultrathink   ≈ 32,000 tokens
 *
 * We return `promptPrefix` and let the caller prepend it at the query() site
 * only — the DB-stored user message stays clean.
 *
 * `permissionMode: 'plan'` IS a native SDK option (CLI flag `--permission-mode plan`).
 * `model` is also native.
 */
export interface ClaudeSdkSettings {
  model?: string;
  permissionMode?: 'plan';
  /** Prepend to the user prompt at query-time to control thinking budget. */
  promptPrefix?: string;
}

function effortToKeyword(effort: ReasoningEffort): string | undefined {
  switch (effort) {
    case 'off': return undefined;
    case 'low': return undefined;       // CLI default is already low-ish
    case 'medium': return 'think';
    case 'high': return 'think hard';
    case 'max': return 'ultrathink';
  }
}

export function toClaudeSdkOptions(resolved: ResolvedSettings): ClaudeSdkSettings {
  const out: ClaudeSdkSettings = {};
  if (resolved.model) out.model = resolved.model;
  if (resolved.reasoningEffort) {
    const kw = effortToKeyword(resolved.reasoningEffort);
    if (kw) out.promptPrefix = kw;
  }
  if (resolved.planMode) out.permissionMode = 'plan';
  return out;
}

/**
 * Codex exec command-line fragments. Returns additional args to push onto the
 * `codex exec ...` argv. Uses `-c key=value` for config overrides.
 */
export function toCodexArgs(resolved: ResolvedSettings): string[] {
  const args: string[] = [];
  if (resolved.model && resolved.model !== 'default') {
    args.push('-c', `model="${resolved.model}"`);
  }
  if (resolved.reasoningEffort && resolved.reasoningEffort !== 'off') {
    // Codex doesn't support 'max' — clamp to 'high'.
    const effort = resolved.reasoningEffort === 'max' ? 'high' : resolved.reasoningEffort;
    args.push('-c', `model_reasoning_effort="${effort}"`);
  }
  // planMode is not supported by Codex — silently ignored (validation already
  // rejected it at resolve time for anyone setting it explicitly).
  return args;
}
