/**
 * Default agent provider/model resolution.
 *
 * Two helpers:
 *
 *   - `getAgentDefaults()` returns one provider+model pair used by routes that
 *     create agents from scratch (no seed reference). Falls back to
 *     `{ claude-cli, sonnet }` if env is unset.
 *
 *   - `resolveAgentProviderModel(seedProvider, seedModel)` is what seed code
 *     uses. It implements three modes via the env vars
 *     `ALLEN_DEFAULT_AGENT_PROVIDER` / `ALLEN_DEFAULT_AGENT_MODEL`:
 *
 *       1. Env UNSET → "preserve" mode. Return the seed's own provider+model
 *          verbatim. Used when the operator has BOTH CLIs installed and
 *          deliberately wants the seed's per-role mix (haiku for triage,
 *          opus for architects, codex for repo-scanner, etc.).
 *
 *       2. Env SET, seed provider matches env provider → "preserve model"
 *          mode. Provider follows env (cheap to verify the CLI is usable);
 *          model preserves the seed's choice when it is a valid model for
 *          that provider. This keeps role-specific opus/haiku/sonnet picks
 *          on same-provider installs.
 *
 *       3. Env SET, seed provider mismatches env (e.g. a codex-seeded agent
 *          on a claude-only install) → fall back to env model. Otherwise the
 *          agent would carry a model string that doesn't belong to the
 *          available CLI and fail at spawn time.
 *
 *   The setup script writes these env vars based on which CLIs are present
 *   and which option the user picked at the prompt.
 */

import { PROVIDERS, type ChatProvider } from './chat-providers.js';

const FALLBACK_PROVIDER: ChatProvider = 'claude-cli';
const FALLBACK_MODEL = 'sonnet';

function readEnvProvider(): ChatProvider | undefined {
  const raw = process.env.ALLEN_DEFAULT_AGENT_PROVIDER?.trim();
  if (raw && PROVIDERS.some((p) => p.provider === raw)) {
    return raw as ChatProvider;
  }
  return undefined;
}

function readEnvModel(provider: ChatProvider): string | undefined {
  const cfg = PROVIDERS.find((p) => p.provider === provider);
  const raw = process.env.ALLEN_DEFAULT_AGENT_MODEL?.trim();
  if (!raw) return undefined;
  // Open providers (e.g. DeepSeek) accept any non-empty model string.
  if (cfg?.open) return raw;
  if (cfg?.models.includes(raw)) return raw;
  return undefined;
}

export function getDefaultAgentProvider(): ChatProvider {
  return readEnvProvider() ?? FALLBACK_PROVIDER;
}

export function getDefaultAgentModel(): string {
  const provider = getDefaultAgentProvider();
  const cfg = PROVIDERS.find((p) => p.provider === provider);
  return readEnvModel(provider) ?? cfg?.defaultModel ?? FALLBACK_MODEL;
}

export function getAgentDefaults(): { provider: ChatProvider; model: string } {
  return { provider: getDefaultAgentProvider(), model: getDefaultAgentModel() };
}

/**
 * Which CLIs the install actually depends on, derived from the env vars
 * `ALLEN_DEFAULT_CHAT_PROVIDER` and `ALLEN_DEFAULT_AGENT_PROVIDER`.
 *
 * Used by the health check so that a Codex-only install doesn't fail on
 * "Claude Code CLI: missing" and vice versa.
 *
 *   - Preserve mode (agent env unset) → both required, because the seed
 *     contains a mix of agents pinned to each provider (architects on
 *     claude, repo-scanner on codex).
 *   - Flatten mode (agent env set) → only the chosen provider is required
 *     for agents. Chat provider adds its own requirement on top (if chat
 *     defaults to codex, codex must be reachable).
 */
export function getRequiredProviders(): { claude: boolean; codex: boolean } {
  const chatRaw = process.env.ALLEN_DEFAULT_CHAT_PROVIDER?.trim();
  const agentRaw = process.env.ALLEN_DEFAULT_AGENT_PROVIDER?.trim();

  // Preserve mode — seed agents span both providers, so both CLIs are needed.
  if (!agentRaw || !PROVIDERS.some((p) => p.provider === agentRaw)) {
    return { claude: true, codex: true };
  }

  // Flatten mode — chat default falls back to 'codex' when unset, mirroring
  // chat-providers.getDefaultChatProvider.
  const chat = chatRaw && PROVIDERS.some((p) => p.provider === chatRaw)
    ? chatRaw
    : 'codex';

  return {
    claude: chat === 'claude-cli' || agentRaw === 'claude-cli' || chat === 'deepseek' || agentRaw === 'deepseek',
    codex: chat === 'codex' || agentRaw === 'codex',
  };
}

/**
 * Strip workflow-node `agentOverrides` fields that don't belong on the active
 * provider. Used at workflow seed time so a YAML node like
 *
 *   agentOverrides: { model: sonnet, reasoningEffort: high, planMode: true }
 *
 * doesn't force Codex agents to try `sonnet` (which Codex rejects) on a
 * codex-only install.
 *
 * Rules:
 *   - Preserve mode (env unset, "Both") → return overrides unchanged. The
 *     user opted into the seed's mix; YAML intent stays.
 *   - Flatten mode (env set):
 *       * `model` is dropped if it's a recognized model belonging to the
 *         OTHER provider. `'default'` and unknown strings are left alone.
 *       * `planMode: true` is dropped when env provider ≠ claude-cli.
 *       * `reasoningEffort: 'max'` is dropped when env provider ≠ claude-cli.
 *       * Everything else (other reasoningEffort values, mcp toggles, etc.)
 *         passes through.
 *
 * Never swaps values (e.g. won't translate `sonnet` → `gpt-5.5`). When a
 * field is dropped the merged spawn settings fall back to the agent's stored
 * default — which `OrgSeedService` has already set to the env-chosen
 * provider+model — so the node runs on the install's available CLI.
 */
export function normalizeNodeOverridesForProvider(
  overrides: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return overrides === null ? undefined : overrides as Record<string, unknown> | undefined;
  }

  const envProvider = readEnvProvider();
  // Preserve mode: keep YAML intent exactly.
  if (!envProvider) return overrides;

  // Build the union "model X belongs to provider Y" lookup once.
  const modelOwner: Record<string, ChatProvider> = {};
  for (const p of PROVIDERS) {
    for (const m of p.models) modelOwner[m] = p.provider;
  }

  const out: Record<string, unknown> = { ...overrides };

  // model: drop only when it's a recognized model belonging to the OTHER
  // provider. 'default' and unknown strings are not in modelOwner so they
  // pass through.
  if (typeof out.model === 'string') {
    const owner = modelOwner[out.model];
    if (owner && owner !== envProvider) {
      delete out.model;
    }
  }

  // planMode is a claude-cli-only feature.
  if (out.planMode === true && envProvider !== 'claude-cli') {
    delete out.planMode;
  }

  // reasoningEffort 'max' requires claude (and Opus); other levels work on
  // both providers.
  if (out.reasoningEffort === 'max' && envProvider !== 'claude-cli') {
    delete out.reasoningEffort;
  }

  return out;
}

/**
 * Resolve the provider+model for a seeded agent given the env config.
 * See file-level docstring for the three modes.
 */
export function resolveAgentProviderModel(
  seedProvider: string,
  seedModel: string,
): { provider: ChatProvider; model: string } {
  const envProvider = readEnvProvider();

  // Mode 1: preserve — env unset means the operator opted for the seed mix.
  if (!envProvider) {
    const sp = PROVIDERS.some((p) => p.provider === seedProvider)
      ? (seedProvider as ChatProvider)
      : FALLBACK_PROVIDER;
    const cfg = PROVIDERS.find((p) => p.provider === sp);
    const model = (cfg?.open && seedModel)
      ? seedModel
      : cfg?.models.includes(seedModel)
        ? seedModel
        : cfg?.defaultModel ?? FALLBACK_MODEL;
    return { provider: sp, model };
  }

  const providerCfg = PROVIDERS.find((p) => p.provider === envProvider);
  const envModel = readEnvModel(envProvider) ?? providerCfg?.defaultModel ?? FALLBACK_MODEL;

  // Mode 2: same-provider hybrid — preserve role-specific model when valid.
  if (seedProvider === envProvider && (providerCfg?.open ? Boolean(seedModel) : providerCfg?.models.includes(seedModel))) {
    return { provider: envProvider, model: seedModel || (providerCfg?.defaultModel ?? FALLBACK_MODEL) };
  }

  // Mode 3: cross-provider mismatch — env wins so the agent runs on the
  // available CLI.
  return { provider: envProvider, model: envModel };
}
