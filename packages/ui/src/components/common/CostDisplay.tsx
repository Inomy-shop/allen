export default function CostDisplay({ cost }: { cost: any }) {
  if (!cost) return <span className="text-theme-subtle font-mono text-xs">-</span>;

  // `actual` is authoritative (token-computed from registry per-MTok prices,
  // or provider-reported as fallback). `estimated` only carries a value on
  // documents persisted before per-turn estimates were retired.
  const hasActual = cost.actual != null;
  const hasLegacyEstimate = !hasActual && (cost.estimated ?? 0) > 0;

  if (!hasActual && !hasLegacyEstimate) {
    return (
      <span
        className="text-theme-subtle font-mono text-xs"
        title="No cost available — set per-MTok prices in Settings → Models"
      >
        —
      </span>
    );
  }

  const value = hasActual ? cost.actual : cost.estimated;
  const badge = hasLegacyEstimate ? 'est' : cost.method === 'sdk_reported' ? 'reported' : null;
  const badgeTitle =
    badge === 'reported'
      ? 'Provider-reported cost — no registry prices for this model'
      : badge === 'est'
        ? 'Legacy per-turn estimate'
        : undefined;

  return (
    <span className="text-sm tabular-nums font-mono">
      <span className="text-theme-secondary">${value.toFixed(2)}</span>
      {badge && (
        <span
          className="ml-1 text-xs text-accent-yellow/60 font-label uppercase tracking-wider"
          title={badgeTitle}
        >
          {badge}
        </span>
      )}
    </span>
  );
}
