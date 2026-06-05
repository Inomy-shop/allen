import { useState, useEffect, useCallback, useRef } from 'react';
import { chat as api, executions as executionsApi, interventions as interventionsApi, authHeaders, type RunStatus, type TokenUsageInfo } from '../services/api';
import { useAuthStore, type AuthUser } from '../stores/authStore';

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
    provider?: 'claude-cli' | 'codex' | 'deepseek' | 'xiaomi-mimo' | null;
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
  status: 'completed' | 'streaming' | 'failed' | 'cancelled';
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
    if (!message.content) continue;
    const matches = message.content.matchAll(/\/executions\/([A-Za-z0-9_-]+)/g);
    for (const match of matches) {
      const executionId = match[1];
      if (!executionId || seen.has(executionId)) continue;
      seen.add(executionId);
      runs.push({
        executionId,
        sourceMessageId: message._id,
        agent: 'Routed run',
        prompt: message.content.split('\n').find(Boolean) ?? '',
        status: 'running',
        activity: [],
      });
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
      parentExecutionId: item.runContext?.execution.parentExecutionId ?? undefined,
      spawnDepth: item.runContext?.execution.spawnDepth ?? undefined,
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
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const spawnedRunSignature = spawnedAgents
    .map(s => `${s.executionId}:${s.status}:${s.runContext?.progress?.phase ?? ''}:${s.runContext?.progress?.percent ?? ''}`)
    .join('|');

  useEffect(() => {
    if (spawnedAgents.length === 0) return;
    let cancelled = false;
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    const refreshContexts = async () => {
      const ids = [...new Set(spawnedAgents.map(s => s.executionId).filter(Boolean))];
      const updates = await Promise.all(ids.map(async (id) => {
        try {
          return { id, context: await executionsApi.context(id) };
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      setSpawnedAgents(prev => {
        let changed = false;
        const next = prev.map(run => {
          const update = updates.find(u => u?.id === run.executionId);
          if (!update?.context) return run;
          changed = true;
          return {
            ...run,
            status: update.context.status as SpawnedAgent['status'],
            runContext: update.context,
            sourceMessageId: update.context.chat?.parentMessageId ?? run.sourceMessageId,
            parentExecutionId: update.context.execution.parentExecutionId ?? run.parentExecutionId,
            spawnDepth: update.context.execution.spawnDepth ?? run.spawnDepth,
          };
        });
        return changed ? next : prev;
      });
    };

    refreshContexts();
    const hasActive = spawnedAgents.some(s => !terminal.has(s.runContext?.status ?? s.status));
    if (!hasActive) return () => { cancelled = true; };
    const timer = window.setInterval(refreshContexts, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [spawnedRunSignature]);

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
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    (async () => {
      try {
        setLoadingMessages(true);
        const [session, persistedRuns] = await Promise.all([
          api.getSession(activeSessionId),
          executionsApi.forChat(activeSessionId).catch(() => []),
        ]);
        if (cancelled) return;
        const loadedMessages = (session.messages || []) as ChatMessage[];
        const { messages: _messages, ...sessionMeta } = session as ChatSession & { messages?: ChatMessage[] };
        void _messages;
        setSessions(prev =>
          prev.some(item => item._id === activeSessionId)
            ? prev.map(item => item._id === activeSessionId ? { ...item, ...sessionMeta } : item)
            : [sessionMeta, ...prev],
        );
        setMessages(loadedMessages);
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

        // Check if this session has an active streaming response
        const { streaming: isActive } = await api.isStreaming(activeSessionId);
        console.log('[useChat:refresh] isStreaming →', isActive);
        if (cancelled || !isActive) {
          return;
        }

        // Reconnect to the active stream
        console.log('[useChat:refresh] reconnecting SSE stream for', activeSessionId);
        setStreaming(true);
        const streamingMsg = session.messages?.find((m: any) => m.status === 'streaming');
        if (streamingMsg) {
          setMessages(prev => prev.filter(m => m._id !== streamingMsg._id));
          setStreamText(streamingMsg.content ?? '');
          setThinkingText(streamingMsg.thinkingText ?? '');
          setActiveToolCalls(activeToolCallsFromRecords(streamingMsg.toolCalls));
        }

        // Attempt to attach an SSE reader with up to MAX_RECONNECT_ATTEMPTS retries.
        let sessionReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
          if (cancelled) break;
          try {
            const response = await fetch(api.streamUrl(activeSessionId), {
              headers: authHeaders(),
              signal: streamAbortController.signal,
            });
            if (response.body) {
              sessionReader = response.body.getReader();
              streamReader = sessionReader;
              console.log('[useChat:refresh] SSE reader attached (attempt', attempt, ')');
              break;
            }
          } catch (fetchErr) {
            if ((fetchErr as Error).name === 'AbortError') break;
            console.warn('[useChat:refresh] SSE fetch attempt', attempt, 'failed:', fetchErr);
          }
          if (attempt < MAX_RECONNECT_ATTEMPTS) {
            await sleep(attempt === 1 ? 1000 : 2000);
          }
        }

        if (cancelled || !sessionReader) {
          if (!cancelled) {
            setStreaming(false);
            console.warn('[useChat:refresh] SSE stream fetch returned no body after retries');
          }
          return;
        }

        const reader = sessionReader;
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); }
            else if (line.startsWith('data: ') && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6));
                handleSSEEvent(currentEvent, data, activeSessionId);
              } catch {}
              currentEvent = '';
            }
          }
        }
        if (!cancelled) setStreaming(false);
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
      if (streamReader) {
        void streamReader.cancel().catch(() => {});
      }
    };
  }, [activeSessionId]);

  // Centralized SSE event handler
  const handleSSEEvent = useCallback((event: string, data: any, sessionId: string) => {
    switch (event) {
      case 'message_delta':
        setStreamText(data.text ?? '');
        break;

      case 'thinking':
        setThinkingText(data.text ?? '');
        break;

      case 'tool_start':
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
    }
  }, [streamText, thinkingText]);

  const createSession = useCallback(
    async (provider?: string, model?: string, agentOverrides?: Record<string, unknown>, repoId?: string, workspaceId?: string) => {
      const session = await api.createSession(provider, model, agentOverrides, repoId, workspaceId);
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
  }, []);

  const sendMessage = useCallback(async (content: string, overrideSessionId?: string, agent?: string, cwd?: string) => {
    const sessionId = overrideSessionId || activeSessionId;
    if (!sessionId || streaming) return;

    sendingRef.current = true;
    setStreaming(true);
  setStreamText('');
  setThinkingText('');
  setActiveToolCalls([]);
  setAgentReports([]);

    // Add user message optimistically
    const userMsg: ChatMessage = {
      sessionId,
      role: 'user',
      content,
      status: 'completed',
      ...currentSenderFields(useAuthStore.getState().user),
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch(api.sendMessageUrl(sessionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ content, agent, ...(cwd ? { cwd } : {}) }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed: ${response.status}`);
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

                  setAgentReports([]);
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
      loadSessions();
    }
  }, [activeSessionId, streaming, loadSessions]);

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
        .then((result: { messageId?: string; content?: string; cancelledExecutions?: Array<{ id?: string; workflowName?: string; status?: string }> } | null) => {
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
    refresh: loadSessions,
  };
}
