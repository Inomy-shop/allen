export const REASONING_EFFORT_VALUES = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type ReasoningEffortValue = (typeof REASONING_EFFORT_VALUES)[number];

export interface ReasoningEffortOption {
  value: ReasoningEffortValue;
  label: string;
  description: string;
}

const OPTIONS: Record<ReasoningEffortValue, ReasoningEffortOption> = {
  off: { value: 'off', label: 'Off', description: 'Use provider default' },
  low: { value: 'low', label: 'Low', description: 'Fast, lighter reasoning' },
  medium: { value: 'medium', label: 'Medium', description: 'Balanced' },
  high: { value: 'high', label: 'High', description: 'Deeper reasoning' },
  xhigh: { value: 'xhigh', label: 'Extra high', description: 'Extra-high reasoning' },
  max: { value: 'max', label: 'Max', description: 'Maximum reasoning' },
  ultra: { value: 'ultra', label: 'Ultra', description: 'Maximum with delegation' },
};

export function reasoningEffortLabel(value: ReasoningEffortValue): string {
  return OPTIONS[value].label;
}

const DEFAULT_ONLY: ReasoningEffortValue[] = ['off'];
const CLAUDE_LEVELS: ReasoningEffortValue[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_XHIGH_LEVELS: ReasoningEffortValue[] = ['off', 'low', 'medium', 'high', 'xhigh'];
const CODEX_MAX_LEVELS: ReasoningEffortValue[] = [...CODEX_XHIGH_LEVELS, 'max'];
const CODEX_ULTRA_LEVELS: ReasoningEffortValue[] = [...CODEX_MAX_LEVELS, 'ultra'];

const CLAUDE_COMPATIBLE_PROVIDERS = new Set([
  'claude',
  'claude-cli',
  'deepseek',
  'xiaomi-mimo',
  'kimi',
  'zai',
]);

const CODEX_MODEL_LEVELS = new Map<string, ReasoningEffortValue[]>([
  ['gpt-5.6-sol', CODEX_ULTRA_LEVELS],
  ['codex-auto-review', CODEX_ULTRA_LEVELS],
  ['gpt-5.6-terra', CODEX_ULTRA_LEVELS],
  ['gpt-5.6-luna', CODEX_MAX_LEVELS],
  ['gpt-5.5', CODEX_XHIGH_LEVELS],
  ['gpt-5.4', CODEX_XHIGH_LEVELS],
  ['gpt-5.4-mini', CODEX_XHIGH_LEVELS],
  ['gpt-5.3-codex-spark', CODEX_XHIGH_LEVELS],
]);

/**
 * UI capability map for the installed CLI runtimes.
 *
 * Codex exposes supported levels per model in `codex debug models`, so unknown
 * models intentionally receive no explicit effort choices. Claude Code exposes
 * low/medium/high/xhigh/max through its `--effort` flag. "Off" remains available
 * as the provider-default reset and is not forwarded as a CLI effort value.
 */
export function reasoningEffortOptionsFor(
  provider?: string | null,
  model?: string | null,
): ReasoningEffortOption[] {
  const normalizedProvider = provider?.toLowerCase() ?? '';
  const normalizedModel = model?.toLowerCase() ?? '';

  let levels = DEFAULT_ONLY;
  if (normalizedProvider === 'codex') {
    levels = CODEX_MODEL_LEVELS.get(normalizedModel) ?? DEFAULT_ONLY;
  } else if (CLAUDE_COMPATIBLE_PROVIDERS.has(normalizedProvider)) {
    levels = CLAUDE_LEVELS;
  } else if (
    normalizedProvider === 'openrouter'
    && normalizedModel.startsWith('anthropic/')
  ) {
    levels = CLAUDE_LEVELS;
  }

  return levels.map((level) => OPTIONS[level]);
}

export function isReasoningEffortSupported(
  provider: string | null | undefined,
  model: string | null | undefined,
  effort: ReasoningEffortValue | null | undefined,
): boolean {
  if (!effort) return true;
  return reasoningEffortOptionsFor(provider, model).some((option) => option.value === effort);
}
