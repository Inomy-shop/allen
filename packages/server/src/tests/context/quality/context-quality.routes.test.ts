// Integration tests for context-quality routes using supertest + MongoMemoryServer.
// Tests focus on service-layer behavior invoked via HTTP endpoints.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express, { type Express } from 'express';
import supertest from 'supertest';
import { contextQualityRoutes } from '../../../routes/context-quality.routes.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let app: Express;

// Enable context engine for tests
const OLD_ENV = process.env['ALLEN_CONTEXT_PROVIDER'];

beforeAll(async () => {
  process.env['ALLEN_CONTEXT_PROVIDER'] = 'allen';
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-quality-routes');

  app = express();
  app.use(express.json());
  // Inject a mock user so admin tests work
  app.use((req, _res, next) => {
    (req as any).user = { userId: 'test-user', role: 'admin' };
    next();
  });
  app.use('/api/context/quality', contextQualityRoutes(db));
});

afterAll(async () => {
  process.env['ALLEN_CONTEXT_PROVIDER'] = OLD_ENV;
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_judge_runs').deleteMany({});
  await db.collection('context_findings').deleteMany({});
  await db.collection('context_review_tasks').deleteMany({});
  await db.collection('context_review_decisions').deleteMany({});
  await db.collection('context_remediations').deleteMany({});
  await db.collection('context_learning_promotions').deleteMany({});
  await db.collection('repo_context_curation_entries').deleteMany({});
  await db.collection('repo_context_curation_entry_revisions').deleteMany({});
  await db.collection('context_judge_config').deleteMany({});
  await db.collection('context_review_worker_assignments').deleteMany({});
  await db.collection('context_agent_dispatch_queue').deleteMany({});
  await db.collection('context_orchestrator_run_records').deleteMany({});
  await db.collection('context_orchestration_sessions').deleteMany({});
  await db.collection('context_judge_scheduler_state').deleteMany({});
});

// ─── CONTEXT_PROVIDER_DISABLED gate ─────────────────────────────────────────

describe('CONTEXT_PROVIDER_DISABLED gate', () => {
  it('returns 409 with CONTEXT_PROVIDER_DISABLED when context engine is disabled', async () => {
    // Temporarily disable
    process.env['ALLEN_CONTEXT_PROVIDER'] = '';
    const res = await supertest(app).get('/api/context/quality/judge-runs');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTEXT_PROVIDER_DISABLED');
    // Re-enable
    process.env['ALLEN_CONTEXT_PROVIDER'] = 'allen';
  });
});

// ─── Judge Runs ──────────────────────────────────────────────────────────────

describe('GET /judge-runs', () => {
  it('returns 200 with empty array when no runs exist', async () => {
    const res = await supertest(app).get('/api/context/quality/judge-runs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /judge-runs', () => {
  it('returns 201 with judgeRunId', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/judge-runs')
      .send({ scope: 'workflow' });
    expect(res.status).toBe(201);
    expect(res.body.judgeRunId).toBeDefined();
  });
});

describe('GET /judge-runs/:judgeRunId', () => {
  it('returns 200 with the run', async () => {
    const created = await supertest(app)
      .post('/api/context/quality/judge-runs')
      .send({ scope: 'node' });
    const res = await supertest(app).get(`/api/context/quality/judge-runs/${created.body.judgeRunId}`);
    expect(res.status).toBe(200);
    expect(res.body.judgeRunId).toBe(created.body.judgeRunId);
  });

  it('returns 404 for unknown judgeRunId', async () => {
    const res = await supertest(app).get('/api/context/quality/judge-runs/unknown-id');
    expect(res.status).toBe(404);
  });
});

describe('POST /judge-runs/:judgeRunId/rejudge', () => {
  it('returns 201 with a new judgeRunId', async () => {
    const original = await supertest(app)
      .post('/api/context/quality/judge-runs')
      .send({ scope: 'workflow', sourceId: 'src-rejudge-01' });
    const res = await supertest(app).post(`/api/context/quality/judge-runs/${original.body.judgeRunId}/rejudge`);
    expect(res.status).toBe(201);
    expect(res.body.judgeRunId).not.toBe(original.body.judgeRunId);
  });

  it('returns 404 for unknown judgeRunId', async () => {
    const res = await supertest(app).post('/api/context/quality/judge-runs/unknown/rejudge');
    expect(res.status).toBe(404);
  });
});

// ─── Findings ────────────────────────────────────────────────────────────────

describe('GET /findings', () => {
  it('returns 200 with findings array', async () => {
    const res = await supertest(app).get('/api/context/quality/findings');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('PATCH /findings/:findingId', () => {
  it('returns 404 for unknown findingId', async () => {
    const res = await supertest(app)
      .patch('/api/context/quality/findings/unknown')
      .send({ status: 'in_review' });
    expect(res.status).toBe(404);
  });
});

// ─── Review Queues ───────────────────────────────────────────────────────────

describe('GET /review/queues', () => {
  it('returns 200 with queue counts', async () => {
    const res = await supertest(app).get('/api/context/quality/review/queues');
    expect(res.status).toBe(200);
    expect(typeof res.body.open).toBe('number');
  });
});

describe('GET /review/queues/:queue', () => {
  it('returns 200 with tasks array', async () => {
    const res = await supertest(app).get('/api/context/quality/review/queues/open');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /review/:taskId/decisions', () => {
  it('returns 400 when actor or action missing', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/review/task-x/decisions')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /review/history', () => {
  it('returns 200 with decisions array', async () => {
    const res = await supertest(app).get('/api/context/quality/review/history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── Remediation Tasks ───────────────────────────────────────────────────────

describe('GET /remediation-tasks', () => {
  it('returns 200 with array', async () => {
    const res = await supertest(app).get('/api/context/quality/remediation-tasks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /remediation-tasks', () => {
  it('returns 201 with remediationId', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/remediation-tasks')
      .send({ taskId: 'task-1', findingId: 'finding-1', judgeRunId: 'run-1', actionKind: 'curated_entry_edit' });
    expect(res.status).toBe(201);
    expect(res.body.remediationId).toBeDefined();
  });

  it('returns 400 when required fields missing', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/remediation-tasks')
      .send({ taskId: 'task-1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /remediation-tasks/:taskId/dispatch', () => {
  it('dispatches a remediation', async () => {
    const created = await supertest(app)
      .post('/api/context/quality/remediation-tasks')
      .send({ taskId: 'task-2', findingId: 'finding-2', judgeRunId: 'run-2', actionKind: 'curated_entry_edit' });
    const remediationId = created.body.remediationId;

    const res = await supertest(app).post(`/api/context/quality/remediation-tasks/${remediationId}/dispatch`);
    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(true);
  });
});

// ─── Curated Edits ───────────────────────────────────────────────────────────

describe('POST /curated-edits/:repoId/:entryId', () => {
  it('returns 201 with revision', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/curated-edits/repo-1/entry-1')
      .send({ title: 'My Title', actor: 'test-user', source: 'manual_edit' });
    expect(res.status).toBe(201);
    expect(res.body.revision).toBeDefined();
  });
});

describe('GET /curated-edits/:repoId/:entryId/history', () => {
  it('returns 200 with history array', async () => {
    // Create an edit first
    await supertest(app)
      .post('/api/context/quality/curated-edits/repo-h/entry-h')
      .send({ title: 'Initial' });

    const res = await supertest(app).get('/api/context/quality/curated-edits/repo-h/entry-h/history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Learning Promotions ─────────────────────────────────────────────────────

describe('GET /learning-promotions', () => {
  it('returns 200 with array', async () => {
    const res = await supertest(app).get('/api/context/quality/learning-promotions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /learning-promotions', () => {
  it('returns 201 with promotionId', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/learning-promotions')
      .send({ learningId: 'learn-001', action: 'create_curated_context' });
    expect(res.status).toBe(201);
    expect(res.body.promotionId).toBeDefined();
  });

  it('returns 400 when required fields missing', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/learning-promotions')
      .send({ learningId: 'learn-002' });
    expect(res.status).toBe(400);
  });
});

describe('POST /learning-promotions/:id/decisions', () => {
  it('returns 201 with updated promotion', async () => {
    const created = await supertest(app)
      .post('/api/context/quality/learning-promotions')
      .send({ learningId: 'learn-003', action: 'create_curated_context' });
    const promotionId = created.body.promotionId;

    const res = await supertest(app)
      .post(`/api/context/quality/learning-promotions/${promotionId}/decisions`)
      .send({ actor: 'admin', decision: 'approved' });
    expect(res.status).toBe(201);
    expect(res.body.decision).toBe('approved');
    expect(res.body.status).toBe('approved');
  });
});

// ─── Config ──────────────────────────────────────────────────────────────────

describe('GET /config', () => {
  it('returns 404 when config not seeded', async () => {
    const res = await supertest(app).get('/api/context/quality/config');
    expect(res.status).toBe(404);
  });

  it('returns 200 with config when seeded', async () => {
    await db.collection('context_judge_config').insertOne({
      configId: 'singleton',
      autoRemediationEnabled: false,
      updatedAt: new Date(),
    });
    const res = await supertest(app).get('/api/context/quality/config');
    expect(res.status).toBe(200);
    expect(res.body.configId).toBe('singleton');
  });
});

// ─── Scheduler Pending ───────────────────────────────────────────────────────

describe('GET /scheduler/pending', () => {
  it('returns 200 with candidates array when sourceType provided', async () => {
    const res = await supertest(app)
      .get('/api/context/quality/scheduler/pending')
      .query({ sourceType: 'workflow_run' });
    expect(res.status).toBe(200);
    expect(res.body.sourceType).toBe('workflow_run');
    expect(Array.isArray(res.body.candidates)).toBe(true);
  });

  it('returns 400 when sourceType missing', async () => {
    const res = await supertest(app).get('/api/context/quality/scheduler/pending');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sourceType');
  });
});

// ─── Worker Assignment PATCH ─────────────────────────────────────────────────

describe('PATCH /worker-assignments/:assignmentId', () => {
  it('returns 200 when assignment exists', async () => {
    // Create an assignment first
    await db.collection('context_review_tasks').insertOne({
      taskId: 'task-patch-1',
      status: 'pending',
      requiresHumanReview: false,
      fixType: 'curated_context_edit',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const created = await supertest(app)
      .post('/api/context/quality/worker-assignments')
      .send({ workerRole: 'context_review_triage' });
    expect(created.status).toBe(201);
    const { assignments } = created.body;
    expect(Array.isArray(assignments)).toBe(true);
    expect(assignments.length).toBeGreaterThan(0);
    const assignmentId = assignments[0].assignmentId;

    const res = await supertest(app)
      .patch(`/api/context/quality/worker-assignments/${assignmentId}`)
      .send({ status: 'running' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
  });

  it('returns 404 for unknown assignment', async () => {
    const res = await supertest(app)
      .patch('/api/context/quality/worker-assignments/non-existent-assignment-id')
      .send({ status: 'running' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /config', () => {
  it('returns 200 with updated config for admin user', async () => {
    await db.collection('context_judge_config').insertOne({
      configId: 'singleton',
      autoRemediationEnabled: false,
      updatedAt: new Date(),
    });
    const res = await supertest(app)
      .patch('/api/context/quality/config')
      .send({ autoRemediationEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.autoRemediationEnabled).toBe(true);
  });

  it('returns 403 for non-admin user', async () => {
    // Create a separate app with non-admin user
    const nonAdminApp = express();
    nonAdminApp.use(express.json());
    nonAdminApp.use((req, _res, next) => {
      (req as any).user = { userId: 'user-2', role: 'member' };
      next();
    });
    nonAdminApp.use('/api/context/quality', contextQualityRoutes(db));

    const res = await supertest(nonAdminApp)
      .patch('/api/context/quality/config')
      .send({ autoRemediationEnabled: true });
    expect(res.status).toBe(403);
  });
});

// ─── Orchestrator Trigger ────────────────────────────────────────────────────

describe('POST /orchestrator/trigger', () => {
  it('returns 201 with runId and triggered status', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'ui' });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeDefined();
    expect(res.body.status).toBe('triggered');
    expect(res.body.triggeredBy).toBe('ui');
    expect(res.body.global).toBe(true);
  });

  it('stores repoId when provided', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ repoId: 'repo-trigger-1', triggeredBy: 'api' });
    expect(res.status).toBe(201);
    expect(res.body.repoId).toBe('repo-trigger-1');
    expect(res.body.global).toBe(false);
  });
});

describe('GET /orchestrator/runs', () => {
  it('returns 200 with runs array', async () => {
    await supertest(app)
      .post('/api/context/quality/orchestrator/trigger')
      .send({ triggeredBy: 'scheduler' });
    const res = await supertest(app).get('/api/context/quality/orchestrator/runs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe('GET /scheduler/pending with cursor lifecycle', () => {
  it('marks cursor running then idle', async () => {
    // seed scheduler state
    await db.collection('context_judge_scheduler_state').insertOne({
      sourceType: 'workflow_run', status: 'idle', updatedAt: new Date(),
    });
    const res = await supertest(app)
      .get('/api/context/quality/scheduler/pending')
      .query({ sourceType: 'workflow_run' });
    expect(res.status).toBe(200);
    // After call, cursor should be idle again
    const state = await db.collection('context_judge_scheduler_state').findOne({ sourceType: 'workflow_run' });
    expect(state?.['status']).toBe('idle');
  });
});

// ─── Usage Trace endpoint (ENG-1760) ─────────────────────────────────────────
// GET /api/context/quality/usage-trace resolves context usage data by
// contextAttemptId OR executionId and returns normalized identifiers.

describe('GET /usage-trace — identifier resolution (ENG-1760)', () => {
  beforeEach(async () => {
    await db.collection('context_attempts').deleteMany({});
    await db.collection('memory_injection_audits').deleteMany({});
  });

  it('returns 400 when neither executionId nor contextAttemptId is provided', async () => {
    const res = await supertest(app).get('/api/context/quality/usage-trace');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 404 when contextAttemptId is not found', async () => {
    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ contextAttemptId: 'ca-nonexistent' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when executionId is not found and no memory_injection_audit exists', async () => {
    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ executionId: 'exec-nonexistent' });
    expect(res.status).toBe(404);
  });

  it('resolves by contextAttemptId and returns normalized payload with both IDs', async () => {
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-route-1', executionId: 'exec-route-1', repoId: 'repo-route',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });
    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ contextAttemptId: 'ca-route-1' });
    expect(res.status).toBe(200);
    expect(res.body.contextAttemptId).toBe('ca-route-1');
    expect(res.body.executionId).toBe('exec-route-1');
    // sourceId is the contextAttemptId (not executionId)
    expect(res.body.sourceId).toBe('ca-route-1');
    expect(res.body.sourceKind).toBe('workflow_run');
    expect(res.body.flowKind).toBe('workflow_node');
    expect(res.body.resolved).toBe(true);
  });

  it('resolves by executionId and returns normalized payload', async () => {
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-route-2', executionId: 'exec-route-2', repoId: 'repo-route2',
      executionKind: 'spawned_agent', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });
    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ executionId: 'exec-route-2' });
    expect(res.status).toBe(200);
    expect(res.body.executionId).toBe('exec-route-2');
    expect(res.body.contextAttemptId).toBe('ca-route-2');
    expect(res.body.sourceKind).toBe('spawned_agent_run');
    expect(res.body.resolved).toBe(true);
  });

  it('falls back to memory_injection_audits when executionId has no context_attempt', async () => {
    await db.collection('memory_injection_audits').insertOne({
      executionId: 'exec-audit-only', packets: [{ refId: 'ref-1' }], createdAt: new Date(),
    });
    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ executionId: 'exec-audit-only' });
    expect(res.status).toBe(200);
    expect(res.body.executionId).toBe('exec-audit-only');
    expect(res.body.contextAttemptId).toBeNull();
    expect(res.body.sourceKind).toBe('workflow_run');
    expect(res.body.flowKind).toBe('execution_level');
    expect(res.body.resolved).toBe(true);
  });
});

// ─── submit-findings route: lazy config bootstrap (ENG-1760) ─────────────────
// POST /orchestrator/sessions/:sessionId/findings must succeed even when
// the singleton context_judge_config is missing (bootstrap on demand).

describe('POST /orchestrator/sessions/:sessionId/findings — lazy config bootstrap', () => {
  it('succeeds when context_judge_config is missing (bootstrap creates default)', async () => {
    // Ensure no config exists
    await db.collection('context_judge_config').deleteMany({});

    // Begin an orchestration session
    const sessionRes = await supertest(app)
      .post('/api/context/quality/orchestrator/sessions')
      .send({ scope: 'workflow' });
    expect(sessionRes.status).toBe(201);
    const sessionId = sessionRes.body.sessionId;

    // Submit findings with no config in DB — should succeed via lazy bootstrap
    const findingsRes = await supertest(app)
      .post(`/api/context/quality/orchestrator/sessions/${sessionId}/findings`)
      .send({
        findings: [
          {
            classification: 'missing_context',
            fixType: 'curated_context_create',
            severity: 'warn',
            risk: 'low',
            confidence: 0.8,
          },
        ],
      });
    expect(findingsRes.status).toBe(201);
    expect(findingsRes.body.judgeRunId).toBeDefined();
    expect(findingsRes.body.findingIds).toHaveLength(1);

    // Verify that config was bootstrapped
    const config = await db.collection('context_judge_config').findOne({ configId: 'singleton' });
    expect(config).not.toBeNull();
    expect((config as any).autoRemediationEnabled).toBe(false);
  });

  it('succeeds when context_judge_config exists (uses existing config)', async () => {
    await db.collection('context_judge_config').insertOne({
      configId: 'singleton',
      autoRemediationEnabled: true,
      autoRemediationThresholds: { minConfidence: 0.7, maxRisk: 'medium', allowedFixTypes: ['no_fix'] },
      mandatoryHumanReview: {
        lowConfidenceThreshold: 0.5,
        highRiskLevels: ['high', 'critical'],
        alwaysForScopes: ['cross_repo', 'global'],
        alwaysForLearningDerived: true,
        alwaysForCodeFix: true,
      },
      updatedAt: new Date(),
    });

    const sessionRes = await supertest(app)
      .post('/api/context/quality/orchestrator/sessions')
      .send({ scope: 'workflow' });
    expect(sessionRes.status).toBe(201);
    const sessionId = sessionRes.body.sessionId;

    const findingsRes = await supertest(app)
      .post(`/api/context/quality/orchestrator/sessions/${sessionId}/findings`)
      .send({
        findings: [
          {
            classification: 'stale_context',
            fixType: 'curated_context_edit',
            severity: 'info',
            risk: 'low',
            confidence: 0.9,
          },
        ],
      });
    expect(findingsRes.status).toBe(201);
    expect(findingsRes.body.judgeRunId).toBeDefined();
  });
});
