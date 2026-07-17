import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import WebSocket from 'ws';
import { StateManager, type ExecutionState } from '@allen/engine';
import { signAccessToken } from '../auth/jwt.js';
import { RealtimeExecutionService } from './realtime-execution.service.js';

function nextMessage(ws: WebSocket, type: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5_000);
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, any>;
      if (message.type !== type) return;
      clearTimeout(timeout);
      ws.off('message', listener);
      resolve(message);
    };
    ws.on('message', listener);
  });
}

describe('RealtimeExecutionService', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let server: Server;
  let realtime: RealtimeExecutionService;
  let url: string;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = 'realtime-test-access-secret';
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-realtime-test');
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    url = `ws://127.0.0.1:${address.port}/ws/realtime`;
    realtime = new RealtimeExecutionService(db, server);
  });

  afterAll(async () => {
    await realtime.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.close();
    await mongo.stop();
  });

  it('authenticates, sends snapshot-first subscriptions, and publishes ordered commits', async () => {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const authenticated = nextMessage(ws, 'authenticated');
    ws.send(JSON.stringify({
      type: 'authenticate',
      token: signAccessToken({ sub: 'user-1', email: 'user@example.test', role: 'user', mustResetPassword: false }),
    }));
    await authenticated;

    const subscribed = nextMessage(ws, 'subscribed');
    ws.send(JSON.stringify({ type: 'subscribe', all: true, executionIds: ['exec-realtime'] }));
    expect((await subscribed).snapshots).toEqual([]);

    const manager = new StateManager(db);
    const execution: ExecutionState = {
      id: 'exec-realtime',
      workflowId: 'workflow-1',
      workflowName: 'Realtime test',
      workflowVersion: 1,
      status: 'running',
      input: {},
      state: {},
      sessions: {},
      retryCounts: {},
      currentNodes: ['start'],
      completedNodes: [],
      nodeAttempts: {},
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    };

    const createdMessage = nextMessage(ws, 'execution.changed');
    await manager.createExecution(execution);
    expect((await createdMessage).snapshot).toMatchObject({
      executionId: 'exec-realtime', revision: 1, runGeneration: 1, status: 'running',
    });

    const completedMessage = nextMessage(ws, 'execution.changed');
    await manager.updateExecution('exec-realtime', { status: 'completed', currentNodes: [], completedNodes: ['start'] });
    expect((await completedMessage).snapshot).toMatchObject({ revision: 2, runGeneration: 1, status: 'completed' });

    const staleWriter = new StateManager(db);
    await staleWriter.getExecution('exec-realtime');
    const resumedMessage = nextMessage(ws, 'execution.changed');
    await manager.updateExecutionWithUnset(
      'exec-realtime',
      { status: 'running', currentNodes: ['start'], completedNodes: [] },
      ['completedAt'],
      { incrementGeneration: true },
    );
    expect((await resumedMessage).snapshot).toMatchObject({ revision: 3, runGeneration: 2, status: 'running' });

    expect(await staleWriter.updateExecution('exec-realtime', { status: 'failed' })).toBeNull();
    expect(await db.collection('executions').findOne({ id: 'exec-realtime' })).toMatchObject({
      revision: 3,
      runGeneration: 2,
      status: 'running',
    });
    ws.close();
  });
});
