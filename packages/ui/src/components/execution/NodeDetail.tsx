import { useState } from 'react';
import type { NodeState, ActivityEntry } from '../../hooks/useExecution';
import StatusBadge from '../common/StatusBadge';
import CostDisplay from '../common/CostDisplay';
import StreamOutput from './StreamOutput';
import { Wrench, CheckCircle, Send, MessageSquare } from 'lucide-react';

interface HumanInputField {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
}

interface Props {
  nodeName: string;
  nodeState: NodeState | undefined;
  trace: any | undefined;
  waitingInput?: {
    node: string;
    prompt: string;
    fields: HumanInputField[];
  } | null;
  onSubmitInput?: (data: Record<string, unknown>) => void;
}

export default function NodeDetail({ nodeName, nodeState, trace, waitingInput, onSubmitInput }: Props) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});

  const isWaitingNode = waitingInput && waitingInput.node === nodeName;

  if (!nodeState && !trace && !isWaitingNode) {
    return (
      <div className="p-4 text-gray-500 text-sm font-mono">
        SELECT A NODE TO VIEW DETAILS
      </div>
    );
  }

  const status = nodeState?.status ?? trace?.status ?? (isWaitingNode ? 'waiting_for_input' : 'pending');
  const output = nodeState?.output ?? trace?.output;
  const cost = nodeState?.cost ?? trace?.cost;
  const durationMs = nodeState?.durationMs ?? trace?.durationMs;
  const prompt = trace?.renderedPrompt;
  const streamText = nodeState?.streamText ?? trace?.rawResponse ?? '';
  const activity: ActivityEntry[] = nodeState?.activity ?? trace?.activity ?? [];

  const handleSubmit = () => {
    if (onSubmitInput) onSubmitInput(formData);
    setFormData({});
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
        <div>
          <h3 className="font-heading text-sm font-semibold text-white tracking-wider">{nodeName}</h3>
          <div className="flex items-center gap-3 mt-1">
            <StatusBadge status={status} />
            {nodeState?.attempt && nodeState.attempt > 1 && (
              <span className="text-xs text-accent-yellow font-mono">attempt #{nodeState.attempt}</span>
            )}
            {durationMs != null && (
              <span className="text-xs text-gray-400 font-mono">{(durationMs / 1000).toFixed(1)}s</span>
            )}
            <CostDisplay cost={cost} />
          </div>
        </div>
      </div>

      {/* Content sections */}
      <div className="flex-1 overflow-auto">
        {/* Human input form — shown when this node is waiting */}
        {isWaitingNode && (
          <section className="p-4 border-b-2 border-accent-yellow/50 bg-accent-yellow/5">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-4 h-4 text-accent-yellow" />
              <h4 className="font-heading text-xs font-semibold text-accent-yellow uppercase tracking-widest">Input Required</h4>
            </div>
            <p className="text-xs text-gray-300 font-body mb-4 whitespace-pre-wrap">{waitingInput.prompt}</p>
            <div className="space-y-3">
              {waitingInput.fields.map((field) => (
                <div key={field.name}>
                  <label className="block text-[11px] font-label uppercase tracking-wider text-gray-400 mb-1">
                    {field.label ?? field.name}
                    {field.required !== false && <span className="text-accent-red ml-0.5">*</span>}
                  </label>
                  {field.type === 'select' && field.options ? (
                    <select
                      className="input w-full text-xs"
                      value={(formData[field.name] as string) ?? ''}
                      onChange={e => setFormData(p => ({ ...p, [field.name]: e.target.value }))}
                    >
                      <option value="">Select...</option>
                      {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : field.type === 'boolean' ? (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!formData[field.name]}
                        onChange={e => setFormData(p => ({ ...p, [field.name]: e.target.checked }))}
                        className="w-4 h-4 rounded-sm accent-accent-blue"
                      />
                      <span className="text-xs text-gray-300 font-body">{field.label ?? field.name}</span>
                    </label>
                  ) : field.type === 'text' ? (
                    <textarea
                      className="input w-full text-xs resize-none"
                      rows={2}
                      placeholder={`Enter ${field.label ?? field.name}...`}
                      value={(formData[field.name] as string) ?? ''}
                      onChange={e => setFormData(p => ({ ...p, [field.name]: e.target.value }))}
                    />
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : 'text'}
                      className="input w-full text-xs"
                      placeholder={`Enter ${field.label ?? field.name}...`}
                      value={(formData[field.name] as string) ?? ''}
                      onChange={e => setFormData(p => ({ ...p, [field.name]: field.type === 'number' ? Number(e.target.value) : e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </div>
            <button onClick={handleSubmit} className="btn-primary w-full mt-4 inline-flex items-center justify-center gap-2 text-xs">
              <Send className="w-3.5 h-3.5" /> Submit
            </button>
          </section>
        )}
        {/* Rendered prompt */}
        {prompt && (
          <section className="p-4 border-b border-border/50">
            <h4 className="font-heading text-xs font-semibold text-gray-400 uppercase mb-2 tracking-widest">Prompt</h4>
            <pre className="text-xs text-gray-300 bg-surface-200/80 rounded-sm p-3 whitespace-pre-wrap max-h-40 overflow-auto font-mono border border-border/30">
              {prompt}
            </pre>
          </section>
        )}

        {/* Live stream output */}
        {streamText && (
          <section className="p-4 border-b border-border/50">
            <h4 className="font-heading text-xs font-semibold text-gray-400 uppercase mb-2 tracking-widest">
              {status === 'running' ? 'Live Output' : 'Response'}
            </h4>
            <StreamOutput text={streamText} isLive={status === 'running'} />
          </section>
        )}

        {/* Activity log */}
        {activity.length > 0 && (
          <section className="p-4 border-b border-border/50">
            <h4 className="font-heading text-xs font-semibold text-gray-400 uppercase mb-2 tracking-widest">
              Activity Log ({activity.length})
            </h4>
            <div className="space-y-1.5 max-h-48 overflow-auto">
              {activity.map((entry, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  {entry.type === 'tool_start' ? (
                    <Wrench className="w-3 h-3 text-accent-blue mt-0.5 shrink-0" />
                  ) : (
                    <CheckCircle className="w-3 h-3 text-accent-green mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    {entry.tool && (
                      <span className="font-mono text-accent-cyan mr-1">{entry.tool}</span>
                    )}
                    <span className="text-gray-400 font-body">{entry.content}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Extracted outputs */}
        {output && Object.keys(output).length > 0 && (
          <section className="p-4 border-b border-border/50">
            <h4 className="font-heading text-xs font-semibold text-gray-400 uppercase mb-2 tracking-widest">Outputs</h4>
            <pre className="text-xs text-gray-300 bg-surface-200/80 rounded-sm p-3 whitespace-pre-wrap max-h-60 overflow-auto font-mono border border-border/30">
              {JSON.stringify(output, null, 2)}
            </pre>
          </section>
        )}

        {/* Input state */}
        {trace?.inputState && (
          <section className="p-4">
            <h4 className="font-heading text-xs font-semibold text-gray-400 uppercase mb-2 tracking-widest">Input State</h4>
            <pre className="text-xs text-gray-300 bg-surface-200/80 rounded-sm p-3 whitespace-pre-wrap max-h-40 overflow-auto font-mono border border-border/30">
              {JSON.stringify(trace.inputState, null, 2)}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
