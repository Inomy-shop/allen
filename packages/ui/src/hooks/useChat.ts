import { useState, useEffect, useCallback, useRef } from 'react';
import { chat as api, executions as executionsApi, interventions as interventionsApi, authHeaders, type RunStatus } from '../services/api';
import { useAuthStore, type AuthUser } from '../stores/authStore';

/** Maximum number of automatic reconnect attempts on a transient stream error. */
export const MAX_RECONNECT_ATTEMPTS = 3;

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
    provider?: 'claude-cli' | 'codex' | null;
    model?: string | null;
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
    planMode?: boolean | null;
  };
  /** Repo associated with this session (set at creation time, immutable). */
  repoId?: string;
  repoPath?: string;
  repoName?: string;
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
  status: 'completed' | 'streaming' | 'failed';
  senderUserId?: string;
  senderName?: string;
  senderEmail?: string;
  senderSource?: 'ui' | 'slack' | 'system';
  costUsd?: number;
  durationMs?: number;
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
export interface ThreadActivity {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'follow_up' | 'response';
  agent: string;
  content?: string;
  tool?: string;
  toolUseId?: string;
  durationMs?: number;
  timestamp: number;
}

/** Agent-to-agent delegation thread (live-updated via SSE) */
export interface AgentThread {
  conversationId: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  status: 'active' | 'waiting_for_answer' | 'completed' | 'failed';
  summary?: string;
  response?: string;
  messages?: { agent: string; type?: string; content: string; toolCalls?: { tool: string }[]; timestamp: string }[];
  costUsd?: number;
  durationMs?: number;
  depth?: number;
  toolCalls?: string[];
  /** Pending question from the target agent */
  pendingQuestion?: { fromAgent: string; question: string };
  /** Real-time activity feed (thinking, text, tool calls) while thread is active */
  liveActivity?: ThreadActivity[];
  /** Parent conversation for nesting (PM→Engineer→QA = QA's parentConversationId is Engineer's) */
  parentConversationId?: string;
  /** Child threads (built on UI side from flat list) */
  children?: AgentThread[];
}

/** Spawned agent execution — live tracking */
export interface SpawnedAgent {
  executionId: string;
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
  interventionId: string;
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

/** Fetch full thread data from the API to get messages/response */
async function fetchThreadDetail(sessionId: string, conversationId: string): Promise<{ messages?: any[]; response?: string } | null> {
  try {
    const threads = await api.getThreads(sessionId);
    const thread = threads.find((t: any) => t._id === conversationId);
    return thread ? { messages: thread.messages, response: thread.response } : null;
  } catch { return null; }
}

/**
 * Apply `update` to whichever thread in the grouped-by-parentMessageId map
 * matches `conversationId`. The SSE `thread_*` handlers used to only update
 * `agentThreads` (live-send state), so refresh-loaded threads in
 * `threadsByMessage` never received subsequent updates. This helper gives
 * the same events a path into that persisted group.
 */
function mapThreadInGroups(
  groups: Record<string, AgentThread[]>,
  conversationId: string,
  update: (t: AgentThread) => AgentThread,
): Record<string, AgentThread[]> {
  let changed = false;
  const next: Record<string, AgentThread[]> = {};
  for (const [key, list] of Object.entries(groups)) {
    next[key] = list.map(t => {
      if (t.conversationId === conversationId) {
        changed = true;
        return update(t);
      }
      return t;
    });
  }
  return changed ? next : groups;
}

function upsertSpawnedRun(prev: SpawnedAgent[], run: Omit<Partial<SpawnedAgent>, 'executionId'> & { executionId: string }): SpawnedAgent[] {
  const existing = prev.find(s => s.executionId === run.executionId);
  if (!existing) {
    return [...prev, {
      executionId: run.executionId,
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
      ? { ...s, ...run, activity: run.activity ?? s.activity }
      : s,
  );
}

function toolRunFromResult(tool: string, result: Record<string, unknown> | undefined): SpawnedAgent | null {
  if (!result) return null;
  const normalizedTool = tool.split('__').pop() ?? tool;
  const isRunTool = /^(run_workflow|spawn_agent|delegate_to_agent)$/.test(normalizedTool);
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

function runsFromMessages(messages: ChatMessage[]): SpawnedAgent[] {
  const seen = new Set<string>();
  const runs: SpawnedAgent[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const run = toolRunFromResult(call.tool, call.result);
      if (!run || seen.has(run.executionId)) continue;
      seen.add(run.executionId);
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
        agent: 'Routed run',
        prompt: message.content.split('\n').find(Boolean) ?? '',
        status: 'running',
        activity: [],
      });
    }
  }
  return runs;
}

export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  const [agentThreads, setAgentThreads] = useState<AgentThread[]>([]); // live SSE threads
  const [agentReports, setAgentReports] = useState<AgentReport[]>([]);
  /** Threads loaded from DB, keyed by parentMessageId */
  const [threadsByMessage, setThreadsByMessage] = useState<Record<string, AgentThread[]>>({});
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
    (async () => {
      try {
        setLoadingMessages(true);
        const [session, threads] = await Promise.all([
          api.getSession(activeSessionId),
          api.getThreads(activeSessionId).catch(() => []),
        ]);
        if (cancelled) return;
        const loadedMessages = (session.messages || []) as ChatMessage[];
        setMessages(loadedMessages);
        setSpawnedAgents(runsFromMessages(loadedMessages));

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

        // Replay persisted intermediate activity for threads that were
        // running when the user left this session. Without this hop, a
        // refresh of a session with an in-flight delegation would lose
        // every thinking/tool event the agent already emitted — the SSE
        // stream only fans out new events, not backfill. We hit the
        // /delegations/:id/activity route for each still-running thread
        // in parallel. Failures are swallowed; missing activity just
        // renders an empty feed, same as before this hydration existed.
        console.log('[useChat:refresh] loaded', threads.length, 'threads — statuses:', threads.map((t: any) => `${t._id.slice(0,8)}=${t.status}`).join(', '));
        const runningThreads = threads.filter(
          (t: any) => t.status === 'active' || t.status === 'waiting_for_answer',
        );
        console.log('[useChat:refresh] running threads to replay:', runningThreads.length);
        const activityById = new Map<string, ThreadActivity[]>();
        if (runningThreads.length > 0) {
          const results = await Promise.all(
            runningThreads.map((t: any) =>
              api.getDelegationActivity(t._id)
                .then((r) => { console.log('[useChat:refresh] activity for', t._id.slice(0,8), '→', r.events?.length ?? 0, 'events'); return r; })
                .catch((err) => { console.warn('[useChat:refresh] activity fetch failed for', t._id.slice(0,8), err); return { events: [] }; }),
            ),
          );
          for (let i = 0; i < runningThreads.length; i++) {
            const events = results[i]?.events ?? [];
            const rows: ThreadActivity[] = events.map((ev) => ({
              type: ev.type as ThreadActivity['type'],
              agent: ev.agent,
              content: ev.content,
              tool: ev.tool,
              toolUseId: ev.toolUseId,
              durationMs: ev.durationMs,
              timestamp: new Date(ev.at).getTime(),
            }));
            activityById.set(runningThreads[i]._id, rows);
          }
        }

        // Group threads by every anchor message they touched so a continued
        // delegation renders inline under each turn that issued/continued
        // it, not only under the original parentMessageId.
        // Legacy rows without parentMessageIds fall back to parentMessageId.
        const grouped: Record<string, AgentThread[]> = {};
        for (const t of threads) {
          const keys: string[] = Array.isArray(t.parentMessageIds) && t.parentMessageIds.length
            ? t.parentMessageIds
            : [t.parentMessageId];
          const threadObj: AgentThread = {
            conversationId: t._id,
            fromAgent: t.fromAgent,
            toAgent: t.toAgent,
            task: t.task,
            status: t.status,
            summary: t.summary,
            response: t.response,
            messages: t.messages,
            costUsd: t.costUsd,
            durationMs: t.durationMs,
            depth: t.depth,
            parentConversationId: t.parentConversationId,
            liveActivity: activityById.get(t._id),
          };
          for (const key of keys) {
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(threadObj);
          }
        }
        setThreadsByMessage(grouped);

        // Check if this session has an active streaming response
        const { streaming: isActive } = await api.isStreaming(activeSessionId);
        console.log('[useChat:refresh] isStreaming →', isActive, '— runningThreads:', runningThreads.length);
        if (cancelled || !isActive) {
          if (!isActive && runningThreads.length > 0) {
            console.warn('[useChat:refresh] ⚠ server says NOT streaming but', runningThreads.length, 'threads are still active — SSE will NOT reconnect. New live events will NOT appear until next send.');
          }
          return;
        }

        // Reconnect to the active stream
        console.log('[useChat:refresh] reconnecting SSE stream for', activeSessionId);
        setStreaming(true);
        const streamingMsg = session.messages?.find((m: any) => m.status === 'streaming');
        if (streamingMsg?.content) setStreamText(streamingMsg.content);

        // Attempt to attach an SSE reader with up to MAX_RECONNECT_ATTEMPTS retries.
        let sessionReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
          if (cancelled) break;
          try {
            const response = await fetch(api.streamUrl(activeSessionId), {
              headers: authHeaders(),
            });
            if (response.body) {
              sessionReader = response.body.getReader();
              console.log('[useChat:refresh] SSE reader attached (attempt', attempt, ')');
              break;
            }
          } catch (fetchErr) {
            console.warn('[useChat:refresh] SSE fetch attempt', attempt, 'failed:', fetchErr);
          }
          if (attempt < MAX_RECONNECT_ATTEMPTS) {
            await sleep(attempt === 1 ? 1000 : 2000);
          }
        }

        if (cancelled || !sessionReader) {
          setStreaming(false);
          console.warn('[useChat:refresh] SSE stream fetch returned no body after retries');
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
        setStreaming(false);
      } catch (e) {
        console.error('Failed to load messages:', e);
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();
    return () => { cancelled = true; };
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
        setActiveToolCalls(prev => [
          ...prev,
          { tool: data.tool, args: data.args ?? {}, status: 'running', toolUseId: data.toolUseId ?? data.tool_use_id },
        ]);
        break;

      case 'tool_result':
        setActiveToolCalls(prev =>
          prev.map(tc =>
            ((data.toolUseId ?? data.tool_use_id) ? tc.toolUseId === (data.toolUseId ?? data.tool_use_id) : tc.tool === data.tool && tc.status === 'running')
              ? { ...tc, status: 'completed' as const, args: data.args ?? tc.args, result: data.result, durationMs: data.durationMs }
              : tc,
          ),
        );
        {
          const run = toolRunFromResult(data.tool, data.result);
          if (run) setSpawnedAgents(prev => upsertSpawnedRun(prev, run));
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

      case 'thread_created':
        setAgentThreads(prev => [...prev, {
          conversationId: data.conversationId as string,
          fromAgent: data.fromAgent as string,
          toAgent: data.toAgent as string,
          task: (data.task as string) ?? '',
          status: 'active',
          depth: data.depth as number,
          parentConversationId: data.parentConversationId as string | undefined,
        }]);
        break;

      case 'thread_message': {
        const activity: ThreadActivity = {
          type: (data.type as string) as ThreadActivity['type'],
          agent: data.agent as string,
          content: data.content as string | undefined,
          tool: data.tool as string | undefined,
          toolUseId: data.toolUseId as string | undefined,
          durationMs: data.durationMs as number | undefined,
          timestamp: Date.now(),
        };
        setAgentThreads(prev => prev.map(t =>
          t.conversationId === data.conversationId
            ? {
                ...t,
                toolCalls: data.tool ? [...(t.toolCalls ?? []), data.tool as string] : t.toolCalls,
                liveActivity: [...(t.liveActivity ?? []), activity],
              }
            : t,
        ));
        // Mirror to threadsByMessage so refresh-loaded threads (which
        // live in the grouped map, not agentThreads) also receive live
        // updates. Without this, SSE events after refresh are dropped
        // because agentThreads is empty post-refresh.
        setThreadsByMessage(prev => mapThreadInGroups(prev, data.conversationId as string, t => ({
          ...t,
          toolCalls: data.tool ? [...(t.toolCalls ?? []), data.tool as string] : t.toolCalls,
          liveActivity: [...(t.liveActivity ?? []), activity],
        })));
        break;
      }

      case 'thread_question':
        setAgentThreads(prev => prev.map(t =>
          t.conversationId === data.conversationId
            ? { ...t, status: 'waiting_for_answer' as const, pendingQuestion: { fromAgent: data.fromAgent as string, question: data.question as string } }
            : t,
        ));
        setThreadsByMessage(prev => mapThreadInGroups(prev, data.conversationId as string, t => ({
          ...t, status: 'waiting_for_answer' as const, pendingQuestion: { fromAgent: data.fromAgent as string, question: data.question as string },
        })));
        break;

      case 'thread_answer':
        setAgentThreads(prev => prev.map(t =>
          t.conversationId === data.conversationId
            ? { ...t, status: 'active' as const, pendingQuestion: undefined }
            : t,
        ));
        setThreadsByMessage(prev => mapThreadInGroups(prev, data.conversationId as string, t => ({
          ...t, status: 'active' as const, pendingQuestion: undefined,
        })));
        break;

      case 'thread_completed':
        setAgentThreads(prev => prev.map(t =>
          t.conversationId === data.conversationId
            ? { ...t, status: (data.error ? 'failed' : 'completed') as AgentThread['status'], summary: data.summary as string, costUsd: data.costUsd as number, durationMs: data.durationMs as number }
            : t,
        ));
        setThreadsByMessage(prev => mapThreadInGroups(prev, data.conversationId as string, t => ({
          ...t,
          status: (data.error ? 'failed' : 'completed') as AgentThread['status'],
          summary: data.summary as string,
          costUsd: data.costUsd as number,
          durationMs: data.durationMs as number,
        })));
        if (sessionId) {
          fetchThreadDetail(sessionId, data.conversationId as string).then(detail => {
            if (detail) {
              setAgentThreads(prev => prev.map(t =>
                t.conversationId === data.conversationId
                  ? { ...t, messages: detail.messages, response: detail.response }
                  : t,
              ));
              setThreadsByMessage(prev => mapThreadInGroups(prev, data.conversationId as string, t => ({
                ...t, messages: detail.messages, response: detail.response,
              })));
            }
          });
        }
        break;

      case 'user_question':
        setPendingUserQuestion({ question: data.question as string, fromAgent: data.fromAgent as string });
        break;

      case 'user_answer':
        setPendingUserQuestion(null);
        break;

      case 'agent_report':
        setAgentReports(prev => [...prev, {
          agent: data.agent as string,
          message: data.message as string,
          status: data.status as string,
          timestamp: data.timestamp as string,
        }]);
        break;

      case 'spawn_started':
        setSpawnedAgents(prev => upsertSpawnedRun(prev, {
          executionId: data.executionId as string,
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
            ? { ...s, activity: [...s.activity, { type: data.type as string, tool: data.tool as string | undefined, command: data.command as string | undefined, content: data.content as string | undefined, timestamp: Date.now() }] }
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
    async (provider?: string, model?: string, agentOverrides?: Record<string, unknown>, repoId?: string) => {
      const session = await api.createSession(provider, model, agentOverrides, repoId);
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
    setAgentThreads([]);
    setAgentReports([]);
    setThreadsByMessage({});
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
    setAgentThreads([]);
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
                  setActiveToolCalls(prev => [
                    ...prev,
                    { tool: data.tool, args: data.args ?? {}, status: 'running', toolUseId: data.toolUseId ?? data.tool_use_id },
                  ]);
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
                  setActiveToolCalls(prev =>
                    prev.map(tc =>
                      (toolUseId ? tc.toolUseId === toolUseId : tc.tool === data.tool && tc.status === 'running')
                        ? { ...tc, status: 'completed' as const, args: data.args ?? tc.args, result: data.result, durationMs: data.durationMs }
                      : tc,
                    ),
                  );
                  const run = toolRunFromResult(data.tool, data.result);
                  if (run) setSpawnedAgents(prev => upsertSpawnedRun(prev, run));
                  break;
                }

                case 'message_complete': {
                  const msgId = data.messageId || assistantMsgId;
                  setMessages(prev => [
                    ...prev,
                    {
                      _id: msgId,
                      sessionId,
                      role: 'assistant',
                      content: assistantText,
                      status: 'completed',
                      costUsd: data.costUsd,
                      durationMs: data.durationMs,
                      toolCalls: data.toolCalls || collectedToolCalls,
                      thinkingText: data.thinkingText ?? assistantThinking,
                      createdAt: new Date().toISOString(),
                    },
                  ]);
                  setStreamText('');
                  setThinkingText('');
                  setActiveToolCalls([]);

                  // Move live threads to threadsByMessage, then load full data from API
                  setAgentThreads(liveThreads => {
                    if (liveThreads.length > 0) {
                      setThreadsByMessage(prev => ({ ...prev, [msgId]: liveThreads }));
                    }
                    return [];
                  });
                  setAgentReports([]);

                  // Fetch full thread data from DB (messages, response, etc.)
                  // This replaces the incomplete SSE-only data with the persisted version
                  if (sessionId) {
                    api.getThreads(sessionId).then(threads => {
                      // Same multi-anchor grouping as the initial-load path
                      // (see the parentMessageIds comment above).
                      const grouped: Record<string, AgentThread[]> = {};
                      for (const t of threads) {
                        const keys: string[] = Array.isArray(t.parentMessageIds) && t.parentMessageIds.length
                          ? t.parentMessageIds
                          : [t.parentMessageId];
                        const threadObj: AgentThread = {
                          conversationId: t._id,
                          fromAgent: t.fromAgent,
                          toAgent: t.toAgent,
                          task: t.task,
                          status: t.status,
                          summary: t.summary,
                          response: t.response,
                          messages: t.messages,
                          costUsd: t.costUsd,
                          durationMs: t.durationMs,
                          depth: t.depth,
                          parentConversationId: t.parentConversationId,
                        };
                        for (const key of keys) {
                          if (!grouped[key]) grouped[key] = [];
                          grouped[key].push(threadObj);
                        }
                      }
                      setThreadsByMessage(grouped);
                    }).catch(() => {});
                  }
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

                case 'thread_created':
                  setAgentThreads(prev => [...prev, {
                    conversationId: data.conversationId as string,
                    fromAgent: data.fromAgent as string,
                    toAgent: data.toAgent as string,
                    task: (data.task as string) ?? '',
                    status: 'active',
                    depth: data.depth as number,
                    parentConversationId: data.parentConversationId as string | undefined,
                  }]);
                  break;

                case 'thread_message': {
                  const act: ThreadActivity = {
                    type: (data.type as string) as ThreadActivity['type'],
                    agent: data.agent as string,
                    content: data.content as string | undefined,
                    tool: data.tool as string | undefined,
                    toolUseId: data.toolUseId as string | undefined,
                    durationMs: data.durationMs as number | undefined,
                    timestamp: Date.now(),
                  };
                  setAgentThreads(prev => prev.map(t =>
                    t.conversationId === data.conversationId
                      ? {
                          ...t,
                          toolCalls: data.tool ? [...(t.toolCalls ?? []), data.tool as string] : t.toolCalls,
                          liveActivity: [...(t.liveActivity ?? []), act],
                        }
                      : t,
                  ));
                  break;
                }

                case 'thread_question':
                  setAgentThreads(prev => prev.map(t =>
                    t.conversationId === data.conversationId
                      ? { ...t, status: 'waiting_for_answer' as const, pendingQuestion: { fromAgent: data.fromAgent as string, question: data.question as string } }
                      : t,
                  ));
                  break;

                case 'thread_answer':
                  setAgentThreads(prev => prev.map(t =>
                    t.conversationId === data.conversationId
                      ? { ...t, status: 'active' as const, pendingQuestion: undefined }
                      : t,
                  ));
                  break;

                case 'thread_completed':
                  setAgentThreads(prev => prev.map(t =>
                    t.conversationId === data.conversationId
                      ? { ...t, status: (data.error ? 'failed' : 'completed') as AgentThread['status'], summary: data.summary as string, costUsd: data.costUsd as number, durationMs: data.durationMs as number }
                      : t,
                  ));
                  if (sessionId) {
                    fetchThreadDetail(sessionId, data.conversationId as string).then(detail => {
                      if (detail) {
                        setAgentThreads(prev => prev.map(t =>
                          t.conversationId === data.conversationId
                            ? { ...t, messages: detail.messages, response: detail.response }
                            : t,
                        ));
                      }
                    });
                  }
                  break;

                case 'user_question':
                  setPendingUserQuestion({ question: data.question as string, fromAgent: data.fromAgent as string });
                  break;

                case 'user_answer':
                  setPendingUserQuestion(null);
                  break;

                case 'agent_report':
                  setAgentReports(prev => [...prev, {
                    agent: data.agent as string,
                    message: data.message as string,
                    status: data.status as string,
                    timestamp: data.timestamp as string,
                  }]);
                  break;

                case 'spawn_started':
                  setSpawnedAgents(prev => upsertSpawnedRun(prev, {
                    executionId: data.executionId as string,
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
                      ? { ...s, activity: [...s.activity, { type: data.type as string, tool: data.tool as string | undefined, command: data.command as string | undefined, content: data.content as string | undefined, timestamp: Date.now() }] }
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
            if (streamingMsg?.content) {
              setStreamText(streamingMsg.content);
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
      }).catch(() => { /* best-effort — frontend abort already happened */ });
    }
    setStreaming(false);
    setStreamText('');
    setThinkingText('');
    setActiveToolCalls([]);
  }, [activeSessionId]);

  const answerWorkflowIntervention = useCallback(async (input: WorkflowInterventionAnswer) => {
    if (!activeSessionId) return;

    await interventionsApi.respond(input.interventionId, {
      decision: input.decision,
      field_values: input.decision === 'approve' || input.decision === 'answer' ? input.fieldValues : undefined,
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
    agentThreads,
    agentReports,
    threadsByMessage,
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
