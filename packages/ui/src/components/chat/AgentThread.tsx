import { useState, useRef, useEffect } from 'react';
import {
  ChevronRight, ChevronDown, Loader2, CheckCircle, XCircle, Wrench,
  Clock, Maximize2, AlertCircle, Brain, Copy, Check,
  HelpCircle, MessageSquare,
} from 'lucide-react';
import RoleIcon from '../common/RoleIcon';
import ThreadDetailPanel from './ThreadDetailPanel';
import { renderMarkdown } from './ChatMessageList';

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
  status: 'active' | 'waiting_for_answer' | 'completed' | 'failed';
  summary?: string;
  response?: string;
  messages?: { agent: string; type?: string; content: string; toolCalls?: { tool: string; args?: Record<string, unknown>; result?: Record<string, unknown>; durationMs?: number }[]; timestamp: string }[];
  costUsd?: number;
  durationMs?: number;
  depth?: number;
  liveActivity?: ThreadActivityItem[];
  pendingQuestion?: { fromAgent: string; question: string };
  parentConversationId?: string;
  children?: AgentThreadData[];
}

interface AgentThreadProps {
  thread: AgentThreadData;
  agents?: Record<string, { displayName?: string; icon?: string; color?: string }>;
}

// ── Helpers ──

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-0.5 rounded hover:bg-app-muted text-theme-subtle hover:text-theme-secondary transition-colors" title="Copy">
      {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ── Tool Call (compact) ──

function ToolItem({ tc }: { tc: { tool: string; args?: Record<string, unknown>; result?: Record<string, unknown>; durationMs?: number } }) {
  const [open, setOpen] = useState(false);
  const short = tc.tool.replace('mcp__allen__', 'al:').replace('mcp__linear__', 'linear:').replace('mcp__postgres__', 'pg:');
  const isErr = tc.result && 'error' in tc.result;
  const hasDetail = (tc.args && Object.keys(tc.args).length > 0) || (tc.result && Object.keys(tc.result).length > 0);

  return (
    <div className="text-[11px] font-mono">
      <button onClick={() => hasDetail && setOpen(!open)} className={`flex items-center gap-1.5 ${hasDetail ? 'hover:text-theme-secondary cursor-pointer' : ''}`}>
        {isErr ? <AlertCircle className="w-2.5 h-2.5 text-accent-red shrink-0" /> : <CheckCircle className="w-2.5 h-2.5 text-accent-green/40 shrink-0" />}
        <span className="text-theme-muted">{short}</span>
        {tc.durationMs != null && <span className="text-theme-subtle">{tc.durationMs}ms</span>}
        {hasDetail && (open ? <ChevronDown className="w-2.5 h-2.5 text-theme-subtle" /> : <ChevronRight className="w-2.5 h-2.5 text-theme-subtle" />)}
      </button>
      {open && (
        <div className="ml-4 mt-1 border-l border-app pl-2 space-y-1">
          {tc.args && Object.keys(tc.args).length > 0 && (
            <div><div className="flex items-center gap-1 text-theme-subtle text-[9px] uppercase tracking-wider">Input <CopyBtn text={JSON.stringify(tc.args, null, 2)} /></div>
              <pre className="text-[10px] text-theme-muted whitespace-pre-wrap max-h-20 overflow-auto">{JSON.stringify(tc.args, null, 2)}</pre></div>
          )}
          {tc.result && Object.keys(tc.result).length > 0 && (
            <div><div className="flex items-center gap-1 text-theme-subtle text-[9px] uppercase tracking-wider">Output <CopyBtn text={JSON.stringify(tc.result, null, 2)} /></div>
              <pre className={`text-[10px] whitespace-pre-wrap max-h-24 overflow-auto ${isErr ? 'text-accent-red/80' : 'text-theme-muted'}`}>{JSON.stringify(tc.result, null, 2)}</pre></div>
          )}
        </div>
      )}
    </div>
  );
}

// Markdown rendering — reuses the same pipeline as the main chat

// ── Thread Message ──

function ThreadMsg({ msg, agentInfo, collapsed: initCollapsed }: {
  msg: { agent: string; type?: string; content: string; toolCalls?: { tool: string; args?: Record<string, unknown>; result?: Record<string, unknown>; durationMs?: number }[]; timestamp: string };
  agentInfo?: { displayName?: string; icon?: string; color?: string };
  collapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initCollapsed ?? false);
  const color = agentInfo?.color ?? '#6b7280';
  const name = agentInfo?.displayName ?? msg.agent;
  const isQ = msg.type === 'question';
  const isA = msg.type === 'answer';
  const isLong = msg.content.length > 300;

  return (
    <div className={`py-2 ${isQ ? 'pl-3 border-l-2 border-amber-400/50 bg-amber-400/[0.03] rounded-r' : isA ? 'pl-3 border-l-2 border-accent-green/50 bg-accent-green/[0.03] rounded-r' : ''}`}>
      {/* Agent name + toggle */}
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${
          isQ ? 'bg-amber-400/15 border border-amber-400/25' :
          isA ? 'bg-accent-green/15 border border-accent-green/25' : ''
        }`} style={!isQ && !isA ? { backgroundColor: color + '15', border: `1px solid ${color}25` } : {}}>
          {isQ ? <HelpCircle className="w-3 h-3 text-accent-yellow" />
            : isA ? <CheckCircle className="w-3 h-3 text-accent-green" />
            : <RoleIcon icon={agentInfo?.icon} color={color} size={12} />}
        </div>
        <span className="text-[12px] font-heading font-semibold tracking-wide" style={{ color: isQ ? '#f59e0b' : isA ? '#22c55e' : color }}>{name}</span>
        {isQ && <span className="text-[10px] font-mono text-accent-yellow/70 bg-accent-yellow/10 px-1.5 py-0.5 rounded">asking</span>}
        {isA && <span className="text-[10px] font-mono text-accent-green/70 bg-accent-green/10 px-1.5 py-0.5 rounded">answered</span>}
        {isLong && (
          <button onClick={() => setCollapsed(!collapsed)} className="p-0.5 rounded text-theme-subtle hover:text-theme-secondary hover:bg-app-muted/50 ml-auto transition-colors" title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* Content — same rendering as main chat */}
      {collapsed ? (
        <div className="text-[12px] text-theme-muted font-body pl-5">{msg.content.slice(0, 150).replace(/\n/g, ' ')}...</div>
      ) : (
        <div className="text-sm text-theme-secondary font-body leading-relaxed pl-5">
          {renderMarkdown(msg.content)}
        </div>
      )}

      {/* Tool calls */}
      {!collapsed && msg.toolCalls && msg.toolCalls.length > 0 && (
        <ToolsToggle tools={msg.toolCalls} />
      )}
    </div>
  );
}

// ── Collapsible Tools ──

function ToolsToggle({ tools }: { tools: { tool: string; args?: Record<string, unknown>; result?: Record<string, unknown>; durationMs?: number }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pl-5 mt-1">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[10px] font-mono text-theme-subtle hover:text-theme-secondary">
        {open ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
        <Wrench className="w-2.5 h-2.5" />
        <span>{tools.length} tool{tools.length !== 1 ? 's' : ''}</span>
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l border-border/10 space-y-0.5">
          {tools.map((tc, j) => <ToolItem key={j} tc={tc} />)}
        </div>
      )}
    </div>
  );
}

// ── Live Activity ──

function LiveFeed({ activity, agentName }: { activity: ThreadActivityItem[]; agentName: string }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [activity.length]);

  return (
    <div className="pl-5 py-1 space-y-0.5">
      {activity.slice(-12).map((act, i) => (
        <div key={i} className="flex items-center gap-1.5 text-[10px] font-mono animate-in fade-in duration-200">
          {act.type === 'thinking' && <><Brain className="w-2.5 h-2.5 text-accent-purple animate-pulse shrink-0" /><span className="text-accent-purple/60 truncate">{act.content?.slice(0, 80)}</span></>}
          {act.type === 'text' && <><span className="w-1 h-1 rounded-full bg-theme-muted shrink-0" /><span className="text-theme-muted truncate">{act.content?.slice(0, 100)}</span></>}
          {act.type === 'tool_call' && <><Loader2 className="w-2.5 h-2.5 text-accent-yellow animate-spin shrink-0" /><span className="text-accent-yellow/70">{act.tool?.replace('mcp__allen__', 'al:')}</span></>}
          {act.type === 'tool_result' && <><CheckCircle className="w-2.5 h-2.5 text-accent-green/40 shrink-0" /><span className="text-theme-subtle">{act.tool?.replace('mcp__allen__', 'al:')}</span></>}
        </div>
      ))}
      <div className="flex items-center gap-1.5 text-[10px] text-accent-cyan">
        <Loader2 className="w-2.5 h-2.5 animate-spin" /><span>{agentName} working...</span>
      </div>
      <div ref={bottomRef} />
    </div>
  );
}

// ── Main Component (Notion/Toggle Style) ──

export function AgentThread({ thread, agents }: AgentThreadProps) {
  const [expanded, setExpanded] = useState(thread.status === 'active' || thread.status === 'waiting_for_answer');
  const [detailOpen, setDetailOpen] = useState(false);

  const fromInfo = agents?.[thread.fromAgent];
  const toInfo = agents?.[thread.toAgent];
  const fromName = fromInfo?.displayName ?? thread.fromAgent;
  const toName = toInfo?.displayName ?? thread.toAgent;
  const fromColor = fromInfo?.color ?? '#6b7280';
  const toColor = toInfo?.color ?? '#6b7280';
  const isActive = thread.status === 'active' || thread.status === 'waiting_for_answer';
  const isWaiting = thread.status === 'waiting_for_answer';
  const isFailed = thread.status === 'failed';
  const msgCount = thread.messages?.length ?? 0;

  return (
    <div className="my-1.5">
      {/* Toggle header */}
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 py-1.5 px-2 -mx-2 text-left group/th hover:bg-app-muted/40 rounded-md transition-colors">
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-theme-muted shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-theme-muted shrink-0" />}

        {/* From agent avatar */}
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: fromColor + '20', border: `1px solid ${fromColor}35` }}>
          <RoleIcon icon={fromInfo?.icon} color={fromColor} size={14} />
        </div>
        <span className="text-[12px] font-heading font-semibold tracking-wide" style={{ color: fromColor }}>{fromName}</span>

        <span className="text-theme-subtle text-xs">→</span>

        {/* To agent avatar */}
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: toColor + '20', border: `1px solid ${toColor}35` }}>
          <RoleIcon icon={toInfo?.icon} color={toColor} size={14} />
        </div>
        <span className="text-[12px] font-heading font-semibold tracking-wide" style={{ color: toColor }}>{toName}</span>

        {/* Status badge */}
        {isWaiting ? <span className="flex items-center gap-1 text-[10px] font-mono text-accent-yellow bg-accent-yellow/10 px-1.5 py-0.5 rounded"><HelpCircle className="w-3 h-3" />asking</span>
          : isActive ? <span className="flex items-center gap-1 text-[10px] font-mono text-accent-cyan bg-accent-cyan/10 px-1.5 py-0.5 rounded"><Loader2 className="w-3 h-3 animate-spin" />working</span>
          : isFailed ? <span className="flex items-center gap-1 text-[10px] font-mono text-accent-red bg-accent-red/10 px-1.5 py-0.5 rounded"><XCircle className="w-3 h-3" />failed</span>
          : <span className="flex items-center gap-1 text-[10px] font-mono text-accent-green bg-accent-green/10 px-1.5 py-0.5 rounded"><CheckCircle className="w-3 h-3" />done</span>}

        <span className="flex-1" />

        {/* Stats — always visible */}
        <span className="text-[10px] text-theme-subtle font-mono flex items-center gap-2">
          {msgCount > 0 && <span>{msgCount} msg{msgCount !== 1 ? 's' : ''}</span>}
          {thread.durationMs != null && thread.durationMs > 0 && <span>{formatDuration(thread.durationMs)}</span>}
          {thread.costUsd != null && thread.costUsd > 0 && <span>${thread.costUsd.toFixed(2)}</span>}
        </span>

        {!isActive && (
          <button onClick={(e) => { e.stopPropagation(); setDetailOpen(true); }}
            className="p-1 rounded text-theme-subtle hover:text-accent-blue hover:bg-accent-blue/10 transition-all shrink-0" title="Open full view">
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}
      </button>

      {/* Expanded content — thread line on left */}
      {expanded && (
        <div className="ml-3 pl-3 pr-3 border-l-2 rounded-bl-md" style={{
          borderColor: isActive ? '#06b6d480' : isFailed ? '#ef444440' : (toColor + '30'),
          backgroundColor: isActive ? '#06b6d406' : isFailed ? '#ef444406' : (toColor + '06'),
        }}>
          {/* Messages */}
          {thread.messages && thread.messages.length > 0 && (
            <div>
              {thread.messages.map((msg, i) => (
                <ThreadMsg key={i} msg={msg} agentInfo={agents?.[msg.agent]}
                  collapsed={msg.content.length > 300 && i < thread.messages!.length - 1} />
              ))}
            </div>
          )}

          {/* Waiting for answer */}
          {isWaiting && thread.pendingQuestion && (
            <div className="py-1.5 pl-2 border-l-2 border-amber-400/40">
              <div className="flex items-center gap-1.5 mb-0.5">
                <HelpCircle className="w-3 h-3 text-accent-yellow shrink-0" />
                <span className="text-[11px] font-heading text-accent-yellow">{agents?.[thread.pendingQuestion.fromAgent]?.displayName ?? thread.pendingQuestion.fromAgent}</span>
                <span className="text-[10px] text-accent-yellow/60">waiting for answer</span>
              </div>
              <div className="text-[12px] text-theme-secondary font-body pl-5">{thread.pendingQuestion.question}</div>
            </div>
          )}

          {/* Live activity */}
          {isActive && !isWaiting && thread.liveActivity && thread.liveActivity.length > 0 && (
            <LiveFeed activity={thread.liveActivity} agentName={toName} />
          )}
          {isActive && !isWaiting && (!thread.liveActivity || thread.liveActivity.length === 0) && (
            <div className="flex items-center gap-1.5 py-1.5 pl-5 text-[10px] text-accent-cyan">
              <Loader2 className="w-2.5 h-2.5 animate-spin" /><span>{toName} working...</span>
            </div>
          )}

          {/* Nested child threads */}
          {thread.children && thread.children.length > 0 && (
            <div className="mt-1 space-y-1">
              {thread.children.map(child => (
                <AgentThread key={child.conversationId} thread={child} agents={agents} />
              ))}
            </div>
          )}
        </div>
      )}

      {detailOpen && <ThreadDetailPanel thread={thread} agents={agents ?? {}} onClose={() => setDetailOpen(false)} />}
    </div>
  );
}
