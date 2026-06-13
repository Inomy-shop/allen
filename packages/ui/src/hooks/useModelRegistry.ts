import { useEffect, useMemo, useState, useCallback } from 'react';
import { system as systemApi, type ModelRegistryEntry } from '../services/api';
import { humanLabel } from '../lib/model-catalog';

/** The provider id 'claude-cli' was renamed to 'claude'. Historical records
 *  (executions, traces) are never rewritten, so display lookups accept the
 *  legacy id forever and resolve it against the current registry. */
function canonicalProviderId(provider: string): string {
  return provider === 'claude-cli' ? 'claude' : provider;
}

export type { ModelRegistryEntry };

// ── Module-level registry snapshot ──────────────────────────────────────────
// Updated whenever any registry fetch completes (this hook or
// useEnabledProviders). Lets deep presentational components (agent cards,
// list rows, execution views) resolve registry-backed defaults without each
// mounting their own fetch. Non-reactive by itself — callers rely on a parent
// that mounts useModelRegistry() re-rendering them when the registry loads.
let registrySnapshot: ModelRegistryEntry[] = [];

/** @internal — also called by useEnabledProviders after its registry fetch. */
export function updateRegistrySnapshot(models: ModelRegistryEntry[]): void {
  if (models.length > 0) registrySnapshot = models;
}

function defaultModelFrom(
  models: ModelRegistryEntry[],
  provider: string,
  opts?: { preferTier?: 'opus' | 'flash' },
): string {
  const normalized = canonicalProviderId(provider);
  const active = models.filter((m) => m.provider === normalized && m.isActive);
  // The API returns models sorted by sortOrder, so the first matching tier
  // entry is the registry's preferred model for that tier.
  const pick = (opts?.preferTier ? active.find((m) => m.tier === opts.preferTier) : undefined)
    ?? active.find((m) => m.tier === 'default')
    ?? active[0];
  // Registry not loaded / no entry → empty; callers render a loading/empty
  // state rather than an invented model id (REQ-005).
  return pick?.fullId ?? '';
}

/**
 * Registry-backed default model for a provider (preferred tier → tier
 * 'default' → first active entry → static catalog). Reads the latest fetched
 * snapshot — for reactive use inside components that already mount the hook,
 * prefer `getDefaultModelForProvider` from useModelRegistry().
 */
export function registryDefaultModelForProvider(
  provider: string,
  opts?: { preferTier?: 'opus' | 'flash' },
): string {
  return defaultModelFrom(registrySnapshot, provider, opts);
}

/**
 * Legacy alias map — maps short alias names used in historical UI code to their
 * fullId counterparts so that `getModelDisplay` can resolve display names for
 * model values that were stored using the old alias convention.
 */
const LEGACY_ALIAS_MAP: Record<string, string> = {
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5-20251001',
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

export interface ModelDisplay {
  providerLabel: string;
  modelLabel: string;
}

/**
 * Resolve a human-readable label for a provider + model combination.
 *
 * Lookup chain (registry only — no static label maps, REQ-001/REQ-002):
 *   1. Registry snapshot — providerDisplayName + displayName
 *   2. Legacy alias / legacy provider-id resolution → registry retry
 *   3. Raw humanize via humanLabel()
 *
 * Never strips prefixes or hardcodes labels — always delegates to the chain.
 */
export function getModelDisplay(provider: string, model?: string): ModelDisplay {
  const canonical = canonicalProviderId(provider);

  // Resolve provider label from the registry.
  // Guard: reject blank/whitespace-only providerDisplayName.
  const providerLabel = (() => {
    const entry = registrySnapshot.find((e) => e.provider === canonical);
    if (entry?.providerDisplayName?.trim()) return entry.providerDisplayName;
    return humanLabel(canonical);
  })();

  if (!model) return { providerLabel, modelLabel: '' };

  // 1. Registry snapshot lookup.
  // Guard: reject blank/whitespace-only displayName.
  const snap = registrySnapshot.find((e) => e.provider === canonical && e.fullId === model);
  if (snap?.displayName?.trim()) return { providerLabel, modelLabel: snap.displayName };

  // 2. Legacy alias resolution → retry registry
  const resolvedFullId = LEGACY_ALIAS_MAP[model.toLowerCase()];
  if (resolvedFullId && resolvedFullId !== model) {
    const snap2 = registrySnapshot.find((e) => e.provider === canonical && e.fullId === resolvedFullId);
    if (snap2?.displayName?.trim()) return { providerLabel, modelLabel: snap2.displayName };
    // Registry entry exists but displayName is blank — use humanLabel on the
    // resolved fullId rather than the short alias (e.g. "Claude Opus 4 7"
    // instead of "Opus").
    if (snap2) return { providerLabel, modelLabel: humanLabel(resolvedFullId) };
  }

  // 3. Humanize the raw model string (NEVER strip prefixes)
  return { providerLabel, modelLabel: humanLabel(model) };
}

export interface CreateModelInput {
  provider: string;
  fullId: string;
  displayName: string;
  providerDisplayName: string;
  costInputPerMTok?: number | null;
  costOutputPerMTok?: number | null;
  costCacheReadPerMTok?: number | null;
  tier?: 'default' | 'opus' | 'flash' | null;
  sortOrder?: number;
}

export type UpdateModelInput = Partial<CreateModelInput> & { active?: boolean };

export interface UseModelRegistryReturn {
  /** All loaded models (active + optionally inactive) */
  models: ModelRegistryEntry[];
  loading: boolean;
  error: string | null;
  /** Refetch with optional filters */
  fetch: (options?: { provider?: string; includeInactive?: boolean }) => Promise<void>;
  /** Get dropdown options for a provider, with "Other…" appended. */
  getModelsForProvider: (provider: string) => { label: string; value: string }[];
  /** Registry default model for a provider (tier 'default' → first active → catalog). */
  getDefaultModelForProvider: (provider: string) => string;
  /** Admin CRUD */
  createModel: (data: CreateModelInput) => Promise<ModelRegistryEntry>;
  updateModel: (id: string, data: Partial<UpdateModelInput>) => Promise<ModelRegistryEntry>;
  deleteModel: (id: string) => Promise<void>;
}

export function useModelRegistry(): UseModelRegistryReturn {
  const [models, setModels] = useState<ModelRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async (options?: { provider?: string; includeInactive?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const result = await systemApi.models.list({
        includeInactive: options?.includeInactive,
        provider: options?.provider,
      });
      setModels(result.models ?? []);
      updateRegistrySnapshot(result.models ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load models';
      setError(message);
      setModels([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const getModelsForProvider = useCallback(
    (provider: string): { label: string; value: string }[] => {
      const normalized = canonicalProviderId(provider);
      const filtered = models
        .filter((m) => m.provider === normalized && m.isActive)
        .map((m) => ({
          label: m.displayName?.trim() || humanLabel(m.fullId),
          value: m.fullId,
        }));
      return filtered;
    },
    [models],
  );

  const getDefaultModelForProvider = useCallback(
    (provider: string): string => defaultModelFrom(models, provider),
    [models],
  );

  const createModel = useCallback(
    async (data: CreateModelInput): Promise<ModelRegistryEntry> => {
      const entry = await systemApi.models.create(data as unknown as Record<string, unknown>);
      await fetch();
      return entry;
    },
    [fetch],
  );

  const updateModel = useCallback(
    async (id: string, data: Partial<UpdateModelInput>): Promise<ModelRegistryEntry> => {
      const entry = await systemApi.models.update(id, data as unknown as Record<string, unknown>);
      await fetch();
      return entry;
    },
    [fetch],
  );

  const deleteModel = useCallback(
    async (id: string): Promise<void> => {
      await systemApi.models.delete(id);
      await fetch();
    },
    [fetch],
  );

  return {
    models,
    loading,
    error,
    fetch,
    getModelsForProvider,
    getDefaultModelForProvider,
    createModel,
    updateModel,
    deleteModel,
  };
}
