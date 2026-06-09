import { useState, useEffect, useMemo, type ReactNode } from 'react';
import type { Node } from '@xyflow/react';
import { Trash2, Plus, X, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { agents as agentsApi, mcp as mcpApi, type McpToolGroup } from '../../services/api';
import Select from '../common/Select';
import { outputsAsMap } from '../../utils/outputs';
import { ALLEN_MCP_TOOL_NAMES } from '../../lib/allen-mcp-tools';
import { useEnabledProviders } from '../../hooks/useEnabledProviders';
import HumanNodeEditor from './HumanNodeEditor';
import KeyValueEditor from './KeyValueEditor';
import JsonField from './JsonField';
import InputSchemaEditor from './InputSchemaEditor';

interface ConditionRow {
  name: string;
  expression: string;
}

interface Props {
  node: Node | null;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
  /** Workflow-level input schema (`input:` section in YAML). Shown when START is selected. */
  workflowInput?: Record<string, any> | null;
  /** Workflow-level `context:` block. Shown when START is selected. */
  workflowContext?: Record<string, any> | null;
  /** Patch workflow-level metadata (input / context). Enables START editing. */
  onWorkflowMetaPatch?: (patch: { input?: any; context?: any }) => void;
  /** All node ids in the graph — used by the human editor for action routes. */
  nodeIds?: string[];
  /** Collapse (hide) the properties sidebar. When set, a button renders at the panel's top-left. */
  onClose?: () => void;
}

/** Top-left close control shared across every panel state. */
function PanelCloseButton({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null;
  return (
    <button
      onClick={onClose}
      title="Close panel"
      className="btn-ghost p-1 text-theme-muted hover:text-theme-primary shrink-0"
    >
      <X className="w-4 h-4" />
    </button>
  );
}

const builtIns = [
  'create-workspace',
  'git-create-branch', 'git-commit', 'git-push', 'git-create-pr', 'git-cleanup-worktree',
  'run-build', 'run-tests',
  'classify-task',
  'prompt-user',
];
const MCP_TOOL_REFRESH_DELAYS = [1_500, 5_000, 10_000, 20_000, 30_000];

export default function NodeProperties({ node, onUpdate, onDelete, workflowInput, workflowContext, onWorkflowMetaPatch, nodeIds = [], onClose }: Props) {
  const [localData, setLocalData] = useState<Record<string, any>>(() => (node ? { ...node.data } : {}));
  const [agentList, setAgentList] = useState<any[]>([]);
  const [mcpToolGroups, setMcpToolGroups] = useState<McpToolGroup[]>([]);

  // Seed localData synchronously when a different node is selected. Child
  // editors that snapshot their value on mount (outputs / input_map /
  // output_map) are keyed by node.id, so they must see the real data on the
  // first render — not the previous node's, and not the empty initial state a
  // post-render effect would leave behind. Setting state during render is
  // React's documented "reset all state when a prop changes" pattern.
  const [seededNodeId, setSeededNodeId] = useState(node?.id);
  if (node && node.id !== seededNodeId) {
    setSeededNodeId(node.id);
    setLocalData({ ...node.data });
  }

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
      <div className="flex flex-col h-full">
        {onClose && (
          <div className="flex items-center justify-end px-2 py-2 border-b border-app shrink-0">
            <PanelCloseButton onClose={onClose} />
          </div>
        )}
        <div className="p-4 text-sm text-theme-muted font-mono">SELECT A NODE TO EDIT</div>
      </div>
    );
  }

  // START — edit the workflow-level input schema + context (what the user is
  // prompted for at run time, and the workflow's requires/tools/secrets).
  if (node.id === 'START') {
    const ctx = (workflowContext ?? {}) as Record<string, any>;
    const patchContext = (patch: Record<string, any>) => {
      if (!onWorkflowMetaPatch) return;
      const next = { ...ctx, ...patch };
      for (const k of Object.keys(next)) {
        const v = next[k];
        if (v === '' || v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
      }
      onWorkflowMetaPatch({ context: Object.keys(next).length > 0 ? next : undefined });
    };
    const listField = (key: 'requires' | 'tools' | 'secrets', label: string, placeholder: string) => (
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">{label}</label>
        <input
          className="input w-full text-xs font-mono"
          value={Array.isArray(ctx[key]) ? ctx[key].join(', ') : ''}
          onChange={e => patchContext({ [key]: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
          placeholder={placeholder}
          disabled={!onWorkflowMetaPatch}
        />
      </div>
    );
    return (
      <div className="p-4 space-y-4 overflow-auto h-full">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wider">Workflow Input</h3>
          <PanelCloseButton onClose={onClose} />
        </div>
        <p className="text-[11px] text-theme-muted font-body">
          Fields the user is prompted for when running this workflow.
        </p>
        <InputSchemaEditor
          value={(workflowInput as Record<string, any> | undefined) ?? undefined}
          onChange={(next) => onWorkflowMetaPatch?.({ input: next })}
        />

        <div className="border-t border-app pt-3 space-y-3">
          <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wider">Context</h3>
          {listField('requires', 'Requires', 'repo ids / capabilities')}
          {listField('tools', 'Tools', 'tool names')}
          {listField('secrets', 'Secrets', 'secret names')}
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Concurrency</label>
            <input
              type="number"
              min={1}
              className="input w-20 text-xs"
              value={ctx.concurrency ?? ''}
              onChange={e => patchContext({ concurrency: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="auto"
              disabled={!onWorkflowMetaPatch}
            />
          </div>
        </div>
      </div>
    );
  }

  // END — nothing to configure
  if (node.id === 'END') {
    return (
      <div className="flex flex-col h-full">
        {onClose && (
          <div className="flex items-center justify-end px-2 py-2 border-b border-app shrink-0">
            <PanelCloseButton onClose={onClose} />
          </div>
        )}
        <div className="p-4 text-sm text-theme-muted font-mono">END — no configuration</div>
      </div>
    );
  }

  const type = (localData.type as string) ?? 'agent';

  const update = (key: string, value: any) => {
    const next = { ...localData, [key]: value };
    setLocalData(next);
    onUpdate(node.id, next);
  };

  // ── Condition helpers ──
  const conditions: ConditionRow[] = (localData.conditions as ConditionRow[]) ?? [];

  const addCondition = () => {
    update('conditions', [...conditions, { name: '', expression: '' }]);
  };

  const updateCondition = (idx: number, key: keyof ConditionRow, value: string) => {
    const next = [...conditions];
    next[idx] = { ...next[idx], [key]: value };
    update('conditions', next);
  };

  const removeCondition = (idx: number) => {
    update('conditions', conditions.filter((_, i) => i !== idx));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header — node identity + delete, fixed above the scrolling body */}
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-app bg-app-card shrink-0">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-theme-primary truncate">{(localData.label as string) ?? node.id}</div>
          <div className="mt-1 flex items-center gap-1.5 min-w-0">
            <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-accent-blue/10 text-accent-blue shrink-0">{type}</span>
            <span className="font-mono text-[10px] text-theme-muted truncate">{node.id}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => onDelete(node.id)} className="btn-ghost text-xs text-accent-red hover:text-accent-red/80 p-1" title="Delete node">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <PanelCloseButton onClose={onClose} />
        </div>
      </div>

      {/* Scrolling body */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
      <SectionLabel divider={false}>Basics</SectionLabel>

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

      <SectionLabel>Configuration</SectionLabel>

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

          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Output format</label>
            <Select
              value={(localData.output_format as string) ?? ''}
              onChange={(value) => update('output_format', value || undefined)}
              searchable={false}
              options={[
                { value: '', label: 'Default' },
                { value: 'json', label: 'json', sublabel: 'parse the response as JSON keyed by outputs' },
                { value: 'freeform', label: 'freeform', sublabel: 'store the raw text response' },
              ]}
            />
          </div>

          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Session key</label>
            <input
              className="input w-full text-xs font-mono"
              value={(localData.session_key as string) ?? ''}
              onChange={e => update('session_key', e.target.value || undefined)}
              placeholder="e.g. implementer:{{current_milestone_id}}"
            />
            <p className="text-[10px] text-theme-subtle font-body mt-1 leading-relaxed">
              Isolates agent sessions per rendered value — used for node-loop workflows so each iteration gets a fresh session.
            </p>
          </div>

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
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Config</label>
            <JsonField
              value={localData.config as Record<string, unknown> | undefined}
              onChange={(next) => update('config', next)}
              placeholder={'{ "branch": "{{task_id}}" }'}
            />
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Retries</label>
            <input type="number" min={0} max={10} className="input w-20 text-xs" value={(localData.retries as number) ?? 0} onChange={e => update('retries', parseInt(e.target.value) || 0)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Backoff</label>
              <Select
                value={(localData.backoff as string) ?? ''}
                onChange={(value) => update('backoff', value || undefined)}
                searchable={false}
                options={[
                  { value: '', label: 'Default' },
                  { value: 'exponential', label: 'exponential' },
                  { value: 'linear', label: 'linear' },
                  { value: 'fixed', label: 'fixed' },
                ]}
              />
            </div>
            <div>
              <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Base ms</label>
              <input type="number" min={0} className="input w-full text-xs" value={(localData.backoff_base_ms as number) ?? ''} onChange={e => update('backoff_base_ms', parseInt(e.target.value) || undefined)} placeholder="1000" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Retry on (comma-separated)</label>
            <input
              className="input w-full text-xs font-mono"
              value={Array.isArray(localData.retry_on) ? (localData.retry_on as string[]).join(', ') : ''}
              onChange={e => {
                const arr = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                update('retry_on', arr.length > 0 ? arr : undefined);
              }}
              placeholder="error substrings that should retry"
            />
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">On failure</label>
            <Select
              value={(localData.on_failure as string) ?? ''}
              onChange={(value) => update('on_failure', value || undefined)}
              searchable={false}
              options={[
                { value: '', label: 'Default (fail)' },
                { value: 'fail', label: 'fail' },
                { value: 'skip', label: 'skip', sublabel: 'continue past this node' },
                { value: 'fallback', label: 'fallback', sublabel: 'use the fallback value below' },
              ]}
            />
          </div>
          {localData.on_failure === 'fallback' && (
            <div>
              <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Fallback value</label>
              <JsonField
                value={localData.fallback_value as Record<string, unknown> | undefined}
                onChange={(next) => update('fallback_value', next)}
              />
            </div>
          )}
        </>
      )}

      {/* ── Human-specific ── */}
      {type === 'human' && (
        <HumanNodeEditor data={localData} update={update} nodeIds={nodeIds} />
      )}

      {/* ── Workflow-specific ── */}
      {type === 'workflow' && (
        <>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Sub-workflow name</label>
            <input className="input w-full text-xs" value={(localData.workflow as string) ?? ''} onChange={e => update('workflow', e.target.value)} placeholder="e.g., bugfix" />
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Input map</label>
            <p className="text-[10px] text-theme-subtle font-body mb-1.5 leading-relaxed">
              Sub-workflow input ← value from this workflow's state.
            </p>
            <KeyValueEditor
              key={`${node.id}-input-map`}
              value={localData.input_map as Record<string, string> | undefined}
              onChange={(next) => update('input_map', next)}
              keyLabel="Sub-workflow input"
              valueLabel="Source value"
              keyPlaceholder="input name in the sub-workflow"
              valuePlaceholder="value / {{state}} from this workflow"
              emptyHint="No input mapping."
            />
          </div>
          <div>
            <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Output map</label>
            <p className="text-[10px] text-theme-subtle font-body mb-1.5 leading-relaxed">
              This node's output key ← sub-workflow output.
            </p>
            <KeyValueEditor
              key={`${node.id}-output-map`}
              value={localData.output_map as Record<string, string> | undefined}
              onChange={(next) => update('output_map', next)}
              keyLabel="Output key"
              valueLabel="Sub-workflow output"
              keyPlaceholder="output name on this node"
              valuePlaceholder="output name from the sub-workflow"
              emptyHint="No output mapping."
            />
          </div>
        </>
      )}

      {/* ── Condition-specific ── */}
      {type === 'condition' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs font-label font-medium text-theme-secondary uppercase tracking-wider">Conditions</label>
            <button onClick={addCondition} className="btn-ghost text-xs p-1 text-accent-blue" title="Add condition">
              <Plus className="w-3 h-3" />
            </button>
          </div>
          <p className="text-[10px] text-theme-subtle font-body mb-2 leading-relaxed">
            Named branches evaluated top-to-bottom. Each expression is filtrex — supports
            <code className="bg-app-muted px-1 rounded mx-0.5">and / or / not</code>, comparisons,
            <code className="bg-app-muted px-1 rounded mx-0.5">in</code>, and dotted state paths
            (e.g. <code className="bg-app-muted px-1 rounded">nodes.review.status</code>). The branch
            name is referenced by outgoing edges.
          </p>
          <div className="space-y-2">
            {conditions.map((cond, idx) => (
              <div key={idx} className="bg-surface-200/80 rounded-sm p-2 space-y-1.5 border border-app">
                <div className="flex items-center gap-1">
                  <input
                    className="input flex-1 text-xs font-mono"
                    placeholder="branch name (e.g. is_critical)"
                    value={cond.name}
                    onChange={e => updateCondition(idx, 'name', e.target.value)}
                  />
                  <button onClick={() => removeCondition(idx)} className="text-theme-muted hover:text-accent-red p-0.5 transition-colors" title="Remove condition">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <textarea
                  className="input w-full text-xs h-14 resize-none font-mono"
                  placeholder={'expression, e.g. severity == "critical"'}
                  value={cond.expression}
                  onChange={e => updateCondition(idx, 'expression', e.target.value)}
                />
              </div>
            ))}
            {conditions.length === 0 && (
              <p className="text-[10px] text-theme-subtle italic">No conditions yet — add at least one branch.</p>
            )}
          </div>
        </div>
      )}

      {/* Outputs (all types except condition) */}
      {type !== 'condition' && (
        <div>
          <SectionLabel>Outputs</SectionLabel>
          <label className="block text-xs font-label font-medium text-theme-secondary mb-1 mt-3 uppercase tracking-wider">Declared outputs</label>
          <p className="text-[10px] text-theme-subtle font-body mb-1.5 leading-relaxed">
            Each key + description. The description is injected into the agent's response-format block.
          </p>
          <KeyValueEditor
            key={`${node.id}-outputs`}
            value={outputsAsMap(localData.outputs)}
            onChange={(next) => update('outputs', next)}
            keyLabel="Output key"
            valueLabel="Description"
            keyPlaceholder="e.g. summary"
            valuePlaceholder="what this value should contain (injected into the agent's response format)"
            valueMultiline
            emptyHint="No declared outputs."
          />
        </div>
      )}

      {/* Execution */}
      <SectionLabel>Execution</SectionLabel>
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Timeout (seconds)</label>
        <input type="number" className="input w-20 text-xs" value={(localData.timeout as number) ?? ''} onChange={e => update('timeout', parseInt(e.target.value) || undefined)} placeholder="600" />
      </div>
      </div>
    </div>
  );
}

/* ── Section label ────────────────────────────────────────────────────────
 * Group header inside the properties panel. A top divider separates each
 * group from the one above; the first group passes divider={false}. */
function SectionLabel({ children, divider = true }: { children: ReactNode; divider?: boolean }) {
  return (
    <div className={`overline ${divider ? 'border-t border-app pt-3.5 mt-1' : ''}`}>
      {children}
    </div>
  );
}

/* ── Agent override sub-component ─────────────────────────────────────── */

type EffortValue = 'off' | 'low' | 'medium' | 'high' | 'max';
type ProviderValue = string;

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
const CLAUDE_MODELS = ['fable', 'sonnet', 'opus', 'haiku'];
const CODEX_MODELS = ['default', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'];

// Compound value in the <select>. Encodes both provider and model so a single
// dropdown can span two providers without a separate provider picker.
function encodeModelOption(provider: ProviderValue, model: string): string {
  return `${provider}::${model}`;
}
function decodeModelOption(value: string): { provider: ProviderValue; model: string } | null {
  if (!value) return null;
  const [p, ...rest] = value.split('::');
  if (!rest.length) return null;
  return { provider: p, model: rest.join('::') };
}

function normalizeProvider(p: string | undefined, enabledProviderIds: Set<string>): ProviderValue {
  if (p === 'codex') return 'codex';
  if (p && enabledProviderIds.has(p)) return p;
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
  const enabledProviders = useEnabledProviders();
  const enabledProviderIds = useMemo(() => new Set(enabledProviders.map((provider) => provider.provider)), [enabledProviders]);
  const openProviderModelSuggestions = useMemo(() => Object.fromEntries(
    enabledProviders
      .filter((provider) => provider.open)
      .map((provider) => [provider.provider, provider.modelSuggestions && provider.modelSuggestions.length > 0
        ? provider.modelSuggestions
        : [provider.defaultModel]]),
  ) as Record<string, string[]>, [enabledProviders]);
  if (!agentName) return null;

  const agent = agentList.find((a) => a.name === agentName);
  if (!agent) return null;

  // Agent defaults — what the node inherits if no override is set.
  const agentProvider = normalizeProvider(agent.provider, enabledProviderIds);
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
  const openModelSuggestions = openProviderModelSuggestions[effectiveProvider];
  const isOpenModelProvider = Boolean(openModelSuggestions);
  const providerLabel = (provider: ProviderValue) => {
    if (provider === 'claude-cli') return 'Claude';
    if (provider === 'codex') return 'Codex';
    const enabledProvider = enabledProviders.find((item) => item.provider === provider);
    if (enabledProvider) return enabledProvider.label;
    return provider;
  };
  const selectableModelGroups = enabledProviders.flatMap((provider) => {
    if (provider.provider === 'claude-cli') {
      return CLAUDE_MODELS.map((model) => ({
        value: encodeModelOption(provider.provider, model),
        label: model,
        sublabel: providerLabel(provider.provider),
      }));
    }
    if (provider.provider === 'codex') {
      return CODEX_MODELS.map((model) => ({
        value: encodeModelOption(provider.provider, model),
        label: model,
        sublabel: providerLabel(provider.provider),
      }));
    }
    if (provider.open) {
      const suggestions = openProviderModelSuggestions[provider.provider] ?? [];
      const currentModel = provider.provider === (overrides.provider ?? agentProvider) ? overrides.model : null;
      const models = [
        ...suggestions,
        ...(currentModel && !suggestions.includes(currentModel) ? [currentModel] : []),
      ];
      return models.map((model) => ({
        value: encodeModelOption(provider.provider, model),
        label: model,
        sublabel: providerLabel(provider.provider),
      }));
    }
    return (provider.models ?? []).map((model) => ({
      value: encodeModelOption(provider.provider, model),
      label: model,
      sublabel: providerLabel(provider.provider),
    }));
  });

  // Current value for the model dropdown — if no override, show the inherit option.
  const modelSelectValue =
    overrides.model != null
      ? encodeModelOption(overrides.provider ?? agentProvider, overrides.model)
      : '';

  const inheritedModelLabel = `${providerLabel(agentProvider)} / ${agentModel ?? '(provider default)'}`;
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
    if (!enabledProviderIds.has(decoded.provider)) return;
    const next: AgentOverridesValue = {
      ...overrides,
      provider: decoded.provider,
      model: decoded.model,
    };
    // Moving away from Claude? Drop any explicit plan-mode override.
    if (decoded.provider !== 'claude-cli' && next.planMode === true) next.planMode = null;
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
    <div className={`rounded border bg-app-muted/40 overflow-hidden transition-colors ${expanded ? 'border-app-strong' : 'border-app'}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full gap-2 px-3 py-2.5 text-left transition-colors hover:bg-app-muted"
      >
        <span className="flex items-center gap-2 min-w-0">
          <SlidersHorizontal className="w-3.5 h-3.5 text-theme-muted shrink-0" />
          <span className="text-xs font-medium text-theme-secondary truncate">Override Model &amp; MCP servers</span>
          {hasAnyOverride && (
            <span className="text-[8.5px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-accent-blue/10 text-accent-blue shrink-0">on</span>
          )}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-theme-muted shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-3 space-y-3 border-t border-app">
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
              allowCustomValue={isOpenModelProvider}
              createCustomValue={(query) => encodeModelOption(effectiveProvider, query)}
              customValueLabel={(query) => `Use "${query}"`}
              options={[
                { value: '', label: 'Inherit', sublabel: inheritedModelLabel },
                ...selectableModelGroups,
              ]}
            />
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
              Plan mode is Claude-only — this node currently resolves to {providerLabel(effectiveProvider)}, so plan
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
                    <div key={group.serverName} className="border border-app rounded bg-app-muted/40">
                      <label
                        className={`flex items-center gap-2 text-[11px] font-mono px-2 py-1.5 rounded-t cursor-pointer border-b border-app ${
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
