import { useEffect, useMemo, useState } from 'react';
import { chat as chatApi } from '../services/api';

export type EnabledProvider = {
  provider: string;
  label: string;
  models: string[];
  defaultModel: string;
  open?: boolean;
  modelSuggestions?: string[];
};

const FALLBACK_PROVIDERS: EnabledProvider[] = [
  {
    provider: 'claude-cli',
    label: 'Claude (CLI)',
    models: ['sonnet', 'opus', 'haiku'],
    defaultModel: 'sonnet',
  },
  {
    provider: 'codex',
    label: 'Codex (CLI)',
    models: ['gpt-5.5', 'gpt-5.4', 'o3', 'o4-mini', 'codex-mini'],
    defaultModel: 'gpt-5.5',
  },
];

export function useEnabledProvidersStatus(): { providers: EnabledProvider[]; loaded: boolean } {
  const [providers, setProviders] = useState<EnabledProvider[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    chatApi.providers()
      .then((list) => {
        if (!cancelled) setProviders((list ?? []) as EnabledProvider[]);
      })
      .catch(() => {
        if (!cancelled) setProviders(FALLBACK_PROVIDERS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resolvedProviders = useMemo(() => {
    const list = providers && providers.length > 0 ? providers : FALLBACK_PROVIDERS;
    const byId = new Map<string, EnabledProvider>();
    for (const provider of list) byId.set(provider.provider, provider);
    for (const provider of FALLBACK_PROVIDERS) {
      if (!byId.has(provider.provider)) byId.set(provider.provider, provider);
    }
    return [...byId.values()];
  }, [providers]);

  return { providers: resolvedProviders, loaded: providers !== null };
}

export function useEnabledProviders(): EnabledProvider[] {
  return useEnabledProvidersStatus().providers;
}
