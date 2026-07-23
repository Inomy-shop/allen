import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleDot,
  Loader2,
} from 'lucide-react';
import Select from '../components/common/Select';
import ProviderIcon, { providerIconColor } from '../components/common/ProviderIcon';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { system } from '../services/api';
import { useModelRegistry } from '../hooks/useModelRegistry';
import { registryDefaultModelForProvider, getModelDisplay } from '../hooks/useModelRegistry';

type Provider = 'codex' | 'claude' | (string & {});
type AgentProvider = '' | Provider;
type ApiProvider = string;

interface HealthCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
}

interface HealthSummary {
  checks: HealthCheck[];
}

// Onboarding-only descriptive copy for known model ids. The model lists
// themselves come from the registry (preferred) or the shared static catalog.
const MODEL_SUBLABELS: Record<string, string> = {
  fable: 'Latest Claude model for inbuilt agents',
  opus: 'Highest-capability Claude model for inbuilt agents',
  sonnet: 'Balanced Claude model for inbuilt agents',
  haiku: 'Fastest Claude model for inbuilt agents',
  'gpt-5.5': 'Default high-capability Codex model for inbuilt agents',
  'gpt-5.4': 'Previous high-capability Codex model',
  'gpt-5.3-codex': 'Codex-tuned model for agent coding work',
  'gpt-5.2-codex': 'Codex-tuned model for agent coding work',
  'gpt-5.1-codex-max': 'Higher-effort Codex agent model',
  'gpt-5.2': 'General GPT model available to Codex provider',
  'gpt-5.1-codex-mini': 'Lower-latency Codex agent model',
  'deepseek-v4-pro[1m]': 'High-capability DeepSeek model',
  'deepseek-v4-flash': 'Fast DeepSeek model',
  'mimo-v2.5-pro': 'Default Xiaomi MiMo model',
  'kimi-k2.6': 'Kimi opus-equivalent model',
  'kimi-k2.5': 'Kimi sonnet and flash model',
};

const API_PROVIDER_OPTIONS: Array<{
  label: string;
  value: ApiProvider;
  apiKey: string;
}> = [
  {
    label: getModelDisplay('deepseek').providerLabel,
    value: 'deepseek',
    apiKey: 'ALLEN_DEEPSEEK_API_KEY',
  },
  {
    label: getModelDisplay('xiaomi-mimo').providerLabel,
    value: 'xiaomi-mimo',
    apiKey: 'ALLEN_XIAOMI_MIMO_API_KEY',
  },
  {
    label: getModelDisplay('kimi').providerLabel,
    value: 'kimi',
    apiKey: 'ALLEN_KIMI_API_KEY',
  },
];

function apiProviderOption(provider: string): (typeof API_PROVIDER_OPTIONS)[number] | undefined {
  return API_PROVIDER_OPTIONS.find(option => option.value === provider);
}

function isApiProvider(provider: string): provider is ApiProvider {
  return Boolean(apiProviderOption(provider));
}

function checkPassed(summary: HealthSummary | null, id: string): boolean {
  return Boolean(summary?.checks.some(check => check.id === id && check.status === 'pass'));
}

function defaultAgentModel(provider: AgentProvider): string {
  if (!provider) return '';
  // Registry-backed. Claude inbuilt agents intentionally default to the
  // highest-capability (opus-tier) registry model.
  return registryDefaultModelForProvider(
    provider,
    provider === 'claude' ? { preferTier: 'opus' } : undefined,
  );
}

export default function OnboardingModelDefaultsPage() {
  const navigate = useNavigate();
  const checkingOnboarding = useOnboardingGate('model_defaults');
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
  const { getModelsForProvider: registryGetModelsForProvider } = useModelRegistry();
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatProvider, setChatProvider] = useState<Provider>('codex');
  const [agentProvider, setAgentProvider] = useState<AgentProvider>('');
  const [agentModel, setAgentModel] = useState('');

  const providerState = useMemo(() => {
    const claudeReady = checkPassed(health, 'claude_cli') && checkPassed(health, 'claude_auth');
    const codexReady = checkPassed(health, 'codex_cli') && checkPassed(health, 'codex_auth');
    return { claudeReady, codexReady };
  }, [health]);

  useEffect(() => {
    if (checkingOnboarding) return;
    if (!isDesktop) {
      navigate('/onboarding/repository', { replace: true });
      return;
    }
    let cancelled = false;
    setLoading(true);
    system.health()
      .then(summary => {
        if (cancelled) return;
        setHealth(summary);
        const claudeReady = checkPassed(summary, 'claude_cli') && checkPassed(summary, 'claude_auth');
        const codexReady = checkPassed(summary, 'codex_cli') && checkPassed(summary, 'codex_auth');
        const nextAgentProvider: AgentProvider = claudeReady && codexReady
          ? ''
          : claudeReady
            ? 'claude'
            : codexReady
              ? 'codex'
              : '';
        setChatProvider(codexReady ? 'codex' : 'claude');
        setAgentProvider(nextAgentProvider);
        setAgentModel(defaultAgentModel(nextAgentProvider));
      })
      .catch(err => {
        if (!cancelled) setError((err as Error).message || 'Could not load provider health');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [checkingOnboarding, isDesktop, navigate]);

  const providerOptions = [
    {
      label: 'Codex',
      value: 'codex',
      sublabel: providerState.codexReady
        ? 'Ready for chat and inbuilt agent defaults'
        : 'Disabled until Codex CLI and auth pass health',
      disabled: !providerState.codexReady,
      icon: <ProviderIcon provider="codex" className={`h-4 w-4 ${providerIconColor('codex')}`} />,
    },
    {
      label: getModelDisplay('claude').providerLabel,
      value: 'claude',
      sublabel: providerState.claudeReady
        ? 'Ready for chat and inbuilt agent defaults'
        : 'Disabled until Claude CLI and auth pass health',
      disabled: !providerState.claudeReady,
      icon: <ProviderIcon provider="claude" className={`h-4 w-4 ${providerIconColor('claude')}`} />,
    },
    ...API_PROVIDER_OPTIONS.map(option => ({
      label: option.label,
      value: option.value,
      sublabel: `Requires ${option.apiKey} to be configured in Settings > Secrets`,
      disabled: false,
      icon: <ProviderIcon provider={option.value} className={`h-4 w-4 ${providerIconColor(option.value)}`} />,
    })),
  ];
  const agentProviderOptions = [
    {
      label: 'Keep inbuilt defaults',
      value: '',
      sublabel: 'Keep each bundled agent/workflow on its role-specific provider and model',
      disabled: !(providerState.claudeReady && providerState.codexReady),
    },
    ...providerOptions.map(option => ({
      ...option,
      label: `Flatten to ${option.label}`,
      sublabel: option.disabled
        ? option.sublabel
        : `Use ${option.label} for all inbuilt agents and workflows`,
    })),
  ];
  const apiAgentProviderOption = isApiProvider(agentProvider) ? apiProviderOption(agentProvider) : undefined;
  const registryModelOptions = useMemo(() => registryGetModelsForProvider(agentProvider), [registryGetModelsForProvider, agentProvider]);
  const hasRegistryModels = registryModelOptions.length > 0;
  // Registry only — while it loads the dropdown is empty (REQ-005).
  const modelOptions = hasRegistryModels
    ? [
        ...registryModelOptions.map((m) => ({
          label: m.label,
          value: m.value,
          sublabel: MODEL_SUBLABELS[m.value] ?? '',
          icon: <ProviderIcon provider={agentProvider} className={`h-4 w-4 ${providerIconColor(agentProvider)}`} />,
        })),
        { label: 'Other…', value: '__other__' },
      ]
    : [];
  const apiSuggestions = apiAgentProviderOption
    ? registryModelOptions.map((m) => ({
        label: m.label,
        value: m.value,
        sublabel: MODEL_SUBLABELS[m.value] ?? '',
        icon: <ProviderIcon provider={agentProvider} className={`h-4 w-4 ${providerIconColor(agentProvider)}`} />,
      }))
    : [];
  const apiModelOptions = [
    ...apiSuggestions,
    ...(apiAgentProviderOption && agentModel && !apiSuggestions.some(option => option.value === agentModel)
      ? [{
          label: agentModel,
          value: agentModel,
          sublabel: 'Custom model ID',
          icon: <ProviderIcon provider={agentProvider} className={`h-4 w-4 ${providerIconColor(agentProvider)}`} />,
        }]
      : []),
  ];
  const canSave = !loading
    && !saving
    && (isApiProvider(chatProvider) ? true : chatProvider === 'codex' ? providerState.codexReady : providerState.claudeReady)
    && (
      agentProvider === ''
        ? providerState.claudeReady && providerState.codexReady
        : agentProvider === 'codex'
          ? providerState.codexReady
          : isApiProvider(agentProvider)
            ? true
            : providerState.claudeReady
    );

  async function saveDefaults() {
    setSaving(true);
    setError(null);
    try {
      await system.saveDesktopOnboardingModelDefaults({
        chatProvider,
        agentProvider,
        agentModel,
      });
      await system.updateOnboardingProgress({ step: 'repository' }).catch(() => {});
      navigate('/onboarding/repository', { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Could not save model defaults');
    } finally {
      setSaving(false);
    }
  }

  const bootstrapSteps: Array<{
    number: string;
    title: string;
    copy: string;
    state: 'done' | 'active' | 'next';
  }> = [
    { number: '01', title: 'Create admin', copy: 'Admin account is ready for this instance.', state: 'done' },
    { number: '02', title: 'Verify runtime', copy: 'Core machine checks are complete.', state: 'done' },
    { number: '03', title: 'Choose models', copy: 'Set chat and inbuilt workflow defaults.', state: 'active' },
    { number: '04', title: 'Connect repo', copy: 'Register a checkout or clone a starter repository.', state: 'next' },
    { number: '05', title: 'Start workflow', copy: 'Launch a small bug fix or feature run.', state: 'next' },
  ];

  if (checkingOnboarding) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app text-[13px] text-theme-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-accent" />
        Loading onboarding
      </div>
    );
  }

  return (
    <OnboardingShell
      step="model_defaults"
      eyebrow="desktop models"
      title="Choose model defaults"
      description="Choose which local AI provider Allen should use by default. These choices are used only by this desktop app when it creates new chats, inbuilt agents, and inbuilt workflow templates."
      runtimeLabel="desktop runtime"
      runtimeCopy="Desktop stores these choices in the local runtime config, not the repo .env file."
      side={(
        <div className="onboarding-card mt-8 rounded-md border border-app bg-app-card p-4">
          <div className="mb-4">
            <div className="font-mono text-[10.5px] text-theme-subtle">bootstrap path</div>
            <div className="mt-1 text-[13px] font-semibold text-theme-primary">Provider defaults</div>
          </div>
          <div className="space-y-0">
            {bootstrapSteps.map(({ number, title, copy, state }) => (
              <div key={number} className="onboarding-step grid grid-cols-[24px_minmax(0,1fr)] gap-3">
                <div className="relative flex justify-center">
                  <div className={`onboarding-step-icon mt-0.5 grid h-5 w-5 place-items-center rounded-full ${
                    state === 'active' ? 'text-accent' : state === 'done' ? 'text-accent-green' : 'text-theme-subtle'
                  }`}>
                    {state === 'done'
                      ? <CheckCircle2 className="h-5 w-5" />
                      : state === 'active'
                        ? <CircleDot className="h-5 w-5" />
                        : <Circle className="h-5 w-5" />}
                  </div>
                  {number !== '05' && (
                    <div className={`onboarding-step-line absolute bottom-0 top-6 w-px ${
                      state === 'done' ? 'bg-accent-green/35' : 'bg-border'
                    }`} />
                  )}
                </div>
                <div className="pb-4">
                  <div className={`text-[13px] font-semibold ${state === 'active' ? 'text-accent' : 'text-theme-primary'}`}>
                    {title}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-5 text-theme-muted">{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    >
      <div className="onboarding-card onboarding-panel-enter rounded-md border border-app bg-app-card p-5 shadow-sm sm:p-6">
        <div className="mb-5">
          <h2 className="text-[22px] font-semibold text-theme-primary">Model defaults</h2>
          <p className="mt-1 text-[13px] leading-5 text-theme-muted">
            Health detected which local CLIs are installed and authenticated. Disabled options cannot be selected until their CLI and login checks pass.
          </p>
        </div>

        {loading ? (
          <div className="onboarding-soft-enter flex items-center gap-2 rounded-md border border-app bg-app-muted px-3 py-2 text-[12px] text-theme-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading provider status
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <div className={`rounded-md border px-3 py-2 ${providerState.codexReady ? 'border-accent-green/25 bg-accent-green/10' : 'border-accent-yellow/25 bg-accent-yellow/10'}`}>
                <div className="flex items-center gap-2 text-[12px] font-semibold text-theme-primary">
                  <ProviderIcon provider="codex" className={`h-4 w-4 ${providerIconColor('codex')}`} />
                  Codex
                  {providerState.codexReady ? <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-accent-green" /> : <AlertTriangle className="ml-auto h-3.5 w-3.5 text-accent-yellow" />}
                </div>
                <div className="mt-1 font-mono text-[10.5px] text-theme-muted">
                  {providerState.codexReady ? 'cli + auth ready' : 'run codex login, then recheck health'}
                </div>
              </div>
              <div className={`rounded-md border px-3 py-2 ${providerState.claudeReady ? 'border-accent-green/25 bg-accent-green/10' : 'border-accent-yellow/25 bg-accent-yellow/10'}`}>
                <div className="flex items-center gap-2 text-[12px] font-semibold text-theme-primary">
                  <ProviderIcon provider="claude" className={`h-4 w-4 ${providerIconColor('claude')}`} />
                  Claude
                  {providerState.claudeReady ? <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-accent-green" /> : <AlertTriangle className="ml-auto h-3.5 w-3.5 text-accent-yellow" />}
                </div>
                <div className="mt-1 font-mono text-[10.5px] text-theme-muted">
                  {providerState.claudeReady ? 'cli + auth ready' : 'run claude login, then recheck health'}
                </div>
              </div>
              {API_PROVIDER_OPTIONS.map((option) => (
                <div key={option.value} className="rounded-md border border-accent-blue/25 bg-accent-blue/10 px-3 py-2">
                  <div className="flex items-center gap-2 text-[12px] font-semibold text-theme-primary">
                    <ProviderIcon provider={option.value} className={`h-4 w-4 ${providerIconColor(option.value)}`} />
                    {option.label}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-theme-muted">
                    configure {option.apiKey} in Settings
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <label className="block font-mono text-[11px] font-medium lowercase text-theme-muted">default chat provider</label>
              <Select
                value={chatProvider}
                onChange={(value) => setChatProvider(value as Provider)}
                options={providerOptions}
                searchable={false}
              />
              <p className="text-[11px] leading-4 text-theme-subtle">
                Used when you start a new chat and do not choose a provider in the chat screen.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block font-mono text-[11px] font-medium lowercase text-theme-muted">inbuilt agents and workflows</label>
              <Select
                value={agentProvider}
                onChange={(value) => {
                  const next = value as AgentProvider;
                  setAgentProvider(next);
                  setAgentModel(defaultAgentModel(next));
                }}
                options={agentProviderOptions}
                searchable={false}
              />
              <p className="text-[11px] leading-4 text-theme-subtle">
                Used for Allen's ready-made agents and workflow templates. Keep inbuilt defaults uses the recommended provider and model for each role. Flatten uses one provider for all of them.
              </p>
            </div>

            {agentProvider && (
              <div className="space-y-1.5">
                <label className="block font-mono text-[11px] font-medium lowercase text-theme-muted">model for inbuilt agents and workflows</label>
                {isApiProvider(agentProvider) ? (
                  <Select
                    value={agentModel}
                    onChange={setAgentModel}
                    searchPlaceholder="Search or enter model ID..."
                    placeholder={`e.g. ${apiSuggestions[0]?.value ?? 'provider-model'}`}
                    options={apiModelOptions}
                    allowCustomValue
                  />
                ) : (
                  <Select
                    value={agentModel}
                    onChange={setAgentModel}
                    options={modelOptions}
                    searchable={false}
                  />
                )}
                <p className="text-[11px] leading-4 text-theme-subtle">
                  Used when all inbuilt agents and workflow templates are set to the same provider.
                </p>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="onboarding-soft-enter mt-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">
            {error}
          </div>
        )}

        {!loading && !canSave && (
          <div className="onboarding-soft-enter mt-4 rounded-md border border-accent-yellow/25 bg-accent-yellow/10 px-3 py-2 text-[12px] text-theme-muted">
            Authenticate the provider you want to use in a terminal, then return to health and retry. Keep inbuilt defaults requires both Codex and Claude CLI to be ready.
          </div>
        )}

        <button
          type="button"
          disabled={!canSave}
          onClick={saveDefaults}
          className="onboarding-control btn-primary mt-5 w-full justify-center"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? 'Saving defaults...' : 'Save and continue'}
          {!saving && <ArrowRight className="h-4 w-4" />}
        </button>
      </div>
    </OnboardingShell>
  );
}
