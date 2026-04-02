export default function CostDisplay({ cost }: { cost: any }) {
  if (!cost) return <span className="text-gray-500">-</span>;

  const value = cost.actual ?? cost.estimated ?? 0;
  const isEstimated = cost.actual == null;

  return (
    <span className="text-sm tabular-nums">
      <span className="text-gray-300">${value.toFixed(4)}</span>
      {isEstimated && (
        <span className="ml-1 text-xs text-yellow-500/70">est</span>
      )}
    </span>
  );
}
