import type { WebContents } from 'electron';
import WebSocket from 'ws';

type Snapshot = { executionId: string; revision: number; runGeneration: number } & Record<string, unknown>;

export class DesktopRealtimeBroker {
  private token: string | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private readonly subscribers = new Map<number, { contents: WebContents; ids: Set<string> }>();
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(
    private readonly baseUrl: string,
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  setAuthToken(token: string | null): void {
    if (this.token === token) return;
    this.token = token;
    this.disconnect();
    if (token) this.connect();
    else {
      this.snapshots.clear();
      this.broadcastStatus('disconnected');
    }
  }

  subscribe(contents: WebContents, executionIds: string[]): Snapshot[] {
    const ids = new Set(executionIds.filter((id) => typeof id === 'string' && id.length > 0));
    const isNewSubscriber = !this.subscribers.has(contents.id);
    this.subscribers.set(contents.id, { contents, ids });
    if (isNewSubscriber) contents.once('destroyed', () => this.subscribers.delete(contents.id));
    this.sendSubscription();
    return [...ids].map((id) => this.snapshots.get(id)).filter((value): value is Snapshot => Boolean(value));
  }

  private connect(): void {
    if (this.stopped || !this.token || this.socket) return;
    const url = new URL('/ws/realtime', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.createSocket(url.toString());
    this.socket = socket;
    this.broadcastStatus('connecting');

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify({ type: 'authenticate', token: this.token }));
    });
    socket.on('message', (raw) => this.handleMessage(raw.toString()));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.broadcastStatus('disconnected');
      this.scheduleReconnect();
    });
    socket.on('error', () => {
      // close drives the single reconnect path
    });
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'authenticated') {
      this.broadcastStatus('connected');
      this.sendSubscription();
      return;
    }
    if (message.type === 'execution.changed' && message.snapshot) {
      this.acceptSnapshot(message.snapshot as Snapshot);
      return;
    }
    if (message.type === 'subscribed' && Array.isArray(message.snapshots)) {
      for (const snapshot of message.snapshots) this.acceptSnapshot(snapshot as Snapshot);
    }
  }

  private acceptSnapshot(snapshot: Snapshot): void {
    if (!snapshot?.executionId) return;
    const current = this.snapshots.get(snapshot.executionId);
    if (current) {
      const currentGeneration = Number(current.runGeneration ?? 1);
      const nextGeneration = Number(snapshot.runGeneration ?? 1);
      if (nextGeneration < currentGeneration) return;
      if (nextGeneration === currentGeneration && Number(snapshot.revision ?? 0) <= Number(current.revision ?? 0)) return;
    }
    this.snapshots.set(snapshot.executionId, snapshot);
    for (const { contents } of this.subscribers.values()) {
      if (!contents.isDestroyed()) contents.send('allen:realtime-event', { type: 'execution.changed', snapshot });
    }
  }

  private sendSubscription(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const executionIds = [...new Set([...this.subscribers.values()].flatMap(({ ids }) => [...ids]))];
    this.socket.send(JSON.stringify({ type: 'subscribe', all: true, executionIds }));
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.token || this.reconnectTimer) return;
    const delay = Math.min(15_000, 500 * (2 ** Math.min(this.reconnectAttempt++, 5)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private broadcastStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    for (const { contents } of this.subscribers.values()) {
      if (!contents.isDestroyed()) contents.send('allen:realtime-status', { status });
    }
  }

  private disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, 'auth changed');
  }

  stop(): void {
    this.stopped = true;
    this.disconnect();
    this.subscribers.clear();
    this.snapshots.clear();
  }
}
