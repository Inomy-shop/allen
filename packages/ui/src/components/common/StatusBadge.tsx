// V8 uses a small semantic dot + lowercase mono label. Status color is data,
// never a tinted pill or decorative app-chrome color.
const statusConfig: Record<string, { cls: string; pulse?: boolean }> = {
  running:           { cls: 'badge-info', pulse: true },
  completed:         { cls: 'badge-ok' },
  failed:            { cls: 'badge-err' },
  cancelled:         { cls: 'badge-muted' },
  canceled:          { cls: 'badge-muted' },
  queued:            { cls: 'badge-warn' },
  waiting_for_input: { cls: 'badge-human' },
  waiting_for_human: { cls: 'badge-human' },
  pending:           { cls: 'badge-muted' },
  idle:              { cls: 'badge-muted' },
  skipped:           { cls: 'badge-muted' },
  model_recovery:    { cls: 'badge-warn' },
};

export default function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? statusConfig.pending;
  const label = status.replace(/_/g, ' ');

  return (
    <span className={`badge ${cfg.cls}`}>
      <span className={`status-dot ${cfg.pulse ? 'status-dot-pulse' : ''}`} aria-hidden="true" />
      {label}
    </span>
  );
}
