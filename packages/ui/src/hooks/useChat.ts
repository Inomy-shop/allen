import { useState, useEffect, useCallback, useRef } from 'react';
import { chat as api, executions as executionsApi, interventions as interventionsApi, executionWatchers as executionWatchersApi, authHeaders, type RunStatus, type TokenUsageInfo, type WatcherUIDoc } from '../services/api';
import { useAuthStore, type AuthUser } from '../stores/authStore';
import { useExecutionStore } from '../stores/executionStore';
import {
  reconcileChildAgentsWithSnapshots,
  reconcileRunContextWithSnapshot,
  runSeedFromSnapshot,
} from './chatExecutionState';
import { mergeWatcherDocuments } from './watcherState';

/** Maximum number of automatic reconnect attempts on a transient stream error. */
export const MAX_RECONNECT_ATTEMPTS = 3;
const MAX_LIVE_ACTIVITY_ITEMS = 300;
const MAX_AGENT_REPORTS = 100;
const MAX_LIVE_TOOL_CALLS = 100;
const MAX_ARCHIVED_ACTIVITY_ITEMS = 5000;

function appendCapped<T>(items: T[] | undefined, item: T, max: number): T[] {
  const next = [...(items ?? []), item];
  return next.length > max ? next.slice(next.length - max) : next;
}

function runActivityArchiveKey(executionId: string): string {
  return `allen-run-activity:${executionId}`;
}

function archiveRunActivity(executionId: string, items: SpawnedAgent['activity']): void {
  if (items.length === 0) return;
  try {
    const key = runActivityArchiveKey(executionId);
    const existing = JSON.parse(sessionStorage.getItem(key) ?? '[]') as SpawnedAgent['activity'];
    const next = [...existing, ...items].slice(-MAX_ARCHIVED_ACTIVITY_ITEMS);
    sessionStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Best effort: keeping React state capped is the important part.
  }
}

function appendRunActivity(run: SpawnedAgent, item: SpawnedAgent['activity'][number]): SpawnedAgent['activity'] {
  const next = [...run.activity, item];
  if (next.length <= MAX_LIVE_ACTIVITY_ITEMS) return next;
  archiveRunActivity(run.executionId, next.slice(0, next.length - MAX_LIVE_ACTIVITY_ITEMS));
  return next.slice(-MAX_LIVE_ACTIVITY_ITEMS);
}

/**
 * Check whether the backend session is still streaming.
 * Returns false on any error so callers can safely fall through to
 * the "show failed message" path.
 */
export async function checkIsStreaming(sessionId: string): Promise<boolean> {
  try {
    const { streaming } = await api.isStreaming(sessionId);
    return streaming;
  } catch {
    return false;
  }
}

/** Tiny sleep helper used for reconnect back-off. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function sessionReconnectDelay(attempt: number): number {
  return Math.min(5_000, 500 * (2 ** Math.min(Math.max(attempt - 1, 0), 4)));
}

/** Consume one chat SSE response. Resolving means the server closed the
 * response, which the caller treats as a reconnect signal rather than a
 * terminal chat state. */
export async function consumeSessionEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: string, data: unknown) => void,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  while (!shouldStop()) {
    const { done, value } = await reader.read();
    if (done || shouldStop()) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
      else if (line.startsWith('data: ') && currentEvent) {
        try { onEvent(currentEvent, JSON.parse(line.slice(6))); } catch { /* ignore malformed event */ }
        currentEvent = '';
      }
    }
  }
}

export interface ChatSession {
  _id: string;
  title: string;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt: string;
  totalCostUsd: number;
  provider: string;
  model?: string;
  llmSessionId?: string;
  activeAgent?: string | null;
  /** Session-level overrides for the agent's model / reasoning effort / plan mode. */
  agentOverrides?: {
    provider?: 'claude' | 'codex' | (string & {}) | null;
    model?: string | null;
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
    planMode?: boolean | null;
  };
  /** Repo associated with this session (set at creation time, immutable). */
  repoId?: string;
  repoPath?: string;
  repoName?: string;
  workspaceId?: string;
  archivedWorkspace?: {
    id: string;
    name?: string;
    repoId?: string;
    repoName?: string;
    repoPath?: string;
    branch?: string;
    baseBranch?: string;
    prNumber?: number;
    prUrl?: string;
    archivedAt?: string;
  };
  /** Where the session was created from. Slack-sourced sessions are read-only in the UI. */
  source?: 'ui' | 'slack';
  /** Slack thread metadata for sessions sourced from Slack. */
  slackContext?: {
    channelId: string;
    threadTs: string;
    teamId: string;
  };
  /** Whether this session is an imported replay bundle. */
  isImported?: boolean;
  /** Bundle ID the session was imported from. */
  importBundleId?: string;
  /** Source environment metadata from the origin Allen instance. */
  sourceEnvironment?: { appName: string; appVersion: string; hostname?: string; exportedAt?: string };
  /** Original session ID on the source instance. */
  sourceSessionId?: string;
  /** Human-readable label shown in the UI, e.g. "Imported replay". */
  replayLabel?: string;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  durationMs: number;
  timestamp: string;
  toolUseId?: string;
}

export interface ChatMessage {
  _id?: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'streaming' | 'failed' | 'interrupted' | 'cancelled';
  senderUserId?: string;
  senderName?: string;
  senderEmail?: string;
  senderSource?: 'ui' | 'slack' | 'system';
  costUsd?: number;
  durationMs?: number;
  tokenUsage?: TokenUsageInfo | null;
  error?: string;
  toolCalls?: ToolCallRecord[];
  thinkingText?: string;
  hidden?: boolean;
  /** Present when this user message was a `/skill <name>` load command —
   *  rendered as a compact skill slice instead of a text bubble. */
  skillLoad?: { name: string; displayName: string };
  createdAt: string;
}

function currentSenderFields(user: AuthUser | null): Pick<ChatMessage, 'senderUserId' | 'senderName' | 'senderEmail' | 'senderSource'> {
  if (!user) return {};
  return {
    senderUserId: user.id,
    senderName: user.name?.trim() || user.email.split('@')[0],
    senderEmail: user.email,
    senderSource: 'ui',
  };
}

/** Active tool call being streamed */
export interface ActiveToolCall {
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'completed';
  result?: Record<string, unknown>;
  durationMs?: number;
  toolUseId?: string;
}

/** Live activity entry for an agent thread */
/** Spawned agent execution — live tracking */
export interface SpawnedAgent {
  executionId: string;
  sourceMessageId?: string;
  parentExecutionId?: string | null;
  spawnDepth?: number | null;
  agent: string;
  prompt: string;
  status: 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';
  activity: { type: string; tool?: string; command?: string; content?: string; timestamp: number }[];
  kind?: 'agent' | 'lead' | 'workflow';
  durationMs?: number;
  toolCount?: number;
  response?: string;
  runContext?: RunStatus;
}

export interface WorkflowInterventionAnswer {
  executionId: string;
  interventionId?: string;
  actionId?: string;
  decision: 'approve' | 'request_changes' | 'reject' | 'answer';
  fieldValues?: Record<string, unknown>;
  feedback?: string;
  answer?: string;
  humanNodeName?: string;
}

/** Progress report from an agent */
export interface AgentReport {
  agent: string;
  message: string;
  status: string;
  timestamp: string;
}

interface ChatCancelResponse {
  messageId?: string;
  content?: string;
  restoreDraft?: string;
  cancelledExecutions?: Array<{ id?: string; workflowName?: string; status?: string }>;
}

function upsertSpawnedRun(prev: SpawnedAgent[], run: Omit<Partial<SpawnedAgent>, 'executionId'> & { executionId: string }): SpawnedAgent[] {
  const existing = prev.find(s => s.executionId === run.executionId);
  if (!existing) {
    return [...prev, {
      executionId: run.executionId,
      sourceMessageId: run.sourceMessageId,
      parentExecutionId: run.parentExecutionId,
      spawnDepth: run.spawnDepth,
      agent: run.agent ?? 'Routed run',
      prompt: run.prompt ?? '',
      status: run.status ?? 'running',
      activity: run.activity ?? [],
      kind: run.kind,
      durationMs: run.durationMs,
      toolCount: run.toolCount,
      response: run.response,
      runContext: run.runContext,
    }];
  }
  return prev.map(s =>
    s.executionId === run.executionId
      ? {
          ...s,
          ...run,
          parentExecutionId: run.parentExecutionId ?? s.parentExecutionId,
          spawnDepth: run.spawnDepth ?? s.spawnDepth,
          activity: run.activity ?? s.activity,
        }
      : s,
  );
}

function toolRunFromResult(tool: string, result: Record<string, unknown> | undefined): SpawnedAgent | null {
  if (!result) return null;
  const normalizedTool = tool.split('__').pop() ?? tool;
  const isRunTool = /^(run_workflow|spawn_agent)$/.test(normalizedTool);
  if (!isRunTool) return null;

  const executionId = typeof result.execution_id === 'string'
    ? result.execution_id
    : typeof result.id === 'string'
      ? result.id
      : undefined;
  if (!executionId) return null;

  const isWorkflow = /run_workflow/i.test(normalizedTool)
    || typeof result.workflow_name === 'string'
    || typeof result.workflowName === 'string';
  const label =
    (typeof result.workflow_name === 'string' && result.workflow_name)
    || (typeof result.workflowName === 'string' && result.workflowName)
    || (typeof result.agent_name === 'string' && result.agent_name)
    || (typeof result.agent === 'string' && result.agent)
    || (isWorkflow ? 'Workflow run' : 'Agent run');

  return {
    executionId,
    agent: label,
    prompt: typeof result.message === 'string' ? result.message : normalizedTool,
    status: (typeof result.status === 'string' ? result.status : 'running') as SpawnedAgent['status'],
    activity: [],
    kind: isWorkflow ? 'workflow' : 'agent',
  };
}

function activeToolCallsFromRecords(records?: ToolCallRecord[]): ActiveToolCall[] {
  return (records ?? []).map(record => ({
    tool: record.tool,
    args: record.args ?? {},
    status: 'completed' as const,
    result: record.result,
    durationMs: record.durationMs,
    toolUseId: record.toolUseId,
  }));
}

function mergeToolStart(prev: ActiveToolCall[], data: any): ActiveToolCall[] {
  const toolUseId = data.toolUseId ?? data.tool_use_id;
  if (toolUseId && prev.some(tc => tc.toolUseId === toolUseId)) return prev;
  return [
    ...prev,
    { tool: data.tool, args: data.args ?? {}, status: 'running' as const, toolUseId },
  ];
}

function mergeToolResult(prev: ActiveToolCall[], data: any): ActiveToolCall[] {
  const toolUseId = data.toolUseId ?? data.tool_use_id;
  let matched = false;
  const next = prev.map(tc => {
    const isMatch = toolUseId
      ? tc.toolUseId === toolUseId
      : tc.tool === data.tool && tc.status === 'running';
    if (!isMatch) return tc;
    matched = true;
    return {
      ...tc,
      status: 'completed' as const,
      args: data.args ?? tc.args,
      result: data.result,
      durationMs: data.durationMs,
      toolUseId: tc.toolUseId ?? toolUseId,
    };
  });
  if (matched) return next;
  return [
    ...next,
    {
      tool: data.tool,
      args: data.args ?? {},
      status: 'completed' as const,
      result: data.result,
      durationMs: data.durationMs,
      toolUseId,
    },
  ];
}

function runsFromMessages(messages: ChatMessage[]): SpawnedAgent[] {
  const seen = new Set<string>();
  const runs: SpawnedAgent[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const run = toolRunFromResult(call.tool, call.result);
      if (!run || seen.has(run.executionId)) continue;
      seen.add(run.executionId);
      run.sourceMessageId = message._id;
      runs.push(run);
    }
  }
  return runs;
}

function mergeSpawnedRuns(primary: SpawnedAgent[], secondary: SpawnedAgent[]): SpawnedAgent[] {
  const byId = new Map<string, SpawnedAgent>();
  for (const run of [...primary, ...secondary]) {
    const existing = byId.get(run.executionId);
    byId.set(run.executionId, existing ? { ...existing, ...run, activity: run.activity ?? existing.activity } : run);
  }
  return [...byId.values()];
}

function runsFromPersistedExecutions(items: Array<{
  executionId: string;
  sourceMessageId?: string | null;
  agent?: string | null;
  prompt?: string | null;
  status?: string | null;
  kind?: SpawnedAgent['kind'];
  runContext?: RunStatus | null;
}>): SpawnedAgent[] {
  return items
    .filter(item => item.executionId)
    .map(item => ({
      executionId: item.executionId,
      sourceMessageId: item.sourceMessageId ?? item.runContext?.chat?.parentMessageId ?? undefined,
      parentExecutionId: item.runContext?.execution?.parentExecutionId ?? undefined,
      spawnDepth: item.runContext?.execution?.spawnDepth ?? undefined,
      agent: item.agent ?? item.runContext?.title ?? 'Routed run',
      prompt: item.prompt ?? item.runContext?.io?.input ?? '',
      status: (item.runContext?.status ?? item.status ?? 'running') as SpawnedAgent['status'],
      activity: [],
      kind: item.kind ?? item.runContext?.runType ?? 'agent',
      runContext: item.runContext ?? undefined,
    }));
}

export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  const [agentReports, setAgentReports] = useState<AgentReport[]>([]);
  /** Pending question from an agent to the user (ask_user) */
  const [pendingUserQuestion, setPendingUserQuestion] = useState<{ question: string; fromAgent: string } | null>(null);
  const [spawnedAgents, setSpawnedAgents] = useState<SpawnedAgent[]>([]);
  const [restoredDraft, setRestoredDraft] = useState<string | null>(null);
  const [watchers, setWatchers] = useState<WatcherUIDoc[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messageReloadNonce, setMessageReloadNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const sessionStreamAbortRef = useRef<AbortController | null>(null);
  const sessionsRef = useRef<ChatSession[]>([]);
  const clearRestoredDraft = useCallback(() => setRestoredDraft(null), []);
  const executionSnapshots = useExecutionStore(state => state.entities);

  const spawnedRunIds = spawnedAgents
    .map(s => s.executionId)
    .filter(Boolean)
    .sort()
    .join('|');

  useEffect(() => {
    setSpawnedAgents(prev => {
      let changed = false;
      let next = prev.map(run => {
        const snapshot = executionSnapshots[run.executionId];
        const contextWithChildren = run.runContext
          ? reconcileChildAgentsWithSnapshots(run.runContext, executionSnapshots)
          : run.runContext;
        if (!snapshot) {
          if (contextWithChildren === run.runContext) return run;
          changed = true;
          return { ...run, runContext: contextWithChildren };
        }
        const currentRevision = Number(run.runContext?.execution?.revision ?? -1);
        const currentGeneration = Number(run.runContext?.execution?.runGeneration ?? -1);
        if (
          run.status === snapshot.status
          && currentRevision === snapshot.revision
          && currentGeneration === snapshot.runGeneration
        ) {
          if (contextWithChildren === run.runContext) return run;
          changed = true;
          return { ...run, runContext: contextWithChildren };
        }

        changed = true;
        return {
          ...run,
          status: snapshot.status as SpawnedAgent['status'],
          parentExecutionId: snapshot.parentExecutionId ?? run.parentExecutionId,
          runContext: contextWithChildren
            ? reconcileRunContextWithSnapshot(contextWithChildren, snapshot)
            : contextWithChildren,
        };
      });

      // A start event can be lost while a session stream reconnects. The
      // global lifecycle stream is snapshot-first, so use it to recover a
      // minimal card immediately instead of waiting for a page refresh.
      const knownIds = new Set(next.map(run => run.executionId));
      for (const snapshot of Object.values(executionSnapshots)) {
        if (snapshot.chatSessionId !== activeSessionId || knownIds.has(snapshot.executionId)) continue;
        next = [...next, runSeedFromSnapshot(snapshot) as SpawnedAgent];
        knownIds.add(snapshot.executionId);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [activeSessionId, spawnedRunIds, executionSnapshots]);

  // Load sessions on mount
  const loadSessions = useCallback(async () => {
    try {
      setLoadingSessions(true);
      const result = await api.listSessions();
      setSessions(result);
    } catch (e) {
      console.error('Failed to load sessions:', e);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Keep sessionsRef in sync so sendMessage can look up workspaceId
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Track whether sendMessage is actively managing state (skip fetch if so)
  const sendingRef = useRef(false);

  // Load messages when active session changes + check for active streaming
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    // If sendMessage is already running for this session, don't fetch — it's managing state
    if (sendingRef.current) return;

    let cancelled = false;
    const streamAbortController = new AbortController();
    sessionStreamAbortRef.current = streamAbortController;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    (async () => {
      try {
        setLoadingMessages(true);
        const [session, persistedRuns] = await Promise.all([
          api.getSession(activeSessionId),
          executionsApi.forChat(activeSessionId).catch(() => []),
        ]);
        if (cancelled) return;
        // Load execution watchers for this session
        executionWatchersApi.list(activeSessionId)
          .then(incoming => setWatchers(prev => mergeWatcherDocuments(prev, incoming)))
          .catch(() => {/* best-effort */});
        const loadedMessages = (session.messages || []) as ChatMessage[];
        const { messages: _messages, ...sessionMeta } = session as ChatSession & { messages?: ChatMessage[] };
        void _messages;
        setSessions(prev =>
          prev.some(item => item._id === activeSessionId)
            ? prev.map(item => item._id === activeSessionId ? { ...item, ...sessionMeta } : item)
            : [sessionMeta, ...prev],
        );
        setMessages(loadedMessages);
        for (const run of persistedRuns) {
          if (run.runContext?.execution) {
            useExecutionStore.getState().ingestExecution(run.runContext.execution as unknown as Record<string, unknown>);
          }
        }
        setSpawnedAgents(mergeSpawnedRuns(runsFromMessages(loadedMessages), runsFromPersistedExecutions(persistedRuns)));

        // Re-surface a pending ask_user question on refresh. The tool
        // persists the question on chat_sessions.pendingUserQuestion while
        // it blocks in a poll loop; without this line a refresh would
        // clear the popup even though the agent is still waiting for an
        // answer.
        const pq = (session as any)?.pendingUserQuestion;
        if (pq && pq.status === 'pending' && typeof pq.question === 'string') {
          setPendingUserQuestion({ question: pq.question, fromAgent: pq.fromAgent ?? 'assistant' });
        } else {
          setPendingUserQuestion(null);
        }

        // Check if this session has an active streaming response. The
        // session SSE stream is connected regardless so watcher/session
        // events keep updating after the assistant turn ends.
        const { streaming: isActive } = await api.isStreaming(activeSessionId);
        console.log('[useChat:refresh] isStreaming →', isActive);
        if (cancelled) return;

        setStreaming(isActive);
        if (isActive) {
          const streamingMsg = session.messages?.find((m: any) => m.status === 'streaming');
          if (streamingMsg) {
            setMessages(prev => prev.filter(m => m._id !== streamingMsg._id));
            setStreamText(streamingMsg.content ?? '');
            setThinkingText(streamingMsg.thinkingText ?? '');
            setActiveToolCalls(activeToolCallsFromRecords(streamingMsg.toolCalls));
          }
        }

        // Initial data is ready before entering the intentionally long-lived
        // stream loop. A closed response is transient; reconnect and
        // reconcile persisted state because the session SSE is non-replay.
        setLoadingMessages(false);
        console.log('[useChat:refresh] connecting live session stream for', activeSessionId);
        let reconnectAttempt = 0;
        let connectedOnce = false;
        while (!cancelled) {
          try {
            const response = await fetch(api.streamUrl(activeSessionId), {
              headers: authHeaders(),
              signal: streamAbortController.signal,
            });
            if (!response.ok || !response.body) throw new Error(`Session stream unavailable (${response.status})`);

            const sessionReader = response.body.getReader();
            streamReader = sessionReader;
            reconnectAttempt = 0;

            if (connectedOnce) {
              const [latestRuns, latestWatchers, latestStreaming] = await Promise.all([
                executionsApi.forChat(activeSessionId).catch(() => []),
                executionWatchersApi.list(activeSessionId).catch(() => []),
                api.isStreaming(activeSessionId).then(result => result.streaming).catch(() => false),
              ]);
              if (cancelled) break;
              for (const run of latestRuns) {
                if (run.runContext?.execution) {
                  useExecutionStore.getState().ingestExecution(run.runContext.execution as unknown as Record<string, unknown>);
                }
              }
              setSpawnedAgents(prev => mergeSpawnedRuns(prev, runsFromPersistedExecutions(latestRuns)));
              setWatchers(prev => mergeWatcherDocuments(prev, latestWatchers));
              setStreaming(latestStreaming);
            }

            connectedOnce = true;
            console.log('[useChat:refresh] SSE reader attached');
            await consumeSessionEventStream(
              sessionReader,
              (event, data) => handleSSEEvent(event, data, activeSessionId),
              () => cancelled,
            );
          } catch (fetchErr) {
            if ((fetchErr as Error).name === 'AbortError') break;
            console.warn('[useChat:refresh] SSE connection ended:', fetchErr);
          }
          streamReader = null;
          if (!cancelled) await sleep(sessionReconnectDelay(++reconnectAttempt));
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          console.error('Failed to load messages:', e);
        }
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();
    return () => {
      cancelled = true;
      streamAbortController.abort();
      if (sessionStreamAbortRef.current === streamAbortController) {
        sessionStreamAbortRef.current = null;
      }
      if (streamReader) {
        void streamReader.cancel().catch(() => {});
      }
    };
  }, [activeSessionId, messageReloadNonce]);

  // Centralized SSE event handler
  const handleSSEEvent = useCallback((event: string, data: any, sessionId: string) => {
    switch (event) {
      case 'message_delta':
        setStreaming(true);
        setStreamText(data.text ?? '');
        break;

      case 'thinking':
        setStreaming(true);
        setThinkingText(data.text ?? '');
        break;

      case 'tool_start':
        setStreaming(true);
        setActiveToolCalls(prev => mergeToolStart(prev, data).slice(-MAX_LIVE_TOOL_CALLS));
        break;

      case 'tool_result':
        setActiveToolCalls(prev => mergeToolResult(prev, data).slice(-MAX_LIVE_TOOL_CALLS));
        {
          const run = toolRunFromResult(data.tool, data.result);
          if (run) {
            run.sourceMessageId = data.messageId;
            setSpawnedAgents(prev => upsertSpawnedRun(prev, run));
          }
        }
        break;

      case 'message_complete':
        setMessages(prev => [
          ...prev.filter(m => m.status !== 'streaming'),
          {
            sessionId,
            role: 'assistant',
            content: data.text ?? streamText,
            status: 'completed',
            costUsd: data.costUsd,
            durationMs: data.durationMs,
            tokenUsage: (data.tokenUsage ?? null) as TokenUsageInfo | null,
            toolCalls: data.toolCalls,
            thinkingText: data.thinkingText ?? thinkingText,
            createdAt: new Date().toISOString(),
          },
        ]);
        setStreamText('');
        setThinkingText('');
        setActiveToolCalls([]);
        setStreaming(false);
        break;

      case 'steered_message': {
        const steeredAt = data.createdAt ?? new Date().toISOString();
        setMessages(prev => [
          ...prev,
          {
            _id: data.steeredMessageId,
            sessionId,
            role: 'user',
            content: data.content ?? '',
            status: 'completed',
            createdAt: steeredAt,
            senderUserId: data.sender?.senderUserId,
            senderName: data.sender?.senderName,
            senderEmail: data.sender?.senderEmail,
            senderSource: data.sender?.senderSource,
          } as ChatMessage,
        ]);
        break;
      }

      case 'session_update':
        if (data.title) {
          setSessions(prev =>
            prev.map(s =>
              s._id === sessionId ? { ...s, title: data.title } : s,
            ),
          );
        }
        break;

      case 'user_question':
        setPendingUserQuestion({ question: data.question as string, fromAgent: data.fromAgent as string });
        break;

      case 'user_answer':
        setPendingUserQuestion(null);
        break;

      case 'agent_report':
        setAgentReports(prev => appendCapped(prev, {
          agent: data.agent as string,
          message: data.message as string,
          status: data.status as string,
          timestamp: data.timestamp as string,
        }, MAX_AGENT_REPORTS));
        break;

      case 'spawn_started':
        setSpawnedAgents(prev => upsertSpawnedRun(prev, {
          executionId: data.executionId as string,
          sourceMessageId: data.messageId as string | undefined,
          parentExecutionId: data.parentExecutionId as string | null | undefined,
          spawnDepth: data.spawnDepth as number | null | undefined,
          agent: data.agent as string,
          prompt: (data.prompt as string) ?? '',
          status: 'running',
          activity: [],
          kind: 'agent',
        }));
        break;

      case 'routed_run_started':
        setSpawnedAgents(prev => upsertSpawnedRun(prev, {
          executionId: data.executionId as string,
          sourceMessageId: data.messageId as string | undefined,
          parentExecutionId: data.parentExecutionId as string | null | undefined,
          spawnDepth: data.spawnDepth as number | null | undefined,
          agent: (data.name as string) ?? (data.agent as string) ?? (data.workflowName as string) ?? 'Routed run',
          prompt: (data.reason as string) ?? '',
          status: 'running',
          activity: [],
          kind: (data.kind as SpawnedAgent['kind']) ?? 'agent',
        }));
        break;

      case 'spawn_activity':
        setSpawnedAgents(prev => prev.map(s =>
          s.executionId === data.executionId
            ? { ...s, activity: appendRunActivity(s, { type: data.type as string, tool: data.tool as string | undefined, command: data.command as string | undefined, content: data.content as string | undefined, timestamp: Date.now() }) }
            : s,
        ));
        break;

      case 'spawn_completed':
        setSpawnedAgents(prev => prev.map(s =>
          s.executionId === data.executionId
            ? { ...s, status: 'completed', durationMs: data.durationMs as number, toolCount: data.toolCount as number, response: data.response as string }
            : s,
        ));
        break;

      case 'stream_inactive':
        setStreaming(false);
        setActiveToolCalls([]);
        break;

      case 'cancelled':
        if (typeof data.restoreDraft === 'string' && data.restoreDraft.trim()) {
          setRestoredDraft(data.restoreDraft);
        }
        break;

      case 'error':
        setMessages(prev => [
          ...prev,
          {
            sessionId,
            role: 'assistant',
            content: streamText || `Error: ${data.error}`,
            status: 'failed',
            error: data.error,
            thinkingText,
            createdAt: new Date().toISOString(),
          },
        ]);
        setStreamText('');
        setActiveToolCalls([]);
        setStreaming(false);
        break;

      case 'watcher_update':
        setWatchers(prev => mergeWatcherDocuments(prev, [data as WatcherUIDoc]));
        break;
    }
  }, [streamText, thinkingText]);

  const createSession = useCallback(
    async (
      provider?: string,
      model?: string,
      agentOverrides?: Record<string, unknown>,
      repoId?: string,
      workspaceId?: string,
      createOverride?: (args: { provider?: string; model?: string; agentOverrides?: Record<string, unknown>; repoId?: string; workspaceId?: string }) => Promise<ChatSession>,
    ) => {
      const session = createOverride
        ? await createOverride({ provider, model, agentOverrides, repoId, workspaceId })
        : await api.createSession(provider, model, agentOverrides, repoId, workspaceId);
      setSessions(prev => [session, ...prev]);
      setActiveSessionId(session._id);
      setMessages([]);
      return session;
    },
    [],
  );

  const deleteSession = useCallback(async (id: string) => {
    await api.deleteSession(id);
    setSessions(prev => prev.filter(s => s._id !== id));
    if (activeSessionId === id) {
      setActiveSessionId(null);
      setMessages([]);
    }
  }, [activeSessionId]);

  /**
   * Optimistic rename — patches the session in local state immediately
   * so the conversations sidebar updates without a roundtrip, then
   * persists via PATCH.
   */
  const updateSessionTitle = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSessions(prev => prev.map(s => s._id === id ? { ...s, title: trimmed } : s));
    try {
      await api.updateSession(id, { title: trimmed });
    } catch (e) {
      // Best-effort: refresh from the server so we don't show stale local edits.
      void loadSessions();
      throw e;
    }
  }, [loadSessions]);

  const generateSessionTitle = useCallback(async (id: string): Promise<string> => {
    const { title } = await api.generateTitle(id);
    setSessions(prev => prev.map(s => s._id === id ? { ...s, title } : s));
    return title;
  }, []);

  const switchSession = useCallback((id: string) => {
    // Detach from the current session's local SSE reader (if any). The server
    // keeps the query running independently in activeQueries — the agent
    // process continues, events are still broadcast, and our listener is
    // dropped on the next write when the aborted fetch closes the Response.
    // When the user switches BACK to this session, the session-load effect
    // reconnects via api.streamUrl() and resumes seeing events live.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    sendingRef.current = false;

    setActiveSessionId(id || null);
    setMessages([]);
    setStreamText('');
    setThinkingText('');
    setActiveToolCalls([]);
    setAgentReports([]);
    setPendingUserQuestion(null);
    setSpawnedAgents([]);
    setStreaming(false);
    setWatchers([]);
  }, []);

  const sendMessage = useCallback(async (content: string, overrideSessionId?: string, agent?: string, cwd?: string) => {
    const sessionId = overrideSessionId || activeSessionId;
    if (!sessionId || streaming) return;

    // The POST /messages response owns the active assistant stream for this
    // tab. Temporarily detach the always-on session stream to avoid applying
    // the same SSE events twice in this hook; reconnect when the POST stream
    // finishes.
    sessionStreamAbortRef.current?.abort();
    sessionStreamAbortRef.current = null;

    sendingRef.current = true;
    setStreaming(true);
  setStreamText('');
  setThinkingText('');
  setActiveToolCalls([]);
  setAgentReports([]);

    // Add user message optimistically. `/skill <name>` gets an optimistic
    // skillLoad marker (slug as display name) so it renders as a skill slice
    // immediately; the server-persisted message carries the real displayName.
    const skillSlug = content.trim().match(/^\/skill\s+(\S+)$/)?.[1]
      ?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const userMsg: ChatMessage = {
      sessionId,
      role: 'user',
      content,
      status: 'completed',
      ...(skillSlug ? { skillLoad: { name: skillSlug, displayName: skillSlug } } : {}),
      ...currentSenderFields(useAuthStore.getState().user),
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    // Notify sidebar that a workspace-linked session has new activity
    {
      const ws = sessionsRef.current.find(s => s._id === sessionId);
      window.dispatchEvent(new CustomEvent('allen:workspace-activity', { detail: { workspaceId: ws?.workspaceId ?? null } }));
    }

    const abortController = new AbortController();
    abortRef.current = abortController;
    // Set when a pre-stream rejection is handled locally — the server never
    // persisted anything, so reloading messages would wipe the error bubble.
    let skipReload = false;

    try {
      const response = await fetch(api.sendMessageUrl(sessionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ content, agent, ...(cwd ? { cwd } : {}) }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        // Pre-stream rejections (e.g. unknown `/skill <name>`) return a JSON
        // body with an error message and optional suggestions — surface it.
        let serverMessage = '';
        if (!response.ok) {
          try {
            const data = await response.json() as { error?: string; suggestions?: string[] };
            serverMessage = data.error ?? '';
            if (serverMessage && data.suggestions?.length) {
              serverMessage += `. Did you mean: ${data.suggestions.map(s => `/skill ${s}`).join(', ')}?`;
            }
          } catch { /* non-JSON body */ }
        }
        const error = new Error(serverMessage || `Request failed: ${response.status}`) as Error & { isClientError?: boolean };
        error.isClientError = response.status >= 400 && response.status < 500;
        throw error;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let assistantText = '';
      let assistantMsgId = '';
      let assistantThinking = '';
      let collectedToolCalls: ToolCallRecord[] = [];
      const activeToolArgs = new Map<string, Record<string, unknown>>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              switch (currentEvent) {
                case 'message_delta':
                  assistantText = data.text;
                  assistantMsgId = data.messageId || assistantMsgId;
                  setStreamText(assistantText);
                  break;

                case 'thinking':
                  assistantThinking = data.text ?? '';
                  setThinkingText(assistantThinking);
                  break;

                case 'tool_start':
                  if (data.toolUseId ?? data.tool_use_id) {
                    activeToolArgs.set(data.toolUseId ?? data.tool_use_id, data.args ?? {});
                  }
                  setActiveToolCalls(prev => mergeToolStart(prev, data).slice(-MAX_LIVE_TOOL_CALLS));
                  break;

                case 'tool_result': {
                  const toolUseId = data.toolUseId ?? data.tool_use_id;
                  const toolRecord: ToolCallRecord = {
                    tool: data.tool,
                    args: data.args ?? (toolUseId ? activeToolArgs.get(toolUseId) : undefined) ?? {},
                    result: data.result,
                    durationMs: data.durationMs,
                    timestamp: new Date().toISOString(),
                    toolUseId,
                  };
                  collectedToolCalls.push(toolRecord);
                  if (toolUseId) activeToolArgs.delete(toolUseId);
                  setActiveToolCalls(prev => mergeToolResult(prev, data).slice(-MAX_LIVE_TOOL_CALLS));
                  const run = toolRunFromResult(data.tool, data.result);
                  if (run) {
                    run.sourceMessageId = data.messageId || assistantMsgId;
                    setSpawnedAgents(prev => upsertSpawnedRun(prev, run));
                  }
                  break;
                }

                case 'message_complete': {
                  const msgId = data.messageId || assistantMsgId;
                  const finalText = (typeof data.text === 'string' && data.text.trim()) ? data.text : assistantText;
                  setMessages(prev => [
                    ...prev,
                    {
                      _id: msgId,
                      sessionId,
                      role: 'assistant',
                      content: finalText,
                      status: 'completed',
                      costUsd: data.costUsd,
                      durationMs: data.durationMs,
                      tokenUsage: (data.tokenUsage ?? null) as TokenUsageInfo | null,
                      toolCalls: data.toolCalls || collectedToolCalls,
                      thinkingText: data.thinkingText ?? assistantThinking,
                      createdAt: new Date().toISOString(),
                    },
                  ]);
                  setStreamText('');
                  setThinkingText('');
                  setActiveToolCalls([]);
                  // The assistant turn is complete as soon as message_complete arrives.
                  // The HTTP stream may stay open briefly for cleanup/title updates, but
                  // model changes should be available for the next turn immediately.
                  setStreaming(false);

                  setAgentReports([]);

                  // Notify sidebar that a workspace-linked session has new activity
                  {
                    const ws = sessionsRef.current.find(s => s._id === sessionId);
                    window.dispatchEvent(new CustomEvent('allen:workspace-activity', { detail: { workspaceId: ws?.workspaceId ?? null } }));
                  }
                  break;
                }

                case 'steered_message': {
                  const steeredAt = data.createdAt ?? new Date().toISOString();
                  setMessages(prev => [
                    ...prev,
                    {
                      _id: data.steeredMessageId,
                      sessionId,
                      role: 'user',
                      content: data.content ?? '',
                      status: 'completed',
                      createdAt: steeredAt,
                      senderUserId: data.sender?.senderUserId,
                      senderName: data.sender?.senderName,
                      senderEmail: data.sender?.senderEmail,
                      senderSource: data.sender?.senderSource,
                    } as ChatMessage,
                  ]);
                  break;
                }

                case 'session_update':
                  if (data.title) {
                    setSessions(prev =>
                      prev.map(s =>
                        s._id === sessionId ? { ...s, title: data.title } : s,
                      ),
                    );
                  }
                  break;

                case 'user_question':
                  setPendingUserQuestion({ question: data.question as string, fromAgent: data.fromAgent as string });
                  break;

                case 'user_answer':
                  setPendingUserQuestion(null);
                  break;

                case 'agent_report':
                  setAgentReports(prev => appendCapped(prev, {
                    agent: data.agent as string,
                    message: data.message as string,
                    status: data.status as string,
                    timestamp: data.timestamp as string,
                  }, MAX_AGENT_REPORTS));
                  break;

                case 'spawn_started':
                  setSpawnedAgents(prev => upsertSpawnedRun(prev, {
                    executionId: data.executionId as string,
                    sourceMessageId: (data.messageId || assistantMsgId) as string | undefined,
                    parentExecutionId: data.parentExecutionId as string | null | undefined,
                    spawnDepth: data.spawnDepth as number | null | undefined,
                    agent: data.agent as string,
                    prompt: (data.prompt as string) ?? '',
                    status: 'running',
                    activity: [],
                    kind: 'agent',
                  }));
                  break;

                case 'routed_run_started':
                  setSpawnedAgents(prev => upsertSpawnedRun(prev, {
                    executionId: data.executionId as string,
                    sourceMessageId: (data.messageId || assistantMsgId) as string | undefined,
                    parentExecutionId: data.parentExecutionId as string | null | undefined,
                    spawnDepth: data.spawnDepth as number | null | undefined,
                    agent: (data.name as string) ?? (data.agent as string) ?? (data.workflowName as string) ?? 'Routed run',
                    prompt: (data.reason as string) ?? '',
                    status: 'running',
                    activity: [],
                    kind: (data.kind as SpawnedAgent['kind']) ?? 'agent',
                  }));
                  break;

                case 'spawn_activity':
                  setSpawnedAgents(prev => prev.map(s =>
                    s.executionId === data.executionId
                      ? { ...s, activity: appendRunActivity(s, { type: data.type as string, tool: data.tool as string | undefined, command: data.command as string | undefined, content: data.content as string | undefined, timestamp: Date.now() }) }
                      : s,
                  ));
                  break;

                case 'spawn_completed':
                  setSpawnedAgents(prev => prev.map(s =>
                    s.executionId === data.executionId
                      ? { ...s, status: 'completed', durationMs: data.durationMs as number, toolCount: data.toolCount as number, response: data.response as string }
                      : s,
                  ));
                  break;

                case 'error':
                  setMessages(prev => [
                    ...prev,
                    {
                      sessionId,
                      role: 'assistant',
                      content: assistantText || `Error: ${data.error}`,
                      status: 'failed',
                      error: data.error,
                      createdAt: new Date().toISOString(),
                    },
                  ]);
                  setStreamText('');
                  setActiveToolCalls([]);
                  break;

                case 'watcher_update':
                  setWatchers(prev => {
                    const idx = prev.findIndex(w => w.executionId === data.executionId);
                    const incoming = data as WatcherUIDoc;
                    if (idx >= 0) {
                      if (incoming.updateSeq > prev[idx].updateSeq) {
                        const next = [...prev];
                        next[idx] = incoming;
                        return next;
                      }
                      return prev;
                    }
                    return [...prev, incoming];
                  });
                  break;
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled — clean up without showing an error message.
        setStreamText('');
        setActiveToolCalls([]);
      } else if ((err as Error & { isClientError?: boolean }).isClientError) {
        // The server rejected the message before persisting/streaming (e.g.
        // unknown /skill). Drop the optimistic user message, restore the
        // draft, and show the server error in a failed assistant bubble.
        skipReload = true;
        setMessages(prev => [
          ...prev.filter(m => m !== userMsg),
          {
            sessionId,
            role: 'assistant',
            content: (err as Error).message,
            status: 'failed',
            error: (err as Error).message,
            createdAt: new Date().toISOString(),
          },
        ]);
        setRestoredDraft(content);
        setStreamText('');
        setActiveToolCalls([]);
      } else {
        // Network / transport error. Before giving up, check whether the
        // backend session is still streaming so we can attempt to reconnect.
        console.warn('Chat stream error (will check if backend still active):', err);

        let reconnected = false;
        for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
          // Back-off: 1 s, 2 s, 2 s
          await sleep(attempt === 1 ? 1000 : 2000);

          // If the user aborted while we were sleeping, stop retrying.
          if (!abortRef.current || abortRef.current.signal.aborted) break;

          const stillStreaming = await checkIsStreaming(sessionId);
          if (!stillStreaming) break;

          console.log(`[useChat] backend still streaming — reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}`);
          try {
            // Backfill any partial content that arrived before the drop.
            const session = await api.getSession(sessionId);
            const streamingMsg = session.messages?.find((m: any) => m.status === 'streaming');
            if (streamingMsg) {
              setMessages(prev => prev.filter(m => m._id !== streamingMsg._id));
              setStreamText(streamingMsg.content ?? '');
              setThinkingText(streamingMsg.thinkingText ?? '');
              setActiveToolCalls(prev => {
                const hydrated = activeToolCallsFromRecords(streamingMsg.toolCalls);
                const existingKeys = new Set(prev.map(tc => tc.toolUseId || `${tc.tool}:${tc.status}`));
                const missing = hydrated.filter(tc => !existingKeys.has(tc.toolUseId || `${tc.tool}:${tc.status}`));
                return missing.length ? [...prev, ...missing] : prev;
              });
            }

            // Attach a fresh SSE reader to the existing stream.
            const reconnectResponse = await fetch(api.streamUrl(sessionId), {
              headers: authHeaders(),
              signal: abortController.signal,
            });
            if (!reconnectResponse.ok) continue;  // skip this attempt, try again
            if (!reconnectResponse.body) continue;

            const rReader = reconnectResponse.body.getReader();
            const rDecoder = new TextDecoder();
            let rBuffer = '';
            let rCurrentEvent = '';

            reconnected = true;
            while (true) {
              if (!abortRef.current || abortRef.current.signal.aborted) {
                await rReader.cancel();
                break;
              }
              const { done, value } = await rReader.read();
              if (done) break;
              rBuffer += rDecoder.decode(value, { stream: true });
              const rLines = rBuffer.split('\n');
              rBuffer = rLines.pop() ?? '';
              for (const line of rLines) {
                if (line.startsWith('event: ')) {
                  rCurrentEvent = line.slice(7).trim();
                } else if (line.startsWith('data: ') && rCurrentEvent) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    handleSSEEvent(rCurrentEvent, data, sessionId);
                  } catch { /* ignore parse errors */ }
                  rCurrentEvent = '';
                }
              }
            }
            // Stream ended cleanly after reconnect — no error message needed.
            break;
          } catch (reconnectErr) {
            if ((reconnectErr as Error).name === 'AbortError') break;
            console.warn(`[useChat] reconnect attempt ${attempt} failed:`, reconnectErr);
            reconnected = false;
            // loop continues to next attempt
          }
        }

        if (!reconnected) {
          // All reconnect attempts failed (or backend was not streaming).
          console.error('Chat stream error (giving up after reconnect attempts):', err);
          setMessages(prev => [
            ...prev,
            {
              sessionId,
              role: 'assistant',
              content: `Error: ${(err as Error).message}`,
              status: 'failed',
              error: (err as Error).message,
              createdAt: new Date().toISOString(),
            },
          ]);
        }

        setStreamText('');
        setActiveToolCalls([]);
      }
    } finally {
      setStreaming(false);
      sendingRef.current = false;
      abortRef.current = null;
      if (!skipReload) setMessageReloadNonce(n => n + 1);
      loadSessions();
    }
  }, [activeSessionId, streaming, loadSessions]);

  const refreshActiveSession = useCallback(() => {
    if (!activeSessionId) return;
    setMessageReloadNonce(n => n + 1);
  }, [activeSessionId]);

  const cancelStream = useCallback(() => {
    // 1. Abort the frontend SSE fetch so the UI stops receiving chunks.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // 2. Tell the server to kill the actual claude-cli subprocess. Without
    //    this the agent keeps running in the background consuming tokens
    //    even though the user clicked Stop.
    if (activeSessionId) {
      fetch(`/api/chat/sessions/${activeSessionId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      })
        .then(res => res.ok ? res.json() : null)
        .then((result: ChatCancelResponse | null) => {
          if (typeof result?.restoreDraft === 'string' && result.restoreDraft.trim()) {
            setRestoredDraft(result.restoreDraft);
          }
          if (!result?.messageId) return;
          const fallbackContent = result.cancelledExecutions?.length
            ? `Interrupted by user. Cancelled linked tasks: ${result.cancelledExecutions.map(exec => exec.id).filter(Boolean).join(', ')}. If you want to rerun, choose fresh start or resume.`
            : 'Interrupted by user.';
          const content = result.content ?? fallbackContent;
          setMessages(prev => {
            const existing = prev.find(message => message._id === result.messageId);
            if (existing) {
              return prev.map(message => message._id === result.messageId
                ? { ...message, content, status: 'cancelled' as const }
                : message);
            }
            return [
              ...prev,
              {
                _id: result.messageId,
                sessionId: activeSessionId,
                role: 'assistant',
                content,
                status: 'cancelled',
                createdAt: new Date().toISOString(),
              },
            ];
          });
          setSpawnedAgents(prev => prev.map(run => run.sourceMessageId === result.messageId
            ? { ...run, status: 'cancelled' as const }
            : run));
        })
        .catch(() => { /* best-effort — frontend abort already happened */ });
    }
    setStreaming(false);
    setStreamText('');
    setThinkingText('');
    setActiveToolCalls([]);
  }, [activeSessionId]);

  const answerWorkflowIntervention = useCallback(async (input: WorkflowInterventionAnswer) => {
    if (!activeSessionId) return;

    if (!input.interventionId) {
      throw new Error('Approval is still syncing. Please wait a moment and try again.');
    }

    await interventionsApi.respond(input.interventionId, {
      decision: input.decision,
      action_id: input.actionId,
      field_values: input.fieldValues,
      feedback: input.feedback,
      answer: input.answer,
      answered_by_user_id: useAuthStore.getState().user?.id,
      human_node_name: input.humanNodeName,
      source: 'chat',
    });

    setPendingUserQuestion(null);
    setSpawnedAgents(prev => prev.map(run =>
      run.executionId === input.executionId
        ? {
            ...run,
            status: input.decision === 'reject' ? 'cancelled' : 'running',
            runContext: run.runContext
              ? {
                  ...run.runContext,
                  status: input.decision === 'reject' ? 'cancelled' : 'running',
                  humanInput: { ...run.runContext.humanInput, required: false },
                }
              : run.runContext,
          }
        : run,
    ));

    try {
      const context = await executionsApi.context(input.executionId);
      setSpawnedAgents(prev => prev.map(run =>
        run.executionId === input.executionId
          ? { ...run, status: context.status as SpawnedAgent['status'], runContext: context }
          : run,
      ));
    } catch {
      // Best-effort refresh; the polling loop will pick up the next context.
    }

    if (!streaming) {
      const summary =
        input.decision === 'request_changes'
          ? 'I requested changes on the workflow intervention.'
          : input.decision === 'reject'
            ? 'I rejected the workflow intervention.'
            : 'I answered the workflow intervention.';
      await sendMessage(
        `${summary} Continue execution ${input.executionId} from the latest workflow state and keep me updated in this chat.`,
        activeSessionId,
      );
    }
  }, [activeSessionId, sendMessage, streaming]);

  return {
    sessions,
    activeSessionId,
    messages,
    streaming,
    streamText,
    watchers,
    thinkingText,
    activeToolCalls,
    agentReports,
    spawnedAgents,
    pendingUserQuestion,
    answerUserQuestion: async (answer: string) => {
      if (!activeSessionId) return;
      const result = await api.answerAgentQuestion(activeSessionId, answer);
      setPendingUserQuestion(null);
      if (result?.workflowInput?.forwarded && !streaming) {
        await sendMessage(
          `I answered the workflow input. Continue execution ${result.workflowInput.execution_id} from the latest workflow state and keep me updated in this chat.`,
          activeSessionId,
        );
      }
    },
    answerWorkflowIntervention,
    loadingSessions,
    loadingMessages,
    sendMessage,
    createSession,
    deleteSession,
    updateSessionTitle,
    generateSessionTitle,
    switchSession,
    cancelStream,
    restoredDraft,
    clearRestoredDraft,
    refresh: loadSessions,
    refreshActiveSession,
  };
}
