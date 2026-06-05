/**
 * AgentSettingsForm — shared form for model / reasoning-effort / plan-mode.
 *
 * Used in three places:
 *   1. Agent editor (RoleManagerPage) — `mode="agent-default"` — edits the agent doc
 *   2. Chat settings popover          — `mode="session-override"` — edits session.agentOverrides
 *   3. Workflow node inspector        — `mode="node-override"`    — edits node.agentOverrides
 *
 * In override modes, every field supports an "Inherit" value. The inherited
 * value shows as ghost text so the user can see what they'd fall back to.
 *
 * Non-destructive: this component never reaches through to mutate the agent
 * document. It only emits changes to its `onChange` callback; the parent
 * decides where they get written.
 */
import { ShieldCheck, Sparkles } from 'lucide-react';
import Select from '../common/Select';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';
export type Provider = 'claude-cli' | 'codex' | 'deepseek' | 'xiaomi-mimo';

export interface AgentSettingsValue {
  provider?: Provider | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  planMode?: boolean | null;
}

export type AgentSettingsMode = 'agent-default' | 'session-override' | 'node-override';

interface Props {
  mode: AgentSettingsMode;
  provider: Provider;
  value: AgentSettingsValue;
  /** For override modes: the resolved values that `null` fields inherit from. */
  inheritedFrom?: AgentSettingsValue;
  /** Available model list for the current provider. */
  modelOptions: Array<{ value: string; label: string }>;
  onChange: (next: AgentSettingsValue) => void;
}

const OPEN_PROVIDER_MODEL_SUGGESTIONS: Partial<Record<Provider, string[]>> = {
  deepseek: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
  'xiaomi-mimo': ['mimo-v2.5-pro'],
};

const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'No extended thinking' },
  { value: 'low', label: 'Low', description: 'Quick thinking' },
  { value: 'medium', label: 'Medium', description: 'Standard' },
  { value: 'high', label: 'High', description: 'Deliberate' },
  { value: 'max', label: 'Max', description: 'Deepest (Opus only)' },
];

export default function AgentSettingsForm({
  mode,
  provider,
  value,
  inheritedFrom,
  modelOptions,
  onChange,
}: Props) {
  const isOverrideMode = mode !== 'agent-default';
  const isClaudeProvider = provider === 'claude-cli';
  const openModelSuggestions = OPEN_PROVIDER_MODEL_SUGGESTIONS[provider];
  const isOpenModelProvider = Boolean(openModelSuggestions);

  // Model display: show selected, or "(inherit)" + ghost text in override mode
  const modelValue = value.model ?? '';
  const modelInherited = inheritedFrom?.model ?? '—';

  const effortValue = value.reasoningEffort ?? '';
  const effortInherited = inheritedFrom?.reasoningEffort ?? '(CLI default)';

  // Tri-state plan: '' = inherit, 'on' / 'off'
  const planSelect = value.planMode === undefined || value.planMode === null
    ? ''
    : value.planMode
      ? 'on'
      : 'off';
  const planInherited = inheritedFrom?.planMode === true
    ? 'on'
    : inheritedFrom?.planMode === false
      ? 'off'
      : '(CLI default: off)';

  function setField<K extends keyof AgentSettingsValue>(key: K, v: AgentSettingsValue[K]): void {
    onChange({ ...value, [key]: v });
  }

  // Disable 'max' unless the effective model looks like Opus.
  const effectiveModel = modelValue || modelInherited || '';
  const opusLike = /opus/i.test(effectiveModel);
  const openModelOptions = [
    ...(isOverrideMode
      ? [{ value: '', label: 'Inherit', sublabel: modelInherited }]
      : []),
    ...(openModelSuggestions ?? []).map((model) => ({ value: model, label: model })),
    ...(isOpenModelProvider && modelValue && !(openModelSuggestions ?? []).includes(modelValue)
      ? [{ value: modelValue, label: modelValue, sublabel: 'Custom model ID' }]
      : []),
  ];

  return (
    <div className="space-y-4">
      {/* ── Model ───────────────────────────────────────────────── */}
      <div>
        <label className="block overline mb-1.5">
          Model
        </label>
        {isOpenModelProvider ? (
          <Select
            value={modelValue}
            onChange={(next) => setField('model', next || null)}
            searchPlaceholder="Search or enter model ID..."
            placeholder={`e.g. ${openModelSuggestions?.[0] ?? 'provider-model'}`}
            options={openModelOptions}
            allowCustomValue
          />
        ) : (
          <Select
            value={modelValue}
            onChange={(next) => setField('model', next || null)}
            searchPlaceholder="Search models..."
            options={[
              ...(isOverrideMode
                ? [{ value: '', label: 'Inherit', sublabel: modelInherited }]
                : []),
              ...modelOptions.map((option) => ({
                value: option.value,
                label: option.label,
              })),
            ]}
          />
        )}
      </div>

      {/* ── Reasoning Effort ─────────────────────────────────────── */}
      <div>
        <label className="flex items-center gap-1.5 overline mb-1.5">
          <Sparkles className="w-3 h-3" />
          Reasoning Effort
        </label>
        <Select
          value={effortValue}
          onChange={(next) => setField('reasoningEffort', (next as ReasoningEffort) || null)}
          searchable={false}
          options={[
            ...(isOverrideMode
              ? [{ value: '', label: 'Inherit', sublabel: effortInherited }]
              : []),
            ...EFFORT_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              sublabel: `${option.description}${option.value === 'max' && !opusLike ? ' · Opus only' : ''}`,
              disabled: option.value === 'max' && !opusLike,
            })),
          ]}
        />
      </div>

      {/* ── Plan Mode (Claude only) ──────────────────────────────── */}
      {isClaudeProvider ? (
        <div>
          <label className="flex items-center gap-1.5 overline mb-1.5">
            <ShieldCheck className="w-3 h-3" />
            Plan Mode
          </label>
          <Select
            value={planSelect}
            onChange={(next) => {
              if (next === '') setField('planMode', null);
              else setField('planMode', next === 'on');
            }}
            searchable={false}
            options={[
              ...(isOverrideMode
                ? [{ value: '', label: 'Inherit', sublabel: planInherited }]
                : []),
              { value: 'off', label: 'Off', sublabel: 'Agent may edit files' },
              { value: 'on', label: 'On', sublabel: 'Read and plan only, no edits' },
            ]}
          />
          <p className="text-[10px] text-theme-subtle mt-1">
            Forces <code className="font-mono">--permission-mode plan</code>. The agent can read,
            explore, and propose changes but cannot write files or run destructive commands.
          </p>
        </div>
      ) : (
        <div>
          <label className="flex items-center gap-1.5 overline mb-1.5">
            <ShieldCheck className="w-3 h-3" />
            Plan Mode
          </label>
          <div className="px-3 py-2 bg-surface-50 border border-app rounded-sm text-xs text-theme-subtle">
            Claude only. Not supported for this provider.
          </div>
        </div>
      )}
    </div>
  );
}
