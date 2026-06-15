import express from 'express';
import request from 'supertest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { watcherRoutes } from './watcher.routes.js';

describe('watcherRoutes', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('watcher-routes-test');
    app = express();
    app.use(express.json());
    app.use('/api/execution-watchers', watcherRoutes(db));
  });

  beforeEach(async () => {
    await db.collection('execution_watchers').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  describe('GET /api/execution-watchers', () => {
    it('returns 400 when chatSessionId is missing', async () => {
      const res = await request(app).get('/api/execution-watchers');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('chatSessionId');
    });

    it('returns empty array when no watchers exist for session', async () => {
      const res = await request(app).get('/api/execution-watchers?chatSessionId=nonexistent');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns watchers for the given chat session', async () => {
      const now = new Date();
      await db.collection('execution_watchers').insertMany([
        {
          watcherId: 'w1',
          executionId: 'exec-1',
          chatSessionId: 'session-1',
          originatingMessageId: null,
          userId: null,
          executionType: 'workflow',
          rootExecutionId: null,
          watcherStatus: 'active',
          executionState: 'running',
          triggerSentForState: null,
          latestStatusText: 'my-workflow is running. Last checked just now.',
          nextPollAt: now,
          lastPolledAt: now,
          lastCheckedAt: now,
          slackTeamId: null,
          slackChannelId: null,
          slackThreadTs: null,
          updateSeq: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          watcherId: 'w2',
          executionId: 'exec-2',
          chatSessionId: 'session-1',
          originatingMessageId: null,
          userId: null,
          executionType: 'agent',
          rootExecutionId: 'root-1',
          watcherStatus: 'active',
          executionState: 'running',
          triggerSentForState: null,
          latestStatusText: 'Backend Developer is running. Last checked 2 min ago.',
          nextPollAt: now,
          lastPolledAt: now,
          lastCheckedAt: now,
          slackTeamId: null,
          slackChannelId: null,
          slackThreadTs: null,
          updateSeq: 2,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const res = await request(app).get('/api/execution-watchers?chatSessionId=session-1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({
        watcherId: 'w1',
        executionId: 'exec-1',
        executionType: 'workflow',
        executionState: 'running',
        updateSeq: 1,
      });
      expect(res.body[1]).toMatchObject({
        watcherId: 'w2',
        executionId: 'exec-2',
        executionType: 'agent',
        updateSeq: 2,
      });
    });

    it('returns only watchers for the specified session', async () => {
      const now = new Date();
      await db.collection('execution_watchers').insertOne({
        watcherId: 'w3',
        executionId: 'exec-3',
        chatSessionId: 'session-2',
        originatingMessageId: null,
        userId: null,
        executionType: 'workflow',
        rootExecutionId: null,
        watcherStatus: 'active',
        executionState: 'running',
        triggerSentForState: null,
        latestStatusText: 'other workflow running',
        nextPollAt: now,
        lastPolledAt: now,
        lastCheckedAt: now,
        slackTeamId: null,
        slackChannelId: null,
        slackThreadTs: null,
        updateSeq: 1,
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(app).get('/api/execution-watchers?chatSessionId=session-1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('GET /api/execution-watchers/:executionId', () => {
    it('returns 404 when watcher does not exist', async () => {
      const res = await request(app).get('/api/execution-watchers/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns a single watcher by executionId', async () => {
      const now = new Date();
      await db.collection('execution_watchers').insertOne({
        watcherId: 'w1',
        executionId: 'exec-1',
        chatSessionId: 'session-1',
        originatingMessageId: null,
        userId: null,
        executionType: 'workflow',
        rootExecutionId: null,
        watcherStatus: 'active',
        executionState: 'running',
        triggerSentForState: null,
        latestStatusText: 'my-workflow running',
        nextPollAt: now,
        lastPolledAt: now,
        lastCheckedAt: now,
        slackTeamId: null,
        slackChannelId: null,
        slackThreadTs: null,
        updateSeq: 3,
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(app).get('/api/execution-watchers/exec-1');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        watcherId: 'w1',
        executionId: 'exec-1',
        executionType: 'workflow',
        executionState: 'running',
        updateSeq: 3,
      });
    });
  });
});
