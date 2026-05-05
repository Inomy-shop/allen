import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useChat } from '../hooks/useChat';
import ChatInput, { type ReasoningEffortValue, type RepoOption } from '../components/chat/ChatInput';
import ChatMessageList from '../components/chat/ChatMessageList';
import CommandPalette from '../components/chat/CommandPalette';
import ConversationLogs from '../components/chat/ConversationLogs';
import AgentChatDropdown from '../components/chat/AgentChatDropdown';
import ChatRunSidebar from '../components/chat/ChatRunSidebar';
import { ToolCallLog } from '../components/common/ToolCallLog';
import { CHAT_TITLE, CHAT_EMPTY_PROMPT } from '../lib/brand';
import {
  Command, Server, ScrollText,
  Sparkles, Zap, BarChart3, Terminal, FolderOpen, AlertTriangle, Bot, Wrench,
  FileText,
} from 'lucide-react';
import { chat as chatApi, mcp as mcpApi, learnings as learningsApi, agents as agentsApi, repos as reposApi } from '../services/api';
import ArtifactsDrawer from '../components/artifacts/ArtifactsDrawer';

const PROVIDER_DISPLAY: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'text-accent-green' },
  'claude-cli': { label: 'Claude CLI', color: 'text-accent' },
};

export default function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [toolLogOpen, setToolLogOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [mcpCount, setMcpCount] = useState<{ enabled: number; connected: number }>({ enabled: 0, connected: 0 });
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('codex');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedAgentCwd, setSelectedAgentCwd] = useState<string | null>(null);
  const [allAgents, setAllAgents] = useState<any[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  // Pending override state for chats that don't have a session yet. Once the
  // first message creates the session, this is merged into createSession().
  const [pendingOverrides, setPendingOverrides] = useState<{
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
    planMode?: boolean | null;
  }>({});
  const chatInputRef = useRef<{ setValue: (v: string) => void; focus: () => void } | null>(null);
  const processedDeepLinkRef = useRef<string | null>(null);

  const {
    sessions, activeSessionId, messages, streaming, streamText,
    thinkingText, activeToolCalls, agentThreads, agentReports, threadsByMessage,
    spawnedAgents, pendingUserQuestion, answerUserQuestion, answerWorkflowIntervention,
    loadingSessions, loadingMessages,
    sendMessage, createSession, switchSession, cancelStream,
    updateSessionTitle, refresh: refreshSessions,
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
      setAgentsLoading(false);
    }).catch(() => { setAgentsLoading(false); });
  }, []);

  useEffect(() => {
    reposApi.list()
      .then((list: RepoOption[]) => setRepos(list ?? []))
      .catch(() => {});
  }, []);

  const activeSession = sessions.find(s => s._id === activeSessionId);
  const activeProvider = activeSession?.provider ?? selectedProvider;

  // Reset pending overrides and repo selection whenever the user switches to a
  // different conversation — they only apply to a new chat that hasn't been
  // created yet.
  useEffect(() => {
    setPendingOverrides({});
    setSelectedRepo(null);
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
      setSelectedAgentCwd(null);
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

  async function handleSend(
    content: string,
    agentOverride?: string | null,
    cwdOverride?: string | null,
    options?: {
      provider?: string | null;
      model?: string | null;
      repoId?: string | null;
      agentOverrides?: {
        reasoningEffort?: ReasoningEffortValue | null;
        planMode?: boolean | null;
      };
    },
  ) {
    const agentName = agentOverride ?? selectedAgent;
    const agentCwd = cwdOverride ?? selectedAgentCwd;
    if (!activeSessionId) {
      // Only pass pending overrides that are explicitly set (not null/undefined).
      const overrides: Record<string, unknown> = {};
      const effectivePendingOverrides = options?.agentOverrides ?? pendingOverrides;
      if (effectivePendingOverrides.reasoningEffort != null) overrides.reasoningEffort = effectivePendingOverrides.reasoningEffort;
      if (effectivePendingOverrides.planMode != null) overrides.planMode = effectivePendingOverrides.planMode;
      const session = await createSession(
        options?.provider ?? selectedProvider,
        (options?.model ?? selectedModel) || undefined,
        Object.keys(overrides).length > 0 ? overrides : undefined,
        (options?.repoId ?? selectedRepo?._id) || undefined,
      );
      navigate(`/chat/${session._id}`, { replace: true });
      sendMessage(content, session._id, agentName ?? undefined, agentCwd ?? undefined);
      // Server auto-summarizes the title from the first message; pull
      // a fresh sessions list shortly after so the sidebar shows the
      // summarized title instead of the placeholder.
      setTimeout(() => { void refreshSessions(); }, 1500);
      setTimeout(() => { void refreshSessions(); }, 5000);
      return;
    }
    sendMessage(content, undefined, agentName ?? undefined, agentCwd ?? undefined);
  }

  // Deep-link support: ?agent=NAME&prompt=PREFILL. Command-center sends use
  // autosend=1 so the user lands in the focused current chat, not a prior
  // conversation picker.
  useEffect(() => {
    const wantedAgent = searchParams.get('agent');
    const wantedAgentCwd = searchParams.get('agentCwd');
    const wantedPrompt = searchParams.get('prompt');
    const autoSend = searchParams.get('autosend') === '1';
    const wantedProvider = searchParams.get('provider');
    const wantedModel = searchParams.get('model');
    const wantedRepoId = searchParams.get('repoId');
    const wantedReasoning = searchParams.get('reasoningEffort') as ReasoningEffortValue | null;
    const wantedPlanMode = searchParams.get('planMode');
    const hasRepoSelection = wantedRepoId ? repos.some((repo) => repo._id === wantedRepoId) : true;
    const signature = [
      wantedAgent ?? '',
      wantedAgentCwd ?? '',
      wantedPrompt ?? '',
      wantedProvider ?? '',
      wantedModel ?? '',
      wantedRepoId ?? '',
      wantedReasoning ?? '',
      wantedPlanMode ?? '',
      autoSend ? 'send' : 'prefill',
    ].join(':');
    if ((!wantedAgent && !wantedPrompt) || processedDeepLinkRef.current === signature) return;
    if (wantedRepoId && repos.length === 0) return;
    processedDeepLinkRef.current = signature;

    if (wantedAgent) setSelectedAgent(wantedAgent);
    if (wantedAgentCwd) setSelectedAgentCwd(wantedAgentCwd);
    if (wantedProvider) setSelectedProvider(wantedProvider);
    if (wantedModel) setSelectedModel(wantedModel);
    if (wantedRepoId) setSelectedRepo(repos.find((repo) => repo._id === wantedRepoId) ?? null);
    const nextOverrides = {
      ...(wantedReasoning ? { reasoningEffort: wantedReasoning } : {}),
      ...(wantedPlanMode != null ? { planMode: wantedPlanMode === 'true' } : {}),
    };
    if (Object.keys(nextOverrides).length > 0) setPendingOverrides(nextOverrides);

    const next = new URLSearchParams(searchParams);
    next.delete('agent');
    next.delete('agentCwd');
    next.delete('prompt');
    next.delete('autosend');
    next.delete('provider');
    next.delete('model');
    next.delete('repoId');
    next.delete('reasoningEffort');
    next.delete('planMode');
    setSearchParams(next, { replace: true });

    if (!wantedPrompt) return;
    if (autoSend) {
      setTimeout(() => {
        void handleSend(wantedPrompt, wantedAgent, wantedAgentCwd, {
          provider: wantedProvider,
          model: wantedModel,
          repoId: hasRepoSelection ? wantedRepoId : null,
          agentOverrides: nextOverrides,
        });
      }, 0);
    } else {
      setTimeout(() => {
        chatInputRef.current?.setValue(wantedPrompt);
        chatInputRef.current?.focus();
      }, 0);
    }
  }, [searchParams, repos]);

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

  const sessionTitle = activeSessionId ? activeSession?.title ?? 'Chat' : CHAT_TITLE;
  const messageCount = activeSession?.messageCount ?? 0;

  // Inline title edit. Persists via useChat.updateSessionTitle which
  // does an optimistic local update so the sidebar reflects the new
  // title immediately. Only enabled when there's an active session.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [savingTitle, setSavingTitle] = useState(false);
  async function commitTitle() {
    const next = (titleDraft ?? '').trim();
    setTitleDraft(null);
    if (!activeSessionId || !next || next === sessionTitle) return;
    setSavingTitle(true);
    try {
      // Optimistic — sidebar updates immediately via setSessions.
      await updateSessionTitle(activeSessionId, next);
    } finally {
      setSavingTitle(false);
    }
  }

  return (
    <div className="flex-1 flex h-full min-w-0">
      <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header — matches handoff/pages/chat.jsx ChatV2 */}
      <div className="px-6 pt-4 pb-3 border-b border-app shrink-0">
        <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
          <span>Threads</span>
          {activeSessionId && (
            <>
              <span className="text-theme-subtle">/</span>
              <span className="truncate max-w-[40rem]">{sessionTitle}</span>
            </>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {activeSessionId && titleDraft !== null ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setTitleDraft(null);
                }}
                className="text-[20px] font-semibold text-theme-primary tracking-tight bg-transparent border border-app rounded px-2 py-0.5 focus:outline-none focus:border-accent w-[40rem] max-w-full"
                disabled={savingTitle}
              />
            ) : (
              <h1
                className={`text-[20px] font-semibold text-theme-primary tracking-tight truncate ${activeSessionId ? 'cursor-text hover:text-accent transition-colors' : ''}`}
                onClick={() => activeSessionId && setTitleDraft(sessionTitle)}
                title={activeSessionId ? 'Click to rename' : undefined}
              >
                {sessionTitle}
              </h1>
            )}
            {activeSessionId && activeProvider && (
              <span className={`badge badge-muted ${PROVIDER_DISPLAY[activeProvider]?.color ?? 'text-theme-muted'}`}>
                {PROVIDER_DISPLAY[activeProvider]?.label}
              </span>
            )}
            {selectedAgent && (() => {
              const agentInfo = allAgents.find((a: any) => a.name === selectedAgent);
              return (
                <span className="badge" style={{ background: 'rgb(var(--color-accent-soft))', color: 'rgb(var(--color-accent))' }}>
                  @{agentInfo?.displayName ?? selectedAgent}
                </span>
              );
            })()}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {mcpCount.enabled > 0 && (
              <span className="text-[11px] font-mono flex items-center gap-1 text-theme-muted" title={`${mcpCount.connected}/${mcpCount.enabled} MCP`}>
                <Server className="w-3 h-3" />
                <span className={mcpCount.connected > 0 ? 'text-accent-green' : ''}>{mcpCount.connected}/{mcpCount.enabled}</span>
              </span>
            )}
            {activeSessionId && (
              <span className="text-[11px] text-theme-muted font-mono">
                {activeSession?.totalCostUsd != null && <>${activeSession.totalCostUsd.toFixed(2)}</>}
                {activeSession?.totalCostUsd != null && messageCount > 0 && ' · '}
                {messageCount > 0 && <>{messageCount} message{messageCount === 1 ? '' : 's'}</>}
              </span>
            )}
            {activeSessionId && (
              <button onClick={() => setLogsOpen(true)} className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Logs">
                <ScrollText className="w-3.5 h-3.5" />
              </button>
            )}
            {activeSessionId && (
              <button onClick={() => setToolLogOpen(o => !o)} className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Tool Log">
                <Wrench className="w-3.5 h-3.5" />
              </button>
            )}
            {activeSessionId && (
              <button onClick={() => setArtifactsOpen(true)} className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Artifacts saved in this chat">
                <FileText className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => setCmdPaletteOpen(true)} className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-app-muted transition-colors" title="Commands">
              <Command className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Messages */}
      {loadingMessages && messages.length === 0 && !streaming ? (
        <div className="flex-1 flex items-center justify-center"><div className="text-xs text-theme-subtle animate-pulse">Loading...</div></div>
      ) : messages.length === 0 && !activeSessionId && !streaming ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          {/* Sparkle icon in rounded square */}
          <div className="w-14 h-14 rounded-xl bg-accent-soft flex items-center justify-center mb-5">
            <Sparkles className="w-6 h-6 text-accent" strokeWidth={1.5} />
          </div>

          {/* Headline */}
          <h2 className="text-[20px] font-semibold text-theme-primary tracking-tight mb-2">
            {CHAT_EMPTY_PROMPT}
          </h2>
          <p className="text-[13px] text-theme-muted font-body mb-8">
            Use <span className="text-accent font-mono">@mentions</span> to reference workflows, repos, and agents.
          </p>

          {/* Quick-action grid (2 columns × 3 rows) */}
          <div className="grid grid-cols-2 gap-2 w-full max-w-lg">
            {[
              { icon: Zap, label: 'List workflows', prompt: 'List all workflows' },
              { icon: BarChart3, label: 'Dashboard stats', prompt: 'Show me the dashboard stats' },
              { icon: Terminal, label: 'Recent executions', prompt: 'Show me recent executions' },
              { icon: FolderOpen, label: 'List repos', prompt: 'List all registered repos' },
              { icon: AlertTriangle, label: 'Failed today', prompt: 'Show me executions that failed today' },
              { icon: Bot, label: 'Available agents', prompt: 'List all available agents' },
            ].map(({ icon: Icon, label, prompt }) => (
              <button
                key={label}
                onClick={() => handleSuggestionClick(prompt)}
                className="card-hover flex items-center gap-2.5 px-3.5 py-2.5 text-left group cursor-pointer"
              >
                <Icon className="w-4 h-4 text-theme-muted group-hover:text-accent shrink-0 transition-colors" strokeWidth={1.5} />
                <span className="text-[13px] text-theme-secondary group-hover:text-theme-primary transition-colors">
                  {label}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ChatMessageList messages={messages} streamText={streamText} thinkingText={thinkingText} streaming={streaming} activeToolCalls={activeToolCalls} agentThreads={agentThreads} agentReports={agentReports} threadsByMessage={threadsByMessage} spawnedAgents={spawnedAgents} pendingUserQuestion={pendingUserQuestion} onAnswerUserQuestion={answerUserQuestion} onAnswerWorkflowIntervention={answerWorkflowIntervention} activeAgent={activeSession?.activeAgent} onSuggestionClick={handleSuggestionClick} onSaveToLearnings={handleSaveToLearnings} />
      )}

      {/* Input */}
      <div>
        <ChatInput
          ref={chatInputRef} onSend={handleSend} onCancel={cancelStream} streaming={streaming}
          disabled={activeSession?.source === 'slack'}
          disabledReason={activeSession?.source === 'slack' ? 'This conversation is managed via Slack. Reply in the Slack thread to continue.' : undefined}
          providers={providers}
          selectedProvider={activeSession?.provider ?? selectedProvider}
          selectedModel={activeSession?.model ?? selectedModel}
          modelLocked={!!activeSessionId}
          onProviderChange={(p, m) => { setSelectedProvider(p); setSelectedModel(m); }}
          repos={repos}
          selectedRepoName={activeSession?.repoName ?? selectedRepo?.name ?? null}
          repoLocked={!!activeSessionId}
          onRepoChange={(repo: RepoOption | null) => {
            if (!activeSessionId) setSelectedRepo(repo);
          }}
          agentOverrides={effectiveOverrides}
          // When no team agent is selected, the chat talks to the raw
          // assistant. Codex defaults to 'high', other providers to 'medium' —
          // see chat.service.ts for the matching server-side fallback.
          inheritedEffort={selectedAgentDoc?.reasoningEffort ?? (activeProvider === 'codex' ? 'high' : 'medium')}
          inheritedPlanMode={selectedAgentDoc?.planMode ?? null}
          onAgentOverridesChanged={handleOverridesChange}
          extraControls={(() => {
            const agentLocked = !!activeSession?.activeAgent && (activeSession?.messageCount ?? 0) > 0;
            return (
              <AgentChatDropdown
                value={selectedAgent}
                onChange={(name, cwd) => {
                  setSelectedAgent(name);
                  setSelectedAgentCwd(cwd);
                }}
                agents={allAgents}
                disabled={agentLocked || activeSession?.source === 'slack'}
                loading={agentsLoading}
                variant="composer"
              />
            );
          })()}
        />
      </div>

      <CommandPalette open={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} onSelect={handleCommandSelect} />
      {activeSessionId && (
        <ArtifactsDrawer
          rootType="chat"
          rootId={activeSessionId}
          open={artifactsOpen}
          onClose={() => setArtifactsOpen(false)}
        />
      )}
      {logsOpen && activeSessionId && <ConversationLogs sessionId={activeSessionId} onClose={() => setLogsOpen(false)} />}
      {toolLogOpen && activeSessionId && (
        <div className="fixed inset-y-0 right-0 w-full max-w-xl border-l border-app bg-app-card shadow-popover flex flex-col z-40">
          <div className="flex items-center justify-between px-4 py-3 border-b border-app">
            <span className="text-[14px] font-medium text-theme-primary">Tool Log</span>
            <button onClick={() => setToolLogOpen(false)} className="text-[12px] text-theme-muted hover:text-theme-primary">Close</button>
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
      {spawnedAgents.length > 0 && <ChatRunSidebar runs={spawnedAgents} />}
    </div>
  );
}
