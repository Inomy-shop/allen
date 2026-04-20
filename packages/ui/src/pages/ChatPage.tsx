import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useChat } from '../hooks/useChat';
import ChatInput from '../components/chat/ChatInput';
import ChatMessageList from '../components/chat/ChatMessageList';
import CommandPalette from '../components/chat/CommandPalette';
import ConversationLogs from '../components/chat/ConversationLogs';
import { ToolCallLog } from '../components/common/ToolCallLog';
import { CHAT_TITLE, CHAT_EMPTY_PROMPT } from '../lib/brand';
import {
  MessageSquare, Command, Server, ScrollText, Users,
  Sparkles, Zap, BarChart3, Terminal, FolderOpen, AlertTriangle, Bot, Wrench,
} from 'lucide-react';
import { chat as chatApi, mcp as mcpApi, learnings as learningsApi, agents as agentsApi } from '../services/api';

const PROVIDER_DISPLAY: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'text-accent-green' },
  'claude-cli': { label: 'Claude CLI', color: 'text-accent-blue' },
};

export default function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [toolLogOpen, setToolLogOpen] = useState(false);
  const [mcpCount, setMcpCount] = useState<{ enabled: number; connected: number }>({ enabled: 0, connected: 0 });
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('codex');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [teamAgents, setTeamAgents] = useState<any[]>([]);
  const [allAgents, setAllAgents] = useState<any[]>([]);
  // Pending override state for chats that don't have a session yet. Once the
  // first message creates the session, this is merged into createSession().
  const [pendingOverrides, setPendingOverrides] = useState<{
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
    planMode?: boolean | null;
  }>({});
  const chatInputRef = useRef<{ setValue: (v: string) => void; focus: () => void } | null>(null);

  const {
    sessions, activeSessionId, messages, streaming, streamText,
    thinkingText, activeToolCalls, agentThreads, agentReports, threadsByMessage,
    spawnedAgents, pendingUserQuestion, answerUserQuestion,
    loadingSessions, loadingMessages,
    sendMessage, createSession, switchSession, cancelStream,
  } = useChat();

  useEffect(() => {
    chatApi.providers().then(p => {
      setProviders(p);
      if (p.length > 0) { setSelectedProvider(p[0].provider); setSelectedModel(p[0].defaultModel); }
    }).catch(() => {});
    mcpApi.list().then(servers => {
      setMcpCount({ enabled: servers.filter((s: any) => s.enabled).length, connected: servers.filter((s: any) => s.status === 'connected').length });
    }).catch(() => {});
    agentsApi.list().then(all => {
      setAllAgents(all);
      setTeamAgents(all.filter((a: any) => a.type === 'team'));
    }).catch(() => {});
  }, []);

  const activeSession = sessions.find(s => s._id === activeSessionId);
  const activeProvider = activeSession?.provider ?? selectedProvider;

  // Reset pending overrides whenever the user switches to a different
  // conversation — they only apply to a new chat that hasn't been created yet.
  useEffect(() => {
    setPendingOverrides({});
  }, [activeSessionId]);

  // The agent doc whose defaults we display as the fallback in the popover.
  const selectedAgentDoc = selectedAgent
    ? allAgents.find((a) => a.name === selectedAgent) ?? null
    : null;

  // Effective overrides: session-persisted if session exists, else in-memory pending.
  const effectiveOverrides = activeSession?.agentOverrides ?? pendingOverrides;

  // Called from ChatInput when the user changes effort or plan mode.
  // Before a session exists, mutate local state. After, PATCH the session doc.
  async function handleOverridesChange(next: {
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
    planMode?: boolean | null;
  }) {
    if (activeSessionId) {
      try {
        await chatApi.updateSession(activeSessionId, { agentOverrides: next });
        setPendingOverrides(next);
      } catch (err) {
        console.error('updateSession failed:', err);
      }
    } else {
      setPendingOverrides(next);
    }
  }

  // Restore agent selector from session when switching conversations or on page load
  useEffect(() => {
    if (activeSession?.activeAgent) {
      setSelectedAgent(activeSession.activeAgent);
    } else if (activeSessionId && activeSession) {
      setSelectedAgent(null);
    }
  }, [activeSessionId, activeSession?.activeAgent]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdPaletteOpen(prev => !prev); } };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Sync URL ↔ activeSessionId (single effect to avoid race conditions)
  useEffect(() => {
    if (urlSessionId && urlSessionId !== activeSessionId) {
      // URL has a session ID that's different from active — load it
      switchSession(urlSessionId);
    } else if (!urlSessionId && activeSessionId) {
      // URL cleared (new chat button) — clear active session
      switchSession('');
    }
  }, [urlSessionId]);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== urlSessionId) {
      // Active session changed (e.g., after creating a new session) — update URL
      navigate(`/chat/${activeSessionId}`, { replace: true });
    }
  }, [activeSessionId]);

  // Deep-link support: ?agent=NAME&prompt=PREFILL
  // We preselect the agent and prefill the input, then strip the query params
  // so a refresh doesn't re-apply them. The user must click Send themselves
  // — no auto-submit, so they can review/edit the proposed prompt first.
  useEffect(() => {
    const wantedAgent = searchParams.get('agent');
    const wantedPrompt = searchParams.get('prompt');
    if (!wantedAgent && !wantedPrompt) return;

    if (wantedAgent) setSelectedAgent(wantedAgent);
    if (wantedPrompt) {
      // setValue is exposed by ChatInput's forwardRef. Defer to next tick so
      // the input is mounted.
      setTimeout(() => chatInputRef.current?.setValue(wantedPrompt), 0);
    }

    // Strip the params so refresh doesn't re-trigger this effect
    const next = new URLSearchParams(searchParams);
    next.delete('agent');
    next.delete('prompt');
    setSearchParams(next, { replace: true });
  }, [searchParams]);

  async function handleSend(content: string) {
    if (!activeSessionId) {
      // Only pass pending overrides that are explicitly set (not null/undefined).
      const overrides: Record<string, unknown> = {};
      if (pendingOverrides.reasoningEffort != null) overrides.reasoningEffort = pendingOverrides.reasoningEffort;
      if (pendingOverrides.planMode != null) overrides.planMode = pendingOverrides.planMode;
      const session = await createSession(
        selectedProvider,
        selectedModel || undefined,
        Object.keys(overrides).length > 0 ? overrides : undefined,
      );
      navigate(`/chat/${session._id}`, { replace: true });
      sendMessage(content, session._id, selectedAgent ?? undefined);
      return;
    }
    sendMessage(content, undefined, selectedAgent ?? undefined);
  }

  function handleSuggestionClick(prompt: string) { handleSend(prompt); }
  function handleCommandSelect(prompt: string, partial?: boolean) {
    if (partial) { chatInputRef.current?.setValue(prompt); chatInputRef.current?.focus(); }
    else handleSend(prompt);
    setCmdPaletteOpen(false);
  }

  async function handleSaveToLearnings(content: string) {
    try {
      await learningsApi.create({
        content: content.slice(0, 1000), type: 'fact', target: 'agent', tags: ['chat', 'saved'],
        scope: { level: 'global' },
        source: { sourceType: 'manual', workflowName: 'chat', nodeName: 'chat', executionId: activeSessionId ?? '', timestamp: new Date() },
        confidence: 0.8, status: 'active',
      });
    } catch {}
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border/50 flex items-center justify-between bg-surface-50/50 shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-accent-blue" />
          <span className="font-heading text-sm font-bold text-theme-primary tracking-wider">
            {activeSessionId ? activeSession?.title ?? 'Chat' : CHAT_TITLE}
          </span>
          {activeSessionId && activeProvider && (
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-200/40 ${PROVIDER_DISPLAY[activeProvider]?.color ?? 'text-theme-muted'}`}>
              {PROVIDER_DISPLAY[activeProvider]?.label}
            </span>
          )}
          {selectedAgent && (() => {
            const agentInfo = teamAgents.find((a: any) => a.name === selectedAgent);
            return (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">
                @{agentInfo?.displayName ?? selectedAgent}
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-2">
          {mcpCount.enabled > 0 && (
            <span className="text-[10px] font-mono flex items-center gap-1 text-theme-subtle" title={`${mcpCount.connected}/${mcpCount.enabled} MCP`}>
              <Server className="w-3 h-3" />
              <span className={mcpCount.connected > 0 ? 'text-accent-green' : ''}>{mcpCount.connected}/{mcpCount.enabled}</span>
            </span>
          )}
          {activeSessionId && activeSession?.totalCostUsd != null && (
            <span className="text-[10px] text-theme-subtle font-mono">${activeSession.totalCostUsd.toFixed(2)}</span>
          )}
          {activeSessionId && (
            <button onClick={() => setLogsOpen(true)} className="p-1.5 rounded-md bg-surface-200/30 hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-all" title="Logs">
              <ScrollText className="w-3.5 h-3.5" />
            </button>
          )}
          {activeSessionId && (
            <button onClick={() => setToolLogOpen(o => !o)} className="p-1.5 rounded-md bg-surface-200/30 hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-all" title="Tool Log">
              <Wrench className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => setCmdPaletteOpen(true)} className="p-1.5 rounded-md bg-surface-200/30 hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-all" title="Commands">
            <Command className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      {loadingMessages && messages.length === 0 && !streaming ? (
        <div className="flex-1 flex items-center justify-center"><div className="text-xs text-theme-subtle animate-pulse">Loading...</div></div>
      ) : messages.length === 0 && !activeSessionId && !streaming ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          {/* Sparkle icon in rounded square */}
          <div className="w-16 h-16 rounded-xl bg-surface-100 border border-border/40 flex items-center justify-center mb-6">
            <Sparkles className="w-7 h-7 text-accent-blue" strokeWidth={1.5} />
          </div>

          {/* Headline */}
          <h2 className="font-heading text-xl text-theme-primary tracking-wide mb-2">
            {CHAT_EMPTY_PROMPT}
          </h2>
          <p className="text-sm text-theme-muted font-body mb-10">
            Use <span className="text-accent-blue font-mono">@mentions</span> to reference workflows, repos, and agents.
          </p>

          {/* Quick-action grid (2 columns × 3 rows) */}
          <div className="grid grid-cols-2 gap-3 w-full max-w-lg">
            {[
              { icon: Zap, color: 'text-accent-blue', label: 'List workflows', prompt: 'List all workflows' },
              { icon: BarChart3, color: 'text-accent-green', label: 'Dashboard stats', prompt: 'Show me the dashboard stats' },
              { icon: Terminal, color: 'text-accent-cyan', label: 'Recent executions', prompt: 'Show me recent executions' },
              { icon: FolderOpen, color: 'text-accent-yellow', label: 'List repos', prompt: 'List all registered repos' },
              { icon: AlertTriangle, color: 'text-accent-red', label: 'Failed today', prompt: 'Show me executions that failed today' },
              { icon: Bot, color: 'text-accent-purple', label: 'Available agents', prompt: 'List all available agents' },
            ].map(({ icon: Icon, color, label, prompt }) => (
              <button
                key={label}
                onClick={() => handleSuggestionClick(prompt)}
                className="flex items-center gap-3 px-4 py-3 rounded-md border border-border/40 bg-surface-50/40 hover:bg-surface-100/60 hover:border-border/70 transition-all text-left group"
              >
                <Icon className={`w-4 h-4 ${color} shrink-0`} strokeWidth={1.5} />
                <span className="text-sm text-theme-secondary font-body group-hover:text-theme-primary transition-colors">
                  {label}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ChatMessageList messages={messages} streamText={streamText} thinkingText={thinkingText} streaming={streaming} activeToolCalls={activeToolCalls} agentThreads={agentThreads} agentReports={agentReports} threadsByMessage={threadsByMessage} spawnedAgents={spawnedAgents} pendingUserQuestion={pendingUserQuestion} onAnswerUserQuestion={answerUserQuestion} activeAgent={activeSession?.activeAgent} onSuggestionClick={handleSuggestionClick} onSaveToLearnings={handleSaveToLearnings} />
      )}

      {/* Agent selector + Input */}
      <div>
        {teamAgents.length > 0 && (() => {
          // Agent is locked once the conversation has messages
          const agentLocked = !!activeSession?.activeAgent && (activeSession?.messageCount ?? 0) > 0;
          return (
            <div className="px-3 pt-2 flex items-center gap-1.5 border-t border-border/30">
              <Users className="w-3 h-3 text-theme-subtle" />
              <button
                onClick={() => !agentLocked && setSelectedAgent(null)}
                disabled={agentLocked}
                className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
                  !selectedAgent ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/20' : agentLocked ? 'text-theme-subtle cursor-not-allowed' : 'text-theme-subtle hover:text-theme-secondary'
                }`}
              >
                Assistant
              </button>
              {teamAgents.map((a: any) => (
                <button
                  key={a.name}
                  onClick={() => !agentLocked && setSelectedAgent(selectedAgent === a.name ? null : a.name)}
                  disabled={agentLocked}
                  title={agentLocked ? `Agent locked for this conversation` : (a.displayName ?? a.name)}
                  className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
                    selectedAgent === a.name
                      ? 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20'
                      : agentLocked ? 'text-theme-subtle cursor-not-allowed' : 'text-theme-subtle hover:text-theme-secondary'
                  }`}
                >
                  {a.displayName ?? a.name}
                </button>
              ))}
              {agentLocked && <span className="text-[9px] text-theme-subtle font-mono ml-1">locked</span>}
            </div>
          );
        })()}
        <ChatInput
          ref={chatInputRef} onSend={handleSend} onCancel={cancelStream} streaming={streaming}
          disabled={activeSession?.source === 'slack'}
          disabledReason={activeSession?.source === 'slack' ? 'This conversation is managed via Slack. Reply in the Slack thread to continue.' : undefined}
          providers={providers}
          selectedProvider={activeSession?.provider ?? selectedProvider}
          selectedModel={activeSession?.model ?? selectedModel}
          modelLocked={!!activeSessionId}
          onProviderChange={(p, m) => { setSelectedProvider(p); setSelectedModel(m); }}
          agentOverrides={effectiveOverrides}
          // When no team agent is selected, the chat talks to the raw
          // assistant. Its default effort is 'medium' — see chat.service.ts
          // for the matching server-side fallback.
          inheritedEffort={selectedAgentDoc?.reasoningEffort ?? 'medium'}
          inheritedPlanMode={selectedAgentDoc?.planMode ?? null}
          onAgentOverridesChanged={handleOverridesChange}
        />
      </div>

      <CommandPalette open={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} onSelect={handleCommandSelect} />
      {logsOpen && activeSessionId && <ConversationLogs sessionId={activeSessionId} onClose={() => setLogsOpen(false)} />}
      {toolLogOpen && activeSessionId && (
        <div className="fixed inset-y-0 right-0 w-full max-w-xl border-l border-border/40 bg-surface-50 shadow-2xl flex flex-col z-40">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/20">
            <span className="text-xs font-label uppercase tracking-widest text-theme-secondary">Tool Log</span>
            <button onClick={() => setToolLogOpen(false)} className="text-[11px] text-theme-muted hover:text-theme-secondary">Close</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <ToolCallLog
              calls={messages.flatMap(m => (m.toolCalls as any[]) ?? [])}
              emptyText="No tool calls yet in this conversation."
            />
          </div>
        </div>
      )}
    </div>
  );
}
