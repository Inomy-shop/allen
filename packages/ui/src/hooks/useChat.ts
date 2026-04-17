import { useState, useEffect, useCallback, useRef } from 'react';
import { chat as api, authHeaders } from '../services/api';

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
}

export interface ChatMessage {
  _id?: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'streaming' | 'failed';
  costUsd?: number;
  durationMs?: number;
  error?: string;
  toolCalls?: ToolCallRecord[];
  createdAt: string;
}

/** Active tool call being streamed */
export interface ActiveToolCall {
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'completed';
  result?: Record<string, unknown>;
  durationMs?: number;
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
  status: 'running' | 'completed' | 'failed';
  activity: { type: string; tool?: string; command?: string; timestamp: number }[];
  durationMs?: number;
  toolCount?: number;
  response?: string;
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
        setMessages(session.messages || []);

        // Group threads by parentMessageId so they render inline with messages
        const grouped: Record<string, AgentThread[]> = {};
        for (const t of threads) {
          const key = t.parentMessageId;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push({
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
          });
        }
        setThreadsByMessage(grouped);

        // Check if this session has an active streaming response
        const { streaming: isActive } = await api.isStreaming(activeSessionId);
        if (cancelled || !isActive) return;

        // Reconnect to the active stream
        setStreaming(true);
        const streamingMsg = session.messages?.find((m: any) => m.status === 'streaming');
        if (streamingMsg?.content) setStreamText(streamingMsg.content);

        const response = await fetch(api.streamUrl(activeSessionId), {
          headers: authHeaders(),
        });
        if (cancelled || !response.body) { setStreaming(false); return; }

        const reader = response.body.getReader();
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
        setThinkingText(''); // clear thinking once text arrives
        break;

      case 'thinking':
        setThinkingText(data.text ?? '');
        break;

      case 'tool_start':
        setActiveToolCalls(prev => [
          ...prev,
          { tool: data.tool, args: data.args ?? {}, status: 'running' },
        ]);
        break;

      case 'tool_result':
        setActiveToolCalls(prev =>
          prev.map(tc =>
            tc.tool === data.tool && tc.status === 'running'
              ? { ...tc, status: 'completed' as const, result: data.result, durationMs: data.durationMs }
              : tc,
          ),
        );
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
        setSpawnedAgents(prev => [...prev, {
          executionId: data.executionId as string,
          agent: data.agent as string,
          prompt: (data.prompt as string) ?? '',
          status: 'running',
          activity: [],
        }]);
        break;

      case 'spawn_activity':
        setSpawnedAgents(prev => prev.map(s =>
          s.executionId === data.executionId
            ? { ...s, activity: [...s.activity, { type: data.type as string, tool: data.tool as string | undefined, command: data.command as string | undefined, timestamp: Date.now() }] }
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
            createdAt: new Date().toISOString(),
          },
        ]);
        setStreamText('');
        setActiveToolCalls([]);
        setStreaming(false);
        break;
    }
  }, [streamText]);

  const createSession = useCallback(
    async (provider?: string, model?: string, agentOverrides?: Record<string, unknown>) => {
      const session = await api.createSession(provider, model, agentOverrides);
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

  const sendMessage = useCallback(async (content: string, overrideSessionId?: string, agent?: string) => {
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
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch(api.sendMessageUrl(sessionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ content, agent }),
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
      let collectedToolCalls: ToolCallRecord[] = [];

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
                  setThinkingText('');
                  break;

                case 'thinking':
                  setThinkingText(data.text ?? '');
                  break;

                case 'tool_start':
                  setActiveToolCalls(prev => [
                    ...prev,
                    { tool: data.tool, args: data.args ?? {}, status: 'running' },
                  ]);
                  break;

                case 'tool_result': {
                  const toolRecord: ToolCallRecord = {
                    tool: data.tool,
                    args: {},
                    result: data.result,
                    durationMs: data.durationMs,
                    timestamp: new Date().toISOString(),
                  };
                  collectedToolCalls.push(toolRecord);
                  setActiveToolCalls(prev =>
                    prev.map(tc =>
                      tc.tool === data.tool && tc.status === 'running'
                        ? { ...tc, status: 'completed' as const, result: data.result, durationMs: data.durationMs }
                        : tc,
                    ),
                  );
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
                      const grouped: Record<string, AgentThread[]> = {};
                      for (const t of threads) {
                        const key = t.parentMessageId;
                        if (!grouped[key]) grouped[key] = [];
                        grouped[key].push({
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
                        });
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
      if ((err as Error).name !== 'AbortError') {
        console.error('Chat stream error:', err);
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
      await api.answerAgentQuestion(activeSessionId, answer);
      setPendingUserQuestion(null);
    },
    loadingSessions,
    loadingMessages,
    sendMessage,
    createSession,
    deleteSession,
    switchSession,
    cancelStream,
    refresh: loadSessions,
  };
}
