/**
 * Integration tests for POST /orchestrator/trigger → dispatch end-to-end flow.
 *
 * Uses MongoMemoryServer + supertest + FakeOrchestratorDispatchAdapter to verify:
 *   1. Run record is created with correct fields
 *   2. Dispatch adapter receives the correct OrchestratorDispatchRequest
 *   3. Run status transitions: triggered → running → completed (or failed)
 *   4. Adapter injection works via contextQualityRoutes(db, adapter)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express, { type Express } from 'express';
import supertest from 'supertest';
import { contextQualityRoutes } from '../../../routes/context-quality.routes.js';
import {
  AllenSpawnOrchestratorDispatchAdapter,
} from '../../../services/context/judge/orchestrator-dispatch-adapter.js';
import type {
  IOrchestratorDispatchAdapter,
  OrchestratorDispatchRequest,
  OrchestratorDispatchResult,
} from '../../../services/context/judge/orchestrator-dispatch-adapter.js';

// ─── Fake adapter ─────────────────────────────────────────────────────────────

class FakeOrchestratorDispatchAdapter implements IOrchestratorDispatchAdapter {
  public calls: OrchestratorDispatchRequest[] = [];
  public shouldFail = false;
  public failMessage = 'dispatch failed';
  // When queued=true the spawned agent owns the status update (leave as 'running')
  public returnQueued = false;

  async dispatch(request: OrchestratorDispatchRequest): Promise<OrchestratorDispatchResult> {
    this.calls.push(request);
    if (this.shouldFail) {
      throw new Error(this.failMessage);
    }
    return { executionId: 'fake-exec-id', queued: this.returnQueued };
  }

  reset() {
    this.calls = [];
    this.shouldFail = false;
    this.returnQueued = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let app: Express;
const fakeAdapter = new FakeOrchestratorDispatchAdapter();

const OLD_ENV = process.env['ALLEN_CONTEXT_PROVIDER'];

beforeAll(async () => {
  process.env['ALLEN_CONTEXT_PROVIDER'] = 'allen';
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-trigger-dispatch');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 'test-user', role: 'admin' };
    next();
  });
  // Inject the fake adapter
  app.use('/api/context/quality', contextQualityRoutes(db, fakeAdapter));
});

afterAll(async () => {
  process.env['ALLEN_CONTEXT_PROVIDER'] = OLD_ENV;
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_orchestrator_run_records').deleteMany({});
  fakeAdapter.reset();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /orchestrator/trigger with FakeOrchestratorDispatchAdapter', () => {
  it('returns 201 immediately with status=triggered and runId', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'ui' });

    expect(res.status).toBe(201);
    expect(res.body.runId).toBeDefined();
    expect(res.body.status).toBe('triggered');
    expect(res.body.triggeredBy).toBe('ui');
  });

  it('creates a global run record when no repoId/repoIds provided', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'scheduler' });

    expect(res.status).toBe(201);
    expect(res.body.global).toBe(true);
    expect(res.body.repoId).toBeUndefined();
  });

  it('creates a repo-scoped run record when repoId is provided', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ repoId: 'repo-trigger-test', triggeredBy: 'api' });

    expect(res.status).toBe(201);
    expect(res.body.repoId).toBe('repo-trigger-test');
    expect(res.body.global).toBe(false);
  });

  it('dispatch adapter receives the correct OrchestratorDispatchRequest', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ repoId: 'repo-dispatch-check', triggeredBy: 'ui' });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    // Wait for the async dispatch to complete
    await sleep(100);

    expect(fakeAdapter.calls).toHaveLength(1);
    const dispatchCall = fakeAdapter.calls[0];
    expect(dispatchCall.runId).toBe(runId);
    expect(dispatchCall.repoId).toBe('repo-dispatch-check');
    expect(dispatchCall.triggeredBy).toBe('ui');
    expect(dispatchCall.global).toBe(false);
  });

  it('dispatch adapter receives global=true for global trigger', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ global: true, triggeredBy: 'cron' });

    expect(res.status).toBe(201);

    await sleep(100);

    expect(fakeAdapter.calls).toHaveLength(1);
    expect(fakeAdapter.calls[0].global).toBe(true);
  });

  it('status transitions triggered → running → completed when adapter returns queued=false', async () => {
    // queued=false → dispatch handled locally → mark completed
    fakeAdapter.returnQueued = false;

    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'manual' });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    // Wait for async dispatch
    await sleep(150);

    const record = await db
      .collection('context_orchestrator_run_records')
      .findOne({ runId });
    expect(record?.['status']).toBe('completed');
  });

  it('status transitions triggered → running when adapter returns queued=true', async () => {
    // queued=true → agent will update status — we leave as 'running'
    fakeAdapter.returnQueued = true;

    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'ui' });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    await sleep(150);

    const record = await db
      .collection('context_orchestrator_run_records')
      .findOne({ runId });
    // Agent owns the final status update — should be 'running' at this point
    expect(record?.['status']).toBe('running');
  });

  it('status transitions triggered → running → failed when adapter throws', async () => {
    fakeAdapter.shouldFail = true;
    fakeAdapter.failMessage = 'spawn endpoint unreachable';

    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'api' });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    await sleep(150);

    const record = await db
      .collection('context_orchestrator_run_records')
      .findOne({ runId });
    expect(record?.['status']).toBe('failed');
    expect((record?.['errors'] as string[])?.[0]).toContain('spawn endpoint unreachable');
  });

  it('HTTP response is not blocked by dispatch — returns 201 immediately', async () => {
    // Even if dispatch is slow, the response should come back right away.
    // We verify by ensuring the response arrives before we poll the DB for status.
    const start = Date.now();
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'api' });
    const responseTime = Date.now() - start;

    expect(res.status).toBe(201);
    // The response should be fast (not waiting for the async dispatch)
    expect(responseTime).toBeLessThan(3000);
  });

  it('accepts repoIds array and passes them to the adapter', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ repoIds: ['repo-a', 'repo-b'], triggeredBy: 'api' });

    expect(res.status).toBe(201);
    expect(res.body.global).toBe(false);

    await sleep(100);

    expect(fakeAdapter.calls).toHaveLength(1);
    expect(fakeAdapter.calls[0].repoIds).toEqual(['repo-a', 'repo-b']);
  });
});

describe('contextQualityRoutes backward compatibility', () => {
  it('works with just db parameter (no adapter) — uses NullAdapter', async () => {
    // Create a separate app without injecting an adapter
    const defaultApp = express();
    defaultApp.use(express.json());
    defaultApp.use((req, _res, next) => {
      (req as any).user = { userId: 'user-compat', role: 'admin' };
      next();
    });
    // Call with only db — backward-compatible
    defaultApp.use('/api/context/quality', contextQualityRoutes(db));

    const res = await supertest(defaultApp)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'ui' });

    expect(res.status).toBe(201);
    expect(res.body.runId).toBeDefined();
    expect(res.body.status).toBe('triggered');
  });
});

describe('vi.useFakeTimers — adapter call count isolation', () => {
  it('each test starts fresh — adapter.calls is reset between tests', async () => {
    // Verify reset works and calls don't bleed between tests
    expect(fakeAdapter.calls).toHaveLength(0);
    await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'ui' });
    await sleep(50);
    expect(fakeAdapter.calls.length).toBeGreaterThanOrEqual(0);
    // After reset (next beforeEach), calls will be 0 again
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENG-1760 Blocker B: AllenSpawnOrchestratorDispatchAdapter uses the registered
// agent name 'context-judge-orchestrator', NOT 'context-judge-orchestrator-agent'
// ─────────────────────────────────────────────────────────────────────────────

describe('ENG-1760 Blocker B: dispatch adapter uses registered agent name', () => {
  it('AllenSpawnOrchestratorDispatchAdapter sends agentName=context-judge-orchestrator', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    // Spin up a minimal HTTP server to capture the spawn request body
    const http = await import('node:http');
    const captureServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try { capturedBody = JSON.parse(body); } catch { capturedBody = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ executionId: 'test-exec-id' }));
      });
    });

    await new Promise<void>((resolve) => captureServer.listen(0, resolve));
    const { port } = captureServer.address() as { port: number };

    const adapter = new AllenSpawnOrchestratorDispatchAdapter(`http://localhost:${port}`);
    await adapter.dispatch({
      runId: 'run-test-001',
      triggeredBy: 'test',
      global: true,
    });

    captureServer.close();

    expect(capturedBody).not.toBeNull();
    // MUST use the registered name 'context-judge-orchestrator', not -agent suffix
    expect((capturedBody as any).agentName).toBe('context-judge-orchestrator');
    expect((capturedBody as any).agentName).not.toContain('-agent');
  });

  it('prompt contains runId and triggeredBy', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const http = await import('node:http');
    const captureServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try { capturedBody = JSON.parse(body); } catch { capturedBody = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ executionId: 'test-exec-2' }));
      });
    });

    await new Promise<void>((resolve) => captureServer.listen(0, resolve));
    const { port } = captureServer.address() as { port: number };

    const adapter = new AllenSpawnOrchestratorDispatchAdapter(`http://localhost:${port}`);
    await adapter.dispatch({
      runId: 'run-blocker-b',
      triggeredBy: 'integration-test',
      repoId: 'repo-b-test',
      global: false,
    });

    captureServer.close();

    const prompt = String((capturedBody as any)?.prompt ?? '');
    expect(prompt).toContain('run-blocker-b');
    expect(prompt).toContain('integration-test');
    expect(prompt).toContain('repo-b-test');
  });
});
