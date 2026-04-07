import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Clock, Wrench, CheckCircle, XCircle, Loader2,
  ChevronDown, ChevronRight, Copy, Check, DollarSign,
} from 'lucide-react';
import RoleIcon from '../common/RoleIcon';
import type { AgentThreadData } from './AgentThread';

interface ThreadDetailPanelProps {
  thread: AgentThreadData;
  agents: Record<string, { displayName?: string; icon?: string; color?: string }>;
  onClose: () => void;
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 rounded hover:bg-surface-200/50 text-gray-600 hover:text-gray-400 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

/** Render markdown with code blocks, bold, inline code, headers, lists */
function renderContent(text: string) {
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{renderInline(text.slice(lastIndex, match.index))}</span>);
    }
    const lang = match[1] || 'code';
    const code = match[2].replace(/\n$/, '');
    parts.push(
      <div key={key++} className="group relative my-3 rounded-md overflow-hidden border border-border/40 bg-[rgb(13,17,28)]">
        <div className="flex items-center justify-between px-3 py-1.5 bg-surface-200/60 border-b border-border/30">
          <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">{lang}</span>
          <CopyBtn text={code} />
        </div>
        <pre className="px-4 py-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-gray-300">
          {code}
        </pre>
      </div>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{renderInline(text.slice(lastIndex))}</span>);
  }

  return <>{parts}</>;
}

function renderInline(text: string) {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    // Headers
    if (line.startsWith('### ')) return <h4 key={i} className="text-[13px] font-heading font-semibold text-gray-200 mt-3 mb-1">{renderSpan(line.slice(4))}</h4>;
    if (line.startsWith('## ')) return <h3 key={i} className="text-sm font-heading font-semibold text-gray-200 mt-4 mb-1.5 uppercase tracking-wider">{renderSpan(line.slice(3))}</h3>;
    if (line.startsWith('# ')) return <h2 key={i} className="text-base font-heading font-bold text-white mt-4 mb-2">{renderSpan(line.slice(2))}</h2>;
    // List items
    if (line.startsWith('- ')) return <div key={i} className="flex gap-2 ml-2"><span className="text-gray-600 shrink-0">•</span><span>{renderSpan(line.slice(2))}</span></div>;
    if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\.\s/)?.[1] ?? '';
      return <div key={i} className="flex gap-2 ml-2"><span className="text-gray-600 shrink-0 font-mono text-[11px]">{num}.</span><span>{renderSpan(line.replace(/^\d+\.\s/, ''))}</span></div>;
    }
    // Empty line
    if (!line.trim()) return <div key={i} className="h-2" />;
    // Regular text
    return <div key={i}>{renderSpan(line)}</div>;
  });
}

function renderSpan(text: string): React.ReactNode {
  // Bold, inline code, italic
  const parts = text.split(/(\*\*.*?\*\*|`[^`]+`|_[^_]+_)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} className="text-gray-200 font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="text-accent-blue/80 bg-surface-200/50 px-1 py-0.5 rounded text-[11px] font-mono">{part.slice(1, -1)}</code>;
    if (part.startsWith('_') && part.endsWith('_')) return <em key={i} className="text-gray-400 italic">{part.slice(1, -1)}</em>;
    return <span key={i}>{part}</span>;
  });
}

function ToolCallBadge({ tool }: { tool: string }) {
  const shortName = tool
    .replace('mcp__flowforge__', 'ff:')
    .replace('mcp__linear__', 'linear:')
    .replace('mcp__postgres__', 'pg:')
    .replace('mcp__mongodb__', 'mongo:');

  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-surface-200/50 text-gray-500 border border-border/20">
      <Wrench className="w-2.5 h-2.5 text-gray-600" />
      {shortName}
    </span>
  );
}

export default function ThreadDetailPanel({ thread, agents, onClose }: ThreadDetailPanelProps) {
  const fromInfo = agents[thread.fromAgent];
  const toInfo = agents[thread.toAgent];
  const fromName = fromInfo?.displayName ?? thread.fromAgent;
  const toName = toInfo?.displayName ?? thread.toAgent;
  const fromColor = fromInfo?.color ?? '#6b7280';
  const toColor = toInfo?.color ?? '#6b7280';
  const isActive = thread.status === 'active';
  const isFailed = thread.status === 'failed';

  const panel = (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="bg-black/40 absolute inset-0" />
      <div
        className="relative w-full max-w-2xl bg-surface-50 border-l border-border/50 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/50 bg-surface-100/50 shrink-0">
          <div className="flex items-center gap-3">
            {/* From agent */}
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: fromColor + '15', border: `1px solid ${fromColor}30` }}>
                <RoleIcon icon={fromInfo?.icon} color={fromColor} size={15} />
              </div>
              <span className="text-xs font-heading font-semibold tracking-wider" style={{ color: fromColor }}>{fromName}</span>
            </div>

            <span className="text-gray-600 text-sm">→</span>

            {/* To agent */}
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: toColor + '15', border: `1px solid ${toColor}30` }}>
                <RoleIcon icon={toInfo?.icon} color={toColor} size={15} />
              </div>
              <span className="text-xs font-heading font-semibold tracking-wider" style={{ color: toColor }}>{toName}</span>
            </div>

            {/* Status badge */}
            {isActive ? (
              <span className="flex items-center gap-1 text-[10px] font-mono text-accent-cyan bg-accent-cyan/10 px-2 py-0.5 rounded border border-accent-cyan/20">
                <Loader2 className="w-3 h-3 animate-spin" /> Running
              </span>
            ) : isFailed ? (
              <span className="flex items-center gap-1 text-[10px] font-mono text-red-400 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20">
                <XCircle className="w-3 h-3" /> Failed
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] font-mono text-accent-green bg-accent-green/10 px-2 py-0.5 rounded border border-accent-green/20">
                <CheckCircle className="w-3 h-3" /> Completed
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Stats */}
            {thread.durationMs != null && thread.durationMs > 0 && (
              <span className="text-[10px] font-mono text-gray-500 flex items-center gap-1">
                <Clock className="w-3 h-3" /> {(thread.durationMs / 1000).toFixed(1)}s
              </span>
            )}
            {thread.costUsd != null && thread.costUsd > 0 && (
              <span className="text-[10px] font-mono text-gray-500 flex items-center gap-1">
                <DollarSign className="w-3 h-3" /> {thread.costUsd.toFixed(3)}
              </span>
            )}
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface-200 text-gray-500 hover:text-gray-300 transition-colors" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Conversation messages */}
        <div className="flex-1 overflow-y-auto">
          {thread.messages && thread.messages.length > 0 ? (
            thread.messages.map((msg, i) => {
              const agentInfo = agents[msg.agent];
              const agentColor = agentInfo?.color ?? '#6b7280';
              const agentName = agentInfo?.displayName ?? msg.agent;
              const isFrom = msg.agent === thread.fromAgent;

              return (
                <div key={i} className={`border-b border-border/10 ${isFrom ? 'bg-surface-100/20' : 'bg-surface-50'}`}>
                  {/* Agent header */}
                  <div className="flex items-center gap-2.5 px-5 pt-4 pb-2">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: agentColor + '15', border: `1px solid ${agentColor}25` }}>
                      <RoleIcon icon={agentInfo?.icon} color={agentColor} size={16} />
                    </div>
                    <div>
                      <span className="text-sm font-heading font-semibold tracking-wider" style={{ color: agentColor }}>
                        {agentName}
                      </span>
                      <span className="text-[10px] text-gray-600 font-mono ml-2">
                        {isFrom ? 'delegated task' : 'response'}
                      </span>
                    </div>
                  </div>

                  {/* Message content — full markdown rendering */}
                  <div className="px-5 pb-4 ml-10">
                    <div className="text-[13px] text-gray-300 font-body leading-relaxed">
                      {renderContent(msg.content)}
                    </div>

                    {/* Tool calls */}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-border/10">
                        <span className="text-[10px] font-label uppercase tracking-wider text-gray-600 mb-1.5 block">
                          Tools used ({msg.toolCalls.length})
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {msg.toolCalls.map((tc, j) => (
                            <ToolCallBadge key={j} tool={tc.tool} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : thread.response ? (
            <div className="px-5 py-4">
              <div className="text-[13px] text-gray-300 font-body leading-relaxed">
                {renderContent(thread.response)}
              </div>
            </div>
          ) : isActive ? (
            <div className="px-5 py-8 flex flex-col items-center gap-2 text-gray-500">
              <Loader2 className="w-6 h-6 animate-spin text-accent-cyan" />
              <span className="text-sm font-body">{toName} is working on this...</span>
            </div>
          ) : null}
        </div>

        {/* Footer with task summary */}
        <div className="border-t border-border/50 px-5 py-3 bg-surface-100/30 shrink-0">
          <span className="text-[10px] font-label uppercase tracking-wider text-gray-600 block mb-1">Task</span>
          <p className="text-[12px] text-gray-400 font-body leading-relaxed">{thread.task}</p>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
