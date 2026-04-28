import { useState, useEffect } from 'react';
import { BarChart3, MessageSquare, Wrench, Clock, DollarSign, TrendingUp } from 'lucide-react';
import { chat as chatApi } from '../services/api';
import ConversationLogs from '../components/chat/ConversationLogs';

interface ChatLog {
  _id: string;
  sessionId: string;
  userMessage: string;
  status: string;
  costUsd: number;
  durationMs: number;
  toolCalls: Array<{ tool: string; durationMs: number }>;
  trace: Array<{ type: string; tool?: string; durationMs?: number }>;
  timestamp: string;
}

export default function AnalyticsPage() {
  const [logs, setLogs] = useState<ChatLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);

  useEffect(() => {
    chatApi
      .logs({ limit: '100' })
      .then((data) => setLogs(Array.isArray(data) ? data : []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, []);

  // Compute stats
  const totalConversations = new Set(logs.map(l => l.sessionId)).size;
  const totalMessages = logs.length;
  const totalCost = logs.reduce((s, l) => s + (l.costUsd ?? 0), 0);
  const avgDuration = totalMessages > 0 ? logs.reduce((s, l) => s + (l.durationMs ?? 0), 0) / totalMessages : 0;

  // Tool usage breakdown
  const toolCounts: Record<string, number> = {};
  for (const log of logs) {
    for (const tc of (log.toolCalls ?? [])) {
      toolCounts[tc.tool] = (toolCounts[tc.tool] ?? 0) + 1;
    }
    for (const t of (log.trace ?? [])) {
      if (t.type === 'tool_call' && t.tool) {
        toolCounts[t.tool] = (toolCounts[t.tool] ?? 0) + 1;
      }
    }
  }
  const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Errors
  const errors = logs.filter(l => l.status === 'failed');

  if (loading) return <div className="p-6 text-xs text-theme-subtle animate-pulse">Loading analytics...</div>;

  return (
    <div className="px-6 pt-5 pb-8 space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <span>Insight</span>
          <span className="text-theme-subtle">/</span>
          <span>Analytics</span>
        </div>
        <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Analytics</h1>
        <p className="text-[13px] text-theme-muted font-body mt-1">Chat agent performance and tool usage</p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <MessageSquare className="w-4 h-4 text-accent-blue" />
            <span className="overline">Messages</span>
          </div>
          <div className="text-2xl font-heading text-theme-primary">{totalMessages}</div>
          <div className="text-[10px] text-theme-subtle font-mono">{totalConversations} conversations</div>
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-accent-green" />
            <span className="overline">Total Cost</span>
          </div>
          <div className="text-2xl font-heading text-theme-primary">${totalCost.toFixed(2)}</div>
          <div className="text-[10px] text-theme-subtle font-mono">${totalMessages > 0 ? (totalCost / totalMessages).toFixed(4) : '0'}/msg</div>
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-accent-yellow" />
            <span className="overline">Avg Response</span>
          </div>
          <div className="text-2xl font-heading text-theme-primary">{(avgDuration / 1000).toFixed(1)}s</div>
          <div className="text-[10px] text-theme-subtle font-mono">per message</div>
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Wrench className="w-4 h-4 text-accent-purple" />
            <span className="overline">Tool Calls</span>
          </div>
          <div className="text-2xl font-heading text-theme-primary">{Object.values(toolCounts).reduce((a, b) => a + b, 0)}</div>
          <div className="text-[10px] text-theme-subtle font-mono">{Object.keys(toolCounts).length} unique tools</div>
        </div>
      </div>

      {/* Tool usage */}
      <div className="card p-5">
        <h3 className="text-[14px] font-medium text-theme-primary tracking-tight mb-4 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-accent-blue" /> Top Tools
        </h3>
        {topTools.length === 0 ? (
          <div className="text-xs text-theme-subtle">No tool calls recorded yet.</div>
        ) : (
          <div className="space-y-2">
            {topTools.map(([tool, count]) => {
              const max = topTools[0][1];
              const pct = (count / max) * 100;
              const name = tool.replace('mcp__allen__', 'al:').replace('mcp__linear__', 'linear:');
              return (
                <div key={tool} className="flex items-center gap-3">
                  <span className="text-xs font-mono text-theme-secondary w-40 truncate" title={tool}>{name}</span>
                  <div className="flex-1 h-2 bg-app-muted rounded-full overflow-hidden">
                    <div className="h-full bg-accent-blue/50 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs font-mono text-theme-muted w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent errors */}
      {errors.length > 0 && (
        <div className="card p-5">
          <h3 className="text-[14px] font-medium text-theme-primary tracking-tight mb-4 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-accent-red" /> Recent Errors ({errors.length})
          </h3>
          <div className="space-y-2">
            {errors.slice(0, 5).map(e => (
              <div key={e._id} className="flex items-center gap-3 text-xs">
                <span className="text-theme-subtle font-mono w-20 shrink-0">{new Date(e.timestamp).toLocaleDateString()}</span>
                <span className="text-accent-red truncate">{e.userMessage?.slice(0, 50)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent messages log */}
      <div className="card p-5">
        <h3 className="text-[14px] font-medium text-theme-primary tracking-tight mb-4">Recent Messages</h3>
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {logs.slice(0, 30).map(log => (
            <button
              key={log._id}
              onClick={() => setViewingSessionId(log.sessionId)}
              className="w-full flex items-center gap-3 py-1.5 border-b border-app last:border-0 text-xs hover:bg-app-muted/50 transition-colors text-left"
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${log.status === 'completed' ? 'bg-accent-green' : 'bg-accent-red'}`} />
              <span className="text-theme-subtle font-mono w-16 shrink-0">{(log.durationMs / 1000).toFixed(1)}s</span>
              <span className="text-theme-secondary font-body truncate flex-1">{log.userMessage?.slice(0, 60)}</span>
              <span className="text-theme-subtle font-mono shrink-0">{(log.trace ?? []).filter(t => t.type === 'tool_call').length} tools</span>
            </button>
          ))}
        </div>
      </div>

      {viewingSessionId && (
        <ConversationLogs sessionId={viewingSessionId} onClose={() => setViewingSessionId(null)} />
      )}
    </div>
  );
}
