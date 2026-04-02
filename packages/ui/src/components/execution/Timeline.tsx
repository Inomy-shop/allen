import type { TimelineEvent } from '../../hooks/useExecution';
import {
  Play, CheckCircle, XCircle, RotateCcw, MessageSquare,
  ArrowRight, GitFork, GitMerge, Zap,
} from 'lucide-react';

const eventIcons: Record<string, { icon: any; color: string }> = {
  execution_started:    { icon: Play,          color: 'text-blue-400' },
  execution_completed:  { icon: CheckCircle,   color: 'text-green-400' },
  execution_failed:     { icon: XCircle,       color: 'text-red-400' },
  node_started:         { icon: ArrowRight,    color: 'text-blue-400' },
  node_completed:       { icon: CheckCircle,   color: 'text-green-400' },
  node_failed:          { icon: XCircle,       color: 'text-red-400' },
  node_retrying:        { icon: RotateCcw,     color: 'text-yellow-400' },
  input_required:       { icon: MessageSquare, color: 'text-orange-400' },
  input_received:       { icon: MessageSquare, color: 'text-green-400' },
  parallel_started:     { icon: GitFork,       color: 'text-purple-400' },
  parallel_branch_done: { icon: Zap,           color: 'text-purple-300' },
  parallel_joined:      { icon: GitMerge,      color: 'text-purple-400' },
};

function formatTime(d: Date) {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <div className="p-4 text-sm text-gray-500">Waiting for events...</div>;
  }

  return (
    <div className="overflow-auto max-h-full">
      {events.map(evt => {
        const cfg = eventIcons[evt.event] ?? { icon: Zap, color: 'text-gray-400' };
        const Icon = cfg.icon;

        return (
          <div key={evt.id} className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-100 text-sm">
            <span className="text-[11px] text-gray-500 font-mono mt-0.5 shrink-0 w-16">
              {formatTime(evt.timestamp)}
            </span>
            <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${cfg.color}`} />
            <div className="min-w-0">
              <span className="text-gray-300">
                {evt.event.replace(/_/g, ' ')}
              </span>
              {evt.node && (
                <span className="ml-1.5 text-gray-400 font-mono text-xs">
                  {evt.node}
                </span>
              )}
              {evt.data.error && (
                <span className="ml-1.5 text-red-400 text-xs">{evt.data.error}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
