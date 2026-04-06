import { useState, useEffect, useCallback, useRef } from 'react';
import { chat as api } from '../services/api';

export interface ChatSession {
  _id: string;
  title: string;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt: string;
  totalCostUsd: number;
  provider: string;
  model?: string;
  claudeSessionId?: string;
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

export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
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
        const session = await api.getSession(activeSessionId);
        if (cancelled) return;
        setMessages(session.messages || []);

        // Check if this session has an active streaming response
        const { streaming: isActive } = await api.isStreaming(activeSessionId);
        if (cancelled || !isActive) return;

        // Reconnect to the active stream
        setStreaming(true);
        const streamingMsg = session.messages?.find((m: any) => m.status === 'streaming');
        if (streamingMsg?.content) setStreamText(streamingMsg.content);

        const response = await fetch(api.streamUrl(activeSessionId));
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

  const createSession = useCallback(async (provider?: string, model?: string) => {
    const session = await api.createSession(provider, model);
    setSessions(prev => [session, ...prev]);
    setActiveSessionId(session._id);
    setMessages([]);
    return session;
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    await api.deleteSession(id);
    setSessions(prev => prev.filter(s => s._id !== id));
    if (activeSessionId === id) {
      setActiveSessionId(null);
      setMessages([]);
    }
  }, [activeSessionId]);

  const switchSession = useCallback((id: string) => {
    if (streaming) return;
    setActiveSessionId(id);
    setStreamText('');
    setThinkingText('');
    setActiveToolCalls([]);
  }, [streaming]);

  const sendMessage = useCallback(async (content: string, overrideSessionId?: string) => {
    const sessionId = overrideSessionId || activeSessionId;
    if (!sessionId || streaming) return;

    sendingRef.current = true;
    setStreaming(true);
    setStreamText('');
    setThinkingText('');
    setActiveToolCalls([]);

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
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

                case 'message_complete':
                  setMessages(prev => [
                    ...prev,
                    {
                      _id: data.messageId || assistantMsgId,
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
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStreaming(false);
    setStreamText('');
    setThinkingText('');
    setActiveToolCalls([]);
  }, []);

  return {
    sessions,
    activeSessionId,
    messages,
    streaming,
    streamText,
    thinkingText,
    activeToolCalls,
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
