import { Circle, CheckCircle, XCircle, Clock, Pause, Loader2, Cpu } from 'lucide-react';

// v2 Linear-clean: status pills use the .badge-* classes from index.css
// (soft tint backgrounds, sentence-case, mono font). Cancelled/skipped fall
// back to .badge-muted.
const statusConfig: Record<string, { icon: any; cls: string }> = {
  running:           { icon: Loader2,     cls: 'badge-info' },
  completed:         { icon: CheckCircle, cls: 'badge-ok' },
  failed:            { icon: XCircle,     cls: 'badge-err' },
  cancelled:         { icon: XCircle,     cls: 'badge-muted' },
  queued:            { icon: Clock,       cls: 'badge-warn' },
  waiting_for_input: { icon: Pause,       cls: 'badge-human' },
  pending:           { icon: Circle,      cls: 'badge-muted' },
  skipped:           { icon: Circle,      cls: 'badge-muted' },
  model_recovery:    { icon: Cpu,         cls: 'badge-warn' },
};

export default function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? statusConfig.pending;
  const Icon = cfg.icon;
  const isSpinning = status === 'running';

  const label = status === 'model_recovery' ? 'Model Recovery' : status.replace(/_/g, ' ');

  return (
    <span className={`badge ${cfg.cls}`}>
      <Icon className={`w-3 h-3 ${isSpinning ? 'animate-spin' : ''}`} />
      {label}
    </span>
  );
}
