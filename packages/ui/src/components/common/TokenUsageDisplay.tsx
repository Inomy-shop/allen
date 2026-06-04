import type { TokenUsageInfo } from '../../services/api';

interface Props {
  tokenUsage?: TokenUsageInfo | null;
  /**
   * When set, the token line shows "(included in parent)" — used for child
   * execution rows that have already been rolled up into a parent total.
   */
  inheritedBy?: { kind: 'parent-execution'; parentExecutionId: string };
}

export default function TokenUsageDisplay({ tokenUsage, inheritedBy }: Props) {
  // Return null when carrier is absent
  if (tokenUsage == null) return null;

  const { inputCachedTokens, inputNonCachedTokens, outputTokens } = tokenUsage;

  // Return null if ALL sub-fields are null (defensive — normalizer should prevent this)
  if (inputCachedTokens === null && inputNonCachedTokens === null && outputTokens === null) {
    return null;
  }

  const fullFmt = new Intl.NumberFormat('en-US');
  const compactFmt = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  });

  const formatCompact = (value: number): string => {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${compactFmt.format(value / 1_000_000)}M`;
    if (abs >= 1_000) return `${compactFmt.format(value / 1_000)}K`;
    return compactFmt.format(value);
  };

  const seg = (v: number | null, label: string, title: string) => (
    <span className="inline-flex items-baseline gap-1" title={title}>
      {v !== null
        ? <span className="tabular-nums">{formatCompact(v)}</span>
        : <span aria-label="not reported">—</span>
      }
      <span className="text-theme-subtle">{label}</span>
    </span>
  );

  const ariaLabel = [
    inputCachedTokens !== null ? `${fullFmt.format(inputCachedTokens)} cached input` : 'cached input not reported',
    inputNonCachedTokens !== null ? `${fullFmt.format(inputNonCachedTokens)} non-cached input` : 'non-cached input not reported',
    outputTokens !== null ? `${fullFmt.format(outputTokens)} output` : 'output not reported',
  ].join(', ');

  return (
    <span
      className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10.5px] leading-tight text-theme-secondary"
      aria-label={`Token usage: ${ariaLabel}`}
      title={`Token usage: ${ariaLabel}`}
    >
      {seg(inputCachedTokens, 'cache', 'Cached input tokens')}
      <span className="text-theme-subtle">·</span>
      {seg(inputNonCachedTokens, 'in', 'Non-cached input tokens')}
      <span className="text-theme-subtle">·</span>
      {seg(outputTokens, 'out', 'Output tokens')}
      {inheritedBy && (
        <span className="ml-1 text-theme-subtle text-[10px]">(included in parent)</span>
      )}
    </span>
  );
}
