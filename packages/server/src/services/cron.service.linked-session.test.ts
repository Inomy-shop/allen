/**
 * Tests for CronService.ensureLinkedSession and the AUTOMATION_CONTEXT
 * injection into dispatchAgent.
 *
 * We test the private logic through a hand-rolled minimal CronService
 * that exposes the method via a subclass, plus an integration test using
 * the real class by intercepting the fetch call.
 */

import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { ObjectId } from 'mongodb';
import { CronService } from './cron.service.js';
import type { CronJob } from './cron.types.js';

// ── Minimal MongoDB stub ────────────────────────────────────────────────────

function makeOid() {
  return new ObjectId();
}

function makeDb(chatSessionsStore: Record<string, unknown>[] = [], cronJobsStore: Record<string, unknown>[] = []) {
  const stores: Record<string, Record<string, unknown>[]> = {
    chat_sessions: chatSessionsStore,
    cron_jobs: cronJobsStore,
    cron_runs: [],
  };

  const makeCollection = (name: string) => ({
    find: (_q: Record<string, unknown>) => ({
      toArray: async () => stores[name] ?? [],
    }),
    findOne: async (query: Record<string, unknown>) => {
      const col = stores[name] ?? [];
      return col.find((doc) => {
        return Object.entries(query).every(([k, v]) => (doc as any)[k] === v);
      }) ?? null;
    },
    insertOne: async (doc: Record<string, unknown>) => {
      const col = (stores[name] = stores[name] ?? []);
      const withId = { _id: makeOid(), ...doc };
      col.push(withId);
      return { insertedId: withId._id };
    },
    updateOne: async (query: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>) => {
      const col = stores[name] ?? [];
      const idx = col.findIndex((doc) => {
        return Object.entries(query).every(([k, v]) => (doc as any)[k] === v);
      });
      if (idx >= 0) {
        if ((update as any).$set) {
          stores[name][idx] = { ...stores[name][idx], ...(update as any).$set };
        }
        return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
      }
      // upsert
      if ((options as any)?.upsert && (update as any).$setOnInsert) {
        const newDoc: Record<string, unknown> = {
          _id: makeOid(),
          ...(update as any).$setOnInsert,
        };
        // Also add query fields (like automationKey)
        Object.assign(newDoc, query);
        (stores[name] = stores[name] ?? []).push(newDoc);
        return { matchedCount: 0, modifiedCount: 0, upsertedId: (newDoc as any)._id };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
    },
    findOneAndUpdate: async (query: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>) => {
      const col = stores[name] ?? [];
      const idx = col.findIndex((doc) => {
        return Object.entries(query).every(([k, v]) => (doc as any)[k] === v);
      });
      if (idx >= 0) {
        if ((update as any).$set) {
          stores[name][idx] = { ...stores[name][idx], ...(update as any).$set };
        }
        return (options as any)?.returnDocument === 'after' ? stores[name][idx] : col[idx];
      }
      // upsert path
      if ((options as any)?.upsert) {
        const newDoc: Record<string, unknown> = {
          _id: makeOid(),
          ...(update as any).$setOnInsert ?? {},
        };
        Object.assign(newDoc, query);
        (stores[name] = stores[name] ?? []).push(newDoc);
        return (options as any)?.returnDocument === 'after' ? newDoc : null;
      }
      return null;
    },
    updateMany: async () => ({ modifiedCount: 0 }),
  });

  return {
    stores,
    collection: (name: string) => makeCollection(name),
  };
}

// ── Expose ensureLinkedSession via subclass ─────────────────────────────────

class TestableCronService extends CronService {
  async publicEnsureLinkedSession(job: CronJob): Promise<string> {
    // Access the private method via TypeScript casting
    return (this as any).ensureLinkedSession(job);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    _id: makeOid(),
    name: 'sample-automation',
    displayName: 'Sample Automation',
    description: 'test job',
    enabled: true,
    schedule: '30 9 * * 1-5',
    timezone: 'America/New_York',
    target: {
      type: 'agent',
      agentName: 'sample-automation',
      prompt: 'Generate the report.',
    },
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    lastRunExecutionId: null,
    runCount: 0,
    runStatus: 'idle',
    nextRunAt: null,
    isBuiltIn: true,
    createdBy: 'seed',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe('CronService.ensureLinkedSession', () => {
  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = 'test-secret-linked-session';
  });

  it('creates a new chat_sessions document with source=automation on first call', async () => {
    const db = makeDb();
    const service = new TestableCronService(db as any);
    const job = makeJob();

    const sessionId = await service.publicEnsureLinkedSession(job);

    expect(sessionId).toBeTruthy();
    const sessions = db.stores.chat_sessions;
    expect(sessions).toHaveLength(1);
    const session = sessions[0] as any;
    expect(session.automationKey).toBe('sample-automation');
    expect(session.source).toBe('automation');
    expect(session.title).toBe('Sample Automation');
  });

  it('returns the same session id on a second call (idempotent)', async () => {
    const db = makeDb();
    const service = new TestableCronService(db as any);
    const job = makeJob();

    const id1 = await service.publicEnsureLinkedSession(job);
    const id2 = await service.publicEnsureLinkedSession(job);

    expect(id1).toBe(id2);
    // Still only one session created
    expect(db.stores.chat_sessions).toHaveLength(1);
  });

  it('reuses an existing session when the cron_jobs row already has linkedChatSessionId', async () => {
    const existingOid = makeOid();
    const db = makeDb(
      [{ _id: existingOid, automationKey: 'sample-automation', source: 'automation', title: 'Sample Automation' }],
    );
    const service = new TestableCronService(db as any);
    const job = makeJob({ linkedChatSessionId: String(existingOid) });

    const sessionId = await service.publicEnsureLinkedSession(job);

    expect(sessionId).toBe(String(existingOid));
    // No new session should have been created
    expect(db.stores.chat_sessions).toHaveLength(1);
  });

  it('stamps linkedChatSessionId onto the cron_jobs row when it was absent', async () => {
    const db = makeDb();
    const service = new TestableCronService(db as any);
    const job = makeJob({ linkedChatSessionId: undefined });
    // Put the job into the cron_jobs store so updateOne can find it
    db.stores.cron_jobs.push({ ...job });

    const sessionId = await service.publicEnsureLinkedSession(job);

    const updatedJob = db.stores.cron_jobs.find((j: any) => String(j._id) === String(job._id)) as any;
    expect(updatedJob?.linkedChatSessionId).toBe(sessionId);
  });

  it('falls back to findOne on E11000 duplicate-key race', async () => {
    // Build a db where findOneAndUpdate throws E11000 on the first call,
    // then findOne returns an existing session.
    const existingOid = makeOid();
    const existingSession = {
      _id: existingOid,
      automationKey: 'sample-automation',
      source: 'automation',
      title: 'Sample Automation',
    };

    const cronJobsStore: Record<string, unknown>[] = [];
    const chatSessionsStore: Record<string, unknown>[] = [existingSession];
    const baseDb = makeDb(chatSessionsStore, cronJobsStore);

    // Override findOneAndUpdate on chat_sessions to throw E11000 once
    let findOneAndUpdateCalled = false;
    const baseCollection = baseDb.collection('chat_sessions');
    const patchedDb = {
      ...baseDb,
      collection: (name: string) => {
        const col = baseDb.collection(name);
        if (name === 'chat_sessions') {
          return {
            ...col,
            findOneAndUpdate: async (...args: unknown[]) => {
              if (!findOneAndUpdateCalled) {
                findOneAndUpdateCalled = true;
                const err = new Error('E11000 duplicate key error') as any;
                err.code = 11000;
                throw err;
              }
              return (col as any).findOneAndUpdate(...args);
            },
          };
        }
        return col;
      },
    };

    // Put the job into cron_jobs so updateOne can stamp linkedChatSessionId
    const job = makeJob({ linkedChatSessionId: undefined });
    cronJobsStore.push({ ...job });

    const service = new TestableCronService(patchedDb as any);
    const sessionId = await service.publicEnsureLinkedSession(job);

    // Should return the existing session's id without throwing
    expect(sessionId).toBe(String(existingOid));
    // cron_jobs should be stamped with the session id
    const updatedJob = cronJobsStore.find((j: any) => String(j._id) === String(job._id)) as any;
    expect(updatedJob?.linkedChatSessionId).toBe(sessionId);
  });

  it('recovers stale pointer — creates new session when old was deleted', async () => {
    // Job already has a linkedChatSessionId pointing to a deleted session.
    // The chat_sessions collection has no doc with automationKey='sample-automation',
    // so ensureLinkedSession should upsert a brand-new session.
    const cronJobsStore: Record<string, unknown>[] = [];
    const db = makeDb([], cronJobsStore); // empty chat_sessions store

    const oldSessionId = 'aabbccddee112233445566aa';
    const job = makeJob({ linkedChatSessionId: oldSessionId });
    // Add job to cron_jobs store so updateOne can find it
    cronJobsStore.push({ ...job });

    const service = new TestableCronService(db as any);
    const sessionId = await service.publicEnsureLinkedSession(job);

    // The returned session id must be a NEW id, not the stale pointer
    expect(sessionId).not.toBe(oldSessionId);
    expect(sessionId).toBeTruthy();

    // A new session should have been created in chat_sessions
    const sessions = db.stores.chat_sessions;
    expect(sessions).toHaveLength(1);
    expect(String((sessions[0] as any)._id)).toBe(sessionId);

    // cron_jobs must be updated with the new session id (stale pointer stamped over)
    const updatedJob = cronJobsStore.find((j: any) => String(j._id) === String(job._id)) as any;
    expect(updatedJob?.linkedChatSessionId).toBe(sessionId);
  });

  it('injects AUTOMATION_CONTEXT into the agent prompt when agentName === job.name', async () => {
    const db = makeDb();
    const service = new TestableCronService(db as any);
    const job = makeJob();

    // Intercept fetch to capture the spawned prompt
    const originalFetch = global.fetch;
    let capturedBody: any;
    global.fetch = vi.fn(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init?.body ?? '{}');
      return {
        ok: true,
        json: async () => ({ execution_id: 'exec-123' }),
        status: 200,
      } as any;
    }) as MockedFunction<typeof fetch>;

    try {
      await (service as any).dispatchAgent(job.target, job);
      expect(capturedBody.prompt).toContain('AUTOMATION_CONTEXT:');
      expect(capturedBody.prompt).toContain('LINKED_CHAT_SESSION_ID:');
      expect(capturedBody.prompt).toContain('AUTOMATION_API_TOKEN:');
      expect(capturedBody.prompt).toContain('AUTOMATION_MESSAGE_URL:');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('AUTOMATION_API_TOKEN is short-lived (≤5 min) — not the 24h default', async () => {
    // Security regression guard: the embedded token is stored in MongoDB as part
    // of the chat_messages prompt text. A long-lived token (ACCESS_TOKEN_TTL = 24h)
    // would be exploitable for up to 24 hours. This test verifies the call site
    // explicitly requests a 5-minute TTL regardless of the global ACCESS_TOKEN_TTL.
    const db = makeDb();
    const service = new TestableCronService(db as any);
    const job = makeJob();

    const originalFetch = global.fetch;
    let capturedBody: any;
    global.fetch = vi.fn(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init?.body ?? '{}');
      return {
        ok: true,
        json: async () => ({ execution_id: 'exec-456' }),
        status: 200,
      } as any;
    }) as MockedFunction<typeof fetch>;

    try {
      await (service as any).dispatchAgent(job.target, job);
      const prompt: string = capturedBody.prompt;

      // Extract the raw JWT from "AUTOMATION_API_TOKEN: <jwt>" line
      const tokenMatch = prompt.match(/AUTOMATION_API_TOKEN:\s+(\S+)/);
      expect(tokenMatch).not.toBeNull();
      const token = tokenMatch![1];

      // Decode payload without signature verification (base64url → JSON)
      const payloadB64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8')) as {
        iat: number;
        exp: number;
        role: string;
      };

      const ttlSeconds = decoded.exp - decoded.iat;
      // Must be ≤ 5 minutes (300 s), NOT the 24h (86 400 s) default
      expect(ttlSeconds).toBeGreaterThan(0);
      expect(ttlSeconds).toBeLessThanOrEqual(300);
      // Role should be admin (required for the automation-message endpoint)
      expect(decoded.role).toBe('admin');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
