import { useState, useEffect } from 'react';
import type { Node } from '@xyflow/react';
import { Trash2, Plus, X } from 'lucide-react';
import { agents as agentsApi, mcp as mcpApi, type McpToolGroup } from '../../services/api';
import Select from '../common/Select';
import { outputsAsKeys, mergeOutputsFromKeys } from '../../utils/outputs';
import { ALLEN_MCP_TOOL_NAMES } from '../../lib/allen-mcp-tools';

interface HumanField {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
}

interface Props {
  node: Node | null;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
  /** Workflow-level input schema (`input:` section in YAML). Shown when START is selected. */
  workflowInput?: Record<string, any> | null;
}

const builtIns = [
  'create-workspace',
  'git-create-branch', 'git-commit', 'git-push', 'git-create-pr', 'git-cleanup-worktree',
  'run-build', 'run-tests',
  'classify-task',
  'prompt-user',
];
const fieldTypes = ['string', 'text', 'boolean', 'number', 'select'];
const MCP_TOOL_REFRESH_DELAYS = [1_500, 5_000, 10_000, 20_000, 30_000];

export default function NodeProperties({ node, onUpdate, onDelete, workflowInput }: Props) {
  const [localData, setLocalData] = useState<Record<string, any>>({});
  const [agentList, setAgentList] = useState<any[]>([]);
  const [mcpToolGroups, setMcpToolGroups] = useState<McpToolGroup[]>([]);

  // Fetch agents from backend
  useEffect(() => {
    agentsApi.list().then(setAgentList).catch(() => {});
    let cancelled = false;
    const loadGroups = (refresh?: boolean) => mcpApi.tools({ refresh })
      .then((groups) => {
        if (!cancelled) setMcpToolGroups(groups ?? []);
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
      window.setTimeout(() => {
        if (!cancelled) void loadGroups(false);
      }, delay),
    );
    return () => {
      cancelled = true;
      timers.forEach(window.clearTimeout);
    };
  }, []);

  useEffect(() => {
    if (node) setLocalData({ ...node.data });
  }, [node?.id, node?.data]);

  if (!node) {
    return (
      <div className="p-4 text-sm text-theme-muted font-mono">
        SELECT A NODE TO EDIT
      </div>
    );
  }

  // START — show workflow input schema so users can see what data the
  // workflow expects at run time.
  if (node.id === 'START') {
    const inputs = workflowInput && typeof workflowInput === 'object' ? Object.entries(workflowInput) : [];
    return (
      <div className="p-4 space-y-3 overflow-auto h-full">
        <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wider">Workflow Input</h3>
        <p className="text-[11px] text-theme-muted font-body">
          Fields the user is prompted for when running this workflow. Edit in the YAML view under <code className="bg-app-muted px-1 rounded text-[10px]">input:</code>.
        </p>
        {inputs.length === 0 ? (
          <div className="text-xs text-theme-subtle italic">No inputs declared.</div>
        ) : (
          <div className="space-y-2">
            {inputs.map(([name, def]) => {
              const d = (def ?? {}) as Record<string, any>;
              return (
                <div key={name} className="border border-app rounded-md p-2.5 bg-app-muted/40">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-theme-primary font-semibold">{name}</span>
                    <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-blue/10 text-accent-blue">
                      {d.type ?? 'string'}
                    </span>
                    {d.required && (
                      <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-red/10 text-accent-red">
                        required
                      </span>
                    )}
                  </div>
                  {d.description && (
                    <p className="text-[10px] text-theme-muted font-body">{d.description}</p>
                  )}
                  {d.default !== undefined && (
                    <div className="text-[10px] text-theme-subtle font-mono mt-1">
                      default: <span className="text-theme-secondary">{JSON.stringify(d.default)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // END — nothing to configure
  if (node.id === 'END') {
    return (
      <div className="p-4 text-sm text-theme-muted font-mono">
        END — no configuration
      </div>
    );
  }

  const type = (localData.type as string) ?? 'agent';

  const update = (key: string, value: any) => {
    const next = { ...localData, [key]: value };
    setLocalData(next);
    onUpdate(node.id, next);
  };

  const updateOutputs = (val: string) => {
    update('outputs', mergeOutputsFromKeys(localData.outputs, val));
  };

  // ── Human field helpers ──
  const fields: HumanField[] = (localData.fields as HumanField[]) ?? [];

  const addField = () => {
    update('fields', [...fields, { name: '', type: 'string', label: '', required: false }]);
  };

  const updateField = (idx: number, key: keyof HumanField, value: any) => {
    const next = [...fields];
    next[idx] = { ...next[idx], [key]: value };
    update('fields', next);
  };

  const removeField = (idx: number) => {
    update('fields', fields.filter((_, i) => i !== idx));
  };

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wider">{(localData.label as string) ?? node.id}</h3>
        <button onClick={() => onDelete(node.id)} className="btn-ghost text-xs text-accent-red hover:text-accent-red/80 p-1">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Node name */}
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Name</label>
        <input className="input w-full text-xs" value={(localData.label as string) ?? ''} onChange={e => update('label', e.target.value)} />
      </div>

      {/* Type selector */}
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Type</label>
        <Select
          value={type}
          onChange={(value) => update('type', value)}
          searchable={false}
          options={[
            { value: 'agent', label: 'Agent' },
            { value: 'code', label: 'Code' },
            { value: 'human', label: 'Human' },
            { value: 'workflow', label: 'Workflow' },
            { value: 'condition', label: 'Condition' },
          ]}
        />
      </div>

      {/* ── Agent-specific ── */}
      {type === 'agent' && (
        <>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Agent</label>
            <Select
              value={(localData.agent as string) ?? (localData.role as string) ?? ''}
              onChange={(value) => {
                const next: Record<string, any> = { ...localData, agent: value };
                delete next.role;
                setLocalData(next);
                onUpdate(node.id, next);
              }}
              placeholder="Select agent..."
              searchPlaceholder="Search agents..."
              options={agentList.map((agent: any) => ({
                value: agent.name,
                label: agent.displayName ?? agent.name,
                sublabel: agent.name,
              }))}
            />
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Prompt</label>
            <textarea
              className="input w-full text-xs h-28 resize-none font-mono"
              value={(localData.prompt as string) ?? ''}
              onChange={e => update('prompt', e.target.value)}
              placeholder="Enter prompt with {{variables}}..."
            />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={!!localData.resume_on_retry} onChange={e => update('resume_on_retry', e.target.checked)} className="w-3.5 h-3.5 rounded-sm bg-surface-200 border-accent-blue/30 accent-accent-blue" />
            <label className="text-xs text-theme-secondary font-label">Resume on retry</label>
          </div>
          <AgentNodeOverrides
            agentName={(localData.agent as string) ?? (localData.role as string) ?? ''}
            agentList={agentList}
            mcpToolGroups={mcpToolGroups}
            overrides={(localData.agentOverrides as AgentOverridesValue | undefined) ?? {}}
            onChange={(next) => update('agentOverrides', next)}
          />
        </>
      )}

      {/* ── Code-specific ── */}
      {type === 'code' && (
        <>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Function</label>
            <Select
              value={(localData.function as string) ?? ''}
              onChange={(value) => update('function', value)}
              placeholder="Select function..."
              searchPlaceholder="Search functions..."
              options={builtIns.map(builtIn => ({ value: builtIn, label: builtIn }))}
            />
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Retries</label>
            <input type="number" min={0} max={10} className="input w-20 text-xs" value={(localData.retries as number) ?? 0} onChange={e => update('retries', parseInt(e.target.value) || 0)} />
          </div>
        </>
      )}

      {/* ── Human-specific ── */}
      {type === 'human' && (
        <>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Prompt</label>
            <textarea className="input w-full text-xs h-20 resize-none" value={(localData.prompt as string) ?? ''} onChange={e => update('prompt', e.target.value)} placeholder="What should the user see?" />
          </div>

          {/* Field editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-label font-medium text-theme-secondary uppercase tracking-wider">Fields</label>
              <button onClick={addField} className="btn-ghost text-xs p-1 text-accent-blue">
                <Plus className="w-3 h-3" />
              </button>
            </div>
            <div className="space-y-2">
              {fields.map((field, idx) => (
                <div key={idx} className="bg-surface-200/80 rounded-sm p-2 space-y-1.5 border border-app">
                  <div className="flex items-center gap-1">
                    <input className="input flex-1 text-xs" placeholder="name" value={field.name} onChange={e => updateField(idx, 'name', e.target.value)} />
                    <Select
                      className="w-24"
                      value={field.type}
                      onChange={(value) => updateField(idx, 'type', value)}
                      searchable={false}
                      options={fieldTypes.map(fieldType => ({ value: fieldType, label: fieldType }))}
                    />
                    <button onClick={() => removeField(idx)} className="text-theme-muted hover:text-accent-red p-0.5 transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <input className="input w-full text-xs" placeholder="Label" value={field.label ?? ''} onChange={e => updateField(idx, 'label', e.target.value)} />
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={!!field.required} onChange={e => updateField(idx, 'required', e.target.checked)} className="w-3 h-3 rounded-sm bg-surface border-border accent-accent-blue" />
                    <span className="overline">Required</span>
                  </div>
                  {field.type === 'select' && (
                    <input className="input w-full text-xs" placeholder="Options (comma-separated)" value={(field.options ?? []).join(', ')} onChange={e => updateField(idx, 'options', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Workflow-specific ── */}
      {type === 'workflow' && (
        <div>
          <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Sub-workflow name</label>
          <input className="input w-full text-xs" value={(localData.workflow as string) ?? ''} onChange={e => update('workflow', e.target.value)} placeholder="e.g., bugfix" />
        </div>
      )}

      {/* Outputs (all types except condition) */}
      {type !== 'condition' && (
        <div>
          <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Outputs (comma-separated)</label>
          <input className="input w-full text-xs" value={outputsAsKeys(localData.outputs).join(', ')} onChange={e => updateOutputs(e.target.value)} placeholder="e.g., changed_files, summary" />
        </div>
      )}

      {/* Timeout */}
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Timeout (seconds)</label>
        <input type="number" className="input w-20 text-xs" value={(localData.timeout as number) ?? ''} onChange={e => update('timeout', parseInt(e.target.value) || undefined)} placeholder="600" />
      </div>
    </div>
  );
}

/* ── Agent override sub-component ─────────────────────────────────────── */

type EffortValue = 'off' | 'low' | 'medium' | 'high' | 'max';
type ProviderValue = 'claude-cli' | 'codex' | 'deepseek';

interface AgentOverridesValue {
  provider?: ProviderValue | null;
  model?: string | null;
  reasoningEffort?: EffortValue | null;
  planMode?: boolean | null;
  externalMcpServers?: string[] | null;
  disabledAllenMcpTools?: string[] | null;
  disabledMcpTools?: Record<string, string[]> | null;
}

// Both Claude and Codex model lists — the dropdown always shows both, grouped
// by provider, so you can cross-override a Claude agent to run on Codex (or
// vice versa) on just this workflow node.
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];
const CODEX_MODELS = ['default', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'];
const DEEPSEEK_MODEL_SUGGESTIONS = ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'];

// Compound value in the <select>. Encodes both provider and model so a single
// dropdown can span two providers without a separate provider picker.
function encodeModelOption(provider: ProviderValue, model: string): string {
  return `${provider}::${model}`;
}
function decodeModelOption(value: string): { provider: ProviderValue; model: string } | null {
  if (!value) return null;
  const [p, ...rest] = value.split('::');
  if (!rest.length) return null;
  if (p !== 'claude-cli' && p !== 'codex' && p !== 'deepseek') return null;
  return { provider: p as ProviderValue, model: rest.join('::') };
}

function normalizeProvider(p: string | undefined): ProviderValue {
  if (p === 'codex') return 'codex';
  if (p === 'deepseek') return 'deepseek';
  return 'claude-cli';
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function normalizeDisabledMcpTools(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([server, tools]) => [server, normalizeStringArray(tools)] as const)
      .filter(([, tools]) => tools.length > 0),
  );
}

function mergeLegacyAllenTools(disabled: Record<string, string[]>, legacy: unknown): Record<string, string[]> {
  const legacyTools = normalizeStringArray(legacy);
  if (legacyTools.length === 0) return disabled;
  return {
    ...disabled,
    allen: [...new Set([...(disabled.allen ?? []), ...legacyTools])],
  };
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

function AgentNodeOverrides({
  agentName,
  agentList,
  mcpToolGroups,
  overrides,
  onChange,
}: {
  agentName: string;
  agentList: any[];
  mcpToolGroups: McpToolGroup[];
  overrides: AgentOverridesValue;
  onChange: (next: AgentOverridesValue) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!agentName) return null;

  const agent = agentList.find((a) => a.name === agentName);
  if (!agent) return null;

  // Agent defaults — what the node inherits if no override is set.
  const agentProvider = normalizeProvider(agent.provider);
  const agentModel: string | undefined = agent.model;
  const agentEffort: EffortValue | undefined = agent.reasoningEffort;
  const agentPlan: boolean | undefined = agent.planMode;
  const agentExternalMcpServers = Array.isArray(agent.externalMcpServers)
    ? agent.externalMcpServers as string[]
    : null;
  const agentDisabledMcpTools = mergeLegacyAllenTools(
    normalizeDisabledMcpTools(agent.disabledMcpTools),
    agent.disabledAllenMcpTools,
  );

  // Effective resolved values (override wins, else agent default).
  const effectiveProvider: ProviderValue = overrides.provider ?? agentProvider;
  const effectiveIsClaude = effectiveProvider === 'claude-cli';

  // Current value for the model dropdown — if no override, show the inherit option.
  const modelSelectValue =
    overrides.model != null
      ? encodeModelOption(overrides.provider ?? agentProvider, overrides.model)
      : '';

  const inheritedModelLabel = agentProvider === 'deepseek'
    ? `DeepSeek / ${agentModel ?? '(provider default)'}`
    : `${agentProvider === 'claude-cli' ? 'Claude' : 'Codex'} / ${agentModel ?? '(CLI default)'}`;
  const inheritedEffortLabel = agentEffort ?? '(CLI default)';
  const inheritedPlanLabel =
    agentPlan === true ? 'on' : agentPlan === false ? 'off' : '(CLI default: off)';

  const planSelectValue =
    overrides.planMode === undefined || overrides.planMode === null
      ? ''
      : overrides.planMode
        ? 'on'
        : 'off';

  function update(next: AgentOverridesValue): void {
    const pruned: AgentOverridesValue = { ...next };
    if (pruned.provider == null) delete pruned.provider;
    if (pruned.model == null) delete pruned.model;
    if (pruned.reasoningEffort == null) delete pruned.reasoningEffort;
    if (pruned.planMode == null) delete pruned.planMode;
    if (pruned.externalMcpServers === undefined) delete pruned.externalMcpServers;
    if (pruned.disabledAllenMcpTools === undefined) delete pruned.disabledAllenMcpTools;
    if (pruned.disabledMcpTools === undefined) delete pruned.disabledMcpTools;
    onChange(pruned);
  }

  // Handler: picking a model option. Encodes provider in the value so we can
  // flip the override's provider in the same edit (and clear plan mode if the
  // user crosses from Claude → Codex, since Codex doesn't support it).
  function handleModelChange(value: string): void {
    if (!value) {
      update({ ...overrides, provider: null, model: null });
      return;
    }
    const decoded = decodeModelOption(value);
    if (!decoded) return;
    const next: AgentOverridesValue = {
      ...overrides,
      provider: decoded.provider,
      model: decoded.model,
    };
    // Moving to Codex or DeepSeek? Drop any explicit plan-mode override.
    if ((decoded.provider === 'codex' || decoded.provider === 'deepseek') && next.planMode === true) next.planMode = null;
    update(next);
  }

  const hasAnyOverride =
    (overrides.provider != null) ||
    (overrides.model != null) ||
    (overrides.reasoningEffort != null) ||
    (overrides.planMode != null) ||
    (overrides.externalMcpServers !== undefined) ||
    (overrides.disabledAllenMcpTools !== undefined) ||
    (overrides.disabledMcpTools !== undefined);

  const mcpOverrideMode: 'inherit' | 'custom' =
    overrides.externalMcpServers === undefined &&
    overrides.disabledMcpTools === undefined &&
    overrides.disabledAllenMcpTools === undefined
      ? 'inherit'
      : 'custom';
  const selectedExternalMcpServers = Array.isArray(overrides.externalMcpServers)
    ? overrides.externalMcpServers
    : [];
  const disabledMcpTools = mergeLegacyAllenTools(
    normalizeDisabledMcpTools(overrides.disabledMcpTools),
    overrides.disabledAllenMcpTools,
  );
  const inheritedMcpLabel = agentExternalMcpServers
    ? agentExternalMcpServers.length > 0 ? agentExternalMcpServers.join(', ') : 'none'
    : 'all enabled';
  const inheritedAllenDisabledCount = agentDisabledMcpTools.allen?.length ?? 0;
  const inheritedAllenLabel = inheritedAllenDisabledCount === 0
    ? 'all Allen checked'
    : `${ALLEN_MCP_TOOL_NAMES.length - inheritedAllenDisabledCount}/${ALLEN_MCP_TOOL_NAMES.length} Allen checked`;
  const visibleMcpToolGroups = withConfiguredMcpGroups(mcpToolGroups, selectedExternalMcpServers, disabledMcpTools);

  function toggleExternalMcpServer(name: string): void {
    const base = mcpOverrideMode === 'custom' ? selectedExternalMcpServers : [];
    const next = base.includes(name) ? base.filter((server) => server !== name) : [...base, name];
    update({ ...overrides, externalMcpServers: next, disabledMcpTools });
  }

  function toggleMcpTool(serverName: string, toolName: string): void {
    const disabledForServer = disabledMcpTools[serverName] ?? [];
    const next = disabledForServer.includes(toolName)
      ? disabledForServer.filter((tool) => tool !== toolName)
      : [...disabledForServer, toolName];
    update({
      ...overrides,
      externalMcpServers: selectedExternalMcpServers,
      disabledMcpTools: { ...disabledMcpTools, [serverName]: next },
      disabledAllenMcpTools: undefined,
    });
  }

  return (
    <div className="mt-3 border-t border-app pt-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="overline text-theme-secondary">
          Override agent settings {hasAnyOverride && <span className="text-accent-blue">●</span>}
        </span>
        <span className="text-[10px] text-theme-subtle">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-3">
          <p className="text-[10px] text-theme-subtle font-body leading-relaxed">
            Ephemeral per-node overrides. The agent's defaults are not modified — these
            values only apply when this workflow node runs. You can cross-override a
            Claude agent to run on a Codex model (or vice versa) on just this node.
          </p>

          {/* Provider + Model (grouped dropdown) */}
          <div>
            <label className="block overline mb-1">
              Model
            </label>
            <Select
              value={modelSelectValue}
              onChange={handleModelChange}
              searchPlaceholder="Search models..."
              options={[
                { value: '', label: 'Inherit', sublabel: inheritedModelLabel },
                ...CLAUDE_MODELS.map((model) => ({
                  value: encodeModelOption('claude-cli', model),
                  label: model,
                  sublabel: 'Claude',
                })),
                ...CODEX_MODELS.map((model) => ({
                  value: encodeModelOption('codex', model),
                  label: model,
                  sublabel: 'Codex',
                })),
                ...DEEPSEEK_MODEL_SUGGESTIONS.map((model) => ({
                  value: encodeModelOption('deepseek', model),
                  label: model,
                  sublabel: 'DeepSeek',
                })),
              ]}
            />
            {/* Custom model text input — shown when effective provider is DeepSeek */}
            {(effectiveProvider === 'deepseek') && (
              <div className="mt-1.5">
                <input
                  type="text"
                  list="node-deepseek-model-suggestions"
                  value={overrides.model ?? ''}
                  onChange={(e) => {
                    const val = e.target.value.trim();
                    if (!val) {
                      handleModelChange('');
                    } else {
                      const decoded = decodeModelOption(modelSelectValue);
                      if (!decoded || decoded.provider !== 'deepseek') {
                        // Set provider to deepseek with the typed model
                        update({ ...overrides, provider: 'deepseek', model: val });
                      } else {
                        update({ ...overrides, provider: 'deepseek', model: val });
                      }
                    }
                  }}
                  placeholder="Custom DeepSeek model (e.g. deepseek-v4-pro[1m])"
                  className="w-full rounded border border-app bg-surface px-2 py-1 text-[11px] text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <datalist id="node-deepseek-model-suggestions">
                  {DEEPSEEK_MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
                </datalist>
                <p className="text-[10px] text-theme-subtle mt-0.5">
                  DeepSeek uses open model names. Type any model ID or pick a suggestion.
                </p>
              </div>
            )}
          </div>

          {/* Effort */}
          <div>
            <label className="block overline mb-1">
              Reasoning Effort
            </label>
            <Select
              value={overrides.reasoningEffort ?? ''}
              onChange={(value) =>
                update({ ...overrides, reasoningEffort: (value || null) as EffortValue | null })
              }
              searchable={false}
              options={[
                { value: '', label: 'Inherit', sublabel: inheritedEffortLabel },
                { value: 'off', label: 'Off' },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'max', label: 'Max', sublabel: 'Claude Opus only' },
              ]}
            />
          </div>

          {/* Plan mode — only when effective provider is Claude */}
          {effectiveIsClaude ? (
            <div>
              <label className="block overline mb-1">
                Plan Mode
              </label>
              <Select
                value={planSelectValue}
                onChange={(value) => {
                  update({ ...overrides, planMode: value === '' ? null : value === 'on' });
                }}
                searchable={false}
                options={[
                  { value: '', label: 'Inherit', sublabel: inheritedPlanLabel },
                  { value: 'off', label: 'Off', sublabel: 'May edit files' },
                  { value: 'on', label: 'On', sublabel: 'Read and plan only' },
                ]}
              />
            </div>
          ) : (
            <div className="text-[10px] text-theme-subtle font-body leading-relaxed">
              Plan mode is Claude-only — this node currently resolves to {effectiveProvider === 'deepseek' ? 'DeepSeek' : 'Codex'}, so plan
              mode is unavailable. Switch the model to a Claude option to use it.
            </div>
          )}

          <div>
            <label className="block overline mb-1">
              MCP Access
            </label>
            <Select
              value={mcpOverrideMode}
              onChange={(value) => {
                if (value === 'inherit') {
                  update({
                    ...overrides,
                    externalMcpServers: undefined,
                    disabledMcpTools: undefined,
                    disabledAllenMcpTools: undefined,
                  });
                } else {
                  update({
                    ...overrides,
                    externalMcpServers: selectedExternalMcpServers,
                    disabledMcpTools,
                    disabledAllenMcpTools: undefined,
                  });
                }
              }}
              searchable={false}
              options={[
                { value: 'inherit', label: 'Inherit', sublabel: `external: ${inheritedMcpLabel}; ${inheritedAllenLabel}` },
                { value: 'custom', label: 'Configure MCP access' },
              ]}
            />
            {mcpOverrideMode === 'custom' && (
              <div className="mt-2 space-y-2">
                {visibleMcpToolGroups.length === 0 ? (
                  <div className="text-[10px] text-theme-subtle font-mono">
                    No MCP tools available
                  </div>
                ) : visibleMcpToolGroups.map((group) => {
                  const isAllen = group.serverName === 'allen';
                  const enabled = isAllen || selectedExternalMcpServers.includes(group.serverName);
                  const disabledForServer = disabledMcpTools[group.serverName] ?? [];
                  return (
                    <div key={group.serverName} className="border border-app rounded-md bg-app-muted/40">
                      <label
                        className={`flex items-center gap-2 text-[11px] font-mono px-2 py-1.5 rounded-t-md cursor-pointer border-b border-app ${
                          enabled ? 'text-accent-blue' : 'text-theme-muted hover:text-theme-primary'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={isAllen}
                          onChange={() => toggleExternalMcpServer(group.serverName)}
                          className="accent-accent-blue"
                        />
                        <span className="truncate">{group.serverName}</span>
                        {isAllen && <span className="text-[9px] text-theme-subtle">default</span>}
                      </label>
                      {enabled && (
                        <div className="max-h-44 overflow-y-auto grid grid-cols-1 gap-1 p-1.5">
                          {group.tools.length === 0 ? (
                            <div className="text-[10px] text-theme-subtle font-mono px-2 py-1.5">
                              Tool list loading...
                            </div>
                          ) : group.tools.map((tool) => {
                            const checked = !disabledForServer.includes(tool.name);
                            return (
                              <label
                                key={tool.fullName}
                                className={`flex items-center gap-2 text-[11px] font-mono px-2 py-1 rounded cursor-pointer border ${
                                  checked
                                    ? 'bg-accent-blue/10 text-accent-blue border-accent-blue/30'
                                    : 'bg-surface-200/60 text-theme-muted border-app hover:bg-app-muted'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMcpTool(group.serverName, tool.name)}
                                  className="accent-accent-blue"
                                />
                                <span className="truncate">{tool.name}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="text-[10px] text-theme-subtle font-body leading-relaxed">
                  Allen is selected by default. External MCP servers are off until selected.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
