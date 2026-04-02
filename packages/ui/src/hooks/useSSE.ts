import { useEffect, useRef, useCallback, useState } from 'react';

export interface SSEEvent {
  event: string;
  data: any;
}

export function useSSE(url: string | null, onEvent: (e: SSEEvent) => void) {
  const sourceRef = useRef<EventSource | null>(null);
  const [connected, setConnected] = useState(false);

  const stableCallback = useRef(onEvent);
  stableCallback.current = onEvent;

  useEffect(() => {
    if (!url) return;

    const es = new EventSource(url);
    sourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const eventTypes = [
      'execution_started', 'execution_completed', 'execution_failed',
      'node_started', 'node_completed', 'node_failed', 'node_retrying',
      'agent_text', 'agent_tool_start', 'agent_tool_complete',
      'input_required', 'input_received',
      'parallel_started', 'parallel_branch_done', 'parallel_joined',
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          stableCallback.current({ event: type, data });
        } catch { /* ignore parse errors */ }
      });
    }

    return () => {
      es.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [url]);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setConnected(false);
  }, []);

  return { connected, close };
}
