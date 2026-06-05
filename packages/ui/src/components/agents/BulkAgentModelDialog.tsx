import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Check, Loader2, Settings, X } from 'lucide-react';
import { agents as agentsApi, type BulkModelSkipped, type BulkUpdateModelResponse } from '../../services/api';
import { useEnabledProvidersStatus, type EnabledProvider } from '../../hooks/useEnabledProviders';
import Select from '../common/Select';
import IconTooltipButton from '../common/IconTooltipButton';
import { useToast } from '../common/Toast';

const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];
const CODEX_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.1-codex-mini'];

type BulkAgentModelDialogProps = {
  open: boolean;
  agentNames: string[];
  onClose: () => void;
  onUpdated: (result: BulkUpdateModelResponse) => void | Promise<void>;
};

function getModelsForProvider(provider: string, enabledProviders: EnabledProvider[]): string[] {
  if (provider === 'codex') return CODEX_MODELS;
  if (enabledProviders.some((item) => item.provider === provider && item.open)) return [];
  return CLAUDE_MODELS;
}

function providerToBackendValue(uiProvider: string): string {
  if (uiProvider === 'claude') return 'claude-cli';
  return uiProvider;
}

function providerLabel(provider: string, enabledProviders: EnabledProvider[]): string {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  const configured = enabledProviders.find((item) => item.provider === provider);
  if (configured?.label) return configured.label;
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'xiaomi-mimo') return 'Xiaomi MiMo';
  if (provider === 'kimi') return 'Kimi';
  return provider;
}

function getOpenProviderModelSuggestions(enabledProviders: EnabledProvider[]): Record<string, string[]> {
  return Object.fromEntries(
    enabledProviders
      .filter((item) => item.open)
      .map((item) => [item.provider, item.modelSuggestions && item.modelSuggestions.length > 0
        ? item.modelSuggestions
        : [item.defaultModel]]),
  ) as Record<string, string[]>;
}

export default function BulkAgentModelDialog({
  open,
  agentNames,
  onClose,
  onUpdated,
}: BulkAgentModelDialogProps) {
  const toast = useToast();
  const { providers: enabledProviders, loaded: enabledProvidersLoaded } = useEnabledProvidersStatus();
  const [provider, setProvider] = useState('claude');
  const [model, setModel] = useState('sonnet');
  const [clearIncompatibleSettings, setClearIncompatibleSettings] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const availableUiProviders = useMemo(() => new Set([
    ...enabledProviders.map((item) => item.provider === 'claude-cli' ? 'claude' : item.provider),
  ]), [enabledProviders]);

  const openProviderModelSuggestions = useMemo(
    () => getOpenProviderModelSuggestions(enabledProviders),
    [enabledProviders],
  );

  const providerOptions = useMemo(() => [
    ...(availableUiProviders.has('claude') ? ['claude'] : []),
    ...(availableUiProviders.has('codex') ? ['codex'] : []),
    ...enabledProviders.filter((item) => item.open).map((item) => item.provider),
  ].filter((p, index, all) => all.indexOf(p) === index).map((p) => ({
    value: p,
    label: providerLabel(p, enabledProviders),
  })), [availableUiProviders, enabledProviders]);

  const modelOptions = useMemo(
    () => getModelsForProvider(provider, enabledProviders).map((item) => ({ value: item, label: item })),
    [enabledProviders, provider],
  );
  const openModelSuggestions = openProviderModelSuggestions[provider];
  const openModelOptions = [
    ...(openModelSuggestions ?? []).map((item) => ({ value: item, label: item })),
    ...(openModelSuggestions && model && !openModelSuggestions.includes(model)
      ? [{ value: model, label: model, sublabel: 'Custom model ID' }]
      : []),
  ];

  useEffect(() => {
    if (!open) return;
    setProvider('claude');
    setModel('sonnet');
    setClearIncompatibleSettings(false);
    setSubmitting(false);
    setError('');
  }, [open]);

  useEffect(() => {
    if (!open || !enabledProvidersLoaded || availableUiProviders.has(provider)) return;
    setProvider('claude');
    setModel('sonnet');
  }, [availableUiProviders, enabledProvidersLoaded, open, provider]);

  function handleProviderChange(nextProvider: string) {
    setProvider(nextProvider);
    const openSuggestions = openProviderModelSuggestions[nextProvider];
    if (openSuggestions) {
      setModel(openSuggestions[0] ?? '');
      return;
    }
    const fixedModels = getModelsForProvider(nextProvider, enabledProviders);
    setModel(fixedModels[0] ?? '');
  }

  async function submit() {
    const trimmedModel = model.trim();
    if (agentNames.length === 0 || !trimmedModel || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await agentsApi.bulkUpdateModel({
        agentNames,
        provider: providerToBackendValue(provider),
        model: trimmedModel,
        clearIncompatibleSettings,
      });
      const updatedCount = result.updated.length;
      const skippedCount = result.skipped.length;
      toast.success(`Updated ${updatedCount} agent${updatedCount === 1 ? '' : 's'}${skippedCount ? `, skipped ${skippedCount}` : ''}.`);
      await onUpdated(result);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update selected agents');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const updateDisabled = agentNames.length === 0 || !model.trim() || submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[620px] max-w-full flex-col overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-app px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app bg-app text-accent">
              <Settings className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <h3 className="text-[17px] font-semibold tracking-tight text-theme-primary">Change model</h3>
              <p className="mt-1 text-[13px] text-theme-muted">
                Update the provider and model for {agentNames.length} selected agent{agentNames.length === 1 ? '' : 's'}.
              </p>
            </div>
          </div>
          <IconTooltipButton label="Close" onClick={onClose} className="h-9 w-9">
            <X className="h-4 w-4" />
          </IconTooltipButton>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[13px] text-accent-red">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="overline">Selected Agents</label>
              <span className="font-mono text-[11px] text-theme-muted">{agentNames.length} selected</span>
            </div>
            <div className="max-h-28 overflow-y-auto rounded-md border border-app bg-app-muted px-3 py-2">
              {agentNames.length === 0 ? (
                <div className="py-2 text-[12px] text-theme-muted">No agents selected.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {agentNames.map((name) => (
                    <span key={name} className="max-w-full truncate rounded border border-app bg-app px-2 py-1 font-mono text-[11px] text-theme-secondary">
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block overline">Provider</label>
              <Select
                value={provider}
                onChange={handleProviderChange}
                options={providerOptions}
                searchable={false}
              />
            </div>
            <div>
              <label className="mb-1.5 block overline">Model</label>
              {openModelSuggestions ? (
                <Select
                  value={model}
                  onChange={setModel}
                  searchPlaceholder="Search or enter model ID..."
                  placeholder={`e.g. ${openModelSuggestions[0] ?? 'provider-model'}`}
                  options={openModelOptions}
                  allowCustomValue
                />
              ) : (
                <Select value={model} onChange={setModel} options={modelOptions} />
              )}
            </div>
          </section>

          <section className="rounded-md border border-accent-yellow/30 bg-accent-yellow/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent-yellow" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-theme-primary">Incompatible settings</div>
                <p className="mt-1 text-[12px] leading-relaxed text-theme-muted">
                  Some agents may have Plan Mode or Max reasoning settings that are not compatible with the selected provider/model.
                  Leave this unchecked to skip those agents.
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12px] text-theme-secondary">
                  <input
                    type="checkbox"
                    checked={clearIncompatibleSettings}
                    onChange={event => setClearIncompatibleSettings(event.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-app bg-app-muted text-accent focus:ring-accent"
                  />
                  <span>Clear incompatible settings when needed</span>
                </label>
              </div>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app px-6 py-4">
          <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={updateDisabled}
            className="btn btn-primary btn-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {submitting ? 'Updating...' : 'Update'}
          </button>
        </div>
      </div>
    </div>
  );
}

export type { BulkModelSkipped };
