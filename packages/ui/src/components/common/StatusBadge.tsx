import { Circle, CheckCircle, XCircle, Clock, Pause, Loader2 } from 'lucide-react';

const statusConfig: Record<string, { icon: any; color: string; bg: string; glow?: string }> = {
  running:           { icon: Loader2,     color: 'text-accent-blue',   bg: 'bg-accent-blue/10',   glow: 'shadow-glow-blue/20' },
  completed:         { icon: CheckCircle, color: 'text-accent-green',  bg: 'bg-accent-green/10',  glow: 'shadow-glow-green/20' },
  failed:            { icon: XCircle,     color: 'text-accent-red',    bg: 'bg-accent-red/10',    glow: 'shadow-glow-red/20' },
  cancelled:         { icon: XCircle,     color: 'text-theme-subtle',   bg: 'bg-surface-200/40' },
  queued:            { icon: Clock,       color: 'text-accent-yellow', bg: 'bg-accent-yellow/10', glow: 'shadow-glow-yellow/20' },
  waiting_for_input: { icon: Pause,       color: 'text-accent-orange', bg: 'bg-accent-orange/10' },
  pending:           { icon: Circle,      color: 'text-theme-muted',   bg: 'bg-surface-200/40' },
  skipped:           { icon: Circle,      color: 'text-theme-subtle',  bg: 'bg-surface-200/40' },
};

export default function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? statusConfig.pending;
  const Icon = cfg.icon;
  const isSpinning = status === 'running';

  return (
    <span className={`badge ${cfg.bg} ${cfg.color} ${cfg.glow ?? ''} gap-1 font-label`}>
      <Icon className={`w-3 h-3 ${isSpinning ? 'animate-spin' : ''}`} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
