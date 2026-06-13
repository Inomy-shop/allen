/**
 * model-catalog.ts — shared model-dropdown helpers for the UI.
 *
 * The model registry (GET /api/system/models, surfaced via `useModelRegistry`)
 * is the ONLY source of provider/model knowledge in the UI. There are no
 * static model lists here by design (REQ-005): when the registry and the
 * providers API haven't loaded yet, dropdowns render a loading/empty state
 * instead of an invented list.
 *
 * Do NOT add per-component model lists or provider-name maps anywhere in the
 * UI — resolve labels via `getModelDisplay` from useModelRegistry.
 */

export interface ModelOption {
  label: string;
  value: string;
}

/**
 * Convert a raw identifier (snake-case, kebab-case, underscore-separated) into
 * a human-readable label by replacing separators with spaces and capitalizing
 * each word. Last-resort formatting only — registry displayName wins.
 *
 * Bracket annotations like `[1m]` (short for context-window size) are
 * normalised to `[1M]` so the human-readable label preserves context hints.
 */
export function humanLabel(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\[([a-z\d]+)\]/g, (m) => m.toUpperCase());
}

/**
 * Per-provider color tokens for dot and text indicators in sidebar / rows.
 * Pure cosmetics — not display names. 'claude-cli' is kept as a legacy key so
 * historical execution rows (which are never migrated) stay colored.
 */
export const PROVIDER_COLORS: Record<string, { color: string; dotBg: string }> = {
  codex: { color: 'text-accent-green', dotBg: 'bg-accent-green' },
  claude: { color: 'text-accent', dotBg: 'bg-accent' },
  'claude-cli': { color: 'text-accent', dotBg: 'bg-accent' },
  deepseek: { color: 'text-accent-blue', dotBg: 'bg-accent-blue' },
  'xiaomi-mimo': { color: 'text-accent-blue', dotBg: 'bg-accent-blue' },
  kimi: { color: 'text-accent-blue', dotBg: 'bg-accent-blue' },
};

/** Minimal structural shape of an enabled provider (see useEnabledProviders). */
export interface ProviderLike {
  provider: string;
  open?: boolean;
  models?: string[];
  modelSuggestions?: string[];
  defaultModel?: string;
}

/** Sentinel option that switches dropdowns into free-text model entry. */
export const OTHER_MODEL_OPTION: ModelOption = { label: 'Other…', value: '__other__' };

/**
 * Build dropdown options for a provider's model select.
 *
 * Source priority:
 *   1. `registryModels` — entries from the model registry (label=displayName,
 *      value=fullId). This is the normal path.
 *   2. The enabled-provider payload from /chat/providers, whose model arrays
 *      are themselves registry-patched server-side.
 *
 * No static fallback: with neither source loaded the list is empty (plus the
 * "Other…" free-text escape hatch).
 *
 * @param currentModel Optional model value that must appear in the options.
 *   If it is not present in the registry/provider lists (e.g. an inactive
 *   model on a saved agent), it is appended with a human-readable label to
 *   prevent the Select trigger from showing blank.
 */
export function buildModelOptionsForProvider(
  provider: string,
  enabledProviders: ProviderLike[],
  registryModels: ModelOption[] = [],
  currentModel?: string,
): ModelOption[] {
  const base: ModelOption[] = registryModels.length > 0
    ? registryModels.map((m) => ({
        label: m.label?.trim() || humanLabel(m.value),
        value: m.value,
      }))
    : (() => {
        const enabled = enabledProviders.find((item) => item.provider === provider);
        const ids = (enabled?.open ? enabled.modelSuggestions : enabled?.models) ?? [];
        return ids.map((model) => ({ label: model, value: model }));
      })();

  // If the currently-selected/saved model is not in the options, append it so
  // the Select trigger never shows blank for a value that exists in saved data
  // but is absent from the active registry.  Skip blank `currentModel` to
  // avoid appending a meaningless entry.
  if (currentModel?.trim() && !base.some((m) => m.value === currentModel)) {
    base.push({ label: humanLabel(currentModel), value: currentModel });
  }

  return [...base, OTHER_MODEL_OPTION];
}

/**
 * Per-provider model suggestions for open (API) providers.
 * `modelSuggestions` on the enabled-provider payload is registry-patched by
 * the server, so the registry remains the source of truth here too.
 */
export function getOpenProviderModelSuggestions(
  enabledProviders: ProviderLike[],
): Record<string, string[]> {
  return Object.fromEntries(
    enabledProviders
      .filter((item) => item.open)
      .map((item) => [
        item.provider,
        item.modelSuggestions && item.modelSuggestions.length > 0
          ? item.modelSuggestions
          : item.defaultModel ? [item.defaultModel] : [],
      ]),
  ) as Record<string, string[]>;
}
