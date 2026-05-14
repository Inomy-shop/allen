import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useChat } from '../hooks/useChat';
import ChatInput, { type ReasoningEffortValue, type RepoOption, type SlashCommandOption } from '../components/chat/ChatInput';
import ChatMessageList from '../components/chat/ChatMessageList';
import CommandPalette from '../components/chat/CommandPalette';
import ConversationLogs from '../components/chat/ConversationLogs';
import AgentChatDropdown from '../components/chat/AgentChatDropdown';
import ChatRunSidebar from '../components/chat/ChatRunSidebar';
import { ToolCallLog } from '../components/common/ToolCallLog';
import { chat as chatApi, mcp as mcpApi, learnings as learningsApi, agents as agentsApi, repos as reposApi } from '../services/api';
import ArtifactsDrawer from '../components/artifacts/ArtifactsDrawer';

type QueuedChatMessage = {
  id: string;
  content: string;
  agent?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
  options?: {
    provider?: string | null;
    model?: string | null;
    repoId?: string | null;
    agentOverrides?: {
      reasoningEffort?: ReasoningEffortValue | null;
      planMode?: boolean | null;
    };
  };
};

export default function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [cmdPaletteAnchor, setCmdPaletteAnchor] = useState<DOMRect | null>(null);
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
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [editingQueuedValue, setEditingQueuedValue] = useState('');
  // Pending override state for chats that don't have a session yet. Once the
  // first message creates the session, this is merged into createSession().
  const [pendingOverrides, setPendingOverrides] = useState<{
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
    planMode?: boolean | null;
  }>({});
  const chatInputRef = useRef<{ setValue: (v: string) => void; focus: () => void } | null>(null);
  const processedDeepLinkRef = useRef<string | null>(null);
  const queuedMessagesRef = useRef<QueuedChatMessage[]>([]);
  const editingQueuedIdRef = useRef<string | null>(null);
  const queueDispatchingRef = useRef(false);

  const {
    sessions, activeSessionId, messages, streaming, streamText,
    thinkingText, activeToolCalls, agentThreads, agentReports, threadsByMessage,
    spawnedAgents, pendingUserQuestion, answerUserQuestion, answerWorkflowIntervention,
    loadingMessages,
    sendMessage, createSession, switchSession, cancelStream,
    refresh: refreshSessions,
  } = useChat();

  const activeSession = sessions.find(s => s._id === activeSessionId);
  const activeProvider = activeSession?.provider ?? selectedProvider;

  useEffect(() => { queuedMessagesRef.current = queuedMessages; }, [queuedMessages]);
  useEffect(() => { editingQueuedIdRef.current = editingQueuedId; }, [editingQueuedId]);

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

  useEffect(() => {
    const provider = activeSession?.provider ?? selectedProvider;
    const cwd = activeSession?.repoPath ?? selectedRepo?.path ?? undefined;
    chatApi.slashCommands({ provider, sessionId: activeSessionId ?? undefined, cwd })
      .then((commands: SlashCommandOption[]) => setSlashCommands(commands ?? []))
      .catch(() => setSlashCommands([]));
  }, [activeSessionId, activeSession?.provider, activeSession?.repoPath, selectedProvider, selectedRepo?.path]);

  // Reset pending overrides and repo selection whenever the user switches to a
  // different conversation — they only apply to a new chat that hasn't been
  // created yet.
  useEffect(() => {
    setPendingOverrides({});
    setSelectedRepo(null);
    setQueuedMessages([]);
    setEditingQueuedId(null);
    setEditingQueuedValue('');
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
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteAnchor(null);
        setCmdPaletteOpen(prev => !prev);
      }
    };
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

  function enqueueMessage(message: QueuedChatMessage): void {
    setQueuedMessages(prev => [...prev, message]);
  }

  async function sendNow(
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
    forcedSessionId?: string | null,
  ) {
    const agentName = agentOverride ?? selectedAgent;
    const agentCwd = cwdOverride ?? selectedAgentCwd;
    if (forcedSessionId) {
      return sendMessage(content, forcedSessionId, agentName ?? undefined, agentCwd ?? undefined);
    }
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
    return sendMessage(content, undefined, agentName ?? undefined, agentCwd ?? undefined);
  }

  async function handleSend(
    content: string,
    agentOverride?: string | null,
    cwdOverride?: string | null,
    options?: QueuedChatMessage['options'],
  ) {
    const shouldQueue = streaming || queuedMessagesRef.current.length > 0 || Boolean(editingQueuedIdRef.current);
    if (shouldQueue) {
      enqueueMessage({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        content,
        agent: agentOverride ?? selectedAgent,
        cwd: cwdOverride ?? selectedAgentCwd,
        sessionId: activeSessionId,
        options,
      });
      return;
    }
    await sendNow(content, agentOverride, cwdOverride, options);
  }

  useEffect(() => {
    if (streaming || editingQueuedId || queueDispatchingRef.current || queuedMessages.length === 0) return;
    const next = queuedMessages[0];
    queueDispatchingRef.current = true;
    setQueuedMessages(prev => prev.slice(1));
    void sendNow(next.content, next.agent, next.cwd, next.options, next.sessionId)
      .finally(() => {
        queueDispatchingRef.current = false;
        setQueuedMessages(prev => [...prev]);
      });
  }, [streaming, editingQueuedId, queuedMessages, activeSessionId, selectedAgent, selectedAgentCwd, selectedProvider, selectedModel, selectedRepo?._id, pendingOverrides]);

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
    setCmdPaletteAnchor(null);
  }

  function handleSlashCommand(command: SlashCommandOption, raw: string): boolean {
    if (command.name === '/clear') {
      switchSession('');
      navigate('/chat', { replace: true });
      return true;
    }
    if (command.name === '/help') {
      setCmdPaletteAnchor(null);
      setCmdPaletteOpen(true);
      return command.provider === 'codex';
    }
    if (!command.dispatchable) return true;
    return false;
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

  const showRunSidebar = spawnedAgents.length > 0;

  return (
    <div className={`chat-page-shell ${showRunSidebar ? 'with-run-sidebar' : ''}`}>
      <div className="chat-main-shell">
      {/* Messages */}
      {loadingMessages && messages.length === 0 && !streaming ? (
        <div className="flex-1 flex items-center justify-center"><div className="text-xs text-theme-subtle animate-pulse">Loading...</div></div>
      ) : messages.length === 0 && !activeSessionId && !streaming ? (
        <div className="chat-empty-stream" aria-label="New conversation" />
      ) : (
        <ChatMessageList messages={messages} streamText={streamText} thinkingText={thinkingText} streaming={streaming} activeToolCalls={activeToolCalls} agentThreads={agentThreads} agentReports={agentReports} threadsByMessage={threadsByMessage} spawnedAgents={spawnedAgents} pendingUserQuestion={pendingUserQuestion} onAnswerUserQuestion={answerUserQuestion} onAnswerWorkflowIntervention={answerWorkflowIntervention} activeAgent={activeSession?.activeAgent} onSuggestionClick={handleSuggestionClick} onSaveToLearnings={handleSaveToLearnings} />
      )}

      {/* Input */}
      <div className="chat-input-dock">
        {queuedMessages.length > 0 && (
          <div className="chat-queue-panel" aria-label="Queued messages">
            <div className="chat-queue-head">
              <span>{queuedMessages.length} queued</span>
              {editingQueuedId && <span>paused while editing</span>}
            </div>
            <div className="chat-queue-list">
              {queuedMessages.map((item, index) => {
                const editing = editingQueuedId === item.id;
                return (
                  <div key={item.id} className="chat-queue-item">
                    <div className="chat-queue-index">{index + 1}</div>
                    {editing ? (
                      <textarea
                        value={editingQueuedValue}
                        onChange={(event) => setEditingQueuedValue(event.target.value)}
                        className="chat-queue-edit"
                        rows={2}
                        autoFocus
                      />
                    ) : (
                      <div className="chat-queue-text">{item.content}</div>
                    )}
                    <div className="chat-queue-actions">
                      {editing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              const next = editingQueuedValue.trim();
                              if (next) {
                                setQueuedMessages(prev => prev.map(q => q.id === item.id ? { ...q, content: next } : q));
                              }
                              setEditingQueuedId(null);
                              setEditingQueuedValue('');
                            }}
                            title="Save queued message"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingQueuedId(null);
                              setEditingQueuedValue('');
                            }}
                            title="Cancel edit"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingQueuedId(item.id);
                              setEditingQueuedValue(item.content);
                            }}
                            title="Edit queued message"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setQueuedMessages(prev => prev.filter(q => q.id !== item.id))}
                            title="Remove queued message"
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
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
          onOpenQuickCommands={(anchor) => {
            setCmdPaletteAnchor(anchor.getBoundingClientRect());
            setCmdPaletteOpen(true);
          }}
          slashCommands={slashCommands}
          onSlashCommand={handleSlashCommand}
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

      <CommandPalette
        open={cmdPaletteOpen}
        anchorRect={cmdPaletteAnchor}
        onClose={() => {
          setCmdPaletteOpen(false);
          setCmdPaletteAnchor(null);
        }}
        onSelect={handleCommandSelect}
      />
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
      {showRunSidebar && <ChatRunSidebar runs={spawnedAgents} />}
    </div>
  );
}
