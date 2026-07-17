import type { Server } from 'node:http';
import type { Db } from 'mongodb';
import { WebSocket, WebSocketServer } from 'ws';
import {
  setExecutionStateChangeListener,
  toExecutionSnapshot,
  type ExecutionSnapshot,
} from '@allen/engine';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';
import { logger } from '../logger.js';

type ClientState = {
  ws: WebSocket;
  user: AccessTokenPayload | null;
  allExecutions: boolean;
  executionIds: Set<string>;
  alive: boolean;
};

type WatcherNotifier = (executionId: string) => void | Promise<void>;

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function parseMessage(raw: WebSocket.RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw.toString());
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Authenticated, snapshot-first lifecycle channel shared by desktop and web.
 * High-volume logs/tool deltas intentionally remain on the existing streams. */
export class RealtimeExecutionService {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<ClientState>();
  private readonly upgradeHandler: Parameters<Server['on']>[1];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private watcherNotifier: WatcherNotifier | null = null;

  constructor(private readonly db: Db, private readonly server: Server) {
    this.upgradeHandler = ((request: any, socket: any, head: Buffer) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/ws/realtime') return;
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    }) as Parameters<Server['on']>[1];
    server.on('upgrade', this.upgradeHandler as any);
    setExecutionStateChangeListener(db, (snapshot) => {
      this.publish(snapshot);
      if (this.watcherNotifier) {
        void Promise.resolve(this.watcherNotifier(snapshot.executionId)).catch((err) => {
          logger.warn('[realtime] watcher notification failed', {
            executionId: snapshot.executionId,
            error: (err as Error).message,
          });
        });
      }
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.ws.terminate();
          continue;
        }
        client.alive = false;
        client.ws.ping();
      }
    }, 15_000);
  }

  setWatcherNotifier(notifier: WatcherNotifier | null): void {
    this.watcherNotifier = notifier;
  }

  publish(snapshot: ExecutionSnapshot): void {
    for (const client of this.clients) {
      if (!client.user) continue;
      if (!client.allExecutions && !client.executionIds.has(snapshot.executionId)) continue;
      send(client.ws, { type: 'execution.changed', snapshot });
    }
  }

  private accept(ws: WebSocket): void {
    const client: ClientState = {
      ws,
      user: null,
      allExecutions: false,
      executionIds: new Set(),
      alive: true,
    };
    this.clients.add(client);

    const authTimeout = setTimeout(() => {
      if (!client.user) ws.close(4401, 'authentication required');
    }, 5_000);

    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => {
      clearTimeout(authTimeout);
      this.clients.delete(client);
    });
    ws.on('error', () => {
      this.clients.delete(client);
    });
    ws.on('message', (raw) => { void this.handleMessage(client, raw); });
    send(ws, { type: 'hello', protocol: 1 });
  }

  private async handleMessage(client: ClientState, raw: WebSocket.RawData): Promise<void> {
    const message = parseMessage(raw);
    if (!message || typeof message.type !== 'string') {
      send(client.ws, { type: 'error', code: 'invalid_message' });
      return;
    }

    if (message.type === 'authenticate') {
      try {
        const token = typeof message.token === 'string' ? message.token : '';
        const user = verifyAccessToken(token);
        if (user.mustResetPassword) throw new Error('password reset required');
        client.user = user;
        send(client.ws, { type: 'authenticated', userId: user.sub });
      } catch {
        client.ws.close(4401, 'unauthorized');
      }
      return;
    }

    if (!client.user) {
      client.ws.close(4401, 'authenticate first');
      return;
    }

    if (message.type === 'subscribe') {
      client.allExecutions = message.all === true;
      const ids = Array.isArray(message.executionIds)
        ? [...new Set(message.executionIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 1_000)
        : [];
      client.executionIds = new Set(ids);

      // Register the subscription before reading. Any concurrent commit is
      // delivered live; revision ordering on the client removes duplicates.
      const docs = ids.length === 0
        ? []
        : await this.db.collection('executions').find(
            { id: { $in: ids } },
            { projection: {
              id: 1, workflowId: 1, workflowName: 1, status: 1,
              revision: 1, runGeneration: 1, updatedAt: 1, startedAt: 1,
              completedAt: 1, currentNodes: 1, completedNodes: 1,
              failedNode: 1, errorMessage: 1, parentExecutionId: 1,
              rootExecutionId: 1, meta: 1, input: 1, source: 1,
            } },
          ).toArray();
      send(client.ws, {
        type: 'subscribed',
        all: client.allExecutions,
        snapshots: docs.map((doc) => toExecutionSnapshot(doc as Record<string, unknown>)),
      });
      return;
    }

    if (message.type === 'ping') send(client.ws, { type: 'pong', at: new Date().toISOString() });
  }

  async stop(): Promise<void> {
    setExecutionStateChangeListener(this.db, null);
    this.watcherNotifier = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.server.off('upgrade', this.upgradeHandler as any);
    for (const client of this.clients) client.ws.close(1001, 'server stopping');
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    logger.debug('[realtime] execution service stopped');
  }
}
