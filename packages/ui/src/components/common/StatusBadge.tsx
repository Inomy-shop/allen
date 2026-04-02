import { Circle, CheckCircle, XCircle, Clock, Pause, Loader2 } from 'lucide-react';

const statusConfig: Record<string, { icon: any; color: string; bg: string }> = {
  running:           { icon: Loader2,     color: 'text-blue-400',   bg: 'bg-blue-400/10' },
  completed:         { icon: CheckCircle, color: 'text-green-400',  bg: 'bg-green-400/10' },
  failed:            { icon: XCircle,     color: 'text-red-400',    bg: 'bg-red-400/10' },
  cancelled:         { icon: XCircle,     color: 'text-gray-400',   bg: 'bg-gray-400/10' },
  queued:            { icon: Clock,       color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  waiting_for_input: { icon: Pause,       color: 'text-orange-400', bg: 'bg-orange-400/10' },
  pending:           { icon: Circle,      color: 'text-gray-500',   bg: 'bg-gray-500/10' },
  skipped:           { icon: Circle,      color: 'text-gray-600',   bg: 'bg-gray-600/10' },
};

export default function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? statusConfig.pending;
  const Icon = cfg.icon;
  const isSpinning = status === 'running';

  return (
    <span className={`badge ${cfg.bg} ${cfg.color} gap-1`}>
      <Icon className={`w-3 h-3 ${isSpinning ? 'animate-spin' : ''}`} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
