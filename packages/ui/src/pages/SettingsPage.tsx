import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BarChart3,
  Brain,
  CalendarClock,
  ChevronDown,
  Cpu,
  FolderOpen,
  HardDrive,
  Monitor,
  Moon,
  Server,
  ShieldCheck,
  Sun,
  User,
  Zap,
} from 'lucide-react';
import McpServerManager from '../components/settings/McpServerManager';
import { ProviderModelRegistrySection } from '../components/settings/ModelRegistryPanel';
import UsageDashboard from '../components/settings/UsageDashboard';
import Select from '../components/common/Select';
import ShortcutKey from '../components/common/ShortcutKey';
import ProviderIcon, { providerIconColor } from '../components/common/ProviderIcon';
import { auth as authApi, system as systemApi, type DesktopRuntimeSettingsResponse } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useModelRegistry, getModelDisplay } from '../hooks/useModelRegistry';
import type { ModelRegistryEntry, UseModelRegistryReturn } from '../hooks/useModelRegistry';
import { useEnabledProvidersStatus, type CliAuthStatus } from '../hooks/useEnabledProviders';
import { type ColorMode } from '../lib/theme';
import CronManagerPage from './CronManagerPage';
import LearningsPage from './LearningsPage';
import SkillsSettingsPage from './SkillsSettingsPage';

const TABS = [
  { id: 'general', adminOnly: false },
  { id: 'context', adminOnly: false },
  { id: 'runtime', adminOnly: false },
  { id: 'models', adminOnly: true },
  { id: 'usage', adminOnly: false },
  { id: 'mcp', adminOnly: false },
  { id: 'schedules', adminOnly: false },
  { id: 'learnings', adminOnly: false },
  { id: 'skills', adminOnly: false },
  { id: 'team', adminOnly: true },
  { id: 'account', adminOnly: false },
] as const;

type TabId = (typeof TABS)[number]['id'];

const PAGE_COPY: Record<TabId, { title: string; description: string; icon: React.ElementType }> = {
  general: {
    title: 'General',
    description: 'Workspace identity, appearance, and application updates.',
    icon: User,
  },
  context: {
    title: 'Context engine',
    description: 'Repo memory that grounds agents in your codebase.',
    icon: Brain,
  },
  runtime: {
    title: 'Runtime',
    description: 'Local engine limits and paths.',
    icon: HardDrive,
  },
  models: {
    title: 'Models & providers',
    description: 'Defaults by job, then every provider with its own model registry and credentials.',
    icon: Cpu,
  },
  usage: {
    title: 'Usage',
    description: 'LLM usage and cost across providers and models — chat, workflow runs, and agent executions, each counted once.',
    icon: BarChart3,
  },
  mcp: {
    title: 'MCP servers',
    description: 'Tool servers available to Allen and its agents.',
    icon: Server,
  },
  schedules: {
    title: 'Schedules',
    description: 'Recurring Allen jobs, in plain words.',
    icon: CalendarClock,
  },
  learnings: {
    title: 'Learnings',
    description: 'Preferences Allen has picked up from working with you.',
    icon: Brain,
  },
  skills: {
    title: 'Skills',
    description: 'Manage the Allen Library skills that guide routing and playbooks in chat.',
    icon: Zap,
  },
  team: {
    title: 'Team',
    description: 'People, roles, and workspace access.',
    icon: ShieldCheck,
  },
  account: {
    title: 'Account',
    description: 'Your profile on this Allen instance.',
    icon: User,
  },
};

const SETTINGS_TAB_ALIASES: Record<string, TabId> = {
  advanced: 'runtime',
  analytics: 'runtime',
  appearance: 'general',
  integrations: 'mcp',
  llm: 'models',
  llms: 'models',
  model: 'models',
  'model-providers': 'models',
  model_defaults: 'models',
  'model-defaults': 'models',
  notifications: 'general',
  profile: 'account',
  providers: 'mcp',
  shortcuts: 'general',
  users: 'team',
};

const COLOR_MODE_OPTIONS = [
  { value: 'light' as ColorMode, label: 'Light', icon: Sun },
  { value: 'dark' as ColorMode, label: 'Dark', icon: Moon },
  { value: 'system' as ColorMode, label: 'System', icon: Monitor },
];

function SettingsPageShell({
  activeTab,
  children,
  wide = false,
}: {
  activeTab: TabId;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const page = PAGE_COPY[activeTab];
  return (
    <div className={`settings-page v8-settings-page ${wide ? 'wide' : ''}`}>
      <div className="settings-page-head">
        <div className="min-w-0">
          <h1>{page.title}</h1>
          <p>{page.description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function SettingsPanel({
  className,
  title,
  description,
  action,
  children,
}: {
  className?: string;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`settings-panel ${className ?? ''}`}>
      {(title || description || action) && (
        <div className="settings-panel-head">
          <div className="settings-panel-head-copy">
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {action && <div className="settings-panel-head-action">{action}</div>}
        </div>
      )}
      <div className="settings-panel-body">{children}</div>
    </section>
  );
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function ReadOnlyInput({ value }: { value: string }) {
  return <input className="settings-readonly-input" readOnly value={value} />;
}

function SettingsSwitch({
  checked = false,
  disabled = false,
  onClick,
}: {
  checked?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-switch ${checked ? 'active' : ''}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
    >
      <span />
    </button>
  );
}

function SettingsSegment({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`settings-segment ${active ? 'active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

function SettingsValue({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return <span className={`settings-value ${mono ? 'mono' : ''}`}>{children}</span>;
}

function SettingsBadge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn'; children: React.ReactNode }) {
  return <span className={`settings-badge ${tone}`}>{children}</span>;
}

function SettingsSectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="settings-section-label">{children}</div>;
}

function formatProfileDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString([], {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatRoleLabel(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}


function AppearancePicker() {
  const colorMode = useSettingsStore((s) => s.colorMode);
  const setColorMode = useSettingsStore((s) => s.setColorMode);

  return (
    <div className="settings-segmented-control" aria-label="Appearance">
      {COLOR_MODE_OPTIONS.map((option) => {
        const Icon = option.icon;
        return (
          <SettingsSegment
            key={option.value}
            active={colorMode === option.value}
            onClick={() => setColorMode(option.value)}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{option.label}</span>
          </SettingsSegment>
        );
      })}
    </div>
  );
}

function GeneralTab() {
  const [workspaceName, setWorkspaceName] = useState(() => localStorage.getItem('allen.workspace.name') || 'allen-internal');
  const [updateChannel, setUpdateChannel] = useState(() => localStorage.getItem('allen.update.channel') || 'Stable');
  const [launchAtLogin, setLaunchAtLogin] = useState(() => localStorage.getItem('allen.launch.at.login') !== 'false');
  const [updateSettings, setUpdateSettings] = useState<Awaited<ReturnType<NonNullable<typeof window.allenDesktop>['getUpdateSettings']>> | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!window.allenDesktop?.getUpdateSettings) return;
    void window.allenDesktop.getUpdateSettings()
      .then(setUpdateSettings)
      .catch((err) => setUpdateStatus(err instanceof Error ? err.message : String(err)));
  }, []);

  async function checkForUpdatesNow() {
    if (!window.allenDesktop?.checkForUpdates) {
      setUpdateStatus('Update checks are available in the packaged desktop app.');
      return;
    }
    setCheckingUpdates(true);
    setUpdateStatus(null);
    try {
      const result = await window.allenDesktop.checkForUpdates();
      if (result.status === 'disabled') setUpdateStatus('Update checks are disabled for this build.');
      else if (result.status === 'not-available') setUpdateStatus(`Allen ${result.currentVersion} is up to date.`);
      else setUpdateStatus(result.opened ? `Allen ${result.latestVersion} installer opened.` : `Allen ${result.latestVersion} is available.`);
    } catch (err) {
      setUpdateStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdates(false);
    }
  }

  function updateWorkspaceName(value: string) {
    setWorkspaceName(value);
    localStorage.setItem('allen.workspace.name', value);
  }

  function updateReleaseChannel(value: string) {
    setUpdateChannel(value);
    localStorage.setItem('allen.update.channel', value);
  }

  function toggleLaunchAtLogin() {
    setLaunchAtLogin((current) => {
      const next = !current;
      localStorage.setItem('allen.launch.at.login', String(next));
      return next;
    });
  }

  const currentVersion = updateSettings?.currentVersion || __ALLEN_APP_VERSION__;

  return (
    <SettingsPageShell activeTab="general">
      <SettingsPanel className="settings-general-ledger">
        <SettingsRow label="Workspace name" description="Shown in the sidebar and window title.">
          <input
            className="settings-readonly-input settings-workspace-name"
            aria-label="Workspace name"
            value={workspaceName}
            onChange={(event) => updateWorkspaceName(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow label="Version" description="Allen Desktop">
          <div className="settings-inline-action">
            <SettingsValue mono>{currentVersion} · up to date</SettingsValue>
            <button type="button" className="settings-secondary-button" onClick={() => void checkForUpdatesNow()}>
              {checkingUpdates ? 'Checking...' : 'Check for updates'}
            </button>
          </div>
        </SettingsRow>
        <SettingsRow label="Update channel" description="Beta gets new builds about a week early.">
          <select
            className="select-native settings-select settings-update-channel"
            aria-label="Update channel"
            value={updateChannel}
            onChange={(event) => updateReleaseChannel(event.target.value)}
          >
            <option>Stable</option>
            <option>Beta</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Theme" description="Follow the system, or lock light / dark.">
          <AppearancePicker />
        </SettingsRow>
        <SettingsRow label="Launch at login" description="Start Allen when you sign in to this Mac.">
          <SettingsSwitch checked={launchAtLogin} onClick={toggleLaunchAtLogin} />
        </SettingsRow>
      </SettingsPanel>
      {updateStatus && <p className="settings-status-line">{updateStatus}</p>}
    </SettingsPageShell>
  );
}

type RuntimeSettings = DesktopRuntimeSettingsResponse;
type RuntimeSettingField = RuntimeSettings['groups'][number]['fields'][number];
type RuntimeSettingOption = NonNullable<RuntimeSettingField['options']>[number];

const PROVIDER_DEFAULT_MODEL_OPTION: RuntimeSettingOption = { label: 'Provider default', value: '' };
const MODEL_RUNTIME_GROUP_IDS = new Set(['agents']);
const ALL_PROVIDER_SETTINGS_ID = '__all-provider-settings__';

function llmOptionsForProvider(provider: string, includeProviderDefault = false, registryModels?: ModelRegistryEntry[]): RuntimeSettingOption[] {
  // Registry only — no static catalog (REQ-005). An empty list simply renders
  // an empty dropdown until the registry loads.
  const canonical = provider === 'claude-cli' ? 'claude' : provider;
  const fromRegistry = (registryModels ?? [])
    .filter((m) => m.provider === canonical && m.isActive)
    .map((m) => ({ label: m.displayName || m.fullId, value: m.fullId }));
  return includeProviderDefault ? [PROVIDER_DEFAULT_MODEL_OPTION, ...fromRegistry] : fromRegistry;
}

function runtimeSourceLabel(source: RuntimeSettingField['source']): string {
  if (source === 'desktop_config') return 'Desktop setting';
  if (source === 'env') return 'Runtime env';
  return 'Default';
}

function runtimeFieldVisible(field: RuntimeSettingField, values: Record<string, string>): boolean {
  const condition = field.showWhen;
  if (!condition) return true;
  const value = values[condition.key] ?? '';
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.notEquals !== undefined) return value !== condition.notEquals;
  if (condition.in) return condition.in.includes(value);
  return true;
}

function settingsValueMap(settings: RuntimeSettings): Record<string, string> {
  const values: Record<string, string> = {};
  for (const group of settings.groups) {
    for (const field of group.fields) {
      values[field.key] = field.key === 'ALLEN_CONTEXT_PROVIDER'
        ? (field.currentValue === 'cognee' || field.currentValue === 'cognee_memory' ? 'cognee' : '')
        : field.currentValue;
    }
  }
  return values;
}

function runtimeSelectOptions(field: RuntimeSettingField, values: Record<string, string>, registryModels?: ModelRegistryEntry[]): RuntimeSettingOption[] {
  if (field.key === 'ALLEN_DEFAULT_CHAT_MODEL') {
    return llmOptionsForProvider(values.ALLEN_DEFAULT_CHAT_PROVIDER ?? '', false, registryModels);
  }
  if (field.key === 'ALLEN_DEFAULT_AGENT_MODEL') {
    return llmOptionsForProvider(values.ALLEN_DEFAULT_AGENT_PROVIDER ?? '', true, registryModels);
  }
  if (field.key === 'ALLEN_CONTEXT_LLM_MODEL') {
    return llmOptionsForProvider(values.ALLEN_CONTEXT_LLM_PROVIDER ?? '', false, registryModels);
  }
  return field.options ?? [];
}

function runtimeFieldProvider(fieldKey: string, values: Record<string, string>): string | null {
  if (fieldKey.endsWith('_PROVIDER')) return null;
  if (fieldKey === 'ALLEN_DEFAULT_CHAT_MODEL') return values.ALLEN_DEFAULT_CHAT_PROVIDER ?? null;
  if (fieldKey === 'ALLEN_DEFAULT_AGENT_MODEL') return values.ALLEN_DEFAULT_AGENT_PROVIDER ?? null;
  if (fieldKey === 'ALLEN_CONTEXT_LLM_MODEL') return values.ALLEN_CONTEXT_LLM_PROVIDER ?? null;
  return null;
}

function RuntimeSettingControl({
  editable,
  field,
  onChange,
  registryModels,
  runtimeValues,
  value,
}: {
  editable: boolean;
  field: RuntimeSettingField;
  onChange: (key: string, value: string) => void;
  registryModels?: ModelRegistryEntry[];
  runtimeValues: Record<string, string>;
  value: string;
}) {
  const disabled = !editable || field.readOnly;

  if (field.readOnly) {
    return <ReadOnlyInput value={value || field.defaultValue || '-'} />;
  }

  if (field.key === 'ALLEN_CONTEXT_PROVIDER') {
    return (
      <SettingsSwitch
        checked={value === 'cognee' || value === 'cognee_memory'}
        disabled={disabled}
        onClick={() => onChange(field.key, value === 'cognee' || value === 'cognee_memory' ? '' : 'cognee')}
      />
    );
  }

  if (field.kind === 'boolean') {
    return (
      <SettingsSwitch
        checked={value === 'true'}
        disabled={disabled}
        onClick={() => onChange(field.key, value === 'true' ? 'false' : 'true')}
      />
    );
  }

  if (field.kind === 'select') {
    const options = runtimeSelectOptions(field, runtimeValues, registryModels);
    const hasCurrentValue = value === '' || options.some((option) => option.value === value);
    const baseSelectOptions = hasCurrentValue
      ? options
      : [{ value, label: value }, ...options];
    const modelProvider = runtimeFieldProvider(field.key, runtimeValues);
    const selectOptions = baseSelectOptions.map(option => {
      const optionProvider = field.key.endsWith('_PROVIDER') ? option.value : modelProvider;
      if (!optionProvider || !option.value) return option;
      return {
        ...option,
        icon: <ProviderIcon provider={optionProvider} className={`h-4 w-4 ${providerIconColor(optionProvider)}`} />,
      };
    });
    return (
      <Select
        className="settings-runtime-select"
        disabled={disabled}
        value={value}
        options={selectOptions}
        placeholder={field.defaultValue || 'Select...'}
        searchable={selectOptions.length > 6}
        searchPlaceholder={`Search ${field.label.toLowerCase()}...`}
        onChange={(next) => onChange(field.key, next)}
      />
    );
  }

  return (
    <input
      className="settings-edit-input"
      disabled={disabled}
      inputMode={field.kind === 'number' ? 'numeric' : undefined}
      placeholder={field.placeholder ?? field.defaultValue}
      type={field.kind === 'number' ? 'number' : 'text'}
      value={value}
      onChange={(event) => onChange(field.key, event.target.value)}
    />
  );
}

type ClaudeCompatibleProviderPanelConfig = {
  title: string;
  description: string;
  disabledLabel: string;
  apiKey: string;
  apiKeyMissingDescription: string;
  apiKeyPlaceholder: string;
  groupId: string;
  settingKeys: string[];
  saveLabel: string;
};

/**
 * Claude and Codex are CLI-backed providers: always enabled, no API key, no
 * disable switch (REQ-002). The only requirement to use them is a logged-in
 * CLI session, surfaced here with a "Check again" re-verification button.
 */
function CliProviderRows({ modelRegistry }: { modelRegistry: UseModelRegistryReturn }) {
  const { providers, loaded } = useEnabledProvidersStatus();
  const [statusOverride, setStatusOverride] = useState<Record<string, CliAuthStatus>>({});
  const [loginCommands, setLoginCommands] = useState<Record<string, string>>({});
  const [checkingProvider, setCheckingProvider] = useState<string | null>(null);
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});

  const cliProviders = providers.filter((p) => p.provider === 'claude' || p.provider === 'codex');

  async function recheck(provider: string) {
    setCheckingProvider(provider);
    try {
      const result = await systemApi.recheckProviderAuth(provider);
      setStatusOverride((current) => ({ ...current, [provider]: result.authStatus }));
      if (result.loginCommand) {
        setLoginCommands((current) => ({ ...current, [provider]: result.loginCommand as string }));
      }
    } catch {
      // Leave the previous status in place; the button stays available.
    } finally {
      setCheckingProvider(null);
    }
  }

  if (!loaded && cliProviders.length === 0) {
    return (
      <div className="settings-provider-item">
        <div className="settings-provider-summary px-3 py-2 text-[13px] text-theme-muted">Loading providers…</div>
      </div>
    );
  }

  return (
    <>
      {cliProviders.map((p) => {
        const status = statusOverride[p.provider] ?? p.authStatus ?? 'logged_in';
        const connected = status === 'logged_in';
        const expanded = Boolean(expandedById[p.provider]);
        const { providerLabel } = getModelDisplay(p.provider);
        const loginHint = status === 'cli_missing'
          ? `The ${providerLabel} CLI is not installed. Install it and log in, then check again.`
          : `Not logged in. Run \`${loginCommands[p.provider] ?? (p.provider === 'codex' ? 'codex login' : 'claude (then /login)')}\` in a terminal, then check again.`;
        return (
          <div key={p.provider} className={`settings-provider-item ${connected ? 'enabled' : ''}`}>
            <div className="settings-provider-summary">
              <button
                type="button"
                className="settings-provider-main"
                onClick={() => setExpandedById((current) => ({ ...current, [p.provider]: !current[p.provider] }))}
                aria-expanded={expanded}
              >
                <span className="settings-provider-mark">
                  <ProviderIcon provider={p.provider} className={`h-4 w-4 ${providerIconColor(p.provider)}`} />
                </span>
                <span className="settings-provider-copy">
                  <span className="settings-provider-title-line">
                    <strong>{providerLabel}</strong>
                    <SettingsBadge tone={connected ? 'ok' : 'warn'}>
                      {connected ? 'connected' : status === 'cli_missing' ? 'CLI missing' : 'not logged in'}
                    </SettingsBadge>
                  </span>
                  <span>Built-in CLI provider — always enabled</span>
                </span>
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="settings-secondary-button"
                  disabled={checkingProvider === p.provider}
                  onClick={() => void recheck(p.provider)}
                >
                  {checkingProvider === p.provider ? 'Checking…' : 'Check again'}
                </button>
                <button
                  type="button"
                  className="settings-provider-chevron-button"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${providerLabel} provider models`}
                  aria-expanded={expanded}
                  onClick={() => setExpandedById((current) => ({ ...current, [p.provider]: !current[p.provider] }))}
                >
                  <ChevronDown className={`settings-provider-chevron ${expanded ? 'open' : ''}`} />
                </button>
              </div>
            </div>
            {!connected && (
              <div className="px-3 pb-3 text-[12px] leading-relaxed text-theme-muted">{loginHint}</div>
            )}
            {expanded && (
              <div className="settings-provider-details">
                <ProviderModelRegistrySection
                  modelRegistry={modelRegistry}
                  provider={p.provider}
                  providerLabel={providerLabel}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function LlmProvidersPanel({
  configs,
  editable,
  modelRegistry,
  savedRuntimeValues,
  showSourceMeta = true,
  runtime,
  runtimeSettings,
  runtimeValues,
  onRuntimeRefresh,
  onRuntimeSettingsRefresh,
  onUpdateRuntimeValue,
}: {
  configs: ClaudeCompatibleProviderPanelConfig[];
  editable: boolean;
  modelRegistry: UseModelRegistryReturn;
  savedRuntimeValues: Record<string, string>;
  showSourceMeta?: boolean;
  runtime: Awaited<ReturnType<typeof systemApi.desktopRuntime>> | null;
  runtimeSettings: RuntimeSettings | null;
  runtimeValues: Record<string, string>;
  onRuntimeRefresh: () => void;
  onRuntimeSettingsRefresh: (updated: RuntimeSettings) => void;
  onUpdateRuntimeValue: (key: string, value: string) => void;
}) {
  const [enabledById, setEnabledById] = useState<Record<string, boolean>>({});
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [providerSaveError, setProviderSaveError] = useState<string | null>(null);

  useEffect(() => {
    setEnabledById((current) => {
      const next = { ...current };
      for (const config of configs) {
        const configured = Boolean(runtime?.secrets.find((s) => s.key === config.apiKey)?.configured);
        if (configured) next[config.groupId] = true;
        else if (next[config.groupId] === undefined) next[config.groupId] = false;
      }
      return next;
    });
  }, [configs, runtime]);

  function apiKeyConfigured(config: ClaudeCompatibleProviderPanelConfig): boolean {
    return Boolean(runtime?.secrets.find((s) => s.key === config.apiKey)?.configured);
  }

  function providerGroup(config: ClaudeCompatibleProviderPanelConfig) {
    return runtimeSettings?.groups.find((g) => g.id === config.groupId);
  }

  function providerHasChanges(config: ClaudeCompatibleProviderPanelConfig) {
    if ((apiKeyInputs[config.groupId] ?? '').trim()) return true;
    return config.settingKeys.some((key) => runtimeValues[key] !== savedRuntimeValues[key]);
  }

  const changedProviderConfigs = configs.filter(providerHasChanges);
  const savingAllProviders = savingProviderId === ALL_PROVIDER_SETTINGS_ID;

  async function saveChangedProviderSettings() {
    if (changedProviderConfigs.length === 0) return;
    setSavingProviderId(ALL_PROVIDER_SETTINGS_ID);
    setProviderSaveError(null);
    try {
      let shouldRefreshRuntime = false;
      const nextApiKeyInputs = { ...apiKeyInputs };
      const nonSecretValues: Record<string, string> = {};
      for (const config of changedProviderConfigs) {
        const apiKeyInput = apiKeyInputs[config.groupId] ?? '';
        if (apiKeyInput.trim()) {
          await systemApi.setDesktopSecret(config.apiKey, apiKeyInput.trim());
          nextApiKeyInputs[config.groupId] = '';
          shouldRefreshRuntime = true;
        }
        for (const key of config.settingKeys) {
          if (runtimeValues[key] !== undefined && runtimeValues[key] !== savedRuntimeValues[key]) {
            nonSecretValues[key] = runtimeValues[key];
          }
        }
      }
      setApiKeyInputs(nextApiKeyInputs);
      if (shouldRefreshRuntime) {
        onRuntimeRefresh();
      }
      if (Object.keys(nonSecretValues).length > 0) {
        const updated = await systemApi.updateDesktopRuntimeSettings(nonSecretValues);
        onRuntimeSettingsRefresh(updated);
      }
    } catch (err) {
      setProviderSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProviderId(null);
    }
  }

  async function deleteApiKey(config: ClaudeCompatibleProviderPanelConfig) {
    setSavingProviderId(config.groupId);
    setProviderSaveError(null);
    try {
      await systemApi.deleteDesktopSecret(config.apiKey);
      setEnabledById((current) => ({ ...current, [config.groupId]: false }));
      setExpandedById((current) => ({ ...current, [config.groupId]: false }));
      onRuntimeRefresh();
    } catch (err) {
      setProviderSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProviderId(null);
    }
  }

  return (
    <SettingsPanel
      className="settings-model-providers-panel"
      title="LLM Providers"
      description="Configure Anthropic-compatible API providers used by chat and workflow agents. Enable a provider to enter credentials and endpoint settings."
      action={editable && (changedProviderConfigs.length > 0 || savingAllProviders) ? (
        <button
          type="button"
          className="settings-secondary-button settings-primary-save-button"
          disabled={savingProviderId !== null}
          onClick={() => void saveChangedProviderSettings()}
        >
          {savingAllProviders ? 'Saving...' : 'Save settings'}
        </button>
      ) : undefined}
    >
      <div className="settings-provider-list">
        {providerSaveError && (
          <div className="settings-provider-save-error">
            {providerSaveError}
          </div>
        )}
        <CliProviderRows modelRegistry={modelRegistry} />
        {configs.map((config) => {
          const enabled = enabledById[config.groupId] ?? apiKeyConfigured(config);
          const expanded = Boolean(expandedById[config.groupId]);
          const configured = apiKeyConfigured(config);
          const group = providerGroup(config);
          const saving = savingProviderId === config.groupId || savingAllProviders;

          return (
            <div key={config.groupId} className={`settings-provider-item ${enabled ? 'enabled' : ''}`}>
              <div className="settings-provider-summary">
                <button
                  type="button"
                  className="settings-provider-main"
                  onClick={() => {
                    setExpandedById((current) => ({ ...current, [config.groupId]: !current[config.groupId] }));
                  }}
                  aria-expanded={expanded}
                >
                  <span className="settings-provider-mark">
                    <ProviderIcon provider={config.groupId} className={`h-4 w-4 ${providerIconColor(config.groupId)}`} />
                  </span>
                  <span className="settings-provider-copy">
                    <span className="settings-provider-title-line">
                      <strong>{config.title}</strong>
                      <SettingsBadge tone={configured ? 'ok' : enabled ? 'warn' : 'neutral'}>
                        {configured ? 'configured' : enabled ? 'needs key' : 'disabled'}
                      </SettingsBadge>
                    </span>
                    <span>{configured ? 'API key configured' : enabled ? 'Enter API key and endpoint settings' : config.disabledLabel}</span>
                  </span>
                </button>
                <span className="settings-provider-state">
                  <SettingsSwitch
                    checked={enabled}
                    disabled={!editable || saving}
                    onClick={() => {
                      if (enabled && configured) {
                        void deleteApiKey(config);
                        return;
                      }
                      setEnabledById((current) => ({ ...current, [config.groupId]: !enabled }));
                      setExpandedById((current) => ({ ...current, [config.groupId]: !enabled }));
                    }}
                  />
                  <button
                    type="button"
                    className="settings-provider-chevron-button"
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${config.title} provider settings`}
                    aria-expanded={expanded}
                    onClick={() => setExpandedById((current) => ({ ...current, [config.groupId]: !current[config.groupId] }))}
                  >
                    <ChevronDown className={`settings-provider-chevron ${expanded ? 'open' : ''}`} />
                  </button>
                </span>
              </div>

              {enabled && expanded && (
                <div className="settings-provider-details">
                  <SettingsRow
                    label="API key"
                    description={configured ? 'Key is configured. Enter a new value to replace it.' : config.apiKeyMissingDescription}
                  >
                    <div className="settings-field-control">
                      <input
                        type="password"
                        className="settings-edit-input"
                        placeholder={configured ? '••••••••  (configured — enter to replace)' : config.apiKeyPlaceholder}
                        value={apiKeyInputs[config.groupId] ?? ''}
                        disabled={!editable}
                        onChange={(event) => setApiKeyInputs((current) => ({ ...current, [config.groupId]: event.target.value }))}
                        autoComplete="off"
                      />
                      <div className="settings-field-meta">
                        <span>{configured ? 'Key configured' : 'Not configured'}</span>
                        <span>Stored via secrets API</span>
                      </div>
                    </div>
                  </SettingsRow>

                  {group?.fields.map((field) => (
                    <SettingsRow
                      key={field.key}
                      label={field.label}
                      description={field.description ?? field.key}
                    >
                      <div className="settings-field-control">
                        <input
                          type="text"
                          className="settings-edit-input"
                          placeholder={field.placeholder ?? field.defaultValue}
                          value={runtimeValues[field.key] ?? ''}
                          disabled={!editable || field.readOnly}
                          onChange={(event) => onUpdateRuntimeValue(field.key, event.target.value)}
                        />
                        <div className="settings-field-meta">
                          {showSourceMeta && <span>Default: {field.defaultValue || 'empty'}</span>}
                          {showSourceMeta && <span>Source: {runtimeSourceLabel(field.source)}</span>}
                          {field.restartRequired && runtimeValues[field.key] !== savedRuntimeValues[field.key] && (
                            <span className="settings-field-warning">Restart required after save</span>
                          )}
                        </div>
                      </div>
                    </SettingsRow>
                  ))}

                </div>
              )}
              {!enabled && expanded && (
                <div className="settings-provider-details">
                  <ProviderModelRegistrySection
                    modelRegistry={modelRegistry}
                    provider={config.groupId}
                    providerLabel={config.title}
                  />
                </div>
              )}
              {enabled && expanded && (
                <div className="settings-provider-details model-registry-provider-details">
                  <ProviderModelRegistrySection
                    modelRegistry={modelRegistry}
                    provider={config.groupId}
                    providerLabel={config.title}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SettingsPanel>
  );
}

function RuntimeSettingsTab({
  view,
  noShell = false,
  modelRegistry,
  registryModels,
}: {
  view: 'runtime' | 'models';
  noShell?: boolean;
  modelRegistry?: UseModelRegistryReturn;
  registryModels?: ModelRegistryEntry[];
}) {
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof systemApi.desktopRuntime>> | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null);
  const [runtimeValues, setRuntimeValues] = useState<Record<string, string>>({});
  const [savedRuntimeValues, setSavedRuntimeValues] = useState<Record<string, string>>({});
  const [desktopInfo, setDesktopInfo] = useState<Awaited<ReturnType<NonNullable<typeof window.allenDesktop>['getRuntimeInfo']>> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cogneeSetupStatus, setCogneeSetupStatus] = useState<string | null>(null);

  useEffect(() => {
    void systemApi.desktopRuntime().then(setRuntime).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    void systemApi.desktopRuntimeSettings().then((settings) => {
      const values = settingsValueMap(settings);
      setRuntimeSettings(settings);
      setRuntimeValues(values);
      setSavedRuntimeValues(values);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    void window.allenDesktop?.getRuntimeInfo().then(setDesktopInfo).catch(() => null);
  }, []);

  function updateRuntimeValue(key: string, value: string) {
    const rm = modelRegistry?.models ?? registryModels;
    setRuntimeValues((current) => {
      const next = { ...current, [key]: value };
      if (key === 'ALLEN_DEFAULT_AGENT_PROVIDER') {
        const options = llmOptionsForProvider(value, true, rm);
        if (!options.some((option) => option.value === next.ALLEN_DEFAULT_AGENT_MODEL)) {
          next.ALLEN_DEFAULT_AGENT_MODEL = '';
        }
      }
      if (key === 'ALLEN_DEFAULT_CHAT_PROVIDER') {
        const options = llmOptionsForProvider(value, false, rm);
        if (!options.some((option) => option.value === next.ALLEN_DEFAULT_CHAT_MODEL)) {
          next.ALLEN_DEFAULT_CHAT_MODEL = options[0]?.value ?? '';
        }
      }
      if (key === 'ALLEN_CONTEXT_LLM_PROVIDER') {
        const options = llmOptionsForProvider(value, false, rm);
        if (!options.some((option) => option.value === next.ALLEN_CONTEXT_LLM_MODEL)) {
          next.ALLEN_CONTEXT_LLM_MODEL = options[0]?.value ?? '';
        }
      }
      return next;
    });
  }

  async function refreshRuntime() {
    try {
      const updated = await systemApi.desktopRuntime();
      setRuntime(updated);
    } catch { /* non-fatal */ }
  }

  async function saveRuntimeSettings() {
    setSaving('runtime-settings');
    setError(null);
    try {
      const updated = await systemApi.updateDesktopRuntimeSettings(runtimeValues);
      const values = settingsValueMap(updated);
      setRuntimeSettings(updated);
      setRuntimeValues(values);
      setSavedRuntimeValues(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  async function setupCogneeContext() {
    setSaving('cognee-setup');
    setError(null);
    setCogneeSetupStatus(null);
    try {
      const selectedProvider = runtimeValues.ALLEN_CONTEXT_PROVIDER === 'cognee_memory' ? 'cognee_memory' : 'cognee';
      const result = await systemApi.setupDesktopCogneeContext(selectedProvider);
      const values = settingsValueMap(result.settings);
      setRuntimeSettings(result.settings);
      setRuntimeValues(values);
      setSavedRuntimeValues(values);
      setCogneeSetupStatus(result.output.length > 0 ? result.output.join('\n') : result.setup.detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  const cogneeProviderSelected = runtimeValues.ALLEN_CONTEXT_PROVIDER === 'cognee'
    || runtimeValues.ALLEN_CONTEXT_PROVIDER === 'cognee_memory';
  const cogneeSetup = runtimeSettings?.contextSetup;
  const cogneeSetupRecommended = Boolean(cogneeSetup && (
    !cogneeSetup.configuredPython || !cogneeSetup.cogneeImportOk
  ));
  const showCogneeSetupPanel = Boolean(runtimeSettings?.editable && cogneeProviderSelected && cogneeSetup);
  const apiProviderPanelConfigs: ClaudeCompatibleProviderPanelConfig[] = (runtimeSettings?.groups ?? [])
    .map((group) => {
      const secret = runtime?.secrets.find((item) => item.group === group.title && item.key.endsWith('_API_KEY'));
      if (!secret || group.fields.length === 0) return null;
      return {
        title: group.title,
        description: `${group.title} API provider. Allen uses the Claude Code binary with your ${group.title} credentials. Enable to configure API access.`,
        disabledLabel: 'Disabled — toggle on to configure',
        apiKey: secret.key,
        apiKeyMissingDescription: `Required to use ${group.title}. Stored securely — never displayed.`,
        apiKeyPlaceholder: 'api-key',
        groupId: group.id,
        settingKeys: group.fields.map((field) => field.key),
        saveLabel: `Save ${group.title} settings`,
      };
    })
    .filter((config): config is ClaudeCompatibleProviderPanelConfig => config !== null);
  const apiProviderGroupIds = new Set(apiProviderPanelConfigs.map((config) => config.groupId));
  const isModelsView = view === 'models';
  const visibleSettingGroups = (runtimeSettings?.groups ?? []).filter((group) => {
    if (apiProviderGroupIds.has(group.id)) return false;
    const isModelGroup = MODEL_RUNTIME_GROUP_IDS.has(group.id);
    return isModelsView ? isModelGroup : !isModelGroup;
  });
  const saveButtonLabel = isModelsView ? 'Save model settings' : 'Save runtime settings';
  const changedRuntimeKeys = new Set(Object.keys(runtimeValues).filter((key) => runtimeValues[key] !== savedRuntimeValues[key]));

  function groupHasChanges(group: RuntimeSettings['groups'][number]) {
    return group.fields.some((field) => changedRuntimeKeys.has(field.key));
  }

  function groupHasRestartRequiredChanges(group: RuntimeSettings['groups'][number]) {
    return group.fields.some((field) => field.restartRequired && changedRuntimeKeys.has(field.key));
  }

  const content = (
    <>
      {!isModelsView && (
        <SettingsPanel title="Environment" description="Runtime configuration Allen is currently using.">
          {error && (
            <SettingsRow label="Status">
              <SettingsBadge tone="warn">{error}</SettingsBadge>
            </SettingsRow>
          )}
          <SettingsRow label="Mode">
            <SettingsBadge tone="ok">{runtime?.desktop ? 'Desktop' : 'Web'}</SettingsBadge>
          </SettingsRow>
          {runtimeSettings && !runtimeSettings.editable && (
            <SettingsRow label="Configuration source" description="Web/runtime mode is intentionally read-only here. Edit the deployment .env for web installs.">
              <SettingsBadge tone="warn">.env controlled</SettingsBadge>
            </SettingsRow>
          )}
          <SettingsRow label="Database">
            <SettingsValue>{runtime?.runtime.managedMongo ? 'Managed local MongoDB' : 'Configured MongoDB URI'}</SettingsValue>
          </SettingsRow>
          <SettingsRow label="Allen home">
            <SettingsValue mono>{runtime?.paths.allenHome ?? '-'}</SettingsValue>
          </SettingsRow>
          <SettingsRow label="Workspaces">
            <SettingsValue mono>{runtime?.paths.workspaceBaseDir ?? '-'}</SettingsValue>
          </SettingsRow>
          {desktopInfo?.logsDir && (
            <SettingsRow label="Logs">
              <div className="settings-inline-action">
                <SettingsValue mono>{desktopInfo.logsDir}</SettingsValue>
                <button type="button" className="settings-icon-button" title="Open logs" onClick={() => void window.allenDesktop?.openLogsDirectory()}>
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              </div>
            </SettingsRow>
          )}
        </SettingsPanel>
      )}

      {isModelsView && error && (
        <SettingsPanel title="Status">
          <SettingsRow label="Runtime settings">
            <SettingsBadge tone="warn">{error}</SettingsBadge>
          </SettingsRow>
        </SettingsPanel>
      )}

      {runtimeSettings && (
        <>
          {visibleSettingGroups.map((group) => {
            const isCogneeContextGroup = group.id === 'context';
            const providerField = group.fields.find((field) => field.key === 'ALLEN_CONTEXT_PROVIDER');
            const cogneeEnabled = runtimeValues.ALLEN_CONTEXT_PROVIDER === 'cognee'
              || runtimeValues.ALLEN_CONTEXT_PROVIDER === 'cognee_memory';
            const fields = group.fields.filter((field) => (
              runtimeFieldVisible(field, runtimeValues)
              && !field.advanced
              && field.key !== 'ALLEN_AGENT_EXECUTION_MODE'
              && !(isCogneeContextGroup && field.key === 'ALLEN_CONTEXT_PROVIDER')
            ));
            if (fields.length === 0 && !isCogneeContextGroup) return null;
            const modelDefaultsGroup = isModelsView && group.id === 'agents';
            const modelDefaultsChanged = modelDefaultsGroup && groupHasChanges(group);
            const modelDefaultsRestartRequired = modelDefaultsGroup && groupHasRestartRequiredChanges(group);
            const panelAction = modelDefaultsGroup ? (
              <div className="settings-model-panel-actions">
                {modelDefaultsChanged && (
                  <SettingsBadge tone={modelDefaultsRestartRequired ? 'warn' : 'neutral'}>
                    {modelDefaultsRestartRequired ? 'restart after save' : 'unsaved changes'}
                  </SettingsBadge>
                )}
                <button
                  type="button"
                  className="settings-secondary-button settings-primary-save-button"
                  disabled={saving === 'runtime-settings' || !runtimeSettings.editable || !modelDefaultsChanged}
                  onClick={() => void saveRuntimeSettings()}
                >
                  {saving === 'runtime-settings' ? 'Saving...' : modelDefaultsChanged ? 'Save model settings' : 'Saved'}
                </button>
              </div>
            ) : isCogneeContextGroup && providerField ? (
              <SettingsSwitch
                checked={cogneeEnabled}
                disabled={!runtimeSettings.editable || providerField.readOnly}
                onClick={() => updateRuntimeValue('ALLEN_CONTEXT_PROVIDER', cogneeEnabled ? '' : 'cognee')}
              />
            ) : undefined;
            return (
              <SettingsPanel
                className={modelDefaultsGroup ? 'settings-model-defaults-panel' : undefined}
                key={group.id}
                title={modelDefaultsGroup ? 'Model Defaults' : isCogneeContextGroup ? 'Cognee Context' : group.title}
                description={modelDefaultsGroup ? 'Choose the default providers and model behavior used by chat and workflow agents.' : isCogneeContextGroup ? 'Enable Cognee-backed repository context. Saving this change applies to future context builds without restarting the app.' : group.description}
                action={panelAction}
              >
                {fields.map((field) => (
                  <SettingsRow
                    key={field.key}
                    label={field.label}
                    description={field.description ?? field.key}
                  >
                    <div className="settings-field-control">
                      <RuntimeSettingControl
                        editable={runtimeSettings.editable}
                        field={field}
                        value={runtimeValues[field.key] ?? ''}
                        registryModels={modelRegistry?.models ?? registryModels}
                        runtimeValues={runtimeValues}
                        onChange={updateRuntimeValue}
                      />
                      <div className="settings-field-meta">
                        {modelDefaultsGroup ? (
                          <>
                            {changedRuntimeKeys.has(field.key) && <span className="settings-field-unsaved">Unsaved change</span>}
                            {field.restartRequired && changedRuntimeKeys.has(field.key) && (
                              <span className="settings-field-warning">Restart required after save</span>
                            )}
                          </>
                        ) : field.key === 'ALLEN_CONTEXT_PROVIDER' ? (
                          <>
                            <span>{runtimeValues[field.key] === 'cognee' || runtimeValues[field.key] === 'cognee_memory' ? 'Sets provider: cognee' : 'Provider not set'}</span>
                            <span>No restart required</span>
                          </>
                        ) : (
                          <>
                            <span>{field.readOnly ? 'Managed by Allen' : `Default: ${field.defaultValue || 'empty'}`}</span>
                            <span>Source: {runtimeSourceLabel(field.source)}</span>
                            {field.restartRequired && <span>Restart required</span>}
                          </>
                        )}
                      </div>
                    </div>
                  </SettingsRow>
                ))}
                {group.id === 'context' && showCogneeSetupPanel && cogneeSetup && (
                  <>
                    <SettingsRow
                      label="Cognee setup"
                      description={cogneeSetupRecommended ? 'Cognee is enabled, but the desktop Python environment still needs setup.' : 'Cognee is enabled and its desktop Python environment is ready.'}
                    >
                      <div className="settings-field-control">
                        <div className="settings-inline-action">
                          <SettingsBadge tone={cogneeSetupRecommended ? 'warn' : 'ok'}>
                            {cogneeSetupRecommended ? 'Setup required' : 'Setup complete'}
                          </SettingsBadge>
                          <SettingsValue mono>{cogneeSetup.pythonPath}</SettingsValue>
                        </div>
                        <div className="settings-field-meta">
                          <span>Managed venv: {cogneeSetup.venvPython}</span>
                        </div>
                      </div>
                    </SettingsRow>
                    {cogneeSetupRecommended && (
                      <SettingsRow
                        label="Desktop setup"
                        description="Runs the context setup script without changing .env, then saves ALLEN_PYTHON in desktop runtime settings."
                      >
                        <div className="settings-field-control">
                          <button
                            type="button"
                            className="settings-secondary-button"
                            disabled={saving === 'cognee-setup' || !runtimeSettings.editable}
                            onClick={() => void setupCogneeContext()}
                          >
                            {saving === 'cognee-setup' ? 'Setting up...' : 'Set up Cognee context'}
                          </button>
                          <div className="settings-field-meta">
                            <span>{cogneeSetup.detail}</span>
                          </div>
                        </div>
                      </SettingsRow>
                    )}
                    {cogneeSetupStatus && (
                      <SettingsRow label="Last setup output">
                        <pre className="settings-runtime-log">{cogneeSetupStatus}</pre>
                      </SettingsRow>
                    )}
                  </>
                )}
                {fields.length === 0 && (
                  <SettingsRow label="Settings">
                    <SettingsValue>Enable this feature to configure its options.</SettingsValue>
                  </SettingsRow>
                )}
              </SettingsPanel>
            );
          })}

          {isModelsView && modelRegistry && (
            <LlmProvidersPanel
              configs={apiProviderPanelConfigs}
              editable={runtimeSettings.editable}
              modelRegistry={modelRegistry}
              savedRuntimeValues={savedRuntimeValues}
              showSourceMeta={false}
              runtime={runtime}
              runtimeSettings={runtimeSettings}
              runtimeValues={runtimeValues}
              onRuntimeRefresh={() => void refreshRuntime()}
              onRuntimeSettingsRefresh={(updated) => {
                const values = settingsValueMap(updated);
                setRuntimeSettings(updated);
                setRuntimeValues(values);
                setSavedRuntimeValues(values);
              }}
              onUpdateRuntimeValue={updateRuntimeValue}
            />
          )}

          {!isModelsView && <div className="settings-floating-actions">
            <button
              type="button"
              className="settings-secondary-button"
              disabled={saving === 'runtime-settings' || !runtimeSettings.editable}
              onClick={() => void saveRuntimeSettings()}
            >
              {saveButtonLabel}
            </button>
          </div>}
        </>
      )}

    </>
  );

  if (noShell) return content;
  return (
    <SettingsPageShell activeTab={isModelsView ? 'models' : 'runtime'} wide>
      {content}
    </SettingsPageShell>
  );
}

function RuntimeTab() {
  return <RuntimeSettingsTab view="runtime" />;
}

function ModelsTab() {
  const modelRegistry = useModelRegistry();
  return (
    <SettingsPageShell activeTab="models" wide>
      <RuntimeSettingsTab view="models" noShell modelRegistry={modelRegistry} />
    </SettingsPageShell>
  );
}

function ContextTab() {
  const navigate = useNavigate();
  const [refreshCadence, setRefreshCadence] = useState(() => localStorage.getItem('allen.context.refresh-cadence') || 'On change');
  const [injectionPolicy, setInjectionPolicy] = useState(() => localStorage.getItem('allen.context.injection-policy') || 'Auto');

  function persistCadence(value: string) {
    setRefreshCadence(value);
    localStorage.setItem('allen.context.refresh-cadence', value);
  }

  function persistInjectionPolicy(value: string) {
    setInjectionPolicy(value);
    localStorage.setItem('allen.context.injection-policy', value);
  }

  return (
    <SettingsPageShell activeTab="context">
      <SettingsPanel className="settings-general-ledger">
        <SettingsRow label="Provider" description="Knowledge recall and repository graph backend.">
          <div className="settings-inline-action">
            <SettingsValue mono>Cognee</SettingsValue>
            <SettingsBadge tone="ok">connected</SettingsBadge>
          </div>
        </SettingsRow>
        <SettingsRow label="Refresh cadence" description="When Allen should refresh repository knowledge.">
          <select
            className="select-native settings-select settings-context-select"
            aria-label="Refresh cadence"
            value={refreshCadence}
            onChange={(event) => persistCadence(event.target.value)}
          >
            <option>On change</option>
            <option>Hourly</option>
            <option>Daily</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Default injection policy" description="How much recalled context is loaded into an agent run.">
          <select
            className="select-native settings-select settings-context-select settings-context-policy"
            aria-label="Default injection policy"
            value={injectionPolicy}
            onChange={(event) => persistInjectionPolicy(event.target.value)}
          >
            <option>Auto</option>
            <option>Manifest only</option>
            <option>Never full-auto</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Per-repo settings" description="Indexing health, mappings, and policies by repository.">
          <button type="button" className="settings-secondary-button" onClick={() => navigate('/repos')}>
            Open repositories <span aria-hidden="true">→</span>
          </button>
        </SettingsRow>
      </SettingsPanel>
    </SettingsPageShell>
  );
}

function McpTab() {
  return (
    <SettingsPageShell activeTab="mcp" wide>
      <div className="settings-mcp-compact">
        <McpServerManager compact />
      </div>
    </SettingsPageShell>
  );
}

function SchedulesTab() {
  return (
    <SettingsPageShell activeTab="schedules" wide>
      <div className="settings-embedded-page">
        <CronManagerPage compact />
      </div>
    </SettingsPageShell>
  );
}

function LearningsTab() {
  return (
    <SettingsPageShell activeTab="learnings" wide>
      <div className="settings-embedded-page">
        <LearningsPage compact />
      </div>
    </SettingsPageShell>
  );
}

function SkillsTab() {
  return (
    <SettingsPageShell activeTab="skills" wide>
      <div className="settings-embedded-page">
        <SkillsSettingsPage />
      </div>
    </SettingsPageShell>
  );
}

function UsageTab() {
  return (
    <SettingsPageShell activeTab="usage" wide>
      <UsageDashboard />
    </SettingsPageShell>
  );
}

function TeamTab() {
  const navigate = useNavigate();
  return (
    <SettingsPageShell activeTab="team">
      <SettingsPanel className="settings-team-handoff">
        <div className="settings-handoff-card">
          <div>
            <strong>Manage people and roles in Teams</strong>
            <span>Add members, set access, and organise the agents working in this workspace.</span>
          </div>
          <button type="button" className="settings-secondary-button" onClick={() => navigate('/agents?section=teams-agents')}>
            Open Teams <span aria-hidden="true">→</span>
          </button>
        </div>
      </SettingsPanel>
    </SettingsPageShell>
  );
}

function AccountTab() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clearAuth = useAuthStore((s) => s.clear);

  async function handleLogout() {
    try {
      if (refreshToken) await authApi.logout(refreshToken);
    } catch {
      // Clear locally even if server logout cannot be reached.
    }
    clearAuth();
    navigate('/login', { replace: true });
  }

  if (!user) {
    return (
      <SettingsPageShell activeTab="account">
        <SettingsPanel title="Session">
          <SettingsRow label="Status">
            <SettingsValue>Not signed in</SettingsValue>
          </SettingsRow>
        </SettingsPanel>
      </SettingsPageShell>
    );
  }

  const displayName = user.name || user.email;
  const avatarInitial = (displayName || 'A').trim().charAt(0).toUpperCase();

  return (
    <SettingsPageShell activeTab="account">
      <SettingsPanel className="settings-account-ledger">
        <div className="settings-identity-row">
          <div className="settings-avatar-dot">{avatarInitial}</div>
          <div className="settings-identity-copy">
            <strong>{displayName}</strong>
            <span>{user.email}</span>
          </div>
          <SettingsBadge>{formatRoleLabel(user.role).toLowerCase()}</SettingsBadge>
        </div>
        <SettingsRow
          label="Password"
          description={user.mustResetPassword ? 'A password reset is required.' : `Account created ${formatProfileDate(user.createdAt)}.`}
        >
          <button
            type="button"
            className="settings-secondary-button"
            onClick={() => navigate('/reset-password?from=/settings/account')}
          >
            Change password
          </button>
        </SettingsRow>
      </SettingsPanel>
      <SettingsSectionLabel>Session</SettingsSectionLabel>
      <SettingsPanel className="settings-account-ledger">
        <SettingsRow label="Sign out" description="Ends this desktop session.">
          <button type="button" className="settings-danger-button" onClick={() => void handleLogout()}>
            <span>Sign out</span>
          </button>
        </SettingsRow>
      </SettingsPanel>
    </SettingsPageShell>
  );
}

const TAB_COMPONENTS: Record<TabId, React.FC> = {
  account: AccountTab,
  context: ContextTab,
  general: GeneralTab,
  learnings: LearningsTab,
  models: ModelsTab,
  mcp: McpTab,
  runtime: RuntimeTab,
  schedules: SchedulesTab,
  skills: SkillsTab,
  team: TeamTab,
  usage: UsageTab,
};

export default function SettingsPage() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'admin';

  const requested = tab ? (SETTINGS_TAB_ALIASES[tab] ?? tab) : 'general';
  const tabDef = TABS.find((t) => t.id === requested);
  const allowed = tabDef && (!tabDef.adminOnly || isAdmin);
  const activeTab: TabId = requested && allowed ? (requested as TabId) : 'general';

  useEffect(() => {
    if (tab && SETTINGS_TAB_ALIASES[tab]) {
      navigate(`/settings/${SETTINGS_TAB_ALIASES[tab]}`, { replace: true });
    } else if (requested && !allowed) {
      navigate('/settings/general', { replace: true });
    }
  }, [requested, tab, allowed, navigate]);

  const TabContent = TAB_COMPONENTS[activeTab];

  return (
    <div className="content scroll-hide v8-settings" data-screen-label="settings">
      <main className={activeTab === 'skills' ? 'settings-main settings-main-full' : 'settings-main'}>
        <TabContent />
      </main>
    </div>
  );
}
