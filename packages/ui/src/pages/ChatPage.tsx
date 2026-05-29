import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useChat, type SpawnedAgent } from '../hooks/useChat';
import ChatInput, { type ReasoningEffortValue, type RepoOption, type SlashCommandOption } from '../components/chat/ChatInput';
import ChatMessageList from '../components/chat/ChatMessageList';
import CommandPalette from '../components/chat/CommandPalette';
import ConversationLogs from '../components/chat/ConversationLogs';
import AgentChatDropdown from '../components/chat/AgentChatDropdown';
import ChatRunSidebar, { type ChatRunPanelTab } from '../components/chat/ChatRunSidebar';
import { ToolCallLog } from '../components/common/ToolCallLog';
import { chat as chatApi, mcp as mcpApi, learnings as learningsApi, agents as agentsApi, repos as reposApi, type ChatQueueItem } from '../services/api';
import { chatCodeDiffs, pullRequests as pullRequestsApi, workspaces as workspacesApi } from '../services/workspaceService';
import { BookOpen, Code2, ExternalLink, FileText, GitPullRequest, ListTree, PanelRightOpen, X } from 'lucide-react';

type PendingSendOptions = {
  provider?: string | null;
  model?: string | null;
  repoId?: string | null;
  agentOverrides?: {
    reasoningEffort?: ReasoningEffortValue | null;
    planMode?: boolean | null;
  };
};

type ChatPullRequest = NonNullable<NonNullable<SpawnedAgent['runContext']>['pullRequest']>;

function humanLabel(value?: string | null): string {
  if (!value) return '';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return 'recently';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function collectPullRequests(runs: SpawnedAgent[]): ChatPullRequest[] {
  const prs = new Map<string, ChatPullRequest>();
  for (const run of runs) {
    const pr = run.runContext?.pullRequest;
    const key = pr?.id ?? pr?.url ?? (pr?.number != null ? String(pr.number) : '');
    if (pr && key) prs.set(key, pr);
  }
  return [...prs.values()].sort((a, b) => {
    const at = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
    const bt = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
    return bt - at;
  });
}

function FloatingPullRequestCard({ pullRequest }: { pullRequest: ChatPullRequest }) {
  const status = humanLabel(pullRequest.status ?? 'open');
  const age = timeAgo(pullRequest.mergedAt ?? pullRequest.updatedAt ?? pullRequest.createdAt);
  return (
    <aside className="chat-pr-float" aria-label="Pull request ready" title={pullRequest.title ?? 'Pull request ready'}>
      <div className="chat-pr-float-main">
        <span className="chat-pr-float-tag">
          <GitPullRequest className="h-3.5 w-3.5" />
          PR
        </span>
        <span className="chat-pr-float-title">#{pullRequest.number ?? ''} {status}</span>
        <span className="chat-pr-float-age">{age}</span>
        <div className="chat-pr-float-actions">
          {pullRequest.url && (
            <a href={pullRequest.url} target="_blank" rel="noopener noreferrer" title="Review on GitHub" aria-label="Review on GitHub">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <a href="/pull-requests" title="Open pull requests" aria-label="Open pull requests">
            <GitPullRequest className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </aside>
  );
}

function diffLineCounts(diff?: string): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  return diff.split('\n').reduce((acc, line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return acc;
    if (line.startsWith('+')) acc.additions += 1;
    else if (line.startsWith('-')) acc.deletions += 1;
    return acc;
  }, { additions: 0, deletions: 0 });
}

type DiffSummaryFile = {
  path?: string;
  diff?: string;
  modifiedContent?: string;
  additions?: number;
  deletions?: number;
};

function summarizeDiffFiles(files: DiffSummaryFile[]): { files: number; additions: number; deletions: number } {
  const byKey = new Map<string, { additions: number; deletions: number }>();
  for (const file of files) {
    if (!file.diff?.trim() && !file.modifiedContent?.trim()) continue;
    const counts = file.additions != null || file.deletions != null
      ? { additions: file.additions ?? 0, deletions: file.deletions ?? 0 }
      : diffLineCounts(file.diff);
    const key = file.path ?? file.diff?.trim() ?? file.modifiedContent?.trim() ?? `${byKey.size}`;
    byKey.set(key, counts);
  }
  return [...byKey.values()].reduce<{ files: number; additions: number; deletions: number }>((acc, item) => ({
    files: acc.files + 1,
    additions: acc.additions + item.additions,
    deletions: acc.deletions + item.deletions,
  }), { files: 0, additions: 0, deletions: 0 });
}

export default function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [cmdPaletteAnchor, setCmdPaletteAnchor] = useState<DOMRect | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [toolLogOpen, setToolLogOpen] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState<ChatRunPanelTab>('tasks');
  const [filesViewRequest, setFilesViewRequest] = useState<{ view: 'files' | 'changes'; nonce: number } | undefined>();
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
  const [queuedMessages, setQueuedMessages] = useState<ChatQueueItem[]>([]);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [editingQueuedValue, setEditingQueuedValue] = useState('');
  const [chatDiffSummary, setChatDiffSummary] = useState<{ files: number; additions: number; deletions: number } | null>(null);
  const [hiddenDiffSignature, setHiddenDiffSignature] = useState<string | null>(null);
  // Pending override state for chats that don't have a session yet. Once the
  // first message creates the session, this is merged into createSession().
  const [pendingOverrides, setPendingOverrides] = useState<{
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
    planMode?: boolean | null;
  }>({});
  const chatInputRef = useRef<{ setValue: (v: string) => void; focus: () => void } | null>(null);
  const processedDeepLinkRef = useRef<string | null>(null);
  const queuedMessagesRef = useRef<ChatQueueItem[]>([]);
  const editingQueuedIdRef = useRef<string | null>(null);
  const chatDiffSignatureRef = useRef('');

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
  const pullRequests = collectPullRequests(spawnedAgents);
  const floatingPullRequest = !sidePanelOpen ? pullRequests[0] ?? null : null;

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
    setSidePanelOpen(false);
    setSidePanelTab('tasks');
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdPaletteAnchor(null);
        setCmdPaletteOpen(prev => !prev);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setCmdPaletteOpen(false);
        chatInputRef.current?.focus();
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

  async function refreshQueue(sessionId = activeSessionId): Promise<void> {
    if (!sessionId) {
      setQueuedMessages([]);
      return;
    }
    try {
      const items = await chatApi.getQueue(sessionId);
      setQueuedMessages(items ?? []);
    } catch (err) {
      console.warn('Failed to load chat queue:', err);
    }
  }

  async function sendNow(
    content: string,
    agentOverride?: string | null,
    cwdOverride?: string | null,
    options?: PendingSendOptions,
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
    options?: PendingSendOptions,
  ) {
    const shouldQueue = Boolean(activeSessionId) && (
      streaming || queuedMessagesRef.current.length > 0 || Boolean(editingQueuedIdRef.current)
    );
    if (shouldQueue) {
      if (!activeSessionId) return;
      if (queuedMessagesRef.current.length >= 3) {
        window.alert('This chat already has 3 queued messages. Send or remove one before adding another.');
        return;
      }
      try {
        const item = await chatApi.enqueueMessage(activeSessionId, {
          content,
          agent: agentOverride ?? selectedAgent,
          cwd: cwdOverride ?? selectedAgentCwd,
        });
        setQueuedMessages(prev => [...prev, item]);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to queue message');
        await refreshQueue(activeSessionId);
      }
      return;
    }
    await sendNow(content, agentOverride, cwdOverride, options);
  }

  useEffect(() => {
    void refreshQueue(activeSessionId);
    if (!activeSessionId) return;
    const timer = window.setInterval(() => {
      void refreshQueue(activeSessionId);
    }, queuedMessagesRef.current.length > 0 || streaming ? 2000 : 6000);
    return () => window.clearInterval(timer);
  }, [activeSessionId, streaming]);

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

  function openSidePanel(tab: ChatRunPanelTab, filesView?: 'files' | 'changes') {
    const nextTab = tab === 'executions' ? 'tasks' : tab;
    if ((tab === 'files' || tab === 'changes') && filesView) {
      setFilesViewRequest(prev => ({ view: filesView, nonce: (prev?.nonce ?? 0) + 1 }));
    }
    setSidePanelTab(nextTab);
    setSidePanelOpen(true);
  }

  function handleSidePanelTabChange(tab: ChatRunPanelTab) {
    if (tab === 'files') {
      openSidePanel('files', 'files');
      return;
    }
    if (tab === 'changes') {
      openSidePanel('changes', 'changes');
      return;
    }
    openSidePanel(tab);
  }

  const workspaceDiffRefs = spawnedAgents.reduce<Array<{ id: string; mode: 'workspace' }>>((acc, run) => {
    const id = run.runContext?.workspace?.id;
    if (!id) return acc;
    const existing = acc.find(item => item.id === id);
    if (!existing) acc.push({ id, mode: 'workspace' });
    return acc;
  }, []);
  const pullRequestDiffRefs = spawnedAgents.reduce<Array<{ id: string }>>((acc, run) => {
    const id = run.runContext?.pullRequest?.id;
    if (id && !acc.some(item => item.id === id)) acc.push({ id });
    return acc;
  }, []);
  const workspaceSignature = workspaceDiffRefs.map(ref => `${ref.id}:${ref.mode}`).join('|');
  const pullRequestSignature = pullRequestDiffRefs.map(ref => ref.id).join('|');
  const diffSourceSignature = [activeSessionId ?? '', workspaceSignature, pullRequestSignature].filter(Boolean).join('::');
  const diffRefreshSignature = spawnedAgents
    .map(run => [
      run.executionId,
      run.sourceMessageId ?? '',
      run.status,
      run.runContext?.status ?? '',
      run.runContext?.workspace?.id ?? '',
    ].join(':'))
    .join('|');

  useEffect(() => {
    if (!diffSourceSignature) {
      chatDiffSignatureRef.current = '';
      setChatDiffSummary(null);
      setHiddenDiffSignature(null);
      return;
    }
    let cancelled = false;
    const workspaceRefs = workspaceDiffRefs;
    const pullRequestRefs = pullRequestDiffRefs;
    const refreshDiffSummary = async () => {
      const snapshotPart = activeSessionId
        ? await chatCodeDiffs.listAll(activeSessionId)
          .then(result => {
            const files = (result.snapshots ?? []).flatMap((snapshot: any) => snapshot.files ?? [])
              .filter((file: any) => file.diff?.trim() || file.modifiedContent?.trim());
            return summarizeDiffFiles(files);
          })
          .catch(() => ({ files: 0, additions: 0, deletions: 0 }))
        : { files: 0, additions: 0, deletions: 0 };
      const parts = await Promise.all(workspaceRefs.map(async ref => {
        try {
          const result = await workspacesApi.getDiff(ref.id, { mode: ref.mode });
          const files = ((result.files ?? []) as Array<{ path?: string; additions?: number; deletions?: number; diff?: string; modifiedContent?: string }>)
            .filter(file => file.diff?.trim() || file.modifiedContent?.trim());
          return files;
        } catch {
          return [];
        }
      }));
      const prParts = await Promise.all(pullRequestRefs.map(async ref => {
        try {
          const result = await pullRequestsApi.getDiff(ref.id);
          const files = ((result.files ?? []) as Array<{ path?: string; diff?: string; modifiedContent?: string }>)
            .filter(file => file.diff?.trim() || file.modifiedContent?.trim());
          return files;
        } catch {
          return [];
        }
      }));
      if (cancelled) return;
      const liveSummary = summarizeDiffFiles([...parts.flat(), ...prParts.flat()]);
      const summary = liveSummary.files > 0 ? liveSummary : snapshotPart;
      const next = summary.files > 0 ? summary : null;
      const nextSignature = next ? `${next.files}:${next.additions}:${next.deletions}` : '';
      if (chatDiffSignatureRef.current !== nextSignature) {
        chatDiffSignatureRef.current = nextSignature;
        setHiddenDiffSignature(null);
      }
      setChatDiffSummary(next);
    };

    void refreshDiffSummary();
    return () => { cancelled = true; };
  }, [diffSourceSignature, diffRefreshSignature, activeSessionId]);

  const showResourceRail = Boolean(activeSessionId) || spawnedAgents.length > 0;
  const archivedWorkspace = activeSession?.archivedWorkspace;
  const repoBrowseSource = archivedWorkspace?.repoId
    ? { id: archivedWorkspace.repoId, name: archivedWorkspace.repoName ?? archivedWorkspace.name, path: archivedWorkspace.repoPath }
    : activeSession?.repoId
      ? { id: activeSession.repoId, name: activeSession.repoName, path: activeSession.repoPath }
      : selectedRepo?._id
        ? { id: selectedRepo._id, name: selectedRepo.name, path: selectedRepo.path }
        : null;

  return (
    <div className={`chat-page-shell ${sidePanelOpen ? 'with-run-sidebar' : ''}`}>
      <div className="chat-main-shell">
      {/* Messages */}
      {loadingMessages && messages.length === 0 && !streaming ? (
        <div className="flex-1 flex items-center justify-center"><div className="text-xs text-theme-subtle animate-pulse">Loading...</div></div>
      ) : messages.length === 0 && !activeSessionId && !streaming ? (
        <div className="chat-empty-stream" aria-label="New conversation" />
      ) : (
        <ChatMessageList messages={messages} streamText={streamText} thinkingText={thinkingText} streaming={streaming} activeToolCalls={activeToolCalls} agentThreads={agentThreads} agentReports={agentReports} threadsByMessage={threadsByMessage} spawnedAgents={spawnedAgents} pendingUserQuestion={pendingUserQuestion} onAnswerUserQuestion={answerUserQuestion} onAnswerWorkflowIntervention={answerWorkflowIntervention} activeAgent={activeSession?.activeAgent} onSuggestionClick={handleSuggestionClick} onSaveToLearnings={handleSaveToLearnings} onOpenExecutionsPanel={() => openSidePanel('tasks')} onOpenFilesPanel={() => openSidePanel('changes', 'changes')} />
      )}
      {floatingPullRequest && <FloatingPullRequestCard pullRequest={floatingPullRequest} />}

      {/* Input */}
      <div className="chat-input-dock">
        {archivedWorkspace && (
          <div className="chat-archived-workspace-note">
            <div>
              <span>Workspace deleted</span>
              <strong>{archivedWorkspace.name ?? archivedWorkspace.branch ?? 'Deleted workspace'}</strong>
              <em>
                {[archivedWorkspace.repoName, archivedWorkspace.branch, archivedWorkspace.baseBranch ? `base ${archivedWorkspace.baseBranch}` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </em>
            </div>
            {archivedWorkspace.prUrl && (
              <a href={archivedWorkspace.prUrl} target="_blank" rel="noreferrer">
                open PR
              </a>
            )}
          </div>
        )}
        {chatDiffSummary && hiddenDiffSignature !== diffSourceSignature && (
          <div className="chat-code-summary-wrap">
            <button
              type="button"
              className="chat-code-summary-pill"
              onClick={() => openSidePanel('changes', 'changes')}
              title="Open all code changes in this chat"
            >
              <Code2 className="h-3 w-3" />
              <span>{chatDiffSummary.files} changed</span>
              <span className="add">+{chatDiffSummary.additions}</span>
              <span className="del">-{chatDiffSummary.deletions}</span>
            </button>
            <button
              type="button"
              className="chat-code-summary-close"
              onClick={() => setHiddenDiffSignature(diffSourceSignature)}
              title="Hide changed files summary"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {queuedMessages.length > 0 && (
          <div className="chat-queue-panel" aria-label="Queued messages">
            <div className="chat-queue-head">
              <span>{queuedMessages.length} queued</span>
              {editingQueuedId && <span>paused while editing</span>}
            </div>
            <div className="chat-queue-list">
              {queuedMessages.map((item, index) => {
                const editing = editingQueuedId === item.id;
                const running = item.status === 'running';
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
                      {running ? (
                        <span>sending</span>
                      ) : editing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              void (async () => {
                                if (!activeSessionId) return;
                                const next = editingQueuedValue.trim();
                                if (next) {
                                  const updated = await chatApi.updateQueuedMessage(activeSessionId, item.id, { content: next, status: 'queued' });
                                  setQueuedMessages(prev => prev.map(q => q.id === item.id ? updated : q));
                                } else {
                                  const updated = await chatApi.updateQueuedMessage(activeSessionId, item.id, { status: 'queued' });
                                  setQueuedMessages(prev => prev.map(q => q.id === item.id ? updated : q));
                                }
                                setEditingQueuedId(null);
                                setEditingQueuedValue('');
                              })().catch(err => window.alert(err instanceof Error ? err.message : 'Failed to save queued message'));
                            }}
                            title="Save queued message"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void (async () => {
                                if (activeSessionId) {
                                  const updated = await chatApi.updateQueuedMessage(activeSessionId, item.id, { status: 'queued' });
                                  setQueuedMessages(prev => prev.map(q => q.id === item.id ? updated : q));
                                }
                                setEditingQueuedId(null);
                                setEditingQueuedValue('');
                              })().catch(err => window.alert(err instanceof Error ? err.message : 'Failed to resume queued message'));
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
                              void (async () => {
                                if (!activeSessionId) return;
                                const updated = await chatApi.updateQueuedMessage(activeSessionId, item.id, { status: 'editing' });
                                setQueuedMessages(prev => prev.map(q => q.id === item.id ? updated : q));
                                setEditingQueuedId(item.id);
                                setEditingQueuedValue(item.content);
                              })().catch(err => window.alert(err instanceof Error ? err.message : 'Failed to edit queued message'));
                            }}
                            title="Edit queued message"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void (async () => {
                                if (!activeSessionId) return;
                                await chatApi.deleteQueuedMessage(activeSessionId, item.id);
                                setQueuedMessages(prev => prev.filter(q => q.id !== item.id));
                              })().catch(err => window.alert(err instanceof Error ? err.message : 'Failed to remove queued message'));
                            }}
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
          selectedRepoName={archivedWorkspace ? `${archivedWorkspace.name ?? 'Workspace'} deleted` : activeSession?.repoName ?? selectedRepo?.name ?? null}
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
          maxVisibleLines={4}
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
      {showResourceRail && !sidePanelOpen && (
        <nav className="chat-resource-rail" aria-label="Chat resources">
          <button
            type="button"
            className={sidePanelOpen ? 'active' : ''}
            onClick={() => setSidePanelOpen(value => !value)}
            title={sidePanelOpen ? 'Close resources' : 'Open resources'}
            data-tooltip={sidePanelOpen ? 'Close resources' : 'Open resources'}
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
          <button type="button" className={sidePanelOpen && sidePanelTab === 'tasks' ? 'active' : ''} onClick={() => openSidePanel('tasks')} title="Task sequence" data-tooltip="Task sequence">
            <ListTree className="h-4 w-4" />
          </button>
          <button type="button" className={sidePanelOpen && sidePanelTab === 'files' ? 'active' : ''} onClick={() => openSidePanel('files', 'files')} title="Files" data-tooltip="Files">
            <FileText className="h-4 w-4" />
          </button>
          <button type="button" className={sidePanelOpen && sidePanelTab === 'changes' ? 'active' : ''} onClick={() => openSidePanel('changes', 'changes')} title="Code changes" data-tooltip="Code changes">
            <Code2 className="h-4 w-4" />
          </button>
          <button type="button" className={sidePanelOpen && sidePanelTab === 'context' ? 'active' : ''} onClick={() => openSidePanel('context')} title="Context" data-tooltip="Context">
            <BookOpen className="h-4 w-4" />
          </button>
        </nav>
      )}
      <ChatRunSidebar
        runs={spawnedAgents}
        rootType="chat"
        rootId={activeSessionId}
        repoBrowseSource={repoBrowseSource}
        open={sidePanelOpen}
        activeTab={sidePanelTab}
        onTabChange={handleSidePanelTabChange}
        filesViewRequest={filesViewRequest}
        onAnswerWorkflowIntervention={answerWorkflowIntervention}
        onClose={() => setSidePanelOpen(false)}
      />
    </div>
  );
}
