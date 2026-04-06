import { useState, useEffect } from 'react';
import { BarChart3, MessageSquare, Wrench, Clock, DollarSign, TrendingUp } from 'lucide-react';
import { chat as chatApi } from '../services/api';

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

  useEffect(() => {
    fetch('/api/chat/logs?limit=100')
      .then(r => r.json())
      .then(data => { setLogs(data); setLoading(false); })
      .catch(() => setLoading(false));
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

  if (loading) return <div className="p-6 text-xs text-gray-600 animate-pulse">Loading analytics...</div>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="font-heading text-2xl text-white tracking-wider">Analytics</h1>
        <p className="text-sm text-gray-500 font-body mt-1">Chat agent performance and tool usage</p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <MessageSquare className="w-4 h-4 text-accent-blue" />
            <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">Messages</span>
          </div>
          <div className="text-2xl font-heading text-white">{totalMessages}</div>
          <div className="text-[10px] text-gray-600 font-mono">{totalConversations} conversations</div>
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-accent-green" />
            <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">Total Cost</span>
          </div>
          <div className="text-2xl font-heading text-white">${totalCost.toFixed(2)}</div>
          <div className="text-[10px] text-gray-600 font-mono">${totalMessages > 0 ? (totalCost / totalMessages).toFixed(4) : '0'}/msg</div>
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-accent-yellow" />
            <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">Avg Response</span>
          </div>
          <div className="text-2xl font-heading text-white">{(avgDuration / 1000).toFixed(1)}s</div>
          <div className="text-[10px] text-gray-600 font-mono">per message</div>
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Wrench className="w-4 h-4 text-accent-purple" />
            <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">Tool Calls</span>
          </div>
          <div className="text-2xl font-heading text-white">{Object.values(toolCounts).reduce((a, b) => a + b, 0)}</div>
          <div className="text-[10px] text-gray-600 font-mono">{Object.keys(toolCounts).length} unique tools</div>
        </div>
      </div>

      {/* Tool usage */}
      <div className="card p-5">
        <h3 className="font-heading text-sm text-white tracking-wider mb-4 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-accent-blue" /> Top Tools
        </h3>
        {topTools.length === 0 ? (
          <div className="text-xs text-gray-600">No tool calls recorded yet.</div>
        ) : (
          <div className="space-y-2">
            {topTools.map(([tool, count]) => {
              const max = topTools[0][1];
              const pct = (count / max) * 100;
              const name = tool.replace('mcp__flowforge__', 'ff:').replace('mcp__linear__', 'linear:');
              return (
                <div key={tool} className="flex items-center gap-3">
                  <span className="text-xs font-mono text-gray-400 w-40 truncate" title={tool}>{name}</span>
                  <div className="flex-1 h-2 bg-surface-200/50 rounded-full overflow-hidden">
                    <div className="h-full bg-accent-blue/50 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs font-mono text-gray-500 w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent errors */}
      {errors.length > 0 && (
        <div className="card p-5">
          <h3 className="font-heading text-sm text-white tracking-wider mb-4 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-accent-red" /> Recent Errors ({errors.length})
          </h3>
          <div className="space-y-2">
            {errors.slice(0, 5).map(e => (
              <div key={e._id} className="flex items-center gap-3 text-xs">
                <span className="text-gray-600 font-mono w-20 shrink-0">{new Date(e.timestamp).toLocaleDateString()}</span>
                <span className="text-red-400 truncate">{e.userMessage?.slice(0, 50)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent messages log */}
      <div className="card p-5">
        <h3 className="font-heading text-sm text-white tracking-wider mb-4">Recent Messages</h3>
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {logs.slice(0, 30).map(log => (
            <div key={log._id} className="flex items-center gap-3 py-1.5 border-b border-border/20 last:border-0 text-xs">
              <span className={`w-2 h-2 rounded-full shrink-0 ${log.status === 'completed' ? 'bg-accent-green' : 'bg-accent-red'}`} />
              <span className="text-gray-600 font-mono w-16 shrink-0">{(log.durationMs / 1000).toFixed(1)}s</span>
              <span className="text-gray-400 font-body truncate flex-1">{log.userMessage?.slice(0, 60)}</span>
              <span className="text-gray-600 font-mono shrink-0">{(log.trace ?? []).filter(t => t.type === 'tool_call').length} tools</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
