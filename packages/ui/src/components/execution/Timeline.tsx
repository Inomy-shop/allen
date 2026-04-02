import type { TimelineEvent } from '../../hooks/useExecution';
import {
  Play, CheckCircle, XCircle, RotateCcw, MessageSquare,
  ArrowRight, GitFork, GitMerge, Zap,
} from 'lucide-react';

const eventIcons: Record<string, { icon: any; color: string }> = {
  execution_started:    { icon: Play,          color: 'text-accent-blue' },
  execution_completed:  { icon: CheckCircle,   color: 'text-accent-green' },
  execution_failed:     { icon: XCircle,       color: 'text-accent-red' },
  node_started:         { icon: ArrowRight,    color: 'text-accent-blue' },
  node_completed:       { icon: CheckCircle,   color: 'text-accent-green' },
  node_failed:          { icon: XCircle,       color: 'text-accent-red' },
  node_retrying:        { icon: RotateCcw,     color: 'text-accent-yellow' },
  input_required:       { icon: MessageSquare, color: 'text-accent-orange' },
  input_received:       { icon: MessageSquare, color: 'text-accent-green' },
  parallel_started:     { icon: GitFork,       color: 'text-accent-purple' },
  parallel_branch_done: { icon: Zap,           color: 'text-accent-purple/70' },
  parallel_joined:      { icon: GitMerge,      color: 'text-accent-purple' },
};

function formatTime(d: Date) {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <div className="p-4 text-sm text-gray-500 font-mono">WAITING FOR EVENTS...</div>;
  }

  return (
    <div>
      {events.map(evt => {
        const cfg = eventIcons[evt.event] ?? { icon: Zap, color: 'text-gray-400' };
        const Icon = cfg.icon;

        return (
          <div key={evt.id} className="flex items-start gap-2 px-3 py-1.5 hover:bg-accent-blue/5 text-sm transition-colors">
            <span className="text-[11px] text-gray-500 font-mono mt-0.5 shrink-0 w-16">
              {formatTime(evt.timestamp)}
            </span>
            <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${cfg.color}`} />
            <div className="min-w-0">
              <span className="text-gray-300 font-body">
                {evt.event.replace(/_/g, ' ')}
              </span>
              {evt.node && (
                <span className="ml-1.5 text-accent-blue/60 font-mono text-xs">
                  {evt.node}
                </span>
              )}
              {evt.data.error && (
                <span className="ml-1.5 text-accent-red text-xs font-mono">{evt.data.error}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
