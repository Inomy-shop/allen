import { useState } from 'react';
import { ChevronRight, ChevronDown, Users, Loader2, CheckCircle, XCircle, Wrench, Clock } from 'lucide-react';
import RoleIcon from '../common/RoleIcon';

export interface AgentThreadData {
  conversationId: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  status: 'active' | 'completed' | 'failed';
  summary?: string;
  response?: string;
  messages?: { agent: string; content: string; toolCalls?: { tool: string }[]; timestamp: string }[];
  costUsd?: number;
  durationMs?: number;
  depth?: number;
}

interface AgentThreadProps {
  thread: AgentThreadData;
  agents?: Record<string, { displayName?: string; icon?: string; color?: string }>;
}

export function AgentThread({ thread, agents }: AgentThreadProps) {
  const [expanded, setExpanded] = useState(false);

  const fromInfo = agents?.[thread.fromAgent];
  const toInfo = agents?.[thread.toAgent];
  const fromName = fromInfo?.displayName ?? thread.fromAgent;
  const toName = toInfo?.displayName ?? thread.toAgent;
  const isActive = thread.status === 'active';
  const isFailed = thread.status === 'failed';

  return (
    <div className={`border rounded-lg overflow-hidden transition-colors ${
      isActive ? 'border-accent-cyan/30 bg-accent-cyan/5' :
      isFailed ? 'border-red-500/30 bg-red-500/5' :
      'border-border/30 bg-surface-200/20'
    }`}>
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-200/30 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-gray-500 shrink-0" />
        )}

        {/* From agent icon */}
        <div className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: (fromInfo?.color ?? '#666') + '15' }}>
          <RoleIcon icon={fromInfo?.icon} color={fromInfo?.color} size={12} />
        </div>

        <span className="text-[11px] font-mono text-gray-400">{fromName}</span>
        <span className="text-[10px] text-gray-600">→</span>

        {/* To agent icon */}
        <div className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: (toInfo?.color ?? '#666') + '15' }}>
          <RoleIcon icon={toInfo?.icon} color={toInfo?.color} size={12} />
        </div>

        <span className="text-[11px] font-mono text-gray-400">{toName}</span>

        {/* Status indicator */}
        {isActive ? (
          <Loader2 className="w-3 h-3 text-accent-cyan animate-spin shrink-0" />
        ) : isFailed ? (
          <XCircle className="w-3 h-3 text-red-400 shrink-0" />
        ) : (
          <CheckCircle className="w-3 h-3 text-accent-green/70 shrink-0" />
        )}

        {/* Summary or task preview */}
        <span className="text-[11px] text-gray-500 truncate flex-1 font-body">
          {thread.summary ?? thread.task.slice(0, 100)}
        </span>

        {/* Duration */}
        {thread.durationMs != null && thread.durationMs > 0 && (
          <span className="text-[10px] text-gray-600 font-mono flex items-center gap-0.5 shrink-0">
            <Clock className="w-2.5 h-2.5" />
            {(thread.durationMs / 1000).toFixed(1)}s
          </span>
        )}

        {/* Cost */}
        {thread.costUsd != null && thread.costUsd > 0 && (
          <span className="text-[10px] text-gray-600 font-mono shrink-0">${thread.costUsd.toFixed(3)}</span>
        )}
      </button>

      {/* Expanded view */}
      {expanded && (
        <div className="border-t border-border/20 px-3 py-2 space-y-2 bg-surface-50/30">
          {/* Task */}
          <div className="text-[11px] text-gray-500 font-body">
            <span className="text-[10px] font-label uppercase tracking-wider text-gray-600">Task: </span>
            {thread.task}
          </div>

          {/* Messages */}
          {thread.messages && thread.messages.length > 0 && (
            <div className="space-y-1.5">
              {thread.messages.map((msg, i) => {
                const agentInfo = agents?.[msg.agent];
                return (
                  <div key={i} className="flex gap-2">
                    <div className="w-4 h-4 rounded flex items-center justify-center shrink-0 mt-0.5" style={{ backgroundColor: (agentInfo?.color ?? '#666') + '15' }}>
                      <RoleIcon icon={agentInfo?.icon} color={agentInfo?.color} size={10} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="text-[10px] font-mono text-gray-500">{agentInfo?.displayName ?? msg.agent}</span>
                      <div className="text-[11px] text-gray-400 font-body mt-0.5 whitespace-pre-wrap">
                        {msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
                      </div>
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {msg.toolCalls.map((tc, j) => (
                            <span key={j} className="inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 bg-surface-200/50 rounded text-gray-500 border border-border/20">
                              <Wrench className="w-2.5 h-2.5" />
                              {tc.tool}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Response (if no messages) */}
          {(!thread.messages || thread.messages.length === 0) && thread.response && (
            <div className="text-[11px] text-gray-400 font-body whitespace-pre-wrap">
              {thread.response.length > 800 ? thread.response.slice(0, 800) + '...' : thread.response}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
