/// <reference lib="webworker" />

type PortState = { port: MessagePort; executionIds: string[] };
const ports = new Set<PortState>();
let token: string | null = null;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

function broadcast(message: unknown): void {
  for (const state of ports) state.port.postMessage(message);
}

function sendSubscription(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const executionIds = [...new Set([...ports].flatMap((state) => state.executionIds))];
  socket.send(JSON.stringify({ type: 'subscribe', all: true, executionIds }));
}

function connect(): void {
  if (!token || socket) return;
  const url = new URL('/ws/realtime', self.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const activeSocket = new WebSocket(url);
  socket = activeSocket;
  broadcast({ type: 'connection.status', status: 'connecting' });
  activeSocket.onopen = () => {
    reconnectAttempt = 0;
    activeSocket.send(JSON.stringify({ type: 'authenticate', token }));
  };
  activeSocket.onmessage = (event) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type === 'authenticated') {
      broadcast({ type: 'connection.status', status: 'connected' });
      sendSubscription();
    } else {
      broadcast(message);
    }
  };
  activeSocket.onclose = () => {
    if (socket !== activeSocket) return;
    socket = null;
    broadcast({ type: 'connection.status', status: 'disconnected' });
    if (!token || reconnectTimer) return;
    const delay = Math.min(15_000, 500 * (2 ** Math.min(reconnectAttempt++, 5)));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };
}

function setToken(nextToken: string | null): void {
  if (token === nextToken) return;
  token = nextToken;
  socket?.close(1000, 'auth changed');
  socket = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (token) connect();
}

(self as unknown as SharedWorkerGlobalScope).onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  const state: PortState = { port, executionIds: [] };
  ports.add(state);
  port.onmessage = (messageEvent) => {
    const message = messageEvent.data as Record<string, unknown>;
    if (message.type === 'auth') setToken(typeof message.token === 'string' ? message.token : null);
    if (message.type === 'subscribe') {
      state.executionIds = Array.isArray(message.executionIds)
        ? message.executionIds.filter((id): id is string => typeof id === 'string')
        : [];
      sendSubscription();
    }
    if (message.type === 'disconnect') {
      ports.delete(state);
      port.close();
    }
  };
  port.start();
};

export {};
