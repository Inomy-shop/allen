import { useState, useEffect, useMemo } from 'react';
import { X, Sparkles, FileText, Eye, Columns, Pencil, AlertCircle, AlertTriangle, Check, ChevronRight } from 'lucide-react';
import Select from './Select';
import RoleIcon from './RoleIcon';
import { renderMarkdown } from '../chat/ChatMessageList';
import { mcp as mcpApi, type McpToolGroup } from '../../services/api';
import { ALLEN_MCP_TOOL_NAMES } from '../../lib/allen-mcp-tools';
import { useEnabledProvidersStatus, isProviderSelectable } from '../../hooks/useEnabledProviders';
import { useModelRegistry, getModelDisplay } from '../../hooks/useModelRegistry';
import { buildModelOptionsForProvider } from '../../lib/model-catalog';
import {
  isNonClaudeOpenRouterModel,
  OPENROUTER_NON_CLAUDE_WARNING,
} from '../../lib/openrouter-warning';

const TOOLS = ['filesystem', 'terminal', 'git', 'web-search', 'web-fetch', 'database'];
const EFFORT_LEVELS = [
  { value: '', label: '(CLI default)' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max — Opus only' },
];
const PLAN_MODE_OPTIONS = [
  { value: '', label: '(CLI default: off)' },
  { value: 'off', label: 'Off — may edit files' },
  { value: 'on', label: 'On — read & plan only' },
];
const ICONS = ['clipboard', 'code', 'eye', 'search', 'flask', 'pen', 'git-branch', 'bar-chart', 'magnifying-glass', 'layout', 'bot'];
const AGENT_TYPES = [
  { value: 'team', label: 'Team Agent — coordinates and spawns agents' },
  { value: 'technical', label: 'Technical Agent — executes specific tasks' },
];
const MCP_TOOL_REFRESH_DELAYS = [1_500, 5_000, 10_000, 20_000, 30_000];
const TOOL_LABELS: Record<string, string> = {
  filesystem: 'Files',
  terminal: 'Terminal',
  git: 'Git',
  'web-search': 'Web search',
  'web-fetch': 'Web fetch',
  database: 'Database',
};

// Provider ids are stored canonically ('claude', 'codex', API provider ids).
// 'claude-cli' is the pre-rename legacy id — accept it when loading old agents.
function normalizeProviderForUi(p: unknown): string {
  if (typeof p === 'string' && p) return p === 'claude-cli' ? 'claude' : p;
  return 'claude';
}

function withConfiguredMcpGroups(
  groups: McpToolGroup[],
  configuredServers: string[],
  disabledTools: Record<string, string[]>,
): McpToolGroup[] {
  const byName = new Map(groups.map((group) => [group.serverName, group]));
  if (!byName.has('allen')) {
    byName.set('allen', {
      serverName: 'allen',
      builtIn: true,
      enabled: true,
      tools: ALLEN_MCP_TOOL_NAMES.map((name) => ({ name, fullName: `mcp__allen__${name}`, description: '' })),
    });
  }
  for (const serverName of [...configuredServers, ...Object.keys(disabledTools)]) {
    if (!serverName || byName.has(serverName)) continue;
    byName.set(serverName, { serverName, builtIn: false, enabled: true, tools: [] });
  }
  return [...byName.values()].sort((a, b) => {
    if (a.serverName === 'allen') return -1;
    if (b.serverName === 'allen') return 1;
    return a.serverName.localeCompare(b.serverName);
  });
}

interface RoleDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  role?: Record<string, unknown> | null;
  teams?: Array<{ name: string; displayName: string }>;
  initialTeamName?: string;
}

type EditorMode = 'edit' | 'preview' | 'split';

export default function RoleDialog({
  open,
  onClose,
  onSave,
  role,
  teams = [],
  initialTeamName = '',
}: RoleDialogProps) {
  const isEdit = !!role;
  const { providers: enabledProviders, loaded: enabledProvidersLoaded } = useEnabledProvidersStatus();
  const { getModelsForProvider: registryGetModelsForProvider, getDefaultModelForProvider } = useModelRegistry();
  // Selectable = enabled, and for CLI providers (claude/codex) also logged in.
  const selectableProviders = useMemo(
    () => enabledProviders.filter(isProviderSelectable),
    [enabledProviders],
  );
  const availableUiProviders = useMemo(
    () => new Set(selectableProviders.map((item) => item.provider)),
    [selectableProviders],
  );

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [system, setSystem] = useState('');
  const [provider, setProvider] = useState('claude');
  const [model, setModel] = useState(() => getDefaultModelForProvider('claude'));
  const [isOtherModel, setIsOtherModel] = useState(false);
  const [customModel, setCustomModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [planMode, setPlanMode] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [externalMcpServers, setExternalMcpServers] = useState<string[]>([]);
  const [disabledMcpTools, setDisabledMcpTools] = useState<Record<string, string[]>>({});
  const [mcpToolGroups, setMcpToolGroups] = useState<McpToolGroup[]>([]);
  const [icon, setIcon] = useState('clipboard');
  const [color, setColor] = useState('#3b82f6');
  const [agentType, setAgentType] = useState('technical');
  const [teamName, setTeamName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPreviousPrompt, setShowPreviousPrompt] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>('edit');
  const [expandedMcpServers, setExpandedMcpServers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && role) {
      setName((role.name as string) ?? '');
      setDisplayName((role.displayName as string) ?? '');
      setSystem((role.system as string) ?? '');
      setProvider(normalizeProviderForUi(role.provider));
      setModel((role.model as string) ?? getDefaultModelForProvider(normalizeProviderForUi(role.provider)));
      setReasoningEffort((role.reasoningEffort as string) ?? '');
      setPlanMode(
        role.planMode === true ? 'on' : role.planMode === false ? 'off' : '',
      );
      setTools((role.tools as string[]) ?? []);
      setExternalMcpServers(Array.isArray(role.externalMcpServers)
        ? (role.externalMcpServers as string[]).filter(Boolean)
        : []);
      const configuredDisabled = role.disabledMcpTools && typeof role.disabledMcpTools === 'object' && !Array.isArray(role.disabledMcpTools)
        ? role.disabledMcpTools as Record<string, string[]>
        : {};
      setDisabledMcpTools({
        ...configuredDisabled,
        ...(Array.isArray(role.disabledAllenMcpTools)
          ? { allen: [...new Set([...(configuredDisabled.allen ?? []), ...(role.disabledAllenMcpTools as string[]).filter(Boolean)])] }
          : {}),
      });
      setIcon((role.icon as string) ?? 'clipboard');
      setColor((role.color as string) ?? '#3b82f6');
      setAgentType((role.type as string) ?? 'technical');
      setTeamName((role.teamName as string) ?? initialTeamName);
      setShowPreviousPrompt(false);
      setEditorMode('edit');
      setExpandedMcpServers(new Set(Object.keys(configuredDisabled)));
      setIsOtherModel(false);
      setCustomModel('');
    } else if (open) {
      setName('');
      setDisplayName('');
      setSystem('');
      setProvider('claude');
      setModel(getDefaultModelForProvider('claude'));
      setReasoningEffort('');
      setPlanMode('');
      setTools([]);
      setExternalMcpServers([]);
      setDisabledMcpTools({});
      setIcon('clipboard');
      setColor('#3b82f6');
      setAgentType('technical');
      setTeamName(initialTeamName);
      setShowPreviousPrompt(false);
      setEditorMode('edit');
      setExpandedMcpServers(new Set());
      setIsOtherModel(false);
      setCustomModel('');
    }
    setError('');
  }, [open, role, initialTeamName]);

  useEffect(() => {
    if (!open || !enabledProvidersLoaded || availableUiProviders.has(provider)) return;
    const fallback = selectableProviders[0]?.provider;
    if (!fallback) return;
    setProvider(fallback);
    setModel(getDefaultModelForProvider(fallback));
    setPlanMode('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableUiProviders, selectableProviders, enabledProvidersLoaded, open, provider]);

  // The registry may finish loading after the open-reset above ran — backfill
  // the default model once it's available instead of leaving the field empty.
  useEffect(() => {
    if (!open || model || isOtherModel || isEdit) return;
    const def = getDefaultModelForProvider(provider);
    if (def) setModel(def);
  }, [open, model, isOtherModel, isEdit, provider, getDefaultModelForProvider]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadGroups = (refresh?: boolean) => mcpApi.tools({ refresh })
      .then((groups) => {
        if (cancelled) return;
        setMcpToolGroups(groups ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setMcpToolGroups([
            {
              serverName: 'allen',
              builtIn: true,
              enabled: true,
              tools: ALLEN_MCP_TOOL_NAMES.map((name) => ({ name, fullName: `mcp__allen__${name}`, description: '' })),
            },
          ]);
        }
      });
    void loadGroups();
    const timers = MCP_TOOL_REFRESH_DELAYS.map((delay) =>
      window.setTimeout(() => { void loadGroups(false); }, delay),
    );
    return () => {
      cancelled = true;
      timers.forEach(window.clearTimeout);
    };
  }, [open]);

  function handleProviderChange(val: string) {
    setProvider(val);
    setIsOtherModel(false);
    setCustomModel('');
    const models = buildModelOptionsForProvider(val, enabledProviders, registryGetModelsForProvider(val));
    const firstModel = models.find((option) => option.value !== '__other__');
    setModel(firstModel?.value ?? '');
  }

  function toggleTool(tool: string) {
    setTools(prev => prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]);
  }

  function toggleExternalMcpServer(name: string) {
    setExternalMcpServers(prev => prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name]);
  }

  function toggleMcpTool(serverName: string, toolName: string) {
    setDisabledMcpTools(prev => {
      const disabled = prev[serverName] ?? [];
      const next = disabled.includes(toolName)
        ? disabled.filter(t => t !== toolName)
        : [...disabled, toolName];
      return { ...prev, [serverName]: next };
    });
  }

  function toggleMcpServerExpanded(serverName: string) {
    setExpandedMcpServers(prev => {
      const next = new Set(prev);
      if (next.has(serverName)) next.delete(serverName);
      else next.add(serverName);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (!isEdit && !teamName) { setError('Team is required'); return; }
    if (!system.trim()) { setError('System prompt is required'); return; }

    setSaving(true);
    setError('');
    try {
      await onSave({
        name: name.trim(),
        displayName: displayName.trim() || name.trim(),
        system: system.trim(),
        provider,
        model,
        reasoningEffort: reasoningEffort || undefined,
        planMode: planMode === '' ? undefined : planMode === 'on',
        tools,
        externalMcpServers,
        disabledMcpTools,
        icon,
        color,
        type: agentType,
        teamName: teamName || undefined,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }

  async function handleRollback() {
    if (!role?.previousSystemPrompt) return;
    setSaving(true);
    setError('');
    try {
      await onSave({
        name: role.name as string,
        system: role.previousSystemPrompt as string,
        previousSystemPrompt: null,
        provider,
        model,
        tools,
        icon,
        color,
        type: agentType,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to rollback');
    } finally {
      setSaving(false);
    }
  }

  // Hooks must run on every render — keep this above the `!open` early
  // return or the hook count changes when the dialog opens (React #310).
  const registryModelsForProvider = useMemo(() => registryGetModelsForProvider(provider), [registryGetModelsForProvider, provider]);

  if (!open) return null;

  const modelOptions = buildModelOptionsForProvider(provider, enabledProviders, registryModelsForProvider, model);
  const providerOptions = selectableProviders
    .map((item) => item.provider)
    .filter((p, index, all) => all.indexOf(p) === index)
    .map(p => ({
      value: p,
      label: getModelDisplay(p).providerLabel,
    }));
  const iconOptions = ICONS.map(i => ({ value: i, label: i }));
  const typeOptions = AGENT_TYPES.map(t => ({ value: t.value, label: t.label }));
  const teamOptions = teams.map(team => ({
    value: team.name,
    label: team.displayName,
    sublabel: team.name,
  }));

  const wordCount = system.trim() ? system.trim().split(/\s+/).length : 0;
  const charCount = system.length;
  const lineCount = system ? system.split('\n').length : 0;
  const visibleMcpToolGroups = withConfiguredMcpGroups(mcpToolGroups, externalMcpServers, disabledMcpTools);
  const enabledMcpToolCount = visibleMcpToolGroups.reduce((sum, group) => {
    const groupEnabled = group.serverName === 'allen' || externalMcpServers.includes(group.serverName);
    if (!groupEnabled) return sum;
    const disabled = new Set(disabledMcpTools[group.serverName] ?? []);
    return sum + group.tools.filter(tool => !disabled.has(tool.name)).length;
  }, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-app px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app"
              style={{ backgroundColor: color + '18' }}
            >
              <RoleIcon icon={icon} color={color} size={19} />
            </div>
            <div className="min-w-0">
              <h2 className="text-[17px] font-semibold tracking-tight text-theme-primary">
                {isEdit ? 'Edit agent' : 'Create agent'}
              </h2>
              <div className="mt-1 font-mono text-[12px] text-theme-muted">
                {displayName || name || 'New agent'}
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-md text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-[26rem_1fr]">
            {/* ── Left column: metadata fields ───────────────────────────── */}
            <div className="min-h-0 space-y-5 overflow-y-auto border-r border-app bg-app-muted/15 p-5">
              {error && (
                <div className="flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[13px] text-accent-red">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="overline text-theme-muted">Identity</h3>
                  <span className="font-mono text-[10px] text-theme-subtle">{agentType}</span>
                </div>

                <div>
                  <label className="mb-1.5 block overline">Agent Type</label>
                  <Select value={agentType} onChange={setAgentType} options={typeOptions} />
                </div>

                {!isEdit && (
                  <div>
                    <label className="mb-1.5 block overline">Team</label>
                    <Select
                      value={teamName}
                      onChange={setTeamName}
                      options={teamOptions}
                      placeholder="Select team..."
                      searchPlaceholder="Search teams..."
                    />
                  </div>
                )}

                <div>
                  <label className="mb-1.5 block overline">Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    disabled={isEdit}
                    placeholder="my-agent-name"
                    className="input w-full disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block overline">Display Name</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    placeholder="My Agent"
                    className="input w-full"
                  />
                </div>
              </section>

              <section className="space-y-3 border-t border-app pt-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="overline text-theme-muted">Runtime</h3>
                  <span className="font-mono text-[10px] text-theme-subtle">{provider} / {model}</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1.5 block overline">Provider</label>
                    <Select value={provider} onChange={handleProviderChange} options={providerOptions} searchable={false} />
                  </div>
                  <div>
                    <label className="mb-1.5 block overline">Model</label>
                    {isOtherModel ? (
                      <input
                        type="text"
                        value={customModel}
                        onChange={(e) => { setCustomModel(e.target.value); setModel(e.target.value); }}
                        placeholder="Enter model ID..."
                        className="input w-full h-9 text-[13px]"
                        autoFocus
                      />
                    ) : (
                      <Select
                        value={model}
                        onChange={(val) => {
                          if (val === '__other__') { setIsOtherModel(true); setCustomModel(''); return; }
                          setModel(val);
                        }}
                        options={modelOptions}
                      />
                    )}
                  </div>
                  <div>
                    <label className="mb-1.5 block overline">Reasoning</label>
                    <Select
                      value={reasoningEffort}
                      onChange={setReasoningEffort}
                      options={EFFORT_LEVELS.filter(l => l.value !== 'max' || /opus/i.test(model))}
                      searchable={false}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block overline">Plan Mode</label>
                    {provider === 'claude' ? (
                      <Select value={planMode} onChange={setPlanMode} options={PLAN_MODE_OPTIONS} searchable={false} />
                    ) : (
                      <div className="flex h-9 items-center rounded-md border border-app bg-app-muted px-3 text-[12px] text-theme-subtle">
                        Claude only
                      </div>
                    )}
                  </div>
                </div>

                {/* ⚠ Non-Claude OpenRouter model warning (AC6) */}
                {isNonClaudeOpenRouterModel(provider, model) && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-accent-yellow/25 bg-accent-yellow/10 px-3 py-2 text-[12px] text-accent-yellow"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{OPENROUTER_NON_CLAUDE_WARNING}</span>
                  </div>
                )}
              </section>

              <section className="space-y-3 border-t border-app pt-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="overline text-theme-muted">Appearance</h3>
                  <div
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-app"
                    style={{ backgroundColor: color + '18' }}
                  >
                    <RoleIcon icon={icon} color={color} size={15} />
                  </div>
                </div>

                <div className="grid grid-cols-[1fr_8.75rem] gap-3">
                  <div>
                    <label className="mb-1.5 block overline">Icon</label>
                    <Select value={icon} onChange={setIcon} options={iconOptions} />
                  </div>
                  <div>
                    <label className="mb-1.5 block overline">Color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={color}
                        onChange={e => setColor(e.target.value)}
                        className="h-9 w-10 cursor-pointer rounded-md border border-app bg-transparent"
                      />
                      <input
                        type="text"
                        value={color}
                        onChange={e => setColor(e.target.value)}
                        className="input min-w-0 flex-1 font-mono text-xs"
                        placeholder="#3b82f6"
                      />
                    </div>
                  </div>
                </div>
              </section>

              <section className="space-y-3 border-t border-app pt-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="overline text-theme-muted">Permissions</h3>
                  <span className="font-mono text-[10px] text-theme-subtle">
                    {tools.length} tools · {enabledMcpToolCount} MCP
                  </span>
                </div>

                <div>
                  <label className="mb-1.5 block overline">System Tools</label>
                  <div className="grid grid-cols-2 gap-1.5">
                  {TOOLS.map(tool => (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => toggleTool(tool)}
                      className={`flex h-9 items-center gap-2 rounded-md border px-2.5 text-left text-[12px] transition-colors ${
                        tools.includes(tool)
                          ? 'border-accent/35 bg-accent/10 text-theme-primary'
                          : 'border-app bg-app-muted/40 text-theme-muted hover:bg-app-muted hover:text-theme-primary'
                      }`}
                    >
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        tools.includes(tool)
                          ? 'border-accent bg-accent text-white'
                          : 'border-app-strong bg-app'
                      }`}
                      >
                        {tools.includes(tool) && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 truncate font-mono">{TOOL_LABELS[tool] ?? tool}</span>
                    </button>
                  ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block overline">MCP Access</label>
                  <div className="space-y-2">
                  {visibleMcpToolGroups.map((group) => {
                    const isAllen = group.serverName === 'allen';
                    const enabled = isAllen || externalMcpServers.includes(group.serverName);
                    const disabledForServer = disabledMcpTools[group.serverName] ?? [];
                    const expanded = expandedMcpServers.has(group.serverName);
                    const enabledToolCountForServer = group.tools.filter(tool => !disabledForServer.includes(tool.name)).length;
                    return (
                      <div key={group.serverName} className="overflow-hidden rounded-md border border-app bg-app-muted/35">
                        <div className="flex h-10 items-center gap-2 px-2.5">
                          <button
                            type="button"
                            onClick={() => toggleMcpServerExpanded(group.serverName)}
                            disabled={!enabled}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-30"
                            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.serverName}`}
                          >
                            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                          </button>
                          <button
                            type="button"
                            disabled={isAllen}
                            onClick={() => toggleExternalMcpServer(group.serverName)}
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                              enabled
                                ? 'border-accent bg-accent text-white'
                                : 'border-app-strong bg-app text-transparent'
                            } disabled:cursor-default disabled:opacity-70`}
                          >
                            {enabled && <Check className="h-3 w-3" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={`truncate font-mono text-[12px] ${enabled ? 'text-theme-primary' : 'text-theme-muted'}`}>
                                {group.serverName}
                              </span>
                              {isAllen && <span className="font-mono text-[9px] text-theme-subtle">default</span>}
                            </div>
                          </div>
                          <span className="shrink-0 font-mono text-[10px] text-theme-subtle">
                            {enabled ? `${enabledToolCountForServer}/${group.tools.length || 0}` : 'off'}
                          </span>
                        </div>
                        {enabled && expanded && (
                          <div className="grid grid-cols-2 gap-1 border-t border-app p-2">
                            {group.tools.length === 0 ? (
                              <div className="col-span-2 px-2 py-1.5 font-mono text-[10px] text-theme-subtle">
                                Tool list loading...
                              </div>
                            ) : group.tools.map((tool) => {
                              const checked = !disabledForServer.includes(tool.name);
                              return (
                                <button
                                  key={tool.fullName}
                                  type="button"
                                  onClick={() => toggleMcpTool(group.serverName, tool.name)}
                                  className={`flex min-w-0 items-center gap-1.5 rounded border px-2 py-1.5 text-left text-[11px] transition-colors ${
                                    checked
                                      ? 'border-accent/25 bg-accent/5 text-theme-secondary'
                                      : 'border-app bg-app text-theme-subtle hover:bg-app-muted hover:text-theme-primary'
                                  }`}
                                >
                                  <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                                    checked ? 'border-accent bg-accent text-white' : 'border-app-strong bg-app'
                                  }`}
                                  >
                                    {checked && <Check className="h-2.5 w-2.5" />}
                                  </span>
                                  <span className="min-w-0 truncate font-mono">{tool.name}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  </div>
                  <p className="mt-1 text-[10px] font-body leading-relaxed text-theme-subtle">
                    Allen is always available. Expand a server only when you need to customize individual tools.
                  </p>
                </div>
              </section>

              {/* Previous prompt */}
              {isEdit && !!role?.previousSystemPrompt && (
                <div className="pt-2 border-t border-app">
                  <button
                    type="button"
                    onClick={() => setShowPreviousPrompt(!showPreviousPrompt)}
                    className="btn-ghost text-[11px] flex items-center gap-1.5"
                  >
                    <Sparkles className="w-3 h-3 text-accent-yellow" />
                    {showPreviousPrompt ? 'Hide Previous Prompt' : 'View Previous Prompt'}
                  </button>
                  {showPreviousPrompt && (
                    <div className="mt-2 space-y-2">
                      <pre className="text-[10px] text-theme-muted bg-surface-200 border border-border rounded-md p-3 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
                        {role.previousSystemPrompt as string}
                      </pre>
                      <button
                        type="button"
                        onClick={handleRollback}
                        disabled={saving}
                        className="btn-ghost text-[11px] text-accent-yellow hover:text-yellow-300"
                      >
                        Rollback to Previous Prompt
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Right column: README-style editor ───────────────────────── */}
            <div className="flex min-h-0 flex-col">
              {/* Editor tab bar */}
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-app bg-app-muted/25 px-5 py-2.5">
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-accent-blue" />
                  <span className="overline font-semibold">
                    Agent Instructions
                  </span>
                  <span className="text-[10px] font-mono text-theme-subtle">README.md</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-[9px] font-mono text-theme-subtle">
                    {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {wordCount} {wordCount === 1 ? 'word' : 'words'} · {charCount} chars
                  </div>
                  <div className="flex items-center rounded-md border border-app overflow-hidden bg-app-muted/50">
                    <button
                      type="button"
                      onClick={() => setEditorMode('edit')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono transition-colors ${
                        editorMode === 'edit'
                          ? 'bg-accent-blue/15 text-accent-blue'
                          : 'text-theme-muted hover:text-theme-primary hover:bg-app-muted'
                      }`}
                      title="Edit only"
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorMode('split')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono transition-colors border-l border-app ${
                        editorMode === 'split'
                          ? 'bg-accent-blue/15 text-accent-blue'
                          : 'text-theme-muted hover:text-theme-primary hover:bg-app-muted'
                      }`}
                      title="Split view"
                    >
                      <Columns className="w-3 h-3" /> Split
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorMode('preview')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono transition-colors border-l border-app ${
                        editorMode === 'preview'
                          ? 'bg-accent-blue/15 text-accent-blue'
                          : 'text-theme-muted hover:text-theme-primary hover:bg-app-muted'
                      }`}
                      title="Preview only"
                    >
                      <Eye className="w-3 h-3" /> Preview
                    </button>
                  </div>
                </div>
              </div>

              {/* Editor body */}
              <div className={`min-h-0 flex-1 ${editorMode === 'split' ? 'grid grid-cols-2' : 'flex flex-col'}`}>
                {(editorMode === 'edit' || editorMode === 'split') && (
                  <textarea
                    value={system}
                    onChange={e => setSystem(e.target.value)}
                    placeholder={`# Agent Role\n\nDescribe what this agent does, its responsibilities, and how it should behave.\n\n## Responsibilities\n\n- Responsibility 1\n- Responsibility 2\n\n## Examples\n\n\`\`\`\nExample interaction\n\`\`\`\n`}
                    spellCheck={false}
                    className={`min-h-0 w-full flex-1 resize-none border-0 bg-app-muted/30 px-5 py-4 font-mono text-[13px] leading-relaxed text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:bg-app-muted/45 ${
                      editorMode === 'split' ? 'border-r border-app' : ''
                    }`}
                  />
                )}
                {(editorMode === 'preview' || editorMode === 'split') && (
                  <div className="min-h-0 flex-1 overflow-y-auto bg-app-muted/25 px-5 py-4">
                    {system.trim() ? (
                      <div className="text-sm text-theme-secondary leading-relaxed prose-allen">
                        {renderMarkdown(system)}
                      </div>
                    ) : (
                      <div className="text-[12px] text-theme-muted italic font-body">
                        Nothing to preview yet. Write some markdown on the left.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-app bg-app-muted/25 px-6 py-4">
            <div className="font-mono text-[11px] text-theme-subtle">
              Tip: Markdown supported — headings, lists, links, code blocks.
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="btn btn-primary btn-sm disabled:opacity-50">
                {saving ? 'Saving...' : isEdit ? 'Update agent' : 'Create agent'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
