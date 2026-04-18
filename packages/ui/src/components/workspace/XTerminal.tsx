import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';

interface XTerminalProps {
  workspaceId: string;
  terminalId?: string;
  className?: string;
  /** Command to auto-run after terminal connects */
  initialCommand?: string;
}

type Status = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

// Reconnect tuning
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

export function XTerminal({ workspaceId, terminalId = 'default', className, initialCommand }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  // Flip to true in cleanup so onclose handler knows not to reconnect
  const unmountedRef = useRef(false);
  // initialCommand should only run on the very first connect, not on reconnects
  const initialCommandSentRef = useRef(false);

  const [status, setStatus] = useState<Status>('connecting');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    unmountedRef.current = false;
    initialCommandSentRef.current = false;
    attemptRef.current = 0;

    // Create terminal ONCE — preserved across reconnects so scrollback/history stays.
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 11,
      fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
      lineHeight: 1.3,
      letterSpacing: 0,
      theme: {
        background: '#0d111c',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#0d111c',
        selectionBackground: '#264f7844',
        selectionForeground: '#c9d1d9',
        black: '#484f58',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#c9d1d9',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc',
      },
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());

    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Input → WebSocket. Bound once; always reads the current wsRef.
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const connect = () => {
      if (unmountedRef.current) return;

      const attemptNum = attemptRef.current;
      setAttempt(attemptNum);
      setStatus(attemptNum === 0 ? 'connecting' : 'reconnecting');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/workspaces/${workspaceId}/terminal/${terminalId}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current) { ws.close(); return; }
        setStatus('connected');
        if (attemptRef.current > 0) {
          term.write('\r\n\x1b[32m[reconnected]\x1b[0m\r\n');
        }
        attemptRef.current = 0;
        setAttempt(0);
        // Resend current size so the server PTY matches the viewport
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        if (initialCommand && !initialCommandSentRef.current) {
          initialCommandSentRef.current = true;
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(initialCommand + '\n');
          }, 500);
        }
      };

      ws.onmessage = (evt) => { term.write(evt.data); };

      ws.onerror = () => { /* let onclose drive the reconnect */ };

      ws.onclose = () => {
        wsRef.current = null;
        if (unmountedRef.current) return;

        if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setStatus('disconnected');
          term.write('\r\n\x1b[31m[disconnected — max retries reached. Reload the page to reconnect.]\x1b[0m\r\n');
          return;
        }

        // First drop: notify user. Subsequent drops: stay silent to avoid spam.
        if (attemptRef.current === 0) {
          term.write('\r\n\x1b[33m[disconnected — reconnecting…]\x1b[0m\r\n');
        }

        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attemptRef.current), MAX_DELAY_MS);
        attemptRef.current += 1;
        setStatus('reconnecting');
        setAttempt(attemptRef.current);
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    // Resize observer — push new cols/rows to server on every fit
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });
    resizeObserver.observe(containerRef.current);

    // Visibility/online events: if we're disconnected when the tab becomes
    // active again or the network comes back, attempt reconnect immediately
    // (skips the remaining backoff delay).
    const kickReconnect = () => {
      if (unmountedRef.current) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) return; // already good
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (attemptRef.current < MAX_RECONNECT_ATTEMPTS) connect();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') kickReconnect(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', kickReconnect);

    return () => {
      unmountedRef.current = true;
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', kickReconnect);
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try { wsRef.current?.close(); } catch {}
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [workspaceId, terminalId]);

  const badge = (() => {
    if (status === 'connected') return null;
    if (status === 'connecting') return { text: 'connecting…', cls: 'text-amber-400 bg-amber-400/10 border-amber-400/20' };
    if (status === 'reconnecting') return { text: `reconnecting… (${attempt}/${MAX_RECONNECT_ATTEMPTS})`, cls: 'text-amber-400 bg-amber-400/10 border-amber-400/20' };
    return { text: 'disconnected', cls: 'text-red-400 bg-red-400/10 border-red-400/20' };
  })();

  return (
    <div className={`relative ${className ?? ''}`}>
      <div ref={containerRef} className="w-full h-full" />
      {badge && (
        <div className={`absolute top-2 right-2 text-[10px] font-mono px-2 py-0.5 rounded border ${badge.cls}`}>
          {badge.text}
        </div>
      )}
    </div>
  );
}
