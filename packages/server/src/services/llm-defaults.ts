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

import type { Db } from 'mongodb';
import { isClaudeCompatibleProvider, PROVIDERS, type ChatProvider } from './chat-providers.js';

const FALLBACK_PROVIDER: ChatProvider = 'claude';
const FALLBACK_MODEL = 'claude-sonnet-4-6';

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
  // Open providers (e.g. DeepSeek, Xiaomi MiMo, Kimi) accept any non-empty model string.
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

  const chatProvider = chat as ChatProvider;
  const agentProvider = agentRaw as ChatProvider;

  return {
    claude: chatProvider === 'claude' || agentProvider === 'claude' || isClaudeCompatibleProvider(chatProvider) || isClaudeCompatibleProvider(agentProvider),
    codex: chat === 'codex' || agentRaw === 'codex',
  };
}

/**
 * Strip workflow-node `agentOverrides` fields that don't belong on the active
 * provider. Now validates against the model_registry collection instead of the
 * static PROVIDERS.models arrays (FR-4.2).
 *
 * @param overrides — The node's agentOverrides object from a workflow YAML node.
 * @param db — MongoDB handle, REQUIRED for the registry lookup.
 * @returns A new overrides object with non-applicable fields removed; undefined
 *   if all fields were stripped or the input was null/empty.
 *
 * Rules:
 *   - Preserve mode (env unset, "Both") → return overrides unchanged.
 *   - Flatten mode (env set):
 *       * `model` is dropped if it's a recognized fullId belonging to the
 *         OTHER provider. `'default'` and unknown strings pass through.
 *       * `planMode: true` dropped when env provider ≠ claude-cli and not
 *         a claude-compatible provider.
 *       * reasoning effort is preserved because supported levels are
 *         provider/model-specific and validated at the runtime boundary.
 */
export async function normalizeNodeOverridesForProvider(
  overrides: Record<string, unknown> | undefined | null,
  db: Db,
): Promise<Record<string, unknown> | undefined> {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return overrides === null ? undefined : overrides as Record<string, unknown> | undefined;
  }

  const envProvider = readEnvProvider();
  // Preserve mode: keep YAML intent exactly.
  if (!envProvider) return overrides;

  // Build model→provider lookup from the registry (FR-4.2).
  const modelOwner: Record<string, string> = {};
  try {
    const registryEntries = await db.collection('model_registry')
      .find({ isActive: true }, { projection: { fullId: 1, provider: 1 } })
      .toArray();
    for (const entry of registryEntries) {
      modelOwner[entry.fullId as string] = entry.provider as string;
    }
  } catch {
    // Registry unavailable — fall back to static PROVIDERS lookup (best-effort).
    for (const p of PROVIDERS) {
      for (const m of p.models) modelOwner[m] = p.provider;
    }
  }

  const out: Record<string, unknown> = { ...overrides };

  // model: drop only recognized fullIds belonging to the OTHER provider.
  // 'default' and unknown strings are NOT in modelOwner and pass through.
  if (typeof out.model === 'string') {
    const owner = modelOwner[out.model];
    if (owner && owner !== envProvider) {
      delete out.model;
    }
  }

  // planMode: claude-cli (and claude-compatible) only.
  if (out.planMode === true && envProvider !== 'claude' && !isClaudeCompatibleProvider(envProvider)) {
    delete out.planMode;
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
