import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Brain,
  CalendarClock,
  FolderOpen,
  HardDrive,
  LogOut,
  Monitor,
  Moon,
  Server,
  ShieldCheck,
  Sun,
  User,
} from 'lucide-react';
import McpServerManager from '../components/settings/McpServerManager';
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
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-panel">
      <div className="settings-panel-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
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
        <SettingsRow label="Startup view" description="Open Allen to the operational dashboard.">
          <SettingsValue>Dashboard</SettingsValue>
        </SettingsRow>
        <SettingsRow label="Command palette" description="Quickly navigate and run app commands.">
          <ShortcutKey value="⌘K" />
        </SettingsRow>
        <SettingsRow label="Repository handoff" description="Ask before using a repository for a new workflow.">
          <SettingsSwitch checked />
        </SettingsRow>
      </SettingsPanel>

      <SettingsPanel title="Notifications" description="Keep interruptions focused on work that needs attention.">
        <SettingsRow label="Run completions" description="Notify when Allen completes a long-running task.">
          <SettingsSwitch />
        </SettingsRow>
        <SettingsRow label="Approval requests" description="Surface required approvals and questions.">
          <SettingsSwitch checked />
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

function RuntimeSettingControl({
  editable,
  field,
  onChange,
  value,
}: {
  editable: boolean;
  field: RuntimeSettingField;
  onChange: (key: string, value: string) => void;
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
    return (
      <select
        className="settings-edit-input"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(field.key, event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={`${field.key}-${option.value}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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

function RuntimeTab() {
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof systemApi.desktopRuntime>> | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null);
  const [runtimeValues, setRuntimeValues] = useState<Record<string, string>>({});
  const [desktopInfo, setDesktopInfo] = useState<Awaited<ReturnType<NonNullable<typeof window.allenDesktop>['getRuntimeInfo']>> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supportBundleStatus, setSupportBundleStatus] = useState<string | null>(null);
  const [cogneeSetupStatus, setCogneeSetupStatus] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

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
    setRuntimeValues((current) => ({ ...current, [key]: value }));
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

  async function exportSupportBundle() {
    setSaving('support-bundle');
    setError(null);
    setSupportBundleStatus(null);
    try {
      const result = await window.allenDesktop?.exportSupportBundle();
      if (!result) throw new Error('Desktop bridge is unavailable');
      if (result.canceled) return;
      if (!result.ok) throw new Error(result.error ?? 'Support bundle export failed');
      setSupportBundleStatus(result.path ? `saved to ${result.path}` : 'saved');
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
          <SettingsPanel title="Desktop runtime settings" description="Feature flags and environment-backed settings managed by the desktop app. Defaults and current sources are shown for every field.">
            <SettingsRow label="Advanced settings" description="Show low-level context, agent, and diagnostics options.">
              <SettingsSwitch checked={showAdvanced} onClick={() => setShowAdvanced(!showAdvanced)} />
            </SettingsRow>
            <SettingsRow label="Config file" description={runtimeSettings.editable ? 'Changes are saved here and mirrored into the running desktop process.' : 'This install is running in web mode.'}>
              <SettingsValue mono>{runtimeSettings.configPath ?? '.env'}</SettingsValue>
            </SettingsRow>
          </SettingsPanel>

          {runtimeSettings.groups.map((group) => {
            const fields = group.fields.filter((field) => runtimeFieldVisible(field, runtimeValues) && (!field.advanced || showAdvanced));
            return (
              <SettingsPanel key={group.id} title={group.title} description={group.description}>
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

      <SettingsPanel title="Diagnostics" description="Export a support bundle when debugging local runtime issues.">
        <SettingsRow label="Support bundle" description="Includes diagnostics, health state, and recent log tails.">
          <div className="settings-inline-action">
            <SettingsValue mono>{supportBundleStatus ?? 'Not exported'}</SettingsValue>
            <button
              type="button"
              className="settings-secondary-button"
              disabled={saving === 'support-bundle'}
              onClick={() => void exportSupportBundle()}
            >
              Export
            </button>
          </div>
        </SettingsRow>
      </SettingsPanel>
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
