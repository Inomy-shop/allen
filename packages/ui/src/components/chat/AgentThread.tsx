import { useState, useRef, useEffect } from 'react';
import {
  ChevronRight, ChevronDown, Loader2, CheckCircle, XCircle, Wrench,
  Clock, MessageSquare, Maximize2, AlertCircle, Brain, Copy, Check,
} from 'lucide-react';
import RoleIcon from '../common/RoleIcon';
import ThreadDetailPanel from './ThreadDetailPanel';

// ── Types ──

export interface ThreadActivityItem {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'follow_up' | 'response';
  agent: string;
  content?: string;
  tool?: string;
  durationMs?: number;
  timestamp: number;
}

export interface AgentThreadData {
  conversationId: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  status: 'active' | 'completed' | 'failed';
  summary?: string;
  response?: string;
  messages?: { agent: string; content: string; toolCalls?: { tool: string; args?: Record<string, unknown>; result?: Record<string, unknown>; durationMs?: number }[]; timestamp: string }[];
  costUsd?: number;
  durationMs?: number;
  depth?: number;
  liveActivity?: ThreadActivityItem[];
}

interface AgentThreadProps {
  thread: AgentThreadData;
  agents?: Record<string, { displayName?: string; icon?: string; color?: string }>;
}

// ── Copy Button ──

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 rounded hover:bg-surface-200/50 text-gray-600 hover:text-gray-400 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

// ── Tool Call Card (nested version) ──

function ThreadToolCall({ tc }: { tc: { tool: string; args?: Record<string, unknown>; result?: Record<string, unknown>; durationMs?: number } }) {
  const [expanded, setExpanded] = useState(false);
  const shortName = tc.tool.replace('mcp__flowforge__', 'ff:').replace('mcp__linear__', 'linear:').replace('mcp__postgres__', 'pg:').replace('mcp__mongodb__', 'mongo:');
  const hasResult = tc.result && Object.keys(tc.result).length > 0;
  const hasArgs = tc.args && Object.keys(tc.args).length > 0;
  const isError = tc.result && 'error' in tc.result;

  return (
    <div className="border border-border/20 rounded-md bg-surface-200/20 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-surface-200/40 transition-colors text-left"
      >
        {isError ? (
          <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
        ) : (
          <CheckCircle className="w-3 h-3 text-accent-green/60 shrink-0" />
        )}
        <Wrench className="w-2.5 h-2.5 text-accent-yellow shrink-0" />
        <span className="text-[11px] font-mono text-accent-yellow">{shortName}</span>

        {hasArgs && (
          <span className="text-[10px] text-gray-600 font-mono truncate max-w-[250px]">
            {Object.entries(tc.args!).slice(0, 2).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 30) : JSON.stringify(v).slice(0, 30)}`).join(', ')}
          </span>
        )}

        <span className="flex-1" />
        {tc.durationMs != null && <span className="text-[10px] text-gray-600 font-mono">{tc.durationMs}ms</span>}
        {(hasArgs || hasResult) && (
          expanded
            ? <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />
            : <ChevronRight className="w-3 h-3 text-gray-600 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/15">
          {hasArgs && (
            <div className="px-2.5 py-1.5 border-b border-border/10">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-label uppercase tracking-wider text-gray-600">Input</span>
                <CopyBtn text={JSON.stringify(tc.args, null, 2)} />
              </div>
              <pre className="text-[10px] font-mono text-gray-500 whitespace-pre-wrap max-h-32 overflow-auto">{JSON.stringify(tc.args, null, 2)}</pre>
            </div>
          )}
          {hasResult && (
            <div className="px-2.5 py-1.5 bg-[rgb(13,17,28)]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-label uppercase tracking-wider text-gray-600">Output</span>
                <CopyBtn text={JSON.stringify(tc.result, null, 2)} />
              </div>
              <pre className={`text-[10px] font-mono whitespace-pre-wrap max-h-48 overflow-auto ${isError ? 'text-red-400/80' : 'text-gray-400'}`}>
                {JSON.stringify(tc.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Simple Markdown ──

function renderMd(text: string): React.ReactNode {
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(<span key={key++}>{renderInline(text.slice(lastIndex, match.index))}</span>);
    const lang = match[1] || 'code';
    const code = match[2].replace(/\n$/, '');
    parts.push(
      <div key={key++} className="my-2 rounded-md overflow-hidden border border-border/30 bg-[rgb(13,17,28)]">
        <div className="flex items-center justify-between px-2.5 py-1 bg-surface-200/50 border-b border-border/20">
          <span className="text-[9px] font-mono text-gray-600 uppercase">{lang}</span>
          <CopyBtn text={code} />
        </div>
        <pre className="px-3 py-2 overflow-x-auto text-[11px] font-mono text-gray-300 leading-relaxed">{code}</pre>
      </div>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(<span key={key++}>{renderInline(text.slice(lastIndex))}</span>);
  return <>{parts}</>;
}

function renderInline(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('### ')) return <div key={i} className="text-[12px] font-heading font-semibold text-gray-200 mt-2 mb-0.5">{renderSpan(line.slice(4))}</div>;
    if (line.startsWith('## ')) return <div key={i} className="text-[13px] font-heading font-semibold text-gray-200 mt-3 mb-1 uppercase tracking-wider">{renderSpan(line.slice(3))}</div>;
    if (line.startsWith('- ')) return <div key={i} className="flex gap-1.5 ml-2"><span className="text-gray-600 shrink-0">•</span><span>{renderSpan(line.slice(2))}</span></div>;
    if (/^\d+\.\s/.test(line)) return <div key={i} className="flex gap-1.5 ml-2"><span className="text-gray-600 shrink-0 font-mono text-[10px]">{line.match(/^(\d+)\./)?.[1]}.</span><span>{renderSpan(line.replace(/^\d+\.\s/, ''))}</span></div>;
    if (!line.trim()) return <div key={i} className="h-1.5" />;
    return <div key={i}>{renderSpan(line)}</div>;
  });
}

function renderSpan(text: string): React.ReactNode {
  return text.split(/(\*\*.*?\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} className="text-gray-200 font-semibold">{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="text-accent-blue/80 bg-surface-200/50 px-1 py-0.5 rounded text-[10px] font-mono">{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

// ── Main Component ──

export function AgentThread({ thread, agents }: AgentThreadProps) {
  const [expanded, setExpanded] = useState(thread.status === 'active');
  const [detailOpen, setDetailOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fromInfo = agents?.[thread.fromAgent];
  const toInfo = agents?.[thread.toAgent];
  const fromName = fromInfo?.displayName ?? thread.fromAgent;
  const toName = toInfo?.displayName ?? thread.toAgent;
  const fromColor = fromInfo?.color ?? '#6b7280';
  const toColor = toInfo?.color ?? '#6b7280';
  const isActive = thread.status === 'active';
  const isFailed = thread.status === 'failed';
  const toolCount = thread.messages?.reduce((s, m) => s + (m.toolCalls?.length ?? 0), 0) ?? 0;

  // Auto-scroll live feed
  useEffect(() => {
    if (isActive && expanded) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [thread.liveActivity?.length, isActive, expanded]);

  return (
    <div className={`rounded-lg overflow-hidden transition-all ${
      isActive ? 'border border-accent-cyan/20 shadow-[0_0_20px_rgba(0,200,255,0.04)]' :
      isFailed ? 'border border-red-500/20' :
      'border border-border/20'
    }`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2.5 px-4 py-2.5 transition-colors text-left ${expanded ? 'bg-surface-100/80' : 'bg-surface-100/40 hover:bg-surface-100/60'}`}
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-600 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-600 shrink-0" />}
        <MessageSquare className="w-3.5 h-3.5 text-gray-600 shrink-0" />

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: fromColor + '20', border: `1px solid ${fromColor}30` }}>
            <RoleIcon icon={fromInfo?.icon} color={fromColor} size={11} />
          </div>
          <span className="text-[11px] font-mono" style={{ color: fromColor }}>{fromName}</span>
        </div>
        <span className="text-gray-700 text-xs">→</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: toColor + '20', border: `1px solid ${toColor}30` }}>
            <RoleIcon icon={toInfo?.icon} color={toColor} size={11} />
          </div>
          <span className="text-[11px] font-mono" style={{ color: toColor }}>{toName}</span>
        </div>

        {isActive ? <Loader2 className="w-3.5 h-3.5 text-accent-cyan animate-spin shrink-0" />
          : isFailed ? <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
          : <CheckCircle className="w-3.5 h-3.5 text-accent-green/60 shrink-0" />}

        <span className="flex-1" />

        {toolCount > 0 && <span className="text-[10px] text-gray-600 font-mono flex items-center gap-0.5 shrink-0"><Wrench className="w-2.5 h-2.5" /> {toolCount}</span>}
        {thread.durationMs != null && thread.durationMs > 0 && <span className="text-[10px] text-gray-600 font-mono flex items-center gap-0.5 shrink-0"><Clock className="w-2.5 h-2.5" /> {(thread.durationMs / 1000).toFixed(0)}s</span>}
        {thread.costUsd != null && thread.costUsd > 0 && <span className="text-[10px] text-gray-600 font-mono shrink-0">${thread.costUsd.toFixed(2)}</span>}
        {thread.status !== 'active' && (
          <button onClick={(e) => { e.stopPropagation(); setDetailOpen(true); }} className="p-1 rounded hover:bg-surface-200/50 text-gray-600 hover:text-accent-blue transition-colors shrink-0" title="Open full view">
            <Maximize2 className="w-3 h-3" />
          </button>
        )}
      </button>

      {/* Expanded: nested chat view */}
      {expanded && (
        <div className="bg-surface-50/30 max-h-[500px] overflow-y-auto">
          {/* Completed messages — render as chat bubbles */}
          {thread.messages && thread.messages.length > 0 && (
            <div className="divide-y divide-border/5">
              {thread.messages.map((msg, i) => {
                const agentInfo = agents?.[msg.agent];
                const agentColor = agentInfo?.color ?? '#6b7280';
                const agentName = agentInfo?.displayName ?? msg.agent;
                const isRequester = msg.agent === thread.fromAgent;

                return (
                  <div key={i} className={`px-4 py-3 ${isRequester ? 'bg-surface-100/15' : ''}`}>
                    {/* Agent header */}
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: agentColor + '15', border: `1px solid ${agentColor}25` }}>
                        <RoleIcon icon={agentInfo?.icon} color={agentColor} size={12} />
                      </div>
                      <span className="text-[12px] font-heading font-semibold tracking-wider" style={{ color: agentColor }}>{agentName}</span>
                      <span className="text-[10px] text-gray-700 font-mono">{isRequester ? 'asked' : 'replied'}</span>
                    </div>

                    {/* Message content */}
                    <div className="ml-8 text-[12px] text-gray-300 font-body leading-relaxed">
                      {renderMd(msg.content)}
                    </div>

                    {/* Tool calls — full expandable cards */}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="ml-8 mt-2 space-y-1.5">
                        {msg.toolCalls.map((tc, j) => (
                          <ThreadToolCall key={j} tc={tc} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Live activity feed (while thread is active) */}
          {isActive && (
            <div className="px-4 py-3 space-y-1.5 border-t border-border/10">
              {thread.liveActivity && thread.liveActivity.length > 0 ? (
                thread.liveActivity.slice(-20).map((act, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] font-mono animate-in fade-in duration-300">
                    {act.type === 'thinking' && (
                      <>
                        <Brain className="w-3 h-3 text-purple-400 animate-pulse shrink-0" />
                        <span className="text-purple-400/70 truncate">{act.content?.slice(0, 120) ?? 'thinking...'}</span>
                      </>
                    )}
                    {act.type === 'text' && (
                      <>
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                        <span className="text-gray-400 truncate">{act.content?.slice(0, 150)}</span>
                      </>
                    )}
                    {act.type === 'tool_call' && (
                      <>
                        <Loader2 className="w-3 h-3 text-accent-yellow animate-spin shrink-0" />
                        <Wrench className="w-2.5 h-2.5 text-accent-yellow shrink-0" />
                        <span className="text-accent-yellow">{act.tool?.replace('mcp__flowforge__', 'ff:').replace('mcp__linear__', 'linear:')}</span>
                      </>
                    )}
                    {act.type === 'tool_result' && (
                      <>
                        <CheckCircle className="w-3 h-3 text-accent-green/60 shrink-0" />
                        <span className="text-gray-500">{act.tool?.replace('mcp__flowforge__', 'ff:')}</span>
                        {act.durationMs != null && <span className="text-gray-600">{act.durationMs}ms</span>}
                      </>
                    )}
                    {act.type === 'follow_up' && (
                      <>
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-blue shrink-0" />
                        <span className="text-accent-blue/70 truncate">↩ {act.content?.slice(0, 120)}</span>
                      </>
                    )}
                  </div>
                ))
              ) : null}
              <div className="flex items-center gap-2 text-[11px] text-accent-cyan pt-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="font-body">{toName} is working...</span>
              </div>
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      )}

      {detailOpen && <ThreadDetailPanel thread={thread} agents={agents ?? {}} onClose={() => setDetailOpen(false)} />}
    </div>
  );
}
