import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { openExternalUrl } from '../../lib/workspace-preview';
import { terminalWebSocketUrl, type TerminalSourceType } from '../../lib/terminal-routing';
import '@xterm/xterm/css/xterm.css';

export type { TerminalSourceType } from '../../lib/terminal-routing';

interface XTerminalProps {
  workspaceId: string;
  terminalId?: string;
  sourceType?: TerminalSourceType;
  className?: string;
  /** Command to auto-run after terminal connects */
  initialCommand?: string;
  /** Send Ctrl+C to the PTY before closing this terminal view. */
  interruptOnUnmount?: boolean;
}

type Status = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
type RuntimeInfo = Awaited<ReturnType<NonNullable<typeof window.allenDesktop>['getRuntimeInfo']>>;

// Reconnect tuning
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
const MAX_TERMINAL_BUFFER_CHARS = 500_000;
const terminalBuffers = new Map<string, string>();
const activeTerminalInputs = new Map<string, (data: string) => boolean>();

function terminalBufferKey(sourceType: TerminalSourceType, sourceId: string, terminalId: string): string {
  return `allen-terminal-buffer:${sourceType}:${sourceId}:${terminalId}`;
}

export function sendTerminalInput(sourceType: TerminalSourceType, sourceId: string, terminalId: string, data: string): boolean {
  return activeTerminalInputs.get(terminalBufferKey(sourceType, sourceId, terminalId))?.(data) ?? false;
}

function readTerminalBuffer(key: string): string {
  const cached = terminalBuffers.get(key);
  if (cached != null) return cached;
  try {
    const stored = sessionStorage.getItem(key) ?? '';
    if (stored) terminalBuffers.set(key, stored);
    return stored;
  } catch {
    return '';
  }
}

function writeTerminalBuffer(key: string, value: string): void {
  const next = value.length > MAX_TERMINAL_BUFFER_CHARS
    ? value.slice(value.length - MAX_TERMINAL_BUFFER_CHARS)
    : value;
  terminalBuffers.set(key, next);
  try {
    sessionStorage.setItem(key, next);
  } catch {
    // Best effort: the in-memory cache still covers tab switches.
  }
}

function appendTerminalBuffer(key: string, value: string): void {
  if (!value) return;
  writeTerminalBuffer(key, `${readTerminalBuffer(key)}${value}`);
}

function writeTerminalPayload(term: XTerm, payload: unknown, bufferKey: string): void {
  if (typeof payload !== 'string') {
    const text = String(payload);
    term.write(text);
    appendTerminalBuffer(bufferKey, text);
    return;
  }
  try {
    const parsed = JSON.parse(payload) as { type?: string; data?: unknown };
    if (parsed?.type === 'error') {
      term.write(`\r\n\x1b[31m${String(parsed.data ?? 'Terminal error')}\x1b[0m\r\n`);
      return;
    }
    if (parsed?.type === 'replay') {
      const replay = String(parsed.data ?? '');
      term.reset();
      term.write(replay);
      writeTerminalBuffer(bufferKey, replay);
      return;
    }
  } catch {
    // Regular terminal bytes.
  }
  term.write(payload);
  appendTerminalBuffer(bufferKey, payload);
}

export function XTerminal({ workspaceId, terminalId = 'default', sourceType = 'workspace', className, initialCommand, interruptOnUnmount = false }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const runtimeInfoRef = useRef<RuntimeInfo | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  // Flip to true in cleanup so onclose handler knows not to reconnect
  const unmountedRef = useRef(false);
  // initialCommand should only run on the very first connect, not on reconnects
  const initialCommandSentRef = useRef(false);

  const [status, setStatus] = useState<Status>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [runtimeMode, setRuntimeMode] = useState<'desktop' | 'web'>('web');

  useEffect(() => {
    if (!containerRef.current) return;

    unmountedRef.current = false;
    initialCommandSentRef.current = false;
    attemptRef.current = 0;

    // Create terminal ONCE — preserved across reconnects so scrollback/history stays.
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 12,
      fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'MesloLGS NF', 'Symbols Nerd Font Mono', 'SF Mono', Menlo, Monaco, 'Cascadia Mono', 'Segoe UI Mono', Consolas, monospace",
      lineHeight: 1.25,
      letterSpacing: 0,
      theme: {
        background: '#0b0f14',
        foreground: '#d0d4da',
        cursor: '#d0d4da',
        cursorAccent: '#0b0f14',
        selectionBackground: '#3b82f666',
        selectionForeground: '#f5f7fa',
        black: '#0b0f14',
        red: '#ff6b6b',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#d0d4da',
        brightBlack: '#626a73',
        brightRed: '#ff8585',
        brightGreen: '#74e8a3',
        brightYellow: '#ffd166',
        brightBlue: '#8abfff',
        brightMagenta: '#d6adff',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void openExternalUrl(uri);
    }));
    term.loadAddon(new SearchAddon());

    term.open(containerRef.current);
    fitAddon.fit();

    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.stopPropagation();
      }
      return true;
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    const bufferKey = terminalBufferKey(sourceType, workspaceId, terminalId);
    activeTerminalInputs.set(bufferKey, (data: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(data);
      return true;
    });
    const restoredBuffer = readTerminalBuffer(bufferKey);
    if (restoredBuffer) {
      term.write(restoredBuffer);
    }

    // xterm should own keyboard input while focused. This lets terminal
    // shortcuts reach the PTY without triggering surrounding app shortcuts
    // such as command palettes, panel toggles, or canvas/editor hotkeys.
    const stopTerminalShortcutBubble = (event: Event) => {
      event.stopPropagation();
    };
    const terminalRoot = containerRef.current;
    terminalRoot.addEventListener('keydown', stopTerminalShortcutBubble);
    terminalRoot.addEventListener('keyup', stopTerminalShortcutBubble);
    terminalRoot.addEventListener('keypress', stopTerminalShortcutBubble);
    terminalRoot.addEventListener('paste', stopTerminalShortcutBubble);
    terminalRoot.addEventListener('copy', stopTerminalShortcutBubble);

    // Input → WebSocket. Bound once; always reads the current wsRef.
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const connect = async () => {
      if (unmountedRef.current) return;
      if (window.allenDesktop?.getRuntimeInfo && !runtimeInfoRef.current) {
        try {
          runtimeInfoRef.current = await window.allenDesktop.getRuntimeInfo();
          setRuntimeMode('desktop');
        } catch {
          runtimeInfoRef.current = null;
          setRuntimeMode('web');
        }
      }
      if (unmountedRef.current) return;

      const attemptNum = attemptRef.current;
      setAttempt(attemptNum);
      setStatus(attemptNum === 0 ? 'connecting' : 'reconnecting');

      const wsUrl = terminalWebSocketUrl(sourceType, workspaceId, terminalId, runtimeInfoRef.current);
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

      ws.onmessage = (evt) => { writeTerminalPayload(term, evt.data, bufferKey); };

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
      terminalRoot.removeEventListener('keydown', stopTerminalShortcutBubble);
      terminalRoot.removeEventListener('keyup', stopTerminalShortcutBubble);
      terminalRoot.removeEventListener('keypress', stopTerminalShortcutBubble);
      terminalRoot.removeEventListener('paste', stopTerminalShortcutBubble);
      terminalRoot.removeEventListener('copy', stopTerminalShortcutBubble);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', kickReconnect);
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      activeTerminalInputs.delete(bufferKey);
      try {
        if (interruptOnUnmount && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send('\x03');
        }
      } catch {}
      try { wsRef.current?.close(); } catch {}
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [workspaceId, terminalId, sourceType]);

  const badge = (() => {
    if (status === 'connected') return null;
    if (status === 'connecting') return { text: 'connecting…', cls: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/30' };
    if (status === 'reconnecting') return { text: `reconnecting… (${attempt}/${MAX_RECONNECT_ATTEMPTS})`, cls: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/30' };
    return { text: 'disconnected', cls: 'text-accent-red bg-accent-red/10 border-accent-red/30' };
  })();

  return (
    <div className={`relative min-h-0 overflow-hidden bg-[#0b0f14] ${className ?? ''}`} data-terminal-runtime={runtimeMode}>
      <div className="flex h-full min-h-0 w-full px-3 pb-8 pt-2">
        <div ref={containerRef} className="allen-terminal min-h-0 flex-1 overflow-hidden" />
      </div>
      {badge && (
        <div className={`absolute right-2 top-2 text-[10px] font-mono px-2 py-0.5 rounded border ${badge.cls}`}>
          {badge.text}
        </div>
      )}
    </div>
  );
}
