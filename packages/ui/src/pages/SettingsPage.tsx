import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Brain,
  CalendarClock,
  ChevronDown,
  FolderOpen,
  HardDrive,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Server,
  ShieldCheck,
  Sun,
  User,
} from 'lucide-react';
import McpServerManager from '../components/settings/McpServerManager';
import Select from '../components/common/Select';
import ShortcutKey from '../components/common/ShortcutKey';
import { auth as authApi, system as systemApi, type DesktopRuntimeSettingsResponse } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useSettingsStore } from '../stores/settingsStore';
import { type ColorMode } from '../lib/theme';
import CronManagerPage from './CronManagerPage';
import LearningsPage from './LearningsPage';
import UsersAdminPage from './UsersAdminPage';

const TABS = [
  { id: 'general', adminOnly: false },
  { id: 'runtime', adminOnly: false },
  { id: 'mcp', adminOnly: false },
  { id: 'schedules', adminOnly: false },
  { id: 'learnings', adminOnly: false },
  { id: 'team', adminOnly: true },
  { id: 'account', adminOnly: false },
] as const;

type TabId = (typeof TABS)[number]['id'];

const PAGE_COPY: Record<TabId, { title: string; description: string; icon: React.ElementType }> = {
  general: {
    title: 'General',
    description: 'Set the everyday behavior for Allen on this device.',
    icon: User,
  },
  runtime: {
    title: 'Runtime',
    description: 'Review desktop runtime paths, database mode, logs, and diagnostics.',
    icon: HardDrive,
  },
  mcp: {
    title: 'MCP Servers',
    description: 'Register and inspect Model Context Protocol servers available to Allen.',
    icon: Server,
  },
  schedules: {
    title: 'Schedules',
    description: 'Manage recurring Allen jobs and scheduled automation.',
    icon: CalendarClock,
  },
  learnings: {
    title: 'Learnings',
    description: 'Review reusable knowledge Allen has collected from work.',
    icon: Brain,
  },
  team: {
    title: 'Team',
    description: 'Manage users, roles, and workspace access.',
    icon: ShieldCheck,
  },
  account: {
    title: 'Account',
    description: 'Review your signed-in profile and session.',
    icon: User,
  },
};

const SETTINGS_TAB_ALIASES: Record<string, TabId> = {
  advanced: 'runtime',
  analytics: 'runtime',
  appearance: 'general',
  integrations: 'mcp',
  notifications: 'general',
  profile: 'account',
  providers: 'mcp',
  shortcuts: 'general',
  users: 'team',
};

const COLOR_MODE_OPTIONS = [
  { value: 'system' as ColorMode, label: 'System', icon: Monitor },
  { value: 'light' as ColorMode, label: 'Light', icon: Sun },
  { value: 'dark' as ColorMode, label: 'Dark', icon: Moon },
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
  const Icon = page.icon;
  return (
    <div className={`settings-page ${wide ? 'wide' : ''}`}>
      <div className="settings-page-head">
        <div className="settings-page-icon">
          <Icon className="h-4 w-4" />
        </div>
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
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-panel">
      <div className="settings-panel-head">
        <div className="settings-panel-head-copy">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="settings-panel-head-action">{action}</div>}
      </div>
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
      aria-pressed={checked}
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
  return (
    <SettingsPageShell activeTab="general">
      <SettingsPanel title="Workspace behavior" description="Defaults for the local Allen desktop experience.">
        <SettingsRow label="Appearance" description="Use system mode or choose a fixed light or dark theme.">
          <AppearancePicker />
        </SettingsRow>
        <SettingsRow label="Command palette" description="Quickly navigate and run app commands.">
          <ShortcutKey value="⌘K" />
        </SettingsRow>
        <SettingsRow label="Focus chat input" description="Focus chat input, or jump to dashboard and focus it from another page.">
          <ShortcutKey value="⌘L" />
        </SettingsRow>
      </SettingsPanel>

      <SettingsPanel title="Notifications" description="Keep interruptions focused on work that needs attention.">
        <SettingsRow label="Run completions" description="Notify when Allen completes a long-running task.">
          <SettingsSwitch />
        </SettingsRow>
        <SettingsRow label="Daily digest" description="Summarize completed work and unresolved items.">
          <SettingsValue>Off</SettingsValue>
        </SettingsRow>
      </SettingsPanel>
    </SettingsPageShell>
  );
}

type RuntimeSettings = DesktopRuntimeSettingsResponse;
type RuntimeSettingField = RuntimeSettings['groups'][number]['fields'][number];
type RuntimeSettingOption = NonNullable<RuntimeSettingField['options']>[number];

const PROVIDER_DEFAULT_MODEL_OPTION: RuntimeSettingOption = { label: 'Provider default', value: '' };
const CLAUDE_RUNTIME_MODEL_OPTIONS: RuntimeSettingOption[] = [
  { label: 'sonnet', value: 'sonnet' },
  { label: 'opus', value: 'opus' },
  { label: 'haiku', value: 'haiku' },
];
const CODEX_RUNTIME_MODEL_OPTIONS: RuntimeSettingOption[] = [
  { label: 'gpt-5.5', value: 'gpt-5.5' },
  { label: 'gpt-5.4', value: 'gpt-5.4' },
  { label: 'gpt-5.3-codex', value: 'gpt-5.3-codex' },
  { label: 'gpt-5.2-codex', value: 'gpt-5.2-codex' },
  { label: 'gpt-5.1-codex-max', value: 'gpt-5.1-codex-max' },
  { label: 'gpt-5.2', value: 'gpt-5.2' },
  { label: 'gpt-5.1-codex-mini', value: 'gpt-5.1-codex-mini' },
];
const OPEN_PROVIDER_RUNTIME_MODEL_OPTIONS: Record<string, RuntimeSettingOption[]> = {
  deepseek: [
    { label: 'deepseek-v4-pro[1m]', value: 'deepseek-v4-pro[1m]' },
    { label: 'deepseek-v4-flash', value: 'deepseek-v4-flash' },
  ],
  'xiaomi-mimo': [
    { label: 'mimo-v2.5-pro', value: 'mimo-v2.5-pro' },
  ],
};

function llmOptionsForProvider(provider: string, includeProviderDefault = false): RuntimeSettingOption[] {
  const models = provider === 'claude-cli'
    ? CLAUDE_RUNTIME_MODEL_OPTIONS
    : provider === 'codex'
      ? CODEX_RUNTIME_MODEL_OPTIONS
      : OPEN_PROVIDER_RUNTIME_MODEL_OPTIONS[provider] ?? [...CLAUDE_RUNTIME_MODEL_OPTIONS, ...CODEX_RUNTIME_MODEL_OPTIONS];
  return includeProviderDefault ? [PROVIDER_DEFAULT_MODEL_OPTION, ...models] : models;
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

function runtimeSelectOptions(field: RuntimeSettingField, values: Record<string, string>): RuntimeSettingOption[] {
  if (field.key === 'ALLEN_DEFAULT_AGENT_MODEL') {
    return llmOptionsForProvider(values.ALLEN_DEFAULT_AGENT_PROVIDER ?? '', true);
  }
  if (field.key === 'ALLEN_CONTEXT_LLM_MODEL') {
    return llmOptionsForProvider(values.ALLEN_CONTEXT_LLM_PROVIDER ?? '');
  }
  return field.options ?? [];
}

function RuntimeSettingControl({
  editable,
  field,
  onChange,
  runtimeValues,
  value,
}: {
  editable: boolean;
  field: RuntimeSettingField;
  onChange: (key: string, value: string) => void;
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
    const options = runtimeSelectOptions(field, runtimeValues);
    const hasCurrentValue = value === '' || options.some((option) => option.value === value);
    const selectOptions = hasCurrentValue
      ? options
      : [{ value, label: value }, ...options];
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

function LlmProvidersPanel({
  configs,
  editable,
  runtime,
  runtimeSettings,
  runtimeValues,
  onRuntimeRefresh,
  onRuntimeSettingsRefresh,
  onUpdateRuntimeValue,
}: {
  configs: ClaudeCompatibleProviderPanelConfig[];
  editable: boolean;
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
  const [saveErrorById, setSaveErrorById] = useState<Record<string, string | null>>({});
  const [saveSuccessById, setSaveSuccessById] = useState<Record<string, boolean>>({});

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

  async function saveProviderSettings(config: ClaudeCompatibleProviderPanelConfig) {
    setSavingProviderId(config.groupId);
    setSaveErrorById((current) => ({ ...current, [config.groupId]: null }));
    setSaveSuccessById((current) => ({ ...current, [config.groupId]: false }));
    try {
      const apiKeyInput = apiKeyInputs[config.groupId] ?? '';
      if (apiKeyInput.trim()) {
        await systemApi.setDesktopSecret(config.apiKey, apiKeyInput.trim());
        setApiKeyInputs((current) => ({ ...current, [config.groupId]: '' }));
        onRuntimeRefresh();
      }
      const nonSecretValues: Record<string, string> = {};
      for (const key of config.settingKeys) {
        if (runtimeValues[key] !== undefined) {
          nonSecretValues[key] = runtimeValues[key];
        }
      }
      if (Object.keys(nonSecretValues).length > 0) {
        const updated = await systemApi.updateDesktopRuntimeSettings(nonSecretValues);
        onRuntimeSettingsRefresh(updated);
      }
      setSaveSuccessById((current) => ({ ...current, [config.groupId]: true }));
      setTimeout(() => {
        setSaveSuccessById((current) => ({ ...current, [config.groupId]: false }));
      }, 3000);
    } catch (err) {
      setSaveErrorById((current) => ({ ...current, [config.groupId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSavingProviderId(null);
    }
  }

  async function deleteApiKey(config: ClaudeCompatibleProviderPanelConfig) {
    setSavingProviderId(config.groupId);
    setSaveErrorById((current) => ({ ...current, [config.groupId]: null }));
    try {
      await systemApi.deleteDesktopSecret(config.apiKey);
      setEnabledById((current) => ({ ...current, [config.groupId]: false }));
      setExpandedById((current) => ({ ...current, [config.groupId]: false }));
      onRuntimeRefresh();
    } catch (err) {
      setSaveErrorById((current) => ({ ...current, [config.groupId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSavingProviderId(null);
    }
  }

  return (
    <SettingsPanel
      title="LLM Providers"
      description="Configure Anthropic-compatible API providers used by chat and workflow agents. Enable a provider to enter credentials and endpoint settings."
    >
      <div className="settings-provider-list">
        {configs.map((config) => {
          const enabled = enabledById[config.groupId] ?? apiKeyConfigured(config);
          const expanded = Boolean(expandedById[config.groupId]);
          const configured = apiKeyConfigured(config);
          const group = providerGroup(config);
          const saving = savingProviderId === config.groupId;
          const saveError = saveErrorById[config.groupId];
          const saveSuccess = saveSuccessById[config.groupId];

          return (
            <div key={config.groupId} className={`settings-provider-item ${enabled ? 'enabled' : ''}`}>
              <div className="settings-provider-summary">
                <button
                  type="button"
                  className="settings-provider-main"
                  onClick={() => {
                    if (!enabled) {
                      setEnabledById((current) => ({ ...current, [config.groupId]: true }));
                      setExpandedById((current) => ({ ...current, [config.groupId]: true }));
                      return;
                    }
                    setExpandedById((current) => ({ ...current, [config.groupId]: !current[config.groupId] }));
                  }}
                  aria-expanded={expanded}
                >
                  <span className="settings-provider-mark">
                    <KeyRound className="h-3.5 w-3.5" />
                  </span>
                  <span className="settings-provider-copy">
                    <strong>{config.title}</strong>
                    <span>{configured ? 'API key configured' : enabled ? 'Enter API key and endpoint settings' : config.disabledLabel}</span>
                  </span>
                </button>
                <span className="settings-provider-state">
                  <SettingsBadge tone={configured ? 'ok' : enabled ? 'warn' : 'neutral'}>
                    {configured ? 'configured' : enabled ? 'needs key' : 'off'}
                  </SettingsBadge>
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
                    disabled={!enabled}
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
                          <span>Default: {field.defaultValue || 'empty'}</span>
                          <span>Source: {runtimeSourceLabel(field.source)}</span>
                        </div>
                      </div>
                    </SettingsRow>
                  ))}

                  {editable && (
                    <SettingsRow label="Save">
                      <div className="settings-field-control">
                        <div className="settings-inline-action">
                          <button
                            type="button"
                            className="settings-secondary-button"
                            disabled={saving}
                            onClick={() => void saveProviderSettings(config)}
                          >
                            {saving ? 'Saving...' : config.saveLabel}
                          </button>
                          {saveSuccess && <SettingsBadge tone="ok">Saved</SettingsBadge>}
                        </div>
                        {saveError && (
                          <div className="settings-field-meta">
                            <span className="text-accent-red">{saveError}</span>
                          </div>
                        )}
                      </div>
                    </SettingsRow>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SettingsPanel>
  );
}

function RuntimeTab() {
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof systemApi.desktopRuntime>> | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null);
  const [runtimeValues, setRuntimeValues] = useState<Record<string, string>>({});
  const [desktopInfo, setDesktopInfo] = useState<Awaited<ReturnType<NonNullable<typeof window.allenDesktop>['getRuntimeInfo']>> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cogneeSetupStatus, setCogneeSetupStatus] = useState<string | null>(null);

  useEffect(() => {
    void systemApi.desktopRuntime().then(setRuntime).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    void systemApi.desktopRuntimeSettings().then((settings) => {
      setRuntimeSettings(settings);
      setRuntimeValues(settingsValueMap(settings));
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    void window.allenDesktop?.getRuntimeInfo().then(setDesktopInfo).catch(() => null);
  }, []);

  function updateRuntimeValue(key: string, value: string) {
    setRuntimeValues((current) => {
      const next = { ...current, [key]: value };
      if (key === 'ALLEN_DEFAULT_AGENT_PROVIDER') {
        const options = llmOptionsForProvider(value, true);
        if (!options.some((option) => option.value === next.ALLEN_DEFAULT_AGENT_MODEL)) {
          next.ALLEN_DEFAULT_AGENT_MODEL = '';
        }
      }
      if (key === 'ALLEN_CONTEXT_LLM_PROVIDER') {
        const options = llmOptionsForProvider(value);
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
      setRuntimeSettings(updated);
      setRuntimeValues(settingsValueMap(updated));
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
      setRuntimeSettings(result.settings);
      setRuntimeValues(settingsValueMap(result.settings));
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

  return (
    <SettingsPageShell activeTab="runtime" wide>
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

      {runtimeSettings && (
        <>
          {runtimeSettings.groups.map((group) => {
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
            if (apiProviderGroupIds.has(group.id)) return null; // rendered separately below
            if (fields.length === 0 && !isCogneeContextGroup) return null;
            return (
              <SettingsPanel
                key={group.id}
                title={isCogneeContextGroup ? 'Cognee Context' : group.title}
                description={isCogneeContextGroup ? 'Enable Cognee-backed repository context. Saving this change applies to future context builds without restarting the app.' : group.description}
                action={isCogneeContextGroup && providerField ? (
                  <SettingsSwitch
                    checked={cogneeEnabled}
                    disabled={!runtimeSettings.editable || providerField.readOnly}
                    onClick={() => updateRuntimeValue('ALLEN_CONTEXT_PROVIDER', cogneeEnabled ? '' : 'cognee')}
                  />
                ) : undefined}
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
                        runtimeValues={runtimeValues}
                        onChange={updateRuntimeValue}
                      />
                      <div className="settings-field-meta">
                        {field.key === 'ALLEN_CONTEXT_PROVIDER' ? (
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

          {apiProviderPanelConfigs.length > 0 && (
            <LlmProvidersPanel
              configs={apiProviderPanelConfigs}
              editable={runtimeSettings.editable}
              runtime={runtime}
              runtimeSettings={runtimeSettings}
              runtimeValues={runtimeValues}
              onRuntimeRefresh={() => void refreshRuntime()}
              onRuntimeSettingsRefresh={(updated) => {
                setRuntimeSettings(updated);
                setRuntimeValues(settingsValueMap(updated));
              }}
              onUpdateRuntimeValue={updateRuntimeValue}
            />
          )}

          <div className="settings-floating-actions">
            <button
              type="button"
              className="settings-secondary-button"
              disabled={saving === 'runtime-settings' || !runtimeSettings.editable}
              onClick={() => void saveRuntimeSettings()}
            >
              Save runtime settings
            </button>
          </div>
        </>
      )}

    </SettingsPageShell>
  );
}

function McpTab() {
  return (
    <SettingsPageShell activeTab="mcp" wide>
      <SettingsPanel title="Configured servers" description="Servers can expose tools and resources to Allen workflows.">
        <div className="[&_.mcp-settings-panel]:p-0 [&_.mcp-panel-head]:border-b [&_.mcp-panel-head]:border-app [&_.mcp-panel-head]:px-4 [&_.mcp-panel-head]:py-3.5 [&_.mcp-panel-head_h2]:font-body [&_.mcp-panel-head_h2]:text-[13px] [&_.mcp-panel-head_h2]:font-semibold [&_.mcp-panel-head_h2]:normal-case [&_.mcp-panel-head_h2]:tracking-normal [&_.mcp-panel-head_p]:mt-1 [&_.mcp-panel-head_p]:text-[12px] [&_.mcp-panel-body]:p-3.5 [&_.mcp-server-groups]:space-y-3.5 [&_.mcp-server-group_h3]:mb-2 [&_.mcp-server-group_h3]:px-0.5 [&_.mcp-server-group_h3]:font-body [&_.mcp-server-group_h3]:text-[12px] [&_.mcp-server-group_h3]:font-semibold [&_.mcp-server-group_h3]:normal-case [&_.mcp-server-group_h3]:tracking-normal [&_.mcp-server-card]:rounded-lg [&_.mcp-server-card]:border-app [&_.mcp-server-card]:bg-app-card [&_.mcp-server-row]:min-h-16 [&_.mcp-server-row]:px-3.5 [&_.mcp-server-row]:py-3 [&_.mcp-server-details]:bg-app-muted/45 [&_.mcp-server-details]:px-4 [&_.mcp-server-details]:py-3">
          <McpServerManager />
        </div>
      </SettingsPanel>
    </SettingsPageShell>
  );
}

function SchedulesTab() {
  return (
    <SettingsPageShell activeTab="schedules" wide>
      <div className="settings-embedded-page">
        <CronManagerPage />
      </div>
    </SettingsPageShell>
  );
}

function LearningsTab() {
  return (
    <SettingsPageShell activeTab="learnings" wide>
      <div className="settings-embedded-page">
        <LearningsPage />
      </div>
    </SettingsPageShell>
  );
}

function TeamTab() {
  return (
    <SettingsPageShell activeTab="team" wide>
      <div className="settings-embedded-page">
        <UsersAdminPage />
      </div>
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
      <SettingsPanel title="Profile" description="This is the account Allen uses for local desktop access.">
        <div className="settings-account-card">
          <div className="settings-avatar-dot">{avatarInitial}</div>
          <div className="min-w-0">
            <strong>{displayName}</strong>
            <span>{user.email}</span>
          </div>
          <span className="ml-auto inline-flex h-6 shrink-0 items-center rounded-md border border-app bg-app-muted px-2 text-[12px] font-medium text-theme-secondary">
            {formatRoleLabel(user.role)}
          </span>
        </div>
        <SettingsRow label="Full name">
          <ReadOnlyInput value={user.name || '-'} />
        </SettingsRow>
        <SettingsRow label="User ID">
          <SettingsValue mono>{user.id}</SettingsValue>
        </SettingsRow>
        <SettingsRow label="Created">
          <SettingsValue>{formatProfileDate(user.createdAt)}</SettingsValue>
        </SettingsRow>
        <SettingsRow label="Last login">
          <SettingsValue>{formatProfileDate(user.lastLoginAt)}</SettingsValue>
        </SettingsRow>
        {user.mustResetPassword && (
          <SettingsRow label="Password">
            <SettingsBadge tone="warn">Reset required</SettingsBadge>
          </SettingsRow>
        )}
      </SettingsPanel>

      <SettingsPanel title="Session">
        <SettingsRow label="Sign out" description="End this Allen session on this device.">
          <button type="button" className="settings-danger-button" onClick={() => void handleLogout()}>
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign out</span>
          </button>
        </SettingsRow>
      </SettingsPanel>
    </SettingsPageShell>
  );
}

const TAB_COMPONENTS: Record<TabId, React.FC> = {
  account: AccountTab,
  general: GeneralTab,
  learnings: LearningsTab,
  mcp: McpTab,
  runtime: RuntimeTab,
  schedules: SchedulesTab,
  team: TeamTab,
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
    <div className="content scroll-hide" data-screen-label="settings">
      <main className="settings-main">
        <TabContent />
      </main>
    </div>
  );
}
