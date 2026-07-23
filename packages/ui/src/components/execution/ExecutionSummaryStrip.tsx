type Props = {
  completed: number;
  total: number;
  duration: string;
  cost?: number | null;
  tokens?: string;
};

export default function ExecutionSummaryStrip({ completed, total, duration, cost, tokens = '—' }: Props) {
  const upcoming = Math.max(0, total - completed);
  return (
    <dl className="v8-execution-summary" aria-label="Execution summary">
      <div><dt>duration</dt><dd>{duration}</dd></div>
      <div><dt>nodes</dt><dd>{completed} of {total}{upcoming > 0 ? ` · ${upcoming} upcoming` : ''}</dd></div>
      <div><dt>cost (run)</dt><dd>{cost == null ? '—' : `$${cost.toFixed(2)}`}</dd></div>
      <div><dt>tokens (run)</dt><dd>{tokens}</dd></div>
    </dl>
  );
}
