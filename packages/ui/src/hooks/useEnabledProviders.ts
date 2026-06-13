import { useEffect, useMemo, useState } from 'react';
import { chat as chatApi, system as systemApi } from '../services/api';
import type { ModelRegistryEntry } from '../services/api';
import { updateRegistrySnapshot } from './useModelRegistry';

export type CliAuthStatus = 'logged_in' | 'not_logged_in' | 'cli_missing';

export type EnabledProvider = {
  provider: string;
  label: string;
  models: string[];
  defaultModel: string;
  open?: boolean;
  modelSuggestions?: string[];
  /** CLI providers only (claude, codex): login state of the local CLI. */
  authStatus?: CliAuthStatus;
};

function mergeRegistryIntoProviders(
  providerList: EnabledProvider[],
  registryModels: ModelRegistryEntry[],
): EnabledProvider[] {
  if (registryModels.length === 0) return providerList;
  const byProvider = new Map<string, string[]>();
  for (const m of registryModels) {
    if (!m.isActive) continue;
    const existing = byProvider.get(m.provider) ?? [];
    existing.push(m.fullId);
    byProvider.set(m.provider, existing);
  }
  if (byProvider.size === 0) return providerList;
  return providerList.map((p) => {
    const registryIds = byProvider.get(p.provider);
    if (registryIds && registryIds.length > 0) {
      return { ...p, models: registryIds, modelSuggestions: registryIds };
    }
    return p;
  });
}

/**
 * A CLI provider (claude/codex) is selectable only when its CLI is logged in;
 * API-key providers in the enabled list are always selectable. Use this to
 * filter provider dropdowns — the Settings panel shows ALL providers
 * (including logged-out CLIs) and should read the unfiltered list.
 */
export function isProviderSelectable(provider: EnabledProvider): boolean {
  return provider.authStatus === undefined || provider.authStatus === 'logged_in';
}

export function useEnabledProvidersStatus(): { providers: EnabledProvider[]; loaded: boolean } {
  const [providers, setProviders] = useState<EnabledProvider[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const providerList = (await chatApi.providers()) ?? [];
        // Client-side safety net: merge registry models into provider arrays
        try {
          const registry = await systemApi.models.list();
          updateRegistrySnapshot(registry.models ?? []);
          const merged = mergeRegistryIntoProviders(providerList as EnabledProvider[], registry.models ?? []);
          if (!cancelled) setProviders(merged);
          return;
        } catch {
          // Registry not available — use provider response as-is
        }
        if (!cancelled) setProviders(providerList as EnabledProvider[]);
      } catch {
        // Providers API unreachable — no invented fallback list (REQ-005);
        // consumers render a loading/empty state.
        if (!cancelled) setProviders([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolvedProviders = useMemo(() => providers ?? [], [providers]);

  return { providers: resolvedProviders, loaded: providers !== null };
}

export function useEnabledProviders(): EnabledProvider[] {
  return useEnabledProvidersStatus().providers;
}
