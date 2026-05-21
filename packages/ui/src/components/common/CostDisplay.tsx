export default function CostDisplay({ cost }: { cost: any }) {
  if (!cost) return <span className="text-theme-subtle font-mono text-xs">-</span>;

  const value = cost.actual ?? cost.estimated ?? 0;
  const isEstimated = cost.actual == null;

  return (
    <span className="text-sm tabular-nums font-mono">
      <span className="text-theme-secondary">${value.toFixed(2)}</span>
      {isEstimated && (
        <span className="ml-1 text-xs text-accent-yellow/60 font-label uppercase tracking-wider">est</span>
      )}
    </span>
  );
}
