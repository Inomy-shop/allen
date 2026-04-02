import type { NodeState, ActivityEntry } from '../../hooks/useExecution';
import StatusBadge from '../common/StatusBadge';
import CostDisplay from '../common/CostDisplay';
import StreamOutput from './StreamOutput';
import { Wrench, CheckCircle } from 'lucide-react';

interface Props {
  nodeName: string;
  nodeState: NodeState | undefined;
  trace: any | undefined;
}

export default function NodeDetail({ nodeName, nodeState, trace }: Props) {
  if (!nodeState && !trace) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        Select a node to view details
      </div>
    );
  }

  const status = nodeState?.status ?? trace?.status ?? 'pending';
  const output = nodeState?.output ?? trace?.output;
  const cost = nodeState?.cost ?? trace?.cost;
  const durationMs = nodeState?.durationMs ?? trace?.durationMs;
  const prompt = trace?.renderedPrompt;
  const streamText = nodeState?.streamText ?? trace?.rawResponse ?? '';
  const activity: ActivityEntry[] = nodeState?.activity ?? trace?.activity ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div>
          <h3 className="text-sm font-semibold text-white">{nodeName}</h3>
          <div className="flex items-center gap-3 mt-1">
            <StatusBadge status={status} />
            {nodeState?.attempt && nodeState.attempt > 1 && (
              <span className="text-xs text-yellow-400">attempt #{nodeState.attempt}</span>
            )}
            {durationMs != null && (
              <span className="text-xs text-gray-400">{(durationMs / 1000).toFixed(1)}s</span>
            )}
            <CostDisplay cost={cost} />
          </div>
        </div>
      </div>

      {/* Content sections */}
      <div className="flex-1 overflow-auto">
        {/* Rendered prompt */}
        {prompt && (
          <section className="p-4 border-b border-border">
            <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">Prompt</h4>
            <pre className="text-xs text-gray-300 bg-surface-200 rounded p-3 whitespace-pre-wrap max-h-40 overflow-auto">
              {prompt}
            </pre>
          </section>
        )}

        {/* Live stream output */}
        {streamText && (
          <section className="p-4 border-b border-border">
            <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">
              {status === 'running' ? 'Live Output' : 'Response'}
            </h4>
            <StreamOutput text={streamText} isLive={status === 'running'} />
          </section>
        )}

        {/* Activity log */}
        {activity.length > 0 && (
          <section className="p-4 border-b border-border">
            <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">
              Activity Log ({activity.length})
            </h4>
            <div className="space-y-1.5 max-h-48 overflow-auto">
              {activity.map((entry, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  {entry.type === 'tool_start' ? (
                    <Wrench className="w-3 h-3 text-blue-400 mt-0.5 shrink-0" />
                  ) : (
                    <CheckCircle className="w-3 h-3 text-green-400 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    {entry.tool && (
                      <span className="font-mono text-accent-cyan mr-1">{entry.tool}</span>
                    )}
                    <span className="text-gray-400">{entry.content}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Extracted outputs */}
        {output && Object.keys(output).length > 0 && (
          <section className="p-4 border-b border-border">
            <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">Outputs</h4>
            <pre className="text-xs text-gray-300 bg-surface-200 rounded p-3 whitespace-pre-wrap max-h-60 overflow-auto">
              {JSON.stringify(output, null, 2)}
            </pre>
          </section>
        )}

        {/* Input state */}
        {trace?.inputState && (
          <section className="p-4">
            <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">Input State</h4>
            <pre className="text-xs text-gray-300 bg-surface-200 rounded p-3 whitespace-pre-wrap max-h-40 overflow-auto">
              {JSON.stringify(trace.inputState, null, 2)}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
