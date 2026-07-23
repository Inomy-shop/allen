import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useChat, type ChatSession } from '../hooks/useChat';
import ChatInput, { type ChatInputHandle, type ReasoningEffortValue, type RepoOption, type SlashCommandOption } from '../components/chat/ChatInput';
import { useFileDropZone, FileDropOverlay } from '../hooks/useFileDropZone';
import { buildSkillSlashCommands } from '../hooks/useSkillSlashCommands';
import ChatMessageList from '../components/chat/ChatMessageList';
import CommandPalette from '../components/chat/CommandPalette';
import ConversationLogs from '../components/chat/ConversationLogs';
import AgentChatDropdown from '../components/chat/AgentChatDropdown';
import ChatRunSidebar, { FileChangesPanel, type ChatRunPanelTab } from '../components/chat/ChatRunSidebar';
import { ToolCallLog } from '../components/common/ToolCallLog';
import { chat as chatApi, mcp as mcpApi, learnings as learningsApi, agents as agentsApi, repos as reposApi, skills as skillsApi, artifacts as artifactsApi, type ChatQueueItem, type SkillRecord } from '../services/api';
import { workspaces as workspacesApi } from '../services/workspaceService';
import { type WorkspaceChatTab, type WorkspaceResourceTab, getTabKey } from '../components/chat/WorkspaceChatTabs';
import ChatDetailHeader from '../components/chat/ChatDetailHeader';
import TeamClassificationSelect from '../components/common/TeamClassificationSelect';
import ChatExportDialog from '../components/chat/ChatExportDialog';
import ImportedChatBanner from '../components/chat/ImportedChatBanner';
import { Activity, AppWindow, ArrowLeft, BookOpen, Code2, FileText, ListTree, MoreHorizontal, PanelRightOpen, Server, Terminal, X, Check, Navigation2, Pencil, Trash2, Upload } from 'lucide-react';
import { XTerminal, type TerminalSourceType } from '../components/workspace/XTerminal';
import WorkspaceServersTab from '../components/workspace/WorkspaceServersTab';
import DocumentTabHost from '../components/artifacts/DocumentTabHost';
import { resourceScopeKey, useDocumentTabStore } from '../stores/documentTabStore';
import { useMediaViewerStore } from '../stores/mediaViewerStore';
import { mediaKindForPath, mimeTypeForMediaPath } from '../lib/resource-navigation';
import { resolveChatTerminalSource } from '../lib/chat-terminal-source';
import { resolveChatResourceScope } from '../lib/chat-resource-scope';
import { insertSiblingTab } from '../lib/tab-order';
import { chatSessionPath, shouldSwitchChatSession, workspaceChatPath } from '../lib/workspace-routes';
import type { TeamClassification } from '../types/teamClassification';

export interface ChatPageConfig {
  /** Override base path for session navigation. Default: 'chat'. */
  routeBase?: string;
  /** Force this agent for all new messages. Hides agent picker. */
  forcedAgent?: string | null;
  /** Custom placeholder for ChatInput. */
  placeholder?: string;
  /** When true, hides the resource rail and run sidebar. */
  designMode?: boolean;
  /** Called when activeSessionId changes (e.g., after creating a new session). */
  onActiveSessionIdChange?: (sessionId: string | null) => void;
  /** Called when the effective linked workspace id changes (e.g., for DesignPage's preview panel). */
  onActiveWorkspaceIdChange?: (workspaceId: string | null) => void;
  /** When true, disables the chat input (e.g. design repo not set up). */
  disabled?: boolean;
  /** Reason shown in the ChatInput disabled banner. */
  disabledReason?: string;
  /** Override new-session creation while preserving the normal composer/send flow. */
  createSessionOverride?: (args: { provider?: string; model?: string; agentOverrides?: Record<string, unknown>; repoId?: string; workspaceId?: string }) => Promise<ChatSession>;
  /** Hide the Planner toggle in the composer. */
  hidePlanMode?: boolean;
  /** Hide repository selection in the composer. */
  hideRepoSelector?: boolean;
  /** Default reasoning effort for a new unsent chat. */
  defaultReasoningEffort?: ReasoningEffortValue;
}

type PendingSendOptions = {
  provider?: string | null;
  model?: string | null;
  repoId?: string | null;
  agentOverrides?: {
    reasoningEffort?: ReasoningEffortValue | null;
    planMode?: boolean | null;
  };
};

type ExternalIdeId = 'vscode' | 'cursor';

type IdeOption = {
  id: ExternalIdeId;
  label: string;
  icon: () => JSX.Element;
};

type ChatTerminalTab = {
  id: string;
  title: string;
  sourceType: TerminalSourceType;
  sourceId: string;
  sourceLabel: string;
};

type ChatSessionTab = {
  id: string;
  title: string;
  isTemp?: boolean;
};

type ChatUtilityTab = {
  id: string;
  title: string;
  kind: 'code-diff' | 'file-explorer';
};

const chatSessionTabKey = (id: string) => `chat:${id}`;
const chatTerminalTabKey = (id: string) => `terminal:${id}`;
const chatUtilityTabKey = (id: string) => `utility:${id}`;

function VsCodeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="chat-ide-option-icon">
      <path fill="#22a7f2" d="M19.3 3.1 9.6 12l9.7 8.9c.6.5 1.7.1 1.7-.7V3.8c0-.8-1.1-1.2-1.7-.7Z" />
      <path fill="#007acc" d="m8.4 8.7-4-3.1c-.4-.3-.9-.3-1.2.1l-1 1c-.3.3-.3.8.1 1.1L6.6 12l-4.3 4.2c-.4.3-.4.8-.1 1.1l1 1c.3.4.8.4 1.2.1l4-3.1 3.7 2.9c.5.4 1.2 0 1.2-.6V6.4c0-.6-.7-1-1.2-.6L8.4 8.7Z" />
    </svg>
  );
}

function CursorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="chat-ide-option-icon">
      <path fill="currentColor" d="M4 2.8 20.5 12 4 21.2V2.8Z" />
      <path fill="rgb(var(--color-card))" d="m7.2 7 8.6 5-8.6 5V7Z" />
      <path fill="currentColor" d="m9.4 10.5 3.4 1.5-3.4 1.5v-3Z" />
    </svg>
  );
}

const IDE_OPTIONS: IdeOption[] = [
  { id: 'vscode', label: 'VS Code', icon: VsCodeIcon },
  { id: 'cursor', label: 'Cursor', icon: CursorIcon },
];

function providerFamily(provider?: string | null): 'codex' | 'claude' | 'unknown' {
  if (provider === 'codex') return 'codex';
  if (provider === 'claude' || provider === 'claude-cli') return 'claude';
  if (provider) return 'claude';
  return 'unknown';
}

function workspaceChatToTab(chat: any): WorkspaceChatTab {
  return {
    id: { kind: 'session' as const, sessionId: chat._id },
    title: chat.title || 'chat',
    isTemp: false,
    titleSource: chat.titleSource,
    lastMessageAt: chat.lastMessageAt,
  };
}

function terminalSequence(terminalId: string): number {
  const match = /^term-(\d+)$/.exec(terminalId);
  return match ? Number(match[1]) : 0;
}

function maxTerminalSequence(terminalIds: string[]): number {
  return terminalIds.reduce((max, id) => Math.max(max, terminalSequence(id)), 0);
}

export default function ChatPage({ config }: { config?: ChatPageConfig } = {}) {
  const routeBase = config?.routeBase ?? 'chat';
  const isDesignMode = Boolean(config?.designMode);
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlWorkspaceId = searchParams.get('workspaceId');
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [cmdPaletteAnchor, setCmdPaletteAnchor] = useState<DOMRect | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [toolLogOpen, setToolLogOpen] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState<ChatRunPanelTab>('documents');
  const [documentCount, setDocumentCount] = useState(0);
  const [filesViewRequest, setFilesViewRequest] = useState<{ view: 'files' | 'changes'; nonce: number } | undefined>();
  const [mcpCount, setMcpCount] = useState<{ enabled: number; connected: number }>({ enabled: 0, connected: 0 });
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('codex');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(config?.forcedAgent ?? null);
  const [selectedAgentCwd, setSelectedAgentCwd] = useState<string | null>(null);
  const [allAgents, setAllAgents] = useState<any[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<ChatQueueItem[]>([]);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [editingQueuedValue, setEditingQueuedValue] = useState('');
  // Pending override state for chats that don't have a session yet. Once the
  // first message creates the session, this is merged into createSession().
  const [pendingOverrides, setPendingOverrides] = useState<{
    reasoningEffort?: ReasoningEffortValue | null;
    planMode?: boolean | null;
  }>(config?.defaultReasoningEffort ? { reasoningEffort: config.defaultReasoningEffort } : {});
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const processedDeepLinkRef = useRef<string | null>(null);
  const queuedMessagesRef = useRef<ChatQueueItem[]>([]);
  const editingQueuedIdRef = useRef<string | null>(null);
  const wsLoadedForSessionRef = useRef<string | null>(null);
  const pendingWorkspaceTempTabRef = useRef<{ workspaceId: string; tab: WorkspaceChatTab } | null>(null);
  const workspaceTabsWorkspaceIdRef = useRef<string | null>(null);
  const ideMenuRef = useRef<HTMLDivElement | null>(null);
  const documentsSidebarAutoHiddenRef = useRef(false);

  // Workspace mode state
  const [activeWorkspace, setActiveWorkspace] = useState<any | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspaceChats, setWorkspaceChats] = useState<any[]>([]);
  const [openWorkspaceTabs, setOpenWorkspaceTabs] = useState<WorkspaceChatTab[]>([]);
  const [activeWorkspaceTabKey, setActiveWorkspaceTabKey] = useState<string | null>(null);
  const [workspaceResourceScopeKey, setWorkspaceResourceScopeKey] = useState<string | null>(null);
  const [activeWorkspaceResourceTabKey, setActiveWorkspaceResourceTabKey] = useState<string | null>(null);
  const [workspaceResourceScopeRegistry, setWorkspaceResourceScopeRegistry] = useState<{
    workspaceId: string | null;
    scopeKeys: string[];
  }>({ workspaceId: null, scopeKeys: [] });
  const [tempTabCounter, setTempTabCounter] = useState(0);
  const [workspaceTerminalCounter, setWorkspaceTerminalCounter] = useState(0);
  const workspaceTerminalCounterRef = useRef(0);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null);
  const [ideMenuOpen, setIdeMenuOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [openChatTabs, setOpenChatTabs] = useState<ChatSessionTab[]>([]);
  const [activeChatTabId, setActiveChatTabId] = useState<string | null>(null);
  const [openChatTerminalTabs, setOpenChatTerminalTabs] = useState<ChatTerminalTab[]>([]);
  const [activeChatTerminalId, setActiveChatTerminalId] = useState<string | null>(null);
  const [openChatUtilityTabs, setOpenChatUtilityTabs] = useState<ChatUtilityTab[]>([]);
  const [activeChatUtilityId, setActiveChatUtilityId] = useState<string | null>(null);
  const [chatTabOrder, setChatTabOrder] = useState<string[]>([]);
  const [teamClassificationOverride, setTeamClassificationOverride] = useState<TeamClassification | null>(null);
  const [teamClassificationError, setTeamClassificationError] = useState<string | null>(null);
  const chatTerminalCounterRef = useRef(0);
  const pendingChatTempTabRef = useRef<string | null>(null);
  const openFile = useDocumentTabStore(state => state.openFile);
  const documentTabs = useDocumentTabStore(state => state.tabs);
  const fileTabs = useDocumentTabStore(state => state.fileTabs);
  const resourceSelections = useDocumentTabStore(state => state.selections);
  const selectDocument = useDocumentTabStore(state => state.selectDocument);
  const selectFile = useDocumentTabStore(state => state.selectFile);
  const closeDocument = useDocumentTabStore(state => state.closeDocument);
  const closeFile = useDocumentTabStore(state => state.closeFile);
  const selectBaseResourceTab = useDocumentTabStore(state => state.selectBaseTab);
  const setActiveResourceScope = useDocumentTabStore(state => state.setActiveScope);
  const openMedia = useMediaViewerStore(state => state.openMedia);

  const {
    sessions, activeSessionId, messages, streaming, streamText,
    thinkingText, activeToolCalls, agentReports,
    spawnedAgents, pendingUserQuestion, answerUserQuestion, answerWorkflowIntervention,
    loadingMessages,
    sendMessage, createSession, switchSession, cancelStream,
    restoredDraft, clearRestoredDraft, watchers,
    refresh: refreshSessions, refreshActiveSession,
  } = useChat();

  const activeSession = sessions.find(s => s._id === activeSessionId);
  const displayedTeamClassification = teamClassificationOverride;
  const latestMessage = messages[messages.length - 1];
  const artifactRefreshKey = [
    activeSessionId ?? '',
    messages.length,
    latestMessage?._id ?? '',
    activeToolCalls.length,
  ].join(':');
  const activeProvider = activeSession?.provider ?? selectedProvider;
  const activeWorkflowName = spawnedAgents.find(run => run.runContext?.runType === 'workflow')?.runContext?.execution.workflowName ?? null;

  useEffect(() => {
    setTeamClassificationOverride(activeSession?.teamClassification ?? null);
    setTeamClassificationError(null);
  }, [activeSession?._id, activeSession?.teamClassification]);

  async function handleTeamClassificationChange(value: TeamClassification | null) {
    if (!activeSessionId || composerDisabled) return;
    const previous = displayedTeamClassification;
    setTeamClassificationOverride(value);
    setTeamClassificationError(null);
    try {
      await chatApi.updateSession(activeSessionId, { teamClassification: value });
      if (!activeSession?.studioWorkspaceId) refreshSessions();
    } catch (error) {
      setTeamClassificationOverride(previous);
      setTeamClassificationError(error instanceof Error ? error.message : 'Could not update the conversation team.');
    }
  }

  useEffect(() => {
    if (!activeSessionId || activeWorkspaceId || activeSession?.workspaceId) return;
    const title = activeSession?.title || 'Untitled conversation';
    const pendingTempTabId = pendingChatTempTabRef.current;
    setOpenChatTabs(current => {
      const existing = current.find(tab => tab.id === activeSessionId);
      if (existing) return current.map(tab => tab.id === activeSessionId ? { ...tab, title } : tab);
      const activeTempIndex = current.findIndex(tab => tab.id === pendingTempTabId && tab.isTemp);
      if (activeTempIndex >= 0) {
        const next = [...current];
        next[activeTempIndex] = { id: activeSessionId, title };
        return next;
      }
      return [...current, { id: activeSessionId, title }];
    });
    setChatTabOrder(current => {
      const nextKey = chatSessionTabKey(activeSessionId);
      if (pendingTempTabId) {
        const pendingKey = chatSessionTabKey(pendingTempTabId);
        const pendingIndex = current.indexOf(pendingKey);
        if (pendingIndex >= 0) {
          const next = [...current];
          next[pendingIndex] = nextKey;
          return next;
        }
      }
      return current.includes(nextKey) ? current : [...current, nextKey];
    });
    pendingChatTempTabRef.current = null;
    setActiveChatTabId(activeSessionId);
  }, [activeSessionId, activeSession?.title, activeSession?.workspaceId, activeWorkspaceId]);

  useEffect(() => {
    if (!activeSessionId) {
      setDocumentCount(0);
      return;
    }
    let cancelled = false;
    artifactsApi.list({ rootType: 'chat', rootId: activeSessionId, limit: 500 })
      .then(items => { if (!cancelled) setDocumentCount(items.length); })
      .catch(() => { if (!cancelled) setDocumentCount(0); });
    return () => { cancelled = true; };
  }, [activeSessionId, artifactRefreshKey]);

  function syncWorkspaceTerminalCounter(terminalIds: string[]) {
    const maxId = maxTerminalSequence(terminalIds);
    workspaceTerminalCounterRef.current = maxId;
    setWorkspaceTerminalCounter(maxId);
  }

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('allen:active-chat-conversation', { detail: { sessionId: activeSessionId ?? null } }));
  }, [activeSessionId]);

  useEffect(() => { queuedMessagesRef.current = queuedMessages; }, [queuedMessages]);
  useEffect(() => { editingQueuedIdRef.current = editingQueuedId; }, [editingQueuedId]);

  useEffect(() => {
    if (!ideMenuOpen) return undefined;

    function onPointerDown(event: PointerEvent) {
      if (ideMenuRef.current?.contains(event.target as Node)) return;
      setIdeMenuOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIdeMenuOpen(false);
    }

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [ideMenuOpen]);

  useEffect(() => {
    if (!restoredDraft?.trim()) return;
    if (chatInputRef.current?.getValue().trim()) {
      clearRestoredDraft();
      return;
    }
    chatInputRef.current?.setValue(restoredDraft);
    chatInputRef.current?.focus();
    clearRestoredDraft();
  }, [restoredDraft, clearRestoredDraft]);

  useEffect(() => {
    chatApi.providers().then(p => {
      setProviders(p);
      if (p.length > 0) {
        setSelectedProvider(p[0].provider);
        setSelectedModel(p[0].defaultModel);
      }
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
    Promise.all([
      chatApi.slashCommands({ provider, sessionId: activeSessionId ?? undefined, cwd })
        .catch(() => [] as SlashCommandOption[]),
      skillsApi.list(false).catch(() => [] as SkillRecord[]),
    ]).then(([commands, skillList]) => {
      setSlashCommands([...(commands ?? []), ...buildSkillSlashCommands(skillList)]);
    });
  }, [activeSessionId, activeSession?.provider, activeSession?.repoPath, selectedProvider, selectedRepo?.path]);

  // Reset pending overrides and repo selection whenever the user switches to a
  // different conversation — they only apply to a new chat that hasn't been
  // created yet.
  useEffect(() => {
    setPendingOverrides(config?.defaultReasoningEffort ? { reasoningEffort: config.defaultReasoningEffort } : {});
    setSelectedRepo(null);
    setQueuedMessages([]);
    setEditingQueuedId(null);
    setEditingQueuedValue('');
    // Resource panels are opt-in. In particular, entering or switching a
    // workspace chat must not cover the conversation with the Docs drawer.
    setSidePanelOpen(false);
    setSidePanelTab('documents');
  }, [activeSessionId]);

  // The agent doc whose defaults we display as the fallback in the popover.
  const selectedAgentDoc = selectedAgent
    ? allAgents.find((a) => a.name === selectedAgent) ?? null
    : null;

  // Effective overrides: session-persisted if session exists, else in-memory pending.
  const effectiveOverrides = activeSession?.agentOverrides ?? pendingOverrides;

  const activeProviderFamily = activeSessionId
    ? providerFamily(activeSession?.provider ?? selectedProvider)
    : 'unknown';
  const composerProviders = activeProviderFamily === 'unknown'
    ? providers
    : providers.filter((provider) => providerFamily(provider.provider) === activeProviderFamily);
  const modelLocked = streaming
    || Boolean(activeSession?.source === 'slack')
    || Boolean(activeSession?.isImported)
    || Boolean(config?.disabled);
  const modelLockReason = streaming
    ? 'Stop the current turn before changing model'
    : activeSession?.source === 'slack'
    ? 'This Slack-managed conversation cannot change model here'
    : activeSession?.isImported
    ? 'Imported replays are read-only'
    : config?.disabledReason;

  async function handleProviderChange(provider: string, model: string) {
    if (!activeSessionId) {
      setSelectedProvider(provider);
      setSelectedModel(model);
      return;
    }
    if (streaming) return;
    const previousProvider = activeSession?.provider ?? selectedProvider;
    const previousModel = activeSession?.model ?? selectedModel;
    setSelectedProvider(provider);
    setSelectedModel(model);
    try {
      await chatApi.updateSession(activeSessionId, { provider, model });
      await refreshSessions();
    } catch (err) {
      setSelectedProvider(previousProvider);
      setSelectedModel(previousModel);
      console.error('updateSession model failed:', err);
    }
  }

  // Called from ChatInput when the user changes effort or plan mode.
  // Before a session exists, mutate local state. After, PATCH the session doc.
  async function handleOverridesChange(next: {
    reasoningEffort?: ReasoningEffortValue | null;
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
      // Only reset to null when no forced agent is configured
      if (!config?.forcedAgent) {
        setSelectedAgent(null);
        setSelectedAgentCwd(null);
      }
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
    } else if (!urlSessionId && !urlWorkspaceId && activeSessionId) {
      // URL cleared (new chat button) — clear active session
      switchSession('');
    }
  }, [urlSessionId, urlWorkspaceId]);

  useEffect(() => {
    if (activeWorkspaceId || urlWorkspaceId) return;
    if (activeSessionId && activeSessionId !== urlSessionId) {
      // Active session changed (e.g., after creating a new session) — update URL
      navigate(`/${routeBase}/${activeSessionId}`, { replace: true });
    }
  }, [activeSessionId, activeWorkspaceId, urlWorkspaceId, urlSessionId, navigate, routeBase]);

  // Notify parent when activeSessionId changes (e.g., for DesignPage's preview panel)
  useEffect(() => {
    config?.onActiveSessionIdChange?.(activeSessionId ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // ── Workspace mode: primary bootstrap (triggered by ?workspaceId in URL) ──
  useEffect(() => {
    if (!urlWorkspaceId) return;

    let cancelled = false;
    workspaceTabsWorkspaceIdRef.current = null;

    async function loadWorkspace() {
      try {
        const ws = await workspacesApi.get(urlWorkspaceId!);
        if (cancelled) return;
        setActiveWorkspace(ws);
        setActiveWorkspaceId(urlWorkspaceId);
        setWorkspaceLoadError(null);

        const chats = await workspacesApi.listChats(urlWorkspaceId!);
        if (cancelled) return;
        setWorkspaceChats(chats);

        // Try to restore tabs from localStorage (best-effort)
        let hasStoredTabState = false;
        let restoredOpenIds: string[] = [];
        let restoredActiveId: string | null = null;
        let restoredActiveTabKey: string | null = null;
        let restoredTerminalIds: string[] = [];
        let restoredServersOpen = false;
        let restoredUtilityKinds: Array<'code-diff' | 'file-explorer'> = [];
        try {
          const stored = localStorage.getItem(`allen-ws-chat-tabs:${urlWorkspaceId}`);
          if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed.openSessionIds)) {
              hasStoredTabState = true;
              restoredOpenIds = parsed.openSessionIds;
            }
            restoredActiveId = typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null;
            restoredActiveTabKey = typeof parsed.activeTabKey === 'string' ? parsed.activeTabKey : null;
            if (Array.isArray(parsed.openTerminalIds) && parsed.openTerminalIds.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
              restoredTerminalIds = parsed.openTerminalIds as string[];
            } else if (parsed.openTerminal === true && parsed.terminalWorkspaceId === urlWorkspaceId) {
              restoredTerminalIds = ['term-1'];
            }
            restoredServersOpen = parsed.openServers === true && parsed.serversWorkspaceId === urlWorkspaceId && (ws.services?.length ?? 0) > 0;
            if (Array.isArray(parsed.openUtilityTabs)) {
              restoredUtilityKinds = parsed.openUtilityTabs.filter((kind: unknown): kind is 'code-diff' | 'file-explorer' => kind === 'code-diff' || kind === 'file-explorer');
            }
          }
        } catch {}

        syncWorkspaceTerminalCounter(restoredTerminalIds);

        const pendingTemp = pendingWorkspaceTempTabRef.current?.workspaceId === urlWorkspaceId
          ? pendingWorkspaceTempTabRef.current.tab
          : null;
        const restoredTerminalTabs: WorkspaceChatTab[] = restoredTerminalIds.map((tid, idx) => ({
          id: { kind: 'terminal', terminalId: tid },
          title: 'Terminal ' + (idx + 1),
          isTemp: false,
        }));
        const restoredServersTab: WorkspaceChatTab | null = restoredServersOpen
          ? { id: { kind: 'servers' }, title: 'Servers', isTemp: false }
          : null;
        const restoredResourceTabs: WorkspaceChatTab[] = restoredUtilityKinds.map(kind => ({
          id: { kind },
          title: kind === 'code-diff' ? 'Code diff' : 'File explorer',
          isTemp: false,
        }));
        const restoredUtilityTabs = [...restoredTerminalTabs, ...restoredResourceTabs, ...(restoredServersTab ? [restoredServersTab] : [])];

        if (chats.length === 0) {
          const tempTab: WorkspaceChatTab = pendingTemp ?? {
            id: { kind: 'temp', tempId: `temp-${Date.now()}` },
            title: 'New chat',
            isTemp: true,
            tempIndex: 0,
          };
          const tabs = [
            tempTab,
            ...restoredUtilityTabs.filter(tab => getTabKey(tab) !== getTabKey(tempTab)),
          ];
          const activeKey = pendingTemp
            ? getTabKey(pendingTemp)
            : restoredActiveTabKey && tabs.some(tab => getTabKey(tab) === restoredActiveTabKey)
              ? restoredActiveTabKey
              : getTabKey(tempTab);
          workspaceTabsWorkspaceIdRef.current = urlWorkspaceId;
          setOpenWorkspaceTabs(tabs);
          setActiveWorkspaceTabKey(activeKey);
          switchSession('');
          if (pendingTemp) pendingWorkspaceTempTabRef.current = null;
        } else {
          const tabSessionIds = hasStoredTabState
            ? restoredOpenIds.filter(id => chats.some((c: any) => c._id === id))
            : (chats[0]?._id ? [chats[0]._id] : []);

          const tabs: WorkspaceChatTab[] = tabSessionIds.map(sid => {
            const chat = chats.find((c: any) => c._id === sid);
            return workspaceChatToTab(chat ?? { _id: sid });
          });

          const finalTabs = tabs.length > 0 ? tabs : [workspaceChatToTab(chats[0])];
          const requestedChat = urlSessionId ? chats.find((chat: any) => chat._id === urlSessionId) : null;
          const tabsWithRequested = requestedChat && !finalTabs.some(tab => getTabKey(tab) === urlSessionId)
            ? [...finalTabs, workspaceChatToTab(requestedChat)]
            : finalTabs;

          const tabsWithUtility = restoredUtilityTabs.reduce<WorkspaceChatTab[]>((acc, tab) => (
            acc.some(item => getTabKey(item) === getTabKey(tab)) ? acc : [...acc, tab]
          ), tabsWithRequested);

          const tabsWithPending = pendingTemp && !tabsWithUtility.some(t => getTabKey(t) === getTabKey(pendingTemp))
            ? [...tabsWithUtility, pendingTemp]
            : tabsWithUtility;

          if (tabsWithPending.length === 0) {
            const recentTab = workspaceChatToTab(chats[0]);
            const recentSessionId = recentTab.id.kind === 'session' ? recentTab.id.sessionId : '';
            workspaceTabsWorkspaceIdRef.current = urlWorkspaceId;
            setOpenWorkspaceTabs([recentTab]);
            setActiveWorkspaceTabKey(getTabKey(recentTab));
            switchSession(recentSessionId);
            if (pendingTemp) pendingWorkspaceTempTabRef.current = null;
            return;
          }

          workspaceTabsWorkspaceIdRef.current = urlWorkspaceId;
          setOpenWorkspaceTabs(tabsWithPending);

          const restoredActiveStillOpen = restoredActiveId && tabsWithPending.some(t => getTabKey(t) === restoredActiveId);
          const restoredActiveTabStillOpen = restoredActiveTabKey && tabsWithPending.some(t => getTabKey(t) === restoredActiveTabKey);
          const activeKey = pendingTemp
            ? getTabKey(pendingTemp)
            : requestedChat
              ? requestedChat._id
            : restoredActiveTabStillOpen
              ? restoredActiveTabKey
              : restoredActiveStillOpen
              ? restoredActiveId
              : getTabKey(tabsWithPending[0]);
          setActiveWorkspaceTabKey(activeKey);

          const firstTab = tabsWithPending.find(t => getTabKey(t) === activeKey);
          if (firstTab && firstTab.id.kind === 'session') {
            switchSession(firstTab.id.sessionId);
          } else {
            switchSession('');
          }
          if (pendingTemp) pendingWorkspaceTempTabRef.current = null;
        }
      } catch (err: unknown) {
        if (cancelled) return;
        console.error('Failed to load workspace:', err);
        setWorkspaceLoadError('Workspace not found. Opening regular chat.');
        setActiveWorkspace(null);
        setActiveWorkspaceId(null);
        setSearchParams(prev => {
          const next = new URLSearchParams(prev.toString());
          next.delete('workspaceId');
          return next;
        });
      }
    }

    void loadWorkspace();
    return () => { cancelled = true; };
  }, [urlWorkspaceId, urlSessionId]);

  // ── Workspace mode: Path B — /chat/:sessionId where session has workspaceId ──
  useEffect(() => {
    if (!urlSessionId || urlWorkspaceId) return; // Only when no ?workspaceId in URL

    const routeSessionId = urlSessionId;
    let cancelled = false;

    async function loadWorkspaceForSession() {
      let session = sessions.find(s => s._id === routeSessionId);
      if (!session?.workspaceId) {
        try {
          session = await chatApi.getSession(routeSessionId);
        } catch {
          return;
        }
      }
      if (cancelled || !session?.workspaceId) return;

      const routeSessionTitle = session.title || 'chat';
      const wsId = session.workspaceId;
      const loadKey = `${wsId}:${routeSessionId}`;
      const routeSessionAlreadyOpen = openWorkspaceTabs.some(t => getTabKey(t) === routeSessionId);

      // Skip only when this exact dashboard/deep-linked session is already open.
      // Same-workspace links still need to restore a closed tab and force it active.
      if (wsLoadedForSessionRef.current === loadKey && activeWorkspaceId === wsId && routeSessionAlreadyOpen) {
        setActiveWorkspaceTabKey(routeSessionId);
        if (shouldSwitchChatSession(activeSessionId, routeSessionId)) switchSession(routeSessionId);
        return;
      }

      try {
        const ws = await workspacesApi.get(wsId);
        if (cancelled) return;
        wsLoadedForSessionRef.current = loadKey;
        workspaceTabsWorkspaceIdRef.current = null;
        setActiveWorkspace(ws);
        setActiveWorkspaceId(wsId);

        const chats = await workspacesApi.listChats(wsId);
        if (cancelled) return;
        setWorkspaceChats(chats);

        let hasStoredTabState = false;
        let restoredOpenIds: string[] = [];
        let restoredTerminalIds: string[] = [];
        let restoredServersOpen = false;
        let restoredUtilityKinds: Array<'code-diff' | 'file-explorer'> = [];
        try {
          const stored = localStorage.getItem(`allen-ws-chat-tabs:${wsId}`);
          if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed.openSessionIds)) {
              hasStoredTabState = true;
              restoredOpenIds = parsed.openSessionIds;
            }
            if (Array.isArray(parsed.openTerminalIds) && parsed.openTerminalIds.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
              restoredTerminalIds = parsed.openTerminalIds as string[];
            } else if (parsed.openTerminal === true && parsed.terminalWorkspaceId === wsId) {
              restoredTerminalIds = ['term-1'];
            }
            restoredServersOpen = parsed.openServers === true && parsed.serversWorkspaceId === wsId && (ws.services?.length ?? 0) > 0;
            if (Array.isArray(parsed.openUtilityTabs)) {
              restoredUtilityKinds = parsed.openUtilityTabs.filter((kind: unknown): kind is 'code-diff' | 'file-explorer' => kind === 'code-diff' || kind === 'file-explorer');
            }
          }
        } catch {}

        syncWorkspaceTerminalCounter(restoredTerminalIds);

        const tabSessionIds = hasStoredTabState
          ? restoredOpenIds.filter(id => chats.some((c: any) => c._id === id))
          : [];

        const tabs: WorkspaceChatTab[] = tabSessionIds.map(sid => {
          const chat = chats.find((c: any) => c._id === sid);
          return workspaceChatToTab(chat ?? { _id: sid });
        });

        // Ensure the clicked session is in the tabs
        if (!tabs.some(t => getTabKey(t) === routeSessionId)) {
          tabs.push({ id: { kind: 'session' as const, sessionId: routeSessionId }, title: routeSessionTitle, isTemp: false });
        }

        // Restore terminal tabs from stored ids
        restoredTerminalIds.forEach((tid, idx) => {
          const tKey = 'terminal-' + tid;
          if (!tabs.some(t => getTabKey(t) === tKey)) {
            tabs.push({ id: { kind: 'terminal' as const, terminalId: tid }, title: 'Terminal ' + (idx + 1), isTemp: false });
          }
        });
        if (restoredServersOpen && !tabs.some(t => getTabKey(t) === 'servers')) {
          tabs.push({ id: { kind: 'servers' as const }, title: 'Servers', isTemp: false });
        }
        restoredUtilityKinds.forEach(kind => {
          if (!tabs.some(t => getTabKey(t) === kind)) {
            tabs.push({ id: { kind }, title: kind === 'code-diff' ? 'Code diff' : 'File explorer', isTemp: false });
          }
        });

        workspaceTabsWorkspaceIdRef.current = wsId;
        setOpenWorkspaceTabs(tabs);
        setActiveWorkspaceTabKey(routeSessionId); // EC-06: force clicked session active
        if (shouldSwitchChatSession(activeSessionId, routeSessionId)) switchSession(routeSessionId);
      } catch {
        // Silently fail — workspace may be deleted/archived
      }
    }

    void loadWorkspaceForSession();
    return () => { cancelled = true; };
  }, [urlSessionId, urlWorkspaceId, sessions, activeSessionId, activeWorkspaceId, openWorkspaceTabs]);

  // ── Workspace mode: clear when navigating to a non-workspace session ──
  useEffect(() => {
    if (urlWorkspaceId) return; // Workspace bootstrap handles this
    if (!urlSessionId) return; // Blank chat — may be a temp tab, don't clear
    const session = sessions.find(s => s._id === urlSessionId);
    if (!session) return; // Not loaded yet
    if (session.workspaceId) return; // Path B will handle
    if (activeWorkspaceId) {
      setActiveWorkspace(null);
      setActiveWorkspaceId(null);
      setWorkspaceChats([]);
      setOpenWorkspaceTabs([]);
      setActiveWorkspaceTabKey(null);
      wsLoadedForSessionRef.current = null;
      workspaceTabsWorkspaceIdRef.current = null;
    }
  }, [urlSessionId, urlWorkspaceId, sessions]);

  // ── Workspace mode: sync tab titles when sessions refresh (AC-07) ──
  useEffect(() => {
    if (!activeWorkspaceId || openWorkspaceTabs.length === 0) return;
    setOpenWorkspaceTabs(prev =>
      prev.map(tab => {
        if (tab.id.kind !== 'session') return tab;
        const tabSessionId = tab.id.sessionId;
        const session = sessions.find(s => s._id === tabSessionId);
        if (!session) return tab;
        const newTitle = session.title || tab.title;
        const newSource = (session as any).titleSource as 'default' | 'auto' | 'user' | undefined;
        if (newTitle === tab.title && newSource === tab.titleSource) return tab;
        return { ...tab, title: newTitle, titleSource: newSource };
      })
    );
  }, [sessions, activeWorkspaceId]);

  // ── Workspace mode: persist open tabs to localStorage (OQ-01) ──
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (workspaceTabsWorkspaceIdRef.current !== activeWorkspaceId) return;
    const openSessionIds = openWorkspaceTabs
      .filter(t => t.id.kind === 'session')
      .map(t => (t.id as { kind: 'session'; sessionId: string }).sessionId);
    const activeSessionIdForStorage = (openWorkspaceTabs.find(t => getTabKey(t) === activeWorkspaceTabKey)?.id as any)?.sessionId ?? null;
    const openTerminalIds = openWorkspaceTabs
      .filter(t => t.id.kind === 'terminal')
      .map(t => (t.id as { kind: 'terminal'; terminalId: string }).terminalId);
    const openTerminal = openTerminalIds.length > 0;
    const openServers = openWorkspaceTabs.some(t => t.id.kind === 'servers');
    const openUtilityTabs = openWorkspaceTabs
      .filter(t => t.id.kind === 'code-diff' || t.id.kind === 'file-explorer')
      .map(t => t.id.kind);
    try {
      localStorage.setItem(`allen-ws-chat-tabs:${activeWorkspaceId}`, JSON.stringify({
        openSessionIds,
        activeSessionId: activeSessionIdForStorage,
        activeTabKey: activeWorkspaceTabKey,
        openTerminalIds,
        openTerminal,
        terminalWorkspaceId: openTerminal ? activeWorkspaceId : null,
        openServers,
        serversWorkspaceId: openServers ? activeWorkspaceId : null,
        openUtilityTabs,
      }));
    } catch {}
  }, [activeWorkspaceId, openWorkspaceTabs, activeWorkspaceTabKey]);

  async function refreshQueue(sessionId = activeSessionId): Promise<void> {
    if (!sessionId) {
      setQueuedMessages([]);
      return;
    }
    try {
      const items = await chatApi.getQueue(sessionId);
      const allActiveItems = items ?? [];
      const visibleItems = allActiveItems.filter(item => item.status !== 'running');
      setQueuedMessages(visibleItems);
      if (allActiveItems.some(item => item.status === 'running') && !streaming) {
        refreshActiveSession();
      }
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

      // Workspace mode: link new session to workspace when sending from a temp tab
      const activeTab = openWorkspaceTabs.find(t => getTabKey(t) === activeWorkspaceTabKey);
      const isActiveTempTab = activeTab?.isTemp ?? false;
      const wsIdToLink = isActiveTempTab ? activeWorkspaceId : undefined;

      const session = await createSession(
        options?.provider ?? selectedProvider,
        (options?.model ?? selectedModel) || undefined,
        Object.keys(overrides).length > 0 ? overrides : undefined,
        (options?.repoId ?? selectedRepo?._id) || undefined,
        wsIdToLink || undefined, // NEW: workspace linkage
        config?.createSessionOverride,
      );
      navigate(`/${routeBase}/${session._id}`, { replace: true });

      // If we were in a temp tab, replace it with the real session tab
      if (isActiveTempTab && activeTab) {
        const tempKey = getTabKey(activeTab);
        setOpenWorkspaceTabs(prev =>
          prev.map(t =>
            getTabKey(t) === tempKey
              ? { ...t, id: { kind: 'session' as const, sessionId: session._id }, isTemp: false, title: session.title || t.title }
              : t
          )
        );
        setActiveWorkspaceTabKey(session._id);
      }

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

  // Steer a queued message into the running agent. The item is already persisted
  // in the queue, so on a successful steer we remove it (otherwise it would also
  // run when the queue drains). If there is no active turn to steer (race), the
  // server re-queues it — we de-dupe by dropping the original and keeping the
  // server's item.
  async function handleSteerQueued(item: ChatQueueItem) {
    if (!activeSessionId) return;
    try {
      const result = await chatApi.steerExecution(activeSessionId, { content: item.content });
      if (result?.steered) {
        await chatApi.deleteQueuedMessage(activeSessionId, item.id).catch(() => {});
        setQueuedMessages(prev => prev.filter(q => q.id !== item.id));
        // The steered user message arrives via the steered_message SSE event in useChat.
      } else if (result?.queued && result?.item) {
        await chatApi.deleteQueuedMessage(activeSessionId, item.id).catch(() => {});
        setQueuedMessages(prev => [...prev.filter(q => q.id !== item.id), result.item!]);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to steer message');
    }
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

  function handleSlashCommand(command: SlashCommandOption, _raw: string): boolean {
    if (command.name === '/clear') {
      switchSession('');
      navigate(`/${routeBase}`, { replace: true });
      return true;
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
    documentsSidebarAutoHiddenRef.current = false;
    const nextTab = tab;
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

  function handleDocumentOpenedFromSidebar() {
    if (!sidePanelOpen || sidePanelTab !== 'documents') return;
    documentsSidebarAutoHiddenRef.current = true;
    setSidePanelOpen(false);
  }

  function handleAllResourceTabsClosed() {
    documentsSidebarAutoHiddenRef.current = false;
  }

  // ── Workspace tab event handlers ──

  function handleWorkspaceTabSelect(key: string) {
    const tab = openWorkspaceTabs.find(t => getTabKey(t) === key);
    if (!tab) return;
    setActiveWorkspaceResourceTabKey(null);
    const conversationScope = tab.id.kind === 'session'
      ? resourceScopeKey('chat', tab.id.sessionId)
      : tab.id.kind === 'temp'
        ? resourceScopeKey('chat', tab.id.tempId)
        : workspaceResourceScopeKey;
    if (conversationScope) {
      selectBaseResourceTab(conversationScope);
      if (tab.id.kind === 'session' || tab.id.kind === 'temp') {
        setWorkspaceResourceScopeKey(conversationScope);
      }
    }
    setActiveWorkspaceTabKey(key);
    if (tab.id.kind === 'session') {
      switchSession(tab.id.sessionId);
      navigate(chatSessionPath(tab.id.sessionId, activeWorkspaceId), { replace: true });
    } else if (tab.id.kind === 'terminal') {
      if (activeWorkspaceId) {
        pendingWorkspaceTempTabRef.current = { workspaceId: activeWorkspaceId, tab };
      }
      switchSession('');
      navigate(`/chat?workspaceId=${activeWorkspaceId}`, { replace: true });
    } else if (tab.id.kind === 'servers') {
      if (activeWorkspaceId) {
        pendingWorkspaceTempTabRef.current = { workspaceId: activeWorkspaceId, tab };
      }
      switchSession('');
      navigate(`/chat?workspaceId=${activeWorkspaceId}`, { replace: true });
    } else if (tab.id.kind === 'code-diff' || tab.id.kind === 'file-explorer') {
      setSidePanelOpen(false);
    } else {
      // Temp tab: clear active session (blank chat)
      switchSession('');
      navigate(`/chat?workspaceId=${activeWorkspaceId}`, { replace: true });
    }
  }

  function handleWorkspaceTabClose(key: string) {
    if (key === 'servers' && activeWorkspaceId) {
      window.dispatchEvent(new CustomEvent('allen:workspace-servers-stop', { detail: { workspaceId: activeWorkspaceId } }));
    }
    const next = openWorkspaceTabs.filter(t => getTabKey(t) !== key);
    if (next.length === 0) {
      const recentChat = workspaceChats[0];
      if (recentChat?._id) {
        const recentTab = workspaceChatToTab(recentChat);
        const recentSessionId = recentTab.id.kind === 'session' ? recentTab.id.sessionId : '';
        setOpenWorkspaceTabs([recentTab]);
        setActiveWorkspaceTabKey(getTabKey(recentTab));
        const recentScope = resourceScopeKey('chat', recentSessionId);
        setWorkspaceResourceScopeKey(recentScope);
        selectBaseResourceTab(recentScope);
        switchSession(recentSessionId);
        navigate(chatSessionPath(recentSessionId, activeWorkspaceId), { replace: true });
        return;
      }

      // No workspace chat history yet: open a blank new chat tab.
      const tempTab: WorkspaceChatTab = {
        id: { kind: 'temp', tempId: `temp-${Date.now()}` },
        title: 'New chat',
        isTemp: true,
        tempIndex: 0,
      };
      setOpenWorkspaceTabs([tempTab]);
      setActiveWorkspaceTabKey(getTabKey(tempTab));
      setWorkspaceResourceScopeKey(resourceScopeKey('chat', getTabKey(tempTab)));
      switchSession('');
      return;
    }
    setOpenWorkspaceTabs(next);
    // Select nearest remaining tab if the closed tab was active
    if (activeWorkspaceTabKey === key) {
      const closedIdx = openWorkspaceTabs.findIndex(t => getTabKey(t) === key);
      const nextTab = next[Math.max(0, closedIdx - 1)] ?? next[0];
      setActiveWorkspaceTabKey(getTabKey(nextTab));
      if (nextTab.id.kind === 'session') {
        const nextScope = resourceScopeKey('chat', nextTab.id.sessionId);
        setWorkspaceResourceScopeKey(nextScope);
        selectBaseResourceTab(nextScope);
        switchSession(nextTab.id.sessionId);
        navigate(chatSessionPath(nextTab.id.sessionId, activeWorkspaceId), { replace: true });
      }
      else if (nextTab.id.kind === 'temp') {
        const nextScope = resourceScopeKey('chat', nextTab.id.tempId);
        setWorkspaceResourceScopeKey(nextScope);
        selectBaseResourceTab(nextScope);
        switchSession('');
      }
      else if (nextTab.id.kind === 'code-diff' || nextTab.id.kind === 'file-explorer') {
        setSidePanelOpen(false);
      } else {
        switchSession('');
        navigate(`/chat?workspaceId=${activeWorkspaceId}`, { replace: true });
      }
    }
  }

  function handleWorkspaceNewTab() {
    const newCounter = tempTabCounter + 1;
    setTempTabCounter(newCounter);
    const tempTab: WorkspaceChatTab = {
      id: { kind: 'temp', tempId: `temp-${Date.now()}` },
      title: newCounter === 1 && openWorkspaceTabs.filter(t => t.isTemp).length === 0 ? 'New chat' : `New chat ${newCounter}`,
      isTemp: true,
      tempIndex: newCounter,
    };
    if (activeWorkspaceId) {
      pendingWorkspaceTempTabRef.current = { workspaceId: activeWorkspaceId, tab: tempTab };
    }
    setOpenWorkspaceTabs(prev => {
      return insertSiblingTab(prev, activeWorkspaceTabKey, getTabKey, tempTab);
    });
    setWorkspaceResourceScopeKey(resourceScopeKey('chat', getTabKey(tempTab)));
    setActiveWorkspaceTabKey(getTabKey(tempTab));
    switchSession('');
    if (activeWorkspaceId) navigate(`/chat?workspaceId=${activeWorkspaceId}`, { replace: true });
  }

  async function handleOpenChatReference(sessionId: string) {
    let target = sessions.find(session => session._id === sessionId);
    if (!target) {
      try {
        target = await chatApi.getSession(sessionId) as ChatSession;
      } catch {
        return;
      }
    }

    const opensInActiveWorkspace = Boolean(activeWorkspaceId && target.workspaceId === activeWorkspaceId);
    if (opensInActiveWorkspace) {
      const newTab = workspaceChatToTab(target);
      setOpenWorkspaceTabs(current => current.some(tab => getTabKey(tab) === sessionId) ? current : [...current, newTab]);
      setActiveWorkspaceTabKey(sessionId);
    } else {
      setOpenChatTabs(current => current.some(tab => tab.id === sessionId)
        ? current.map(tab => tab.id === sessionId ? { ...tab, title: target?.title || tab.title } : tab)
        : [...current, { id: sessionId, title: target.title || 'Untitled conversation' }]);
      setActiveChatTabId(sessionId);
    }
    setActiveChatTerminalId(null);
    setActiveChatUtilityId(null);
    switchSession(sessionId);
    navigate(chatSessionPath(sessionId, opensInActiveWorkspace ? activeWorkspaceId : null), { replace: true });
  }

  function handleChatTabSelect(tabId: string) {
    const tab = openChatTabs.find(item => item.id === tabId);
    if (!tab) return;
    pendingChatTempTabRef.current = tab.isTemp ? tab.id : null;
    setActiveChatTabId(tabId);
    setActiveChatTerminalId(null);
    setActiveChatUtilityId(null);
    if (tab.isTemp) {
      switchSession('');
      return;
    }
    switchSession(tabId);
    navigate(`/chat/${tabId}`, { replace: true });
  }

  function activeChatViewKey(): string | null {
    if (activeChatTerminalId) return chatTerminalTabKey(activeChatTerminalId);
    if (activeChatUtilityId) return chatUtilityTabKey(activeChatUtilityId);
    if (activeChatTabId) return chatSessionTabKey(activeChatTabId);
    return activeSessionId ? chatSessionTabKey(activeSessionId) : null;
  }

  function handleChatTabClose(tabId: string) {
    const index = openChatTabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const next = openChatTabs.filter(tab => tab.id !== tabId);
    if (pendingChatTempTabRef.current === tabId) pendingChatTempTabRef.current = null;
    setOpenChatTabs(next);
    setChatTabOrder(current => current.filter(key => key !== chatSessionTabKey(tabId)));
    if (activeChatTabId === tabId) {
      const fallback = next[Math.min(index, next.length - 1)] ?? next[next.length - 1];
      if (fallback) {
        setActiveChatTabId(fallback.id);
        if (fallback.isTemp) {
          switchSession('');
        } else {
          switchSession(fallback.id);
          navigate(`/chat/${fallback.id}`, { replace: true });
        }
      } else {
        setActiveChatTabId(null);
        switchSession('');
      }
    }
  }

  function handleNewChatTab() {
    const id = `temp-chat-${Date.now()}`;
    const tab: ChatSessionTab = { id, title: 'New chat', isTemp: true };
    pendingChatTempTabRef.current = id;
    setOpenChatTabs(current => {
      return [...current, tab];
    });
    setChatTabOrder(current => insertSiblingTab(current, activeChatViewKey(), key => key, chatSessionTabKey(id)));
    setActiveChatTabId(id);
    setActiveChatTerminalId(null);
    setActiveChatUtilityId(null);
    switchSession('');
  }

  function handleChatTerminalSelect(terminalId: string) {
    setActiveChatTerminalId(terminalId);
    setActiveChatUtilityId(null);
  }

  function handleChatTerminalClose(terminalId: string) {
    const index = openChatTerminalTabs.findIndex(tab => tab.id === terminalId);
    if (index < 0) return;
    const next = openChatTerminalTabs.filter(tab => tab.id !== terminalId);
    setOpenChatTerminalTabs(next);
    setChatTabOrder(current => current.filter(key => key !== chatTerminalTabKey(terminalId)));
    if (activeChatTerminalId === terminalId) {
      setActiveChatTerminalId(next[Math.min(index, next.length - 1)]?.id ?? null);
    }
  }

  function handleNewTerminalTab() {
    const source = resolveChatTerminalSource({
      workspaceId: effectiveLinkedWorkspaceId,
      workspaceLabel: activeWorkspace?.branch ?? activeWorkspace?.name ?? activeSession?.repoName,
      repoId: activeSession?.repoId ?? selectedRepo?._id,
      repoLabel: activeSession?.repoName ?? selectedRepo?.name,
    });

    if (source.type === 'workspace') {
      setActiveChatTerminalId(null);
      setActiveChatUtilityId(null);
      openWorkspaceTerminalTab(source.id);
      return;
    }

    chatTerminalCounterRef.current += 1;
    const sequence = chatTerminalCounterRef.current;
    const tab: ChatTerminalTab = {
      id: `terminal-${sequence}`,
      title: `Terminal ${sequence}`,
      sourceType: source.type,
      sourceId: source.id,
      sourceLabel: source.label,
    };
    setOpenChatTerminalTabs(current => [...current, tab]);
    setChatTabOrder(current => insertSiblingTab(current, activeChatViewKey(), key => key, chatTerminalTabKey(tab.id)));
    setActiveChatTerminalId(tab.id);
    setActiveChatUtilityId(null);
  }

  function handleChatUtilitySelect(tabId: string) {
    setActiveChatUtilityId(tabId);
    setActiveChatTerminalId(null);
  }

  function handleChatUtilityClose(tabId: string) {
    const index = openChatUtilityTabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const next = openChatUtilityTabs.filter(tab => tab.id !== tabId);
    setOpenChatUtilityTabs(next);
    setChatTabOrder(current => current.filter(key => key !== chatUtilityTabKey(tabId)));
    if (activeChatUtilityId === tabId) {
      setActiveChatUtilityId(next[Math.min(index, next.length - 1)]?.id ?? null);
    }
  }

  function handleNewUtilityTab(kind: ChatUtilityTab['kind']) {
    if (activeWorkspaceId) {
      handleWorkspaceUtilityTab(kind);
      return;
    }
    const existing = openChatUtilityTabs.find(tab => tab.kind === kind);
    if (existing) {
      handleChatUtilitySelect(existing.id);
      return;
    }
    const tab: ChatUtilityTab = {
      id: kind,
      kind,
      title: kind === 'code-diff' ? 'Code diff' : 'File explorer',
    };
    setOpenChatUtilityTabs(current => [...current, tab]);
    setChatTabOrder(current => insertSiblingTab(current, activeChatViewKey(), key => key, chatUtilityTabKey(tab.id)));
    setActiveChatUtilityId(tab.id);
    setActiveChatTerminalId(null);
    setSidePanelOpen(false);
  }

  function openWorkspaceTerminalTab(workspaceId: string) {
    setActiveChatTerminalId(null);
    setActiveWorkspaceResourceTabKey(null);
    selectBaseResourceTab();
    const existingTerminalIds = openWorkspaceTabs
      .filter(tab => tab.id.kind === 'terminal')
      .map(tab => (tab.id as { kind: 'terminal'; terminalId: string }).terminalId);
    const nextN = Math.max(workspaceTerminalCounterRef.current, maxTerminalSequence(existingTerminalIds)) + 1;
    workspaceTerminalCounterRef.current = nextN;
    setWorkspaceTerminalCounter(nextN);
    const terminalId = 'term-' + nextN;
    const terminalTab: WorkspaceChatTab = {
      id: { kind: 'terminal', terminalId },
      title: 'Terminal ' + nextN,
      isTemp: false,
    };
    pendingWorkspaceTempTabRef.current = { workspaceId, tab: terminalTab };
    setOpenWorkspaceTabs(prev => {
      return insertSiblingTab(prev, activeWorkspaceTabKey, getTabKey, terminalTab);
    });
    setActiveWorkspaceTabKey(getTabKey(terminalTab));
    switchSession('');
    navigate(`/chat?workspaceId=${workspaceId}`, { replace: true });
  }

  function handleWorkspaceTerminalTab() {
    if (!activeWorkspaceId) return;
    openWorkspaceTerminalTab(activeWorkspaceId);
  }

  function handleWorkspaceUtilityTab(kind: 'code-diff' | 'file-explorer') {
    if (!activeWorkspaceId) return;
    setActiveWorkspaceResourceTabKey(null);
    selectBaseResourceTab();
    const key = kind;
    const existing = openWorkspaceTabs.find(tab => getTabKey(tab) === key);
    if (!existing) {
      const tab: WorkspaceChatTab = {
        id: { kind },
        title: kind === 'code-diff' ? 'Code diff' : 'File explorer',
        isTemp: false,
      };
      setOpenWorkspaceTabs(prev => {
        return insertSiblingTab(prev, activeWorkspaceTabKey, getTabKey, tab);
      });
    }
    setActiveWorkspaceTabKey(key);
    setSidePanelOpen(false);
  }

  function handleWorkspaceServersTab() {
    if (!activeWorkspaceId || (activeWorkspace?.services?.length ?? 0) === 0) return;
    setActiveWorkspaceResourceTabKey(null);
    selectBaseResourceTab();
    const serversTab: WorkspaceChatTab = {
      id: { kind: 'servers' },
      title: 'Servers',
      isTemp: false,
    };
    pendingWorkspaceTempTabRef.current = { workspaceId: activeWorkspaceId, tab: serversTab };
    setOpenWorkspaceTabs(prev => prev.some(tab => getTabKey(tab) === 'servers') ? prev : [...prev, serversTab]);
    setActiveWorkspaceTabKey('servers');
    switchSession('');
    navigate(`/chat?workspaceId=${activeWorkspaceId}`, { replace: true });
  }

  useEffect(() => {
    function handleDocumentTabCreate(event: Event) {
      const detail = (event as CustomEvent<{ kind?: 'chat' | 'terminal' | 'code-diff' | 'file-explorer'; workspaceId?: string }>).detail;
      if (!activeWorkspaceId || detail?.workspaceId !== activeWorkspaceId) return;
      if (detail.kind === 'terminal') handleWorkspaceTerminalTab();
      else if (detail.kind === 'code-diff') handleWorkspaceUtilityTab('code-diff');
      else if (detail.kind === 'file-explorer') handleWorkspaceUtilityTab('file-explorer');
      else if (detail.kind === 'chat') handleWorkspaceNewTab();
    }

    window.addEventListener('allen:workspace-tab-create', handleDocumentTabCreate);
    return () => window.removeEventListener('allen:workspace-tab-create', handleDocumentTabCreate);
  });

  function handleCreateSiblingTab(kind: 'chat' | 'terminal' | 'code-diff' | 'file-explorer') {
    if (kind === 'chat') {
      if (activeWorkspaceId) handleWorkspaceNewTab();
      else handleNewChatTab();
      return;
    }
    if (kind === 'terminal') {
      if (activeWorkspaceId) handleWorkspaceTerminalTab();
      else handleNewTerminalTab();
      return;
    }
    handleNewUtilityTab(kind);
  }

  async function handleOpenWorkspaceIde(ide: ExternalIdeId) {
    if (!activeWorkspaceId || !window.allenDesktop?.openWorkspaceIde) return;
    setIdeMenuOpen(false);
    const result = await window.allenDesktop.openWorkspaceIde(activeWorkspaceId, ide);
    if (!result.ok) {
      window.alert(result.error ?? 'Could not open workspace in IDE');
    }
  }

  const linkedWorkspaceId = activeWorkspaceId ?? activeSession?.workspaceId ?? null;
  // Also check spawned agents for a workspace id (covers the case where the workspace is
  // visible in runContext but not yet DB-linked to the chatSession).
  const spawnedWorkspaceId =
    spawnedAgents.find((a) => a.runContext?.workspace?.id)?.runContext?.workspace?.id ?? null;
  const effectiveLinkedWorkspaceId = linkedWorkspaceId ?? spawnedWorkspaceId;

  // Notify parent (e.g., DesignPage) when the effective linked workspace id changes
  useEffect(() => {
    config?.onActiveWorkspaceIdChange?.(effectiveLinkedWorkspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveLinkedWorkspaceId]);

  const linkedWorkspaceBrowseSource = linkedWorkspaceId
    ? {
      id: linkedWorkspaceId,
      name: activeWorkspace?.name ?? activeSession?.repoName ?? 'Workspace',
      repoId: activeWorkspace?.repoId ?? activeSession?.repoId ?? null,
    }
    : null;

  const showResourceRail = Boolean(activeSessionId) || spawnedAgents.length > 0 || Boolean(activeWorkspaceId);

  const displayWorkspaceTabs = openWorkspaceTabs.map(tab => {
    if (tab.id.kind !== 'session') return tab;
    const tabSessionId = tab.id.sessionId;
    const session = sessions.find(s => s._id === tabSessionId);
    if (!session?.title) return tab;
    return { ...tab, title: session.title, titleSource: (session as any).titleSource ?? tab.titleSource };
  });
  const activeWorkspaceTab = openWorkspaceTabs.find(tab => getTabKey(tab) === activeWorkspaceTabKey) ?? null;
  const workspaceBaseTabActive = !activeWorkspaceResourceTabKey;
  const workspaceTerminalActive = workspaceBaseTabActive && activeWorkspaceTab?.id.kind === 'terminal';
  const workspaceTerminalTabs = openWorkspaceTabs.filter((tab): tab is WorkspaceChatTab & { id: { kind: 'terminal'; terminalId: string } } => tab.id.kind === 'terminal');
  const workspaceTerminalTabsOpen = workspaceTerminalTabs.length > 0;
  const workspaceServersActive = workspaceBaseTabActive && activeWorkspaceTab?.id.kind === 'servers';
  const workspaceServersTabOpen = openWorkspaceTabs.some(tab => tab.id.kind === 'servers');
  const workspaceCodeDiffActive = workspaceBaseTabActive && activeWorkspaceTab?.id.kind === 'code-diff';
  const workspaceFileExplorerActive = workspaceBaseTabActive && activeWorkspaceTab?.id.kind === 'file-explorer';
  const workspaceUtilityTabActive = workspaceTerminalActive || workspaceServersActive || workspaceCodeDiffActive || workspaceFileExplorerActive;
  const workspaceHeaderChatTabs = displayWorkspaceTabs.flatMap(tab => (
    tab.id.kind === 'session' || tab.id.kind === 'temp'
      ? [{ id: getTabKey(tab), title: tab.title, isTemp: tab.isTemp }]
      : []
  ));
  const workspaceHeaderTerminalTabs = displayWorkspaceTabs.flatMap(tab => (
    tab.id.kind === 'terminal'
      ? [{ id: getTabKey(tab), title: tab.title, sourceLabel: activeWorkspace?.branch ?? activeWorkspace?.name ?? 'Workspace' }]
      : []
  ));
  const workspaceHeaderUtilityTabs = displayWorkspaceTabs.flatMap(tab => (
    tab.id.kind === 'code-diff' || tab.id.kind === 'file-explorer' || tab.id.kind === 'servers'
      ? [{ id: getTabKey(tab), title: tab.title, kind: tab.id.kind }]
      : []
  ));
  const workspaceHeaderTabOrder = displayWorkspaceTabs.map(tab => {
    const key = getTabKey(tab);
    if (tab.id.kind === 'terminal') return `terminal:${key}`;
    if (tab.id.kind === 'code-diff' || tab.id.kind === 'file-explorer' || tab.id.kind === 'servers') return `utility:${key}`;
    return `chat:${key}`;
  });
  const activeWorkspaceChatId = activeWorkspaceTab?.id.kind === 'session' || activeWorkspaceTab?.id.kind === 'temp'
    ? getTabKey(activeWorkspaceTab)
    : null;
  const activeWorkspaceTerminalId = workspaceTerminalActive && activeWorkspaceTab ? getTabKey(activeWorkspaceTab) : null;
  const activeWorkspaceUtilityId = (workspaceServersActive || workspaceCodeDiffActive || workspaceFileExplorerActive) && activeWorkspaceTab
    ? getTabKey(activeWorkspaceTab)
    : null;
  const activeChatTerminalTab = openChatTerminalTabs.find(tab => tab.id === activeChatTerminalId) ?? null;
  const chatTerminalActive = Boolean(activeChatTerminalTab && !activeWorkspace);
  const chatTerminalTabsOpen = openChatTerminalTabs.length > 0;
  const activeChatUtilityTab = openChatUtilityTabs.find(tab => tab.id === activeChatUtilityId) ?? null;
  const chatUtilityActive = Boolean(activeChatUtilityTab && !activeWorkspace);
  const chatAlternateTabActive = chatTerminalActive || chatUtilityActive;
  const activeConversationTab = openChatTabs.find(tab => tab.id === activeChatTabId) ?? null;
  const activeWorkspaceConversationScope = activeWorkspaceId && activeWorkspaceTab?.id.kind === 'session'
    ? resourceScopeKey('chat', activeWorkspaceTab.id.sessionId)
    : activeWorkspaceId && activeWorkspaceTab?.id.kind === 'temp'
      ? resourceScopeKey('chat', activeWorkspaceTab.id.tempId)
      : null;
  const registeredWorkspaceResourceScopes = workspaceResourceScopeRegistry.workspaceId === activeWorkspaceId
    ? workspaceResourceScopeRegistry.scopeKeys
    : [];
  const visibleWorkspaceResourceScopes = new Set([
    ...registeredWorkspaceResourceScopes,
    ...(activeWorkspaceConversationScope ? [activeWorkspaceConversationScope] : []),
    ...(workspaceResourceScopeKey ? [workspaceResourceScopeKey] : []),
  ]);
  const workspaceResourceTabs: WorkspaceResourceTab[] = activeWorkspaceId ? [
    ...documentTabs
      .filter(tab => visibleWorkspaceResourceScopes.has(tab.scopeKey))
      .map(tab => ({
        key: `document:${tab.scopeKey}:${tab.artifact.artifactId}`,
        kind: 'document' as const,
        title: tab.artifact.filename,
        tooltip: `${tab.artifact.filename} · ${tab.sourceLabel}`,
        scopeKey: tab.scopeKey,
        resourceId: tab.artifact.artifactId,
      })),
    ...fileTabs
      .filter(tab => visibleWorkspaceResourceScopes.has(tab.scopeKey))
      .map(tab => ({
        key: `file:${tab.key}`,
        kind: 'file' as const,
        title: tab.path.split('/').pop() || tab.path,
        tooltip: `${tab.path} · ${tab.sourceLabel}`,
        scopeKey: tab.scopeKey,
        resourceId: tab.key,
      })),
  ] : [];
  const activeWorkspaceResourceTab = workspaceResourceTabs.find(tab => tab.key === activeWorkspaceResourceTabKey) ?? null;
  const activeResourceScopeKey = activeWorkspaceId
    ? activeWorkspaceResourceTab?.scopeKey
      ?? activeWorkspaceConversationScope
      ?? workspaceResourceScopeKey
      ?? resolveChatResourceScope({ workspaceId: activeWorkspaceId, workspaceTab: activeWorkspaceTab?.id ?? null })
    : resolveChatResourceScope({
      chatTabId: activeConversationTab?.id ?? null,
      terminalTabId: activeChatTerminalTab?.id ?? null,
      utilityTabId: activeChatUtilityTab?.id ?? null,
      sessionId: activeSessionId,
    });

  useLayoutEffect(() => {
    if (activeWorkspaceConversationScope) {
      setWorkspaceResourceScopeKey(activeWorkspaceConversationScope);
      setWorkspaceResourceScopeRegistry(current => {
        const scopeKeys = current.workspaceId === activeWorkspaceId ? current.scopeKeys : [];
        if (scopeKeys.includes(activeWorkspaceConversationScope)) {
          return current.workspaceId === activeWorkspaceId ? current : { workspaceId: activeWorkspaceId, scopeKeys };
        }
        return { workspaceId: activeWorkspaceId, scopeKeys: [...scopeKeys, activeWorkspaceConversationScope] };
      });
    } else if (!activeWorkspaceId) {
      setWorkspaceResourceScopeKey(null);
      setActiveWorkspaceResourceTabKey(null);
      setWorkspaceResourceScopeRegistry({ workspaceId: null, scopeKeys: [] });
    }
  }, [activeWorkspaceConversationScope, activeWorkspaceId]);

  // Scope resource tabs before the browser paints a newly selected sibling.
  // This prevents a document or file from the previous conversation appearing
  // even for a single frame in a new, unsent chat.
  useLayoutEffect(() => {
    setActiveResourceScope(activeResourceScopeKey);
  }, [activeResourceScopeKey, setActiveResourceScope]);

  const workspaceSelection = resourceSelections[activeResourceScopeKey];
  useLayoutEffect(() => {
    if (!activeWorkspaceId || activeWorkspaceResourceTabKey) return;
    const selectedResource = workspaceResourceTabs.find(tab => (
      tab.scopeKey === activeResourceScopeKey
      && (tab.kind === 'document'
        ? tab.resourceId === workspaceSelection?.activeArtifactId
        : tab.resourceId === workspaceSelection?.activeFileKey)
    ));
    if (selectedResource) setActiveWorkspaceResourceTabKey(selectedResource.key);
  }, [
    activeResourceScopeKey,
    activeWorkspaceId,
    activeWorkspaceResourceTabKey,
    workspaceResourceTabs,
    workspaceSelection?.activeArtifactId,
    workspaceSelection?.activeFileKey,
  ]);
  const activeWorkspaceResourceKey = activeWorkspaceResourceTab?.key ?? null;

  function handleWorkspaceResourceSelect(key: string) {
    const tab = workspaceResourceTabs.find(item => item.key === key);
    if (!tab) return;
    setActiveWorkspaceResourceTabKey(tab.key);
    setWorkspaceResourceScopeKey(tab.scopeKey);
    if (tab.kind === 'document') selectDocument(tab.resourceId, tab.scopeKey);
    else selectFile(tab.resourceId, tab.scopeKey);
  }

  function handleWorkspaceResourceClose(key: string) {
    const tab = workspaceResourceTabs.find(item => item.key === key);
    if (!tab) return;
    const closingIndex = workspaceResourceTabs.findIndex(item => item.key === key);
    const remaining = workspaceResourceTabs.filter(item => item.key !== key);
    if (tab.kind === 'document') closeDocument(tab.resourceId, tab.scopeKey);
    else closeFile(tab.resourceId, tab.scopeKey);
    if (activeWorkspaceResourceTabKey !== key) return;
    const fallback = remaining[Math.min(closingIndex, remaining.length - 1)] ?? remaining[remaining.length - 1];
    if (fallback) handleWorkspaceResourceSelect(fallback.key);
    else {
      setActiveWorkspaceResourceTabKey(null);
      if (activeWorkspaceConversationScope) selectBaseResourceTab(activeWorkspaceConversationScope);
      handleAllResourceTabsClosed();
    }
  }

  const canOpenWorkspaceIde = Boolean(activeWorkspaceId && window.allenDesktop?.openWorkspaceIde);
  const archivedWorkspace = activeSession?.archivedWorkspace;
  const repoBrowseSource = archivedWorkspace?.repoId
    ? { id: archivedWorkspace.repoId, name: archivedWorkspace.repoName ?? archivedWorkspace.name, path: archivedWorkspace.repoPath }
    : activeSession?.repoId
      ? { id: activeSession.repoId, name: activeSession.repoName, path: activeSession.repoPath }
      : selectedRepo?._id
        ? { id: selectedRepo._id, name: selectedRepo.name, path: selectedRepo.path }
        : null;

  async function handleOpenFileReference(path: string) {
    const scopeKey = activeResourceScopeKey;
    let result: any | null = null;
    let sourceKind: 'workspace' | 'repo' = 'repo';
    let sourceId = repoBrowseSource?.id ?? 'unavailable';
    let sourceLabel = repoBrowseSource?.name || 'Repository unavailable';

    if (activeWorkspaceId) {
      try {
        result = await workspacesApi.getFile(activeWorkspaceId, path);
        sourceKind = 'workspace';
        sourceId = activeWorkspaceId;
        sourceLabel = activeWorkspace?.name || activeWorkspace?.branch || 'Current workspace';
      } catch {
        // A chat may reference a file that exists only on the registered repo.
      }
    }

    if (!result && repoBrowseSource?.id) {
      try {
        result = await reposApi.getFile(repoBrowseSource.id, path);
        sourceKind = 'repo';
        sourceId = repoBrowseSource.id;
        sourceLabel = repoBrowseSource.name || 'Selected repository';
      } catch {
        // Open a clear unavailable state below instead of silently doing nothing.
      }
    }

    if (!result) {
      openFile({
        path,
        content: `Unable to open ${path}.\n\nThe file was not found in the active workspace or selected repository.`,
        sourceKind,
        sourceId,
        sourceLabel,
        language: 'plaintext',
        scopeKey,
      });
      return;
    }

    const kind = result.isVideo ? 'video' : result.isImage ? 'image' : mediaKindForPath(path);
    if (kind && (result.isImage || result.isVideo)) {
      const mimeType = result.mimeType || mimeTypeForMediaPath(path, kind);
      openMedia({
        kind,
        title: path.split('/').pop() || path,
        src: `data:${mimeType};base64,${result.content}`,
        mimeType: mimeType ?? undefined,
      });
      return;
    }

    openFile({
      path,
      content: String(result.content ?? ''),
      sourceKind,
      sourceId,
      sourceLabel,
      scopeKey,
    });
  }

  const composerDisabled = activeSession?.source === 'slack' || Boolean(config?.disabled) || Boolean(activeSession?.isImported);
  const { dragActive, dropProps } = useFileDropZone(
    (files) => chatInputRef.current?.uploadFiles(files),
    composerDisabled,
  );

  return (
    <div className={`chat-page-shell v8-chat-detail ${sidePanelOpen ? 'with-run-sidebar' : ''} ${activeWorkspace ? 'v8-workspace-detail' : ''}`} {...dropProps}>
      {dragActive && <FileDropOverlay />}
      <div className="chat-main-shell">
      {!isDesignMode && (
        <ChatDetailHeader
          title={activeSession?.title || 'Untitled conversation'}
          onExport={activeSessionId ? () => setExportDialogOpen(true) : undefined}
          teamClassification={displayedTeamClassification}
          onTeamClassificationChange={activeSessionId ? handleTeamClassificationChange : undefined}
          classificationDisabled={composerDisabled}
          chatTabs={activeWorkspace ? workspaceHeaderChatTabs : openChatTabs}
          activeChatId={activeWorkspace ? activeWorkspaceChatId : activeChatTabId ?? activeSessionId}
          onChatSelect={activeWorkspace ? handleWorkspaceTabSelect : handleChatTabSelect}
          onChatClose={activeWorkspace ? handleWorkspaceTabClose : handleChatTabClose}
          terminalTabs={activeWorkspace
            ? workspaceHeaderTerminalTabs
            : openChatTerminalTabs.map(tab => ({ id: tab.id, title: tab.title, sourceLabel: tab.sourceLabel }))}
          activeTerminalId={activeWorkspace ? activeWorkspaceTerminalId : activeChatTerminalId}
          onTerminalSelect={activeWorkspace ? handleWorkspaceTabSelect : handleChatTerminalSelect}
          onTerminalClose={activeWorkspace ? handleWorkspaceTabClose : handleChatTerminalClose}
          utilityTabs={activeWorkspace ? workspaceHeaderUtilityTabs : openChatUtilityTabs}
          tabOrder={activeWorkspace ? workspaceHeaderTabOrder : chatTabOrder}
          activeUtilityId={activeWorkspace ? activeWorkspaceUtilityId : activeChatUtilityId}
          onUtilitySelect={activeWorkspace ? handleWorkspaceTabSelect : handleChatUtilitySelect}
          onUtilityClose={activeWorkspace ? handleWorkspaceTabClose : handleChatUtilityClose}
          onBaseChatSelect={() => {
            if (activeWorkspace) {
              setActiveWorkspaceResourceTabKey(null);
              if (activeWorkspaceConversationScope) selectBaseResourceTab(activeWorkspaceConversationScope);
              return;
            }
            setActiveChatTerminalId(null);
            setActiveChatUtilityId(null);
          }}
          resourceTabs={activeWorkspace ? workspaceResourceTabs : undefined}
          activeResourceKey={activeWorkspace ? activeWorkspaceResourceKey : undefined}
          onResourceSelect={activeWorkspace ? handleWorkspaceResourceSelect : undefined}
          onResourceClose={activeWorkspace ? handleWorkspaceResourceClose : undefined}
          onNewChat={activeWorkspace ? handleWorkspaceNewTab : handleNewChatTab}
          onNewTerminal={activeWorkspace ? handleWorkspaceTerminalTab : handleNewTerminalTab}
          onOpenCodeDiff={() => handleNewUtilityTab('code-diff')}
          onOpenFileExplorer={() => handleNewUtilityTab('file-explorer')}
        />
      )}

      {/* Workspace load error toast (EC-02) */}
      {workspaceLoadError && (
        <div className="p-3 text-sm text-yellow-700 bg-yellow-50 border-b border-yellow-200">
          {workspaceLoadError}
        </div>
      )}

      {/* Workspace terminals stay mounted while switching tabs so each xterm remains interactive. */}
      {workspaceTerminalTabsOpen && activeWorkspaceId && (
        <div className={`${workspaceTerminalActive ? 'relative flex-1 min-h-0' : 'fixed -left-[10000px] top-0 h-[720px] w-[1100px] pointer-events-none opacity-0'}`}>
          {workspaceTerminalTabs.map(tab => {
            const tabKey = getTabKey(tab);
            const active = tabKey === activeWorkspaceTabKey;
            return (
              <div key={tabKey} className={`${active ? 'absolute inset-0' : 'absolute inset-0 invisible pointer-events-none'}`}>
                <XTerminal workspaceId={activeWorkspaceId} terminalId={`chat-tab-${activeWorkspaceId}-${tab.id.terminalId}`} className="h-full" />
              </div>
            );
          })}
        </div>
      )}

      {/* Messages */}

      {/* Servers tab — kept alive off-screen when not active (moved outside terminal gate to mirror terminal keep-alive) */}
      {workspaceServersTabOpen && activeWorkspaceId && (
        <div className={`${workspaceServersActive ? 'flex-1 min-h-0' : 'fixed -left-[10000px] top-0 h-[720px] w-[1100px] pointer-events-none opacity-0'}`}>
          <WorkspaceServersTab
            workspaceId={activeWorkspaceId}
            services={activeWorkspace?.services ?? []}
          />
        </div>
      )}

      {(workspaceCodeDiffActive || workspaceFileExplorerActive) && activeWorkspaceId && (
        <div className="flex-1 min-h-0 overflow-hidden bg-app-muted p-3">
          <FileChangesPanel
            runs={spawnedAgents}
            rootType="chat"
            rootId={activeSessionId}
            workspaceBrowseSource={linkedWorkspaceBrowseSource}
            repoBrowseSource={repoBrowseSource}
            activeView={workspaceCodeDiffActive ? 'changes' : 'files'}
            presentation="tab"
          />
        </div>
      )}

      {/* Chat content — kept alive off-screen when terminal or servers tab is active, mirroring terminal keep-alive */}
      <div className={workspaceUtilityTabActive
        ? 'fixed -left-[10000px] top-0 h-[720px] w-[1100px] pointer-events-none opacity-0'
        : 'flex-1 min-h-0 flex flex-col'
      }>
        {isDesignMode && (
          <header className="v8-design-threadhead">
            <button
              type="button"
              onClick={() => navigate(searchParams.get('ws') ? `/studio/workspaces/${searchParams.get('ws')}` : '/studio')}
              aria-label="Back to Allen Design workspace"
            >
              <ArrowLeft />
            </button>
            <b>{activeSession?.title || 'New design chat'}</b>
            <span className="v8-design-mode-tag"><i /> design mode</span>
            <span className="spacer" />
            {activeSessionId && (
              <TeamClassificationSelect
                compact
                value={displayedTeamClassification}
                onChange={handleTeamClassificationChange}
                disabled={composerDisabled}
                ariaLabel="Conversation team"
              />
            )}
            <button type="button" aria-label="Conversation menu" title="Conversation menu"><MoreHorizontal /></button>
          </header>
        )}
        {teamClassificationError && (
          <div className="team-classification-error" role="alert">{teamClassificationError}</div>
        )}
        {!isDesignMode && (
          <>
            {activeSession?.isImported && (
              <ImportedChatBanner session={activeSession} />
            )}
          </>
        )}

        {/* Non-workspace terminals stay mounted so shell state survives tab switches. */}
        {chatTerminalTabsOpen && !activeWorkspace && (
          <div className={`${chatTerminalActive ? 'relative flex-1 min-h-0' : 'fixed -left-[10000px] top-0 h-[720px] w-[1100px] pointer-events-none opacity-0'}`}>
            {openChatTerminalTabs.map(tab => {
              const active = tab.id === activeChatTerminalId;
              return (
                <div key={tab.id} className={`${active ? 'absolute inset-0' : 'absolute inset-0 invisible pointer-events-none'}`}>
                  <XTerminal
                    workspaceId={tab.sourceId}
                    sourceType={tab.sourceType}
                    terminalId={`chat-tab-${tab.sourceType}-${tab.sourceId}-${tab.id}`}
                    className="h-full"
                  />
                </div>
              );
            })}
          </div>
        )}

        {chatUtilityActive && activeChatUtilityTab && (
          <div className="flex-1 min-h-0 overflow-hidden bg-app-muted p-3">
            <FileChangesPanel
              runs={spawnedAgents}
              rootType="chat"
              rootId={activeSessionId}
              workspaceBrowseSource={linkedWorkspaceBrowseSource}
              repoBrowseSource={repoBrowseSource}
              activeView={activeChatUtilityTab.kind === 'code-diff' ? 'changes' : 'files'}
              presentation="tab"
            />
          </div>
        )}

        {/* Loading indicator: only when loading messages for an existing session (not blank new tabs) */}
        {!chatAlternateTabActive && loadingMessages && messages.length === 0 && !streaming && activeSessionId && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-xs text-theme-subtle animate-pulse">Loading...</div>
          </div>
        )}

        {/* Empty state: only when no session is active (new blank tab or no chats yet) */}
        {!chatAlternateTabActive && messages.length === 0 && !activeSessionId && !streaming && !loadingMessages && (
          isDesignMode ? (
            <div className="flex flex-col items-center justify-center flex-1 px-8 py-12 text-center gap-4" aria-label="Design empty state">
              <div className="flex flex-col items-center gap-2 mb-2">
                <h2 className="text-[18px] font-semibold text-theme-primary">Design with Allen</h2>
                <p className="text-[13px] text-theme-muted max-w-sm">
                  Describe what you'd like to design or build. Allen will generate specs, prototypes, and iterate with you.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  'Design a dashboard for analytics',
                  'Build a login/signup flow',
                  'Create a responsive landing page',
                  'Design a mobile settings screen',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => handleSuggestionClick(prompt)}
                    className="rounded-full border border-app bg-app-card px-3 py-1.5 text-[12px] text-theme-secondary hover:bg-app-muted transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-theme-subtle mt-2">
                Use the <strong>Preview</strong> panel on the right to set up your design repo and live preview.
              </p>
            </div>
          ) : (
            <div className="chat-empty-stream" aria-label="New conversation" />
          )
        )}

        {/* ChatMessageList: kept mounted in DOM to preserve scroll state.
            Hidden (display:none) during initial load to avoid layout conflict with loading indicator above.
            When hidden is removed after load, instant scroll (PI-1 fix) ensures no visible animation. */}
        {!chatAlternateTabActive && (activeSessionId || messages.length > 0 || streaming) && (
          <div className={loadingMessages && messages.length === 0 && !streaming ? 'hidden' : 'flex-1 min-h-0 flex flex-col'}>
            <ChatMessageList
              messages={messages}
              streamText={streamText}
              thinkingText={thinkingText}
              streaming={streaming}
              activeToolCalls={activeToolCalls}
              agentReports={agentReports}
              spawnedAgents={spawnedAgents}
              pendingUserQuestion={pendingUserQuestion}
              onAnswerUserQuestion={activeSession?.isImported ? undefined : answerUserQuestion}
              onAnswerWorkflowIntervention={activeSession?.isImported ? undefined : answerWorkflowIntervention}
              activeAgent={activeSession?.activeAgent}
              onSuggestionClick={handleSuggestionClick}
              onSaveToLearnings={handleSaveToLearnings}
              onOpenExecutionsPanel={() => openSidePanel('tasks')}
              onOpenFilesPanel={() => openSidePanel('changes', 'changes')}
              watchers={watchers}
              conversationTitle={activeSession?.title || 'Untitled conversation'}
              conversationTag={activeSession?.repoName}
              conversationWorkflow={activeWorkflowName}
              documentCount={documentCount}
              provider={activeSession?.provider}
              resourceScopeKey={activeResourceScopeKey}
              model={activeSession?.model}
              onOpenFileReference={handleOpenFileReference}
              onOpenChatReference={handleOpenChatReference}
              onOpenInternalReference={path => navigate(path)}
            />
          </div>
        )}
      </div>
      {/* Input */}
      {!workspaceUtilityTabActive && !chatAlternateTabActive && <div className="chat-input-dock">
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
                            aria-label="Save"
                          >
                            <Check className="w-3.5 h-3.5" />
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
                            aria-label="Cancel edit"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          {streaming && (
                            <button
                              type="button"
                              onClick={() => { void handleSteerQueued(item); }}
                              title="Steer (inject this message into the running turn)"
                              aria-label="Steer"
                            >
                              <Navigation2 className="w-3.5 h-3.5" />
                            </button>
                          )}
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
                            aria-label="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
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
                            aria-label="Remove"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
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
          controlPresentation="v8-chat"
          disabled={composerDisabled}
          disabledReason={
            config?.disabled && config?.disabledReason
              ? config.disabledReason
              : activeSession?.source === 'slack'
              ? 'This conversation is managed via Slack. Reply in the Slack thread to continue.'
              : activeSession?.isImported
              ? (activeSession.replayLabel || 'Imported replay (read-only)')
              : undefined
          }
          providers={composerProviders}
          selectedProvider={activeSession?.provider ?? selectedProvider}
          selectedAgent={activeSession?.activeAgent ?? selectedAgent}
          selectedModel={activeSession?.model ?? selectedModel}
          modelLocked={modelLocked}
          modelLockReason={modelLockReason}
          onProviderChange={handleProviderChange}
          repos={repos}
          selectedRepoName={archivedWorkspace ? `${archivedWorkspace.name ?? 'Workspace'} deleted` : activeSession?.repoName ?? selectedRepo?.name ?? null}
          repoLocked={!!activeSessionId}
          hideRepoSelector={config?.hideRepoSelector}
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
          hidePlanMode={config?.hidePlanMode}
          maxVisibleLines={4}
          placeholder={config?.placeholder}
          extraControls={config?.forcedAgent ? null : (() => {
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
      </div>}

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
      {!isDesignMode && (
        <DocumentTabHost
          workspaceId={activeWorkspaceId}
          onAllResourcesClosed={handleAllResourceTabsClosed}
          onCreateTab={handleCreateSiblingTab}
          showTabStrip={false}
          visible={!activeWorkspace || Boolean(activeWorkspaceResourceKey)}
        />
      )}
      </div>
      {!isDesignMode && showResourceRail && (
        <nav className="chat-resource-rail" aria-label="Chat resources">
          <button
            type="button"
            className={sidePanelOpen ? 'active' : ''}
            onClick={() => {
              documentsSidebarAutoHiddenRef.current = false;
              setSidePanelOpen(value => !value);
            }}
            title={sidePanelOpen ? 'Close resources' : 'Open resources'}
            data-tooltip={sidePanelOpen ? 'Close resources' : 'Open resources'}
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
          <button type="button" className={sidePanelOpen && sidePanelTab === 'tasks' ? 'active' : ''} onClick={() => openSidePanel('tasks')} title="Task sequence" data-tooltip="Task sequence">
            <ListTree className="h-4 w-4" />
          </button>
          <button type="button" className={sidePanelOpen && sidePanelTab === 'executions' ? 'active' : ''} onClick={() => openSidePanel('executions')} title="Executions" data-tooltip="Executions">
            <Activity className="h-4 w-4" />
          </button>
          <button type="button" className={sidePanelOpen && sidePanelTab === 'documents' ? 'active' : ''} onClick={() => openSidePanel('documents')} title="Documents" data-tooltip="Documents">
            <FileText className="h-4 w-4" />
          </button>
          <button type="button" className={sidePanelOpen && sidePanelTab === 'changes' ? 'active' : ''} onClick={() => openSidePanel('changes', 'changes')} title="Code changes" data-tooltip="Code changes">
            <Code2 className="h-4 w-4" />
          </button>
          {activeWorkspaceId && (
            <button type="button" className={activeWorkspaceTabKey?.startsWith('terminal-') ? 'active' : ''} onClick={handleWorkspaceTerminalTab} title="Terminal" data-tooltip="Terminal">
              <Terminal className="h-4 w-4" />
            </button>
          )}
          {canOpenWorkspaceIde && (
            <div className={`chat-ide-menu-wrap ${ideMenuOpen ? 'expanded' : ''}`} ref={ideMenuRef}>
              <button
                type="button"
                className={ideMenuOpen ? 'active' : ''}
                onClick={() => setIdeMenuOpen(value => !value)}
                title="Open workspace in IDE"
                data-tooltip="Open in IDE"
                aria-haspopup="menu"
                aria-expanded={ideMenuOpen}
              >
                <AppWindow className="h-4 w-4" />
              </button>
              <div className="chat-ide-inline-options" role="menu" aria-label="Open workspace in IDE">
                {IDE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitem"
                      className="chat-ide-option-button"
                      title={`Open in ${option.label}`}
                      data-tooltip={option.label}
                      aria-label={`Open workspace in ${option.label}`}
                      onClick={() => void handleOpenWorkspaceIde(option.id)}
                    >
                      <Icon />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {activeWorkspaceId && (activeWorkspace?.services?.length ?? 0) > 0 && (
            <button type="button" className={activeWorkspaceTabKey === 'servers' ? 'active' : ''} onClick={handleWorkspaceServersTab} title="Servers" data-tooltip="Servers">
              <Server className="h-4 w-4" />
            </button>
          )}
          <button type="button" className={sidePanelOpen && sidePanelTab === 'context' ? 'active' : ''} onClick={() => openSidePanel('context')} title="Context" data-tooltip="Context">
            <BookOpen className="h-4 w-4" />
          </button>
        </nav>
      )}
      {!isDesignMode && (
        <ChatRunSidebar
          runs={spawnedAgents}
          rootType="chat"
          rootId={activeSessionId}
          workspaceBrowseSource={linkedWorkspaceBrowseSource}
          repoBrowseSource={repoBrowseSource}
          open={sidePanelOpen}
          activeTab={sidePanelTab}
          onTabChange={handleSidePanelTabChange}
          filesViewRequest={filesViewRequest}
          artifactRefreshKey={artifactRefreshKey}
          onDocumentOpened={handleDocumentOpenedFromSidebar}
          onAnswerWorkflowIntervention={answerWorkflowIntervention}
          onClose={() => {
            documentsSidebarAutoHiddenRef.current = false;
            setSidePanelOpen(false);
          }}
        />
      )}
      {activeSessionId && (
        <ChatExportDialog
          sessionId={activeSessionId}
          sessionTitle={activeSession?.title || 'Conversation'}
          isOpen={exportDialogOpen}
          onClose={() => setExportDialogOpen(false)}
        />
      )}
    </div>
  );
}
