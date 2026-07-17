import { useAuthStore } from '../../stores/authStore';
import { useExecutionStore, type ExecutionSnapshot } from '../../stores/executionStore';

type Message = { type?: string; status?: string; snapshot?: ExecutionSnapshot; snapshots?: ExecutionSnapshot[] };
type DesktopBridge = NonNullable<Window['allenDesktop']>;
let cleanupActive: (() => void) | null = null;
let unsubscribeAuth: (() => void) | null = null;

function hasDesktopRealtimeBridge(
  desktop: Window['allenDesktop'] | undefined,
): desktop is DesktopBridge {
  return Boolean(
    desktop
    && typeof desktop.setRealtimeAuth === 'function'
    && typeof desktop.subscribeExecutionState === 'function'
    && typeof desktop.onRealtimeEvent === 'function'
    && typeof desktop.onRealtimeStatus === 'function',
  );
}

function executionIds(): string[] {
  return Object.keys(useExecutionStore.getState().entities);
}

function receive(payload: unknown): void {
  const message = payload as Message;
  if (message.type === 'execution.changed' && message.snapshot) useExecutionStore.getState().ingest(message.snapshot);
  if (message.type === 'subscribed' && Array.isArray(message.snapshots)) useExecutionStore.getState().ingestMany(message.snapshots);
  if (message.type === 'connection.status' && message.status) {
    useExecutionStore.getState().setConnectionStatus(message.status as 'connecting' | 'connected' | 'disconnected');
  }
}

function startDesktop(token: string): () => void {
  const desktop = window.allenDesktop!;
  void desktop.setRealtimeAuth(token);
  const offEvent = desktop.onRealtimeEvent(receive);
  const offStatus = desktop.onRealtimeStatus((payload) => receive({ type: 'connection.status', ...payload }));
  void desktop.subscribeExecutionState(executionIds()).then((snapshots) => receive({ type: 'subscribed', snapshots })).catch(() => {});
  const unsubscribeStore = useExecutionStore.subscribe((state, previous) => {
    if (Object.keys(state.entities).length !== Object.keys(previous.entities).length) {
      void desktop.subscribeExecutionState(Object.keys(state.entities)).catch(() => {});
    }
  });
  return () => {
    offEvent();
    offStatus();
    unsubscribeStore();
  };
}

function startSharedWorker(token: string): (() => void) | null {
  if (typeof SharedWorker === 'undefined') return null;
  const worker = new SharedWorker(new URL('./sharedWorker.ts', import.meta.url), { type: 'module', name: 'allen-execution-state' });
  worker.port.onmessage = (event) => receive(event.data);
  worker.port.start();
  worker.port.postMessage({ type: 'auth', token });
  worker.port.postMessage({ type: 'subscribe', executionIds: executionIds() });
  const unsubscribeStore = useExecutionStore.subscribe((state, previous) => {
    if (Object.keys(state.entities).length !== Object.keys(previous.entities).length) {
      worker.port.postMessage({ type: 'subscribe', executionIds: Object.keys(state.entities) });
    }
  });
  return () => {
    unsubscribeStore();
    worker.port.postMessage({ type: 'disconnect' });
    worker.port.close();
  };
}

function startDirect(token: string, emit: (payload: unknown) => void = receive): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  const connect = () => {
    if (stopped) return;
    const url = new URL('/ws/realtime', window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url);
    emit({ type: 'connection.status', status: 'connecting' });
    socket.onopen = () => socket?.send(JSON.stringify({ type: 'authenticate', token }));
    socket.onmessage = (event) => {
      let message: Message;
      try { message = JSON.parse(String(event.data)) as Message; } catch { return; }
      if (message.type === 'authenticated') {
        attempt = 0;
        emit({ type: 'connection.status', status: 'connected' });
        socket?.send(JSON.stringify({ type: 'subscribe', all: true, executionIds: executionIds() }));
      } else emit(message);
    };
    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      emit({ type: 'connection.status', status: 'disconnected' });
      retry = setTimeout(connect, Math.min(15_000, 500 * (2 ** Math.min(attempt++, 5))));
    };
  };
  connect();
  const unsubscribeStore = useExecutionStore.subscribe((state, previous) => {
    if (socket?.readyState === WebSocket.OPEN && Object.keys(state.entities).length !== Object.keys(previous.entities).length) {
      socket.send(JSON.stringify({ type: 'subscribe', all: true, executionIds: Object.keys(state.entities) }));
    }
  });
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    unsubscribeStore();
    socket?.close(1000, 'client stopped');
  };
}

/**
 * SharedWorker is the preferred web coordinator. This fallback elects one
 * tab to own the socket and fans safe snapshots out over BroadcastChannel,
 * avoiding one backend connection per tab in browsers without SharedWorker.
 */
function startBroadcastLeader(token: string): (() => void) | null {
  if (typeof BroadcastChannel === 'undefined' || typeof localStorage === 'undefined') return null;
  const channel = new BroadcastChannel('allen-execution-state');
  const leaderKey = 'allen-execution-state-leader';
  const tabId = crypto.randomUUID();
  const leaseMs = 6_000;
  let stopped = false;
  let leaderCleanup: (() => void) | null = null;

  type Lease = { tabId: string; expiresAt: number };
  const readLease = (): Lease | null => {
    try {
      const value = JSON.parse(localStorage.getItem(leaderKey) ?? 'null') as Lease | null;
      return value && typeof value.tabId === 'string' && typeof value.expiresAt === 'number' ? value : null;
    } catch { return null; }
  };
  const writeLease = (): boolean => {
    try {
      localStorage.setItem(leaderKey, JSON.stringify({ tabId, expiresAt: Date.now() + leaseMs }));
      return readLease()?.tabId === tabId;
    } catch { return false; }
  };
  const announceInterest = () => {
    channel.postMessage({ kind: 'interest', snapshots: Object.values(useExecutionStore.getState().entities) });
  };
  const becomeLeader = () => {
    if (leaderCleanup || stopped) return;
    leaderCleanup = startDirect(token, (payload) => {
      receive(payload);
      channel.postMessage({ kind: 'state', payload });
    });
  };
  const relinquish = () => {
    leaderCleanup?.();
    leaderCleanup = null;
  };
  const elect = () => {
    if (stopped) return;
    const lease = readLease();
    if (lease?.tabId === tabId) {
      writeLease();
      becomeLeader();
      return;
    }
    if (!lease || lease.expiresAt <= Date.now()) {
      if (writeLease()) becomeLeader();
    } else {
      relinquish();
      announceInterest();
    }
  };

  channel.onmessage = (event) => {
    const message = event.data as { kind?: string; payload?: unknown; snapshots?: ExecutionSnapshot[] };
    if (message.kind === 'state') receive(message.payload);
    if (message.kind === 'interest' && leaderCleanup && Array.isArray(message.snapshots)) {
      useExecutionStore.getState().ingestMany(message.snapshots);
    }
  };
  const unsubscribeStore = useExecutionStore.subscribe((state, previous) => {
    if (!leaderCleanup && state.changeVersion !== previous.changeVersion) announceInterest();
  });
  const interval = window.setInterval(elect, 2_000);
  const onStorage = (event: StorageEvent) => { if (event.key === leaderKey) elect(); };
  window.addEventListener('storage', onStorage);
  elect();
  announceInterest();

  return () => {
    stopped = true;
    window.clearInterval(interval);
    window.removeEventListener('storage', onStorage);
    unsubscribeStore();
    relinquish();
    if (readLease()?.tabId === tabId) localStorage.removeItem(leaderKey);
    channel.close();
  };
}

function restart(token: string | null): void {
  cleanupActive?.();
  cleanupActive = null;
  const desktop = window.allenDesktop;
  if (!token) {
    useExecutionStore.getState().clear();
    if (hasDesktopRealtimeBridge(desktop)) void desktop.setRealtimeAuth(null);
    return;
  }
  if (desktop && !hasDesktopRealtimeBridge(desktop)) {
    useExecutionStore.getState().setConnectionStatus('disconnected');
    console.error('[execution-realtime] Desktop preload bridge is missing realtime methods');
    return;
  }
  cleanupActive = desktop
    ? startDesktop(token)
    : startSharedWorker(token) ?? startBroadcastLeader(token) ?? startDirect(token);
}

export function initializeExecutionRealtime(): void {
  if (unsubscribeAuth) return;
  let currentToken = useAuthStore.getState().accessToken;
  restart(currentToken);
  unsubscribeAuth = useAuthStore.subscribe((state) => {
    if (state.accessToken === currentToken) return;
    currentToken = state.accessToken;
    restart(currentToken);
  });
}
