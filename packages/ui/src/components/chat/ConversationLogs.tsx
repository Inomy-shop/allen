import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Clock, Wrench, Brain, CheckCircle, XCircle, Play,
  ChevronDown, ChevronRight, MessageSquare, Zap, AlertCircle,
} from 'lucide-react';

interface TraceEvent {
  timestamp: string;
  type: string;
  tool?: string;
  toolUseId?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  durationMs?: number;
  isError?: boolean;
  text?: string;
}

interface ChatLogEntry {
  _id: string;
  sessionId: string;
  messageId: string;
  llmSessionId?: string;
  userMessage: string;
  assistantResponse?: string;
  model?: string;
  costUsd: number;
  durationMs: number;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: Record<string, unknown>; durationMs: number }>;
  trace: TraceEvent[];
  status: string;
  timestamp: string;
}

const TYPE_STYLE: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  session_start: { icon: Play, color: 'text-accent-blue', label: 'Session' },
  thinking: { icon: Brain, color: 'text-purple-400', label: 'Thinking' },
  tool_call: { icon: Wrench, color: 'text-accent-yellow', label: 'Tool Call' },
  tool_result: { icon: CheckCircle, color: 'text-accent-green', label: 'Tool Result' },
  builtin_tool_call: { icon: Zap, color: 'text-accent-orange', label: 'Built-in Call' },
  builtin_tool_result: { icon: CheckCircle, color: 'text-accent-green', label: 'Built-in Result' },
  error: { icon: XCircle, color: 'text-accent-red', label: 'Error' },
  complete: { icon: CheckCircle, color: 'text-theme-muted', label: 'Complete' },
};

function TraceEventRow({ event }: { event: TraceEvent }) {
  const [expanded, setExpanded] = useState(false);
  const style = TYPE_STYLE[event.type] ?? { icon: MessageSquare, color: 'text-theme-muted', label: event.type };
  const Icon = style.icon;
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const toolName = event.tool?.replace('mcp__flowforge__', 'ff:').replace('mcp__linear__', 'linear:').replace('mcp__postgres__', 'pg:').replace('mcp__mongodb__', 'mongo:') ?? '';
  const hasDetail = event.args || event.result || (event.text && event.text.length > 80);

  return (
    <div className={`border-l-2 ${event.isError ? 'border-accent-red/50' : 'border-border/30'} ml-3`}>
      <button
        onClick={() => hasDetail && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${hasDetail ? 'hover:bg-surface-200/30 cursor-pointer' : ''}`}
      >
        <span className="text-[10px] font-mono text-theme-subtle w-16 shrink-0">{time}</span>
        <Icon className={`w-3.5 h-3.5 shrink-0 ${event.isError ? 'text-accent-red' : style.color}`} />
        <span className={`text-[11px] font-mono ${style.color}`}>{style.label}</span>
        {toolName && <span className="text-[11px] font-mono text-theme-secondary">{toolName}</span>}
        {event.durationMs != null && <span className="text-[10px] font-mono text-theme-subtle">{event.durationMs}ms</span>}
        {event.text && !event.tool && <span className="text-[10px] text-theme-muted truncate max-w-[200px]">{event.text.slice(0, 80)}</span>}
        <span className="flex-1" />
        {hasDetail && (expanded ? <ChevronDown className="w-3 h-3 text-theme-subtle" /> : <ChevronRight className="w-3 h-3 text-theme-subtle" />)}
      </button>

      {expanded && (
        <div className="mx-3 mb-2 ml-8 p-2 bg-[rgb(var(--color-editor-background))] rounded-md border border-border/20 max-h-60 overflow-auto">
          {event.args && Object.keys(event.args).length > 0 && (
            <div className="mb-2">
              <span className="text-[9px] font-label uppercase tracking-widest text-theme-subtle">Args</span>
              <pre className="text-[11px] font-mono text-theme-secondary mt-0.5 whitespace-pre-wrap">{JSON.stringify(event.args, null, 2)}</pre>
            </div>
          )}
          {event.result && (
            <div>
              <span className="text-[9px] font-label uppercase tracking-widest text-theme-subtle">Result</span>
              <pre className="text-[11px] font-mono text-theme-secondary mt-0.5 whitespace-pre-wrap">{JSON.stringify(event.result, null, 2).slice(0, 2000)}</pre>
            </div>
          )}
          {event.text && event.text.length > 80 && !event.args && !event.result && (
            <pre className="text-[11px] font-mono text-theme-secondary whitespace-pre-wrap">{event.text.slice(0, 1000)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function LogEntry({ log }: { log: ChatLogEntry }) {
  const [expanded, setExpanded] = useState(true);
  const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const toolCount = (log.trace ?? []).filter(t => t.type === 'tool_call' || t.type === 'builtin_tool_call').length;

  return (
    <div className="border border-border/30 rounded-lg overflow-hidden mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        title={expanded ? "Collapse" : "Expand"}
        className="w-full flex items-center gap-3 px-4 py-3 bg-surface-200/20 hover:bg-surface-200/40 transition-colors text-left"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${log.status === 'completed' ? 'bg-accent-green' : 'bg-accent-red'}`} />
        <MessageSquare className="w-3.5 h-3.5 text-theme-muted shrink-0" />
        <span className="text-xs text-theme-secondary font-body truncate flex-1">{log.userMessage?.slice(0, 60) ?? '(no message)'}</span>
        <span className="text-[10px] font-mono text-theme-subtle">{toolCount} tools</span>
        <span className="text-[10px] font-mono text-theme-subtle">{(log.durationMs / 1000).toFixed(1)}s</span>
        {log.costUsd > 0 && <span className="text-[10px] font-mono text-theme-subtle">${log.costUsd.toFixed(4)}</span>}
        <span className="text-[10px] font-mono text-theme-subtle">{time}</span>
        {expanded ? <ChevronDown className="w-3 h-3 text-theme-subtle" /> : <ChevronRight className="w-3 h-3 text-theme-subtle" />}
      </button>

      {expanded && (
        <div className="py-1">
          {(log.trace ?? []).length > 0 ? (
            log.trace.map((event, i) => <TraceEventRow key={i} event={event} />)
          ) : log.toolCalls?.length > 0 ? (
            log.toolCalls.map((tc, i) => (
              <TraceEventRow key={i} event={{ timestamp: log.timestamp, type: 'tool_call', tool: tc.tool, args: tc.args, result: tc.result, durationMs: tc.durationMs }} />
            ))
          ) : (
            <div className="px-4 py-2 text-[11px] text-theme-subtle">No trace events recorded</div>
          )}

          {log.assistantResponse && (
            <div className="mx-3 mt-2 mb-2 p-2 bg-surface-200/20 rounded-md border border-border/20">
              <span className="text-[9px] font-label uppercase tracking-widest text-theme-subtle">Response preview</span>
              <p className="text-[11px] text-theme-secondary font-body mt-1 line-clamp-3">{log.assistantResponse.slice(0, 300)}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ConversationLogsProps {
  sessionId: string;
  onClose: () => void;
}

export default function ConversationLogs({ sessionId, onClose }: ConversationLogsProps) {
  const [logs, setLogs] = useState<ChatLogEntry[]>([]);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`/api/chat/sessions/${sessionId}/logs`).then(r => r.json()),
      fetch(`/api/chat/sessions/${sessionId}`).then(r => r.json()),
    ]).then(([logData, sessionData]) => {
      setLogs(logData);
      setSession(sessionData);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [sessionId]);

  return createPortal(
    <div className="fixed top-0 right-0 bottom-0 left-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-2xl h-full bg-surface-100 border-l border-border/50 shadow-2xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 bg-surface-50">
          <div>
            <h2 className="font-heading text-sm text-theme-primary tracking-wider">{session?.title ?? 'Conversation Logs'}</h2>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-[10px] text-theme-muted font-mono">{session?.provider}</span>
              <span className="text-[10px] text-theme-muted font-mono">{logs.length} messages</span>
              {session?.totalCostUsd > 0 && <span className="text-[10px] text-theme-muted font-mono">${session.totalCostUsd.toFixed(4)}</span>}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface-200/50 text-theme-muted hover:text-theme-secondary transition-colors" title="Close logs">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Log entries */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <div className="text-xs text-theme-subtle animate-pulse">Loading logs...</div>}
          {!loading && logs.length === 0 && <div className="text-xs text-theme-subtle">No logs recorded for this conversation.</div>}
          {logs.map(log => <LogEntry key={log._id} log={log} />)}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border/30 flex items-center gap-4 text-[10px] text-theme-subtle font-mono">
          <span>Session: {session?.llmSessionId?.slice(0, 8) ?? 'n/a'}...</span>
          <span>Created: {session?.createdAt ? new Date(session.createdAt).toLocaleString() : 'n/a'}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
