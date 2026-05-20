export type AllenContextProvider = 'allen' | 'cognee' | 'cognee_memory';
export type CogneeMandatoryGraphMode = 'auto' | 'required' | 'off';
export type ContextIndexGraphMode = 'full_graph' | 'mandatory_context_map';

const DISABLED_CONTEXT_PROVIDER_VALUES = new Set(['', 'none', 'off', 'disabled']);
const KNOWN_CONTEXT_PROVIDERS = new Set<AllenContextProvider>(['allen', 'cognee', 'cognee_memory']);
const LEGACY_CONTEXT_PROVIDER_ALIASES = new Map<string, AllenContextProvider>([['graph', 'allen']]);

export function configuredContextProvider(): AllenContextProvider | null {
  const raw = rawContextProviderValue().toLowerCase();
  if (DISABLED_CONTEXT_PROVIDER_VALUES.has(raw)) return null;
  const aliased = LEGACY_CONTEXT_PROVIDER_ALIASES.get(raw);
  if (aliased) return aliased;
  if (KNOWN_CONTEXT_PROVIDERS.has(raw as AllenContextProvider)) return raw as AllenContextProvider;
  return null;
}

export function rawContextProviderValue(): string {
  return (process.env.ALLEN_CONTEXT_PROVIDER ?? '').trim();
}

export function isContextEngineEnabled(): boolean {
  return configuredContextProvider() !== null;
}

export function isCogneeContextEnabled(): boolean {
  const provider = configuredContextProvider();
  return provider === 'cognee' || provider === 'cognee_memory';
}

export function cogneeMandatoryGraphMode(): CogneeMandatoryGraphMode {
  const raw = (process.env.ALLEN_COGNEE_MANDATORY_GRAPH ?? 'auto').trim().toLowerCase();
  if (raw === 'auto' || raw === 'required' || raw === 'off') return raw;
  if (raw === 'true' || raw === 'enabled' || raw === 'on' || raw === '1') return 'auto';
  if (raw === 'false' || raw === 'disabled' || raw === 'none' || raw === '0') return 'off';
  return 'auto';
}

export function isCogneeMandatoryGraphEnabled(): boolean {
  return isCogneeContextEnabled() && cogneeMandatoryGraphMode() !== 'off';
}

export function isGraphContextEnabled(): boolean {
  return configuredContextProvider() === 'allen';
}

export function contextIndexGraphModeForProvider(
  provider: AllenContextProvider | null = configuredContextProvider(),
): ContextIndexGraphMode | null {
  if (provider === 'allen') return 'full_graph';
  if (provider === 'cognee' || provider === 'cognee_memory') return 'mandatory_context_map';
  return null;
}

export function contextProviderRuntimeConfig(): {
  enabled: boolean;
  provider: AllenContextProvider | null;
  cogneeEnabled: boolean;
} {
  const provider = configuredContextProvider();
  return {
    enabled: provider !== null,
    provider,
    cogneeEnabled: provider === 'cognee' || provider === 'cognee_memory',
  };
}

export function contextProviderDisabledError(message = 'Context provider is disabled. Set ALLEN_CONTEXT_PROVIDER to enable context engine flows.'): Error {
  const error = new Error(message);
  (error as Error & { code?: string; statusCode?: number }).code = 'CONTEXT_PROVIDER_DISABLED';
  (error as Error & { code?: string; statusCode?: number }).statusCode = 409;
  return error;
}
