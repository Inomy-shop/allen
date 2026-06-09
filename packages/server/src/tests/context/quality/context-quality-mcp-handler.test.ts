/**
 * Unit tests for MCP handler logic for context quality tools.
 *
 * Tests verify route behavior for handlers that tools in allen-mcp-server.ts
 * invoke (same integration path as the handler) with a real in-memory DB.
 *
 * Covers ENG-1760 requirements:
 * A. MCP tool registry includes all required trace/source-evaluation tools
 * B. context_quality_submit_source_evaluation preserves enhanced fields
 * C. context_quality_list_unevaluated_traces hits scheduler route correctly
 * D. context_quality_list_source_evaluations route works
 * E. context_quality_get_usage_trace URL construction
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express, { type Express } from 'express';
import supertest from 'supertest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextQualityRoutes } from '../../../routes/context-quality.routes.js';
import { contextRoutes } from '../../../routes/context.routes.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let app: Express;

const OLD_ENV = process.env['ALLEN_CONTEXT_PROVIDER'];

// Resolve the allen-mcp-server.ts source path for registry checks
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_SERVER_SRC = path.resolve(
  __dirname,
  '../../../services/allen-mcp-server.ts',
);
const ENGINE_MCP_TOOLS_SRC = path.resolve(__dirname, '../../../../../engine/src/allen-mcp-tools.ts');
const UI_MCP_TOOLS_SRC = path.resolve(__dirname, '../../../../../ui/src/lib/allen-mcp-tools.ts');

beforeAll(async () => {
  process.env['ALLEN_CONTEXT_PROVIDER'] = 'allen';
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-mcp-handler');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 'test-user', role: 'admin' };
    next();
  });
  app.use('/api/context', contextRoutes(db));
  app.use('/api/context/quality', contextQualityRoutes(db));
});

afterAll(async () => {
  process.env['ALLEN_CONTEXT_PROVIDER'] = OLD_ENV;
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_attempts').deleteMany({});
  await db.collection('context_refs').deleteMany({});
  await db.collection('repo_context_curation_entries').deleteMany({});
  await db.collection('memory_injection_audits').deleteMany({});
  await db.collection('context_source_evaluations').deleteMany({});
  await db.collection('context_trace_analysis_assignments').deleteMany({});
  await db.collection('context_orchestration_sessions').deleteMany({});
  await db.collection('executions').deleteMany({});
  await db.collection('context_artifacts').deleteMany({});
  await db.collection('context_ref_events').deleteMany({});
});

// ─────────────────────────────────────────────────────────────────────────────
// The handler builds a URL like:
//   /api/context/quality/usage-trace?contextAttemptId=<id>
// or
//   /api/context/quality/usage-trace?executionId=<id>
// or
//   /api/context/quality/usage-trace?executionId=<id>&contextAttemptId=<id>
// and calls callAPI() with it.
// These tests verify the route behavior for each arg pattern.
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP handler: context_quality_get_usage_trace — URL construction via route', () => {
  it('query with only contextAttemptId resolves the attempt by contextAttemptId', async () => {
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-mcp-1', executionId: 'exec-mcp-1', repoId: 'repo-mcp',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });

    // Simulate handler building URL with context_attempt_id=ca-mcp-1
    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ contextAttemptId: 'ca-mcp-1' });

    expect(res.status).toBe(200);
    expect(res.body.contextAttemptId).toBe('ca-mcp-1');
    expect(res.body.executionId).toBe('exec-mcp-1');
    // sourceId is the contextAttemptId — not executionId
    expect(res.body.sourceId).toBe('ca-mcp-1');
    expect(res.body.resolved).toBe(true);
  });

  it('query with only executionId resolves the attempt by executionId', async () => {
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-mcp-2', executionId: 'exec-mcp-2', repoId: 'repo-mcp',
      executionKind: 'spawned_agent', status: 'ready',
      contextInjection: { injectedCount: 2, consideredCount: 3 }, createdAt: new Date(),
    });

    // Simulate handler building URL with executionId=exec-mcp-2
    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ executionId: 'exec-mcp-2' });

    expect(res.status).toBe(200);
    expect(res.body.executionId).toBe('exec-mcp-2');
    expect(res.body.contextAttemptId).toBe('ca-mcp-2');
    expect(res.body.resolved).toBe(true);
  });

  it('query with executionId returns all matching attempts for exhaustive analysis', async () => {
    await db.collection('context_attempts').insertMany([
      {
        contextAttemptId: 'ca-mcp-exhaustive-1', executionId: 'exec-mcp-exhaustive', repoId: 'repo-mcp',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 3 }, createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
      {
        contextAttemptId: 'ca-mcp-exhaustive-2', executionId: 'exec-mcp-exhaustive', repoId: 'repo-mcp',
        executionKind: 'workflow_node', status: 'ready',
        contextInjection: { injectedCount: 2, consideredCount: 4 }, createdAt: new Date('2026-01-01T00:00:02.000Z'),
      },
    ]);

    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ executionId: 'exec-mcp-exhaustive' });

    expect(res.status).toBe(200);
    expect(res.body.contextAttemptId).toBe('ca-mcp-exhaustive-1');
    expect(res.body.contextAttemptIds).toEqual(['ca-mcp-exhaustive-1', 'ca-mcp-exhaustive-2']);
    expect(res.body.matchingContextAttempts).toHaveLength(2);
    expect(res.body.attemptCount).toBe(2);
  });

  it('normalizes chat_agent attempts to chat_turn for session lookup', async () => {
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-mcp-chat-1',
      executionId: 'chat-session-1',
      sessionId: 'chat-session-1',
      repoId: 'repo-chat',
      executionKind: 'chat_agent',
      status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 },
      createdAt: new Date(),
    });

    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ sessionId: 'chat-session-1' });

    expect(res.status).toBe(200);
    expect(res.body.contextAttemptId).toBe('ca-mcp-chat-1');
    expect(res.body.sourceKind).toBe('chat_turn');
    expect(res.body.flowKind).toBe('chat_agent');
    expect(res.body.matchingContextAttempts[0].sourceKind).toBe('chat_turn');
  });

  it('query with both contextAttemptId and executionId resolves correctly (contextAttemptId wins)', async () => {
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-mcp-3', executionId: 'exec-mcp-3', repoId: 'repo-mcp',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });

    // Simulate handler building URL with both params (when both are present in args)
    const res = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ contextAttemptId: 'ca-mcp-3', executionId: 'exec-mcp-3' });

    expect(res.status).toBe(200);
    // contextAttemptId lookup takes precedence in the route implementation
    expect(res.body.contextAttemptId).toBe('ca-mcp-3');
    expect(res.body.executionId).toBe('exec-mcp-3');
    expect(res.body.resolved).toBe(true);
  });

  it('query with neither param returns 400 — mirrors handler returning {error: ...}', async () => {
    // The handler returns { error: ... } when neither arg is supplied.
    // The route returns 400 for the same condition.
    const res = await supertest(app).get('/api/context/quality/usage-trace');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('executionId is NOT treated as contextAttemptId — they resolve different queries', async () => {
    // Verify that passing executionId as a contextAttemptId would fail (different field)
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-mcp-4', executionId: 'exec-mcp-4', repoId: 'repo-mcp',
      executionKind: 'workflow_node', status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date(),
    });

    // Passing the executionId as contextAttemptId should NOT resolve the attempt
    const wrongRes = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ contextAttemptId: 'exec-mcp-4' }); // executionId passed as contextAttemptId
    expect(wrongRes.status).toBe(404); // exec-mcp-4 is not a contextAttemptId

    // Passing the correct contextAttemptId resolves correctly
    const correctRes = await supertest(app)
      .get('/api/context/quality/usage-trace')
      .query({ contextAttemptId: 'ca-mcp-4' });
    expect(correctRes.status).toBe(200);
    expect(correctRes.body.contextAttemptId).toBe('ca-mcp-4');
  });
});

describe('MCP handler: context_quality_get_attempt_evidence route and batch contract', () => {
  beforeEach(async () => {
    await db.collection('context_attempts').insertMany([
      {
        contextAttemptId: 'ca-evidence-1',
        executionId: 'exec-evidence',
        repoId: 'repo-evidence',
        executionKind: 'workflow_node',
        status: 'ready',
        contextInjection: { injectedCount: 1, consideredCount: 2 },
        createdAt: new Date(),
      },
      {
        contextAttemptId: 'ca-evidence-2',
        executionId: 'exec-evidence',
        repoId: 'repo-evidence',
        executionKind: 'workflow_node',
        status: 'ready',
        contextInjection: { injectedCount: 0, consideredCount: 1 },
        createdAt: new Date(),
      },
    ]);
  });

  it('GET /api/context/attempts/:id/evidence returns one evidence bundle', async () => {
    const res = await supertest(app).get('/api/context/attempts/ca-evidence-1/evidence');

    expect(res.status).toBe(200);
    expect(res.body.contextAttemptId).toBe('ca-evidence-1');
    expect(res.body.executionId).toBe('exec-evidence');
    expect(res.body.completeness).toEqual(expect.objectContaining({
      injectedContextIncluded: true,
      sourceEvaluationsIncluded: true,
      priorFindingsIncluded: true,
    }));
  });

  it('POST /api/context/attempts/evidence/batch reports found, missing, and errors separately', async () => {
    const res = await supertest(app)
      .post('/api/context/attempts/evidence/batch')
      .send({ context_attempt_ids: ['ca-evidence-1', 'missing-attempt', 'ca-evidence-2'] });

    expect(res.status).toBe(200);
    expect(res.body.contextAttemptIds).toEqual(['ca-evidence-1', 'missing-attempt', 'ca-evidence-2']);
    expect(Object.keys(res.body.evidenceByAttemptId)).toEqual(['ca-evidence-1', 'ca-evidence-2']);
    expect(res.body.missingContextAttemptIds).toEqual(['missing-attempt']);
    expect(res.body.errorsByAttemptId).toEqual({});
    expect(res.body.counts).toEqual({ requested: 3, found: 2, missing: 1, errors: 0 });
  });

  it('allen MCP batch tool calls the batch evidence API and preserves error fields', () => {
    const src = fs.readFileSync(MCP_SERVER_SRC, 'utf8');
    const batchCase = src.slice(
      src.indexOf("case 'context_quality_get_attempt_evidence_batch'"),
      src.indexOf("case 'context_quality_get_usage_trace'"),
    );
    expect(batchCase).toContain("/api/context/attempts/evidence/batch");
    expect(batchCase).not.toContain("Promise.all(contextAttemptIds.map");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENG-1760 Blocker A: MCP tool registry includes all trace/source-eval tools
//
// Verifies that allen-mcp-server.ts source contains all tool names required
// by buildContextJudgeOrchestratorPrompt and buildContextTraceAnalysisWorkerPrompt.
// ─────────────────────────────────────────────────────────────────────────────

describe('ENG-1760 Blocker A: MCP tool registry includes all required trace tools', () => {
  const REQUIRED_TOOLS = [
    'context_quality_list_unevaluated_traces',
    'context_quality_create_trace_analysis_assignment',
    'context_quality_create_trace_analysis_wave',
    'context_quality_list_trace_analysis_assignments',
    'context_quality_update_trace_analysis_assignment',
    'context_quality_submit_source_evaluation',
    'context_quality_list_source_evaluations',
    'context_quality_get_usage_trace',
    'context_quality_replay_usage_trace',
    'context_quality_get_stage_state',
    'context_quality_get_repair_state',
    'context_quality_list_remediation_tasks',
  ];

  it('allen-mcp-server.ts TOOLS array contains all required tool names', () => {
    const src = fs.readFileSync(MCP_SERVER_SRC, 'utf8');
    for (const toolName of REQUIRED_TOOLS) {
      // Each tool name must appear as a quoted name property in the TOOLS array definition
      expect(src, `Expected TOOLS array to contain tool: ${toolName}`).toContain(`name: '${toolName}'`);
    }
  });

  it('listed context MCP tools stay within the Codex exposed-name limit', () => {
    const src = fs.readFileSync(MCP_SERVER_SRC, 'utf8');
    const toolNames = [...src.matchAll(/name:\s*'([^']+)'/g)].map(match => match[1]);
    const listedContextTools = [...new Set(toolNames)].filter(toolName => toolName.includes('context'));
    for (const toolName of listedContextTools) {
      const exposedName = `mcp__allen__${toolName}`;
      expect(
        exposedName.length,
        `${exposedName} must not exceed Codex's 64-character exposed tool-name limit`,
      ).toBeLessThanOrEqual(64);
    }
  });

  it('allen-mcp-server.ts executeTool switch contains cases for all required tools', () => {
    const src = fs.readFileSync(MCP_SERVER_SRC, 'utf8');
    for (const toolName of REQUIRED_TOOLS) {
      // Each tool must have a case in the executeTool switch
      expect(src, `Expected executeTool to handle case: ${toolName}`).toContain(`case '${toolName}'`);
    }
  });

  it('static Allen MCP allowlists include every built-in context_quality tool', () => {
    const serverSrc = fs.readFileSync(MCP_SERVER_SRC, 'utf8');
    const engineSrc = fs.readFileSync(ENGINE_MCP_TOOLS_SRC, 'utf8');
    const uiSrc = fs.readFileSync(UI_MCP_TOOLS_SRC, 'utf8');
    const contextQualityToolNames = [...serverSrc.matchAll(/name:\s*'([^']+)'/g)]
      .map(match => match[1])
      .filter((toolName): toolName is string => Boolean(toolName?.startsWith('context_quality_')));

    for (const toolName of new Set(contextQualityToolNames)) {
      expect(engineSrc, `engine allowlist missing ${toolName}`).toContain(`'${toolName}'`);
      expect(uiSrc, `ui allowlist missing ${toolName}`).toContain(`'${toolName}'`);
    }
  });

  it('allen-mcp-server.ts encodes curated entry path parameters', () => {
    const src = fs.readFileSync(MCP_SERVER_SRC, 'utf8');
    expect(src).toContain('function pathSegment');
    expect(src).toContain('/curated-entries/${pathSegment(args.repo_id)}/${pathSegment(args.entry_id)}');
    expect(src).toContain('/curated-edits/${pathSegment(args.repo_id)}/${pathSegment(args.entry_id)}');
    expect(src).toContain('/history');
    expect(src).toContain('/revert/${pathSegment(args.revision_id)}');
  });
});

describe('ENG-1760: context_quality_create_trace_analysis_wave route', () => {
  function makeTrace(index: number, repoId = 'repo-wave', executionId?: string) {
    const id = `ca-wave-${String(index).padStart(3, '0')}`;
    return {
      contextAttemptId: id,
      executionId: executionId ?? `exec-${id}`,
      repoId,
      executionKind: 'workflow_node',
      status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 2 },
      createdAt: new Date(Date.now() + index),
    };
  }

  it('POST /trace-analysis-assignments/wave creates up to 4 assignments of 20 traces each', async () => {
    await db.collection('context_attempts').insertMany(
      Array.from({ length: 85 }, (_, i) => makeTrace(i + 1)),
    );

    const res = await supertest(app)
      .post('/api/context/quality/trace-analysis-assignments/wave')
      .send({
        sessionId: 'sess-wave-1',
        repoId: 'repo-wave',
        maxAssignments: 4,
        limitPerAssignment: 20,
      });

    expect(res.status).toBe(201);
    expect(res.body.assignments).toHaveLength(4);
    expect(res.body.assignedTraceCount).toBe(80);
    expect(res.body.exhausted).toBe(false);
    for (const assignment of res.body.assignments) {
      expect(assignment.sourceIds).toHaveLength(20);
      expect(assignment.workerAgentName).toBe('context-trace-analysis-agent');
    }

    const assignedIds = res.body.assignments.flatMap((assignment: any) => assignment.sourceIds);
    expect(new Set(assignedIds).size).toBe(80);
  });

  it('POST /trace-analysis-assignments/wave creates fewer assignments and marks exhausted when backlog is smaller', async () => {
    await db.collection('context_attempts').insertMany(
      Array.from({ length: 35 }, (_, i) => makeTrace(i + 1)),
    );

    const res = await supertest(app)
      .post('/api/context/quality/trace-analysis-assignments/wave')
      .send({
        sessionId: 'sess-wave-2',
        repoId: 'repo-wave',
        maxAssignments: 4,
        limitPerAssignment: 20,
      });

    expect(res.status).toBe(201);
    expect(res.body.assignments).toHaveLength(2);
    expect(res.body.assignments.map((assignment: any) => assignment.sourceIds.length)).toEqual([20, 15]);
    expect(res.body.assignedTraceCount).toBe(35);
    expect(res.body.exhausted).toBe(true);
  });

  it('POST /trace-analysis-assignments/wave can refill one open slot without duplicating active assignments', async () => {
    await db.collection('context_attempts').insertMany(
      Array.from({ length: 85 }, (_, i) => makeTrace(i + 1)),
    );

    const initial = await supertest(app)
      .post('/api/context/quality/trace-analysis-assignments/wave')
      .send({
        sessionId: 'sess-wave-refill',
        repoId: 'repo-wave',
        maxAssignments: 4,
        limitPerAssignment: 20,
      });

    expect(initial.status).toBe(201);
    expect(initial.body.assignments).toHaveLength(4);

    const refill = await supertest(app)
      .post('/api/context/quality/trace-analysis-assignments/wave')
      .send({
        sessionId: 'sess-wave-refill',
        repoId: 'repo-wave',
        maxAssignments: 1,
        limitPerAssignment: 20,
      });

    expect(refill.status).toBe(201);
    expect(refill.body.assignments).toHaveLength(1);
    expect(refill.body.assignedTraceCount).toBe(5);
    expect(refill.body.exhausted).toBe(true);

    const initiallyAssigned = new Set(initial.body.assignments.flatMap((assignment: any) => assignment.sourceIds));
    const refillAssigned = refill.body.assignments.flatMap((assignment: any) => assignment.sourceIds);
    expect(refillAssigned).toHaveLength(5);
    for (const sourceId of refillAssigned) {
      expect(initiallyAssigned.has(sourceId)).toBe(false);
    }
  });

  it('POST /trace-analysis-assignments/wave respects repo and self-execution exclusions', async () => {
    await db.collection('context_attempts').insertMany([
      ...Array.from({ length: 10 }, (_, i) => makeTrace(i + 1, 'repo-include')),
      ...Array.from({ length: 10 }, (_, i) => makeTrace(i + 101, 'repo-other')),
      makeTrace(999, 'repo-include', 'root-exec-to-exclude'),
    ]);

    const res = await supertest(app)
      .post('/api/context/quality/trace-analysis-assignments/wave')
      .send({
        sessionId: 'sess-wave-3',
        repoId: 'repo-include',
        maxAssignments: 4,
        limitPerAssignment: 20,
        excludeRootExecutionId: 'root-exec-to-exclude',
      });

    expect(res.status).toBe(201);
    expect(res.body.assignments).toHaveLength(1);
    const assignedIds = res.body.assignments.flatMap((assignment: any) => assignment.sourceIds);
    expect(assignedIds).toHaveLength(10);
    expect(assignedIds).not.toContain('ca-wave-999');

    const storedAssignments = await db.collection('context_trace_analysis_assignments').find({ sessionId: 'sess-wave-3' }).toArray();
    expect(storedAssignments).toHaveLength(1);
    expect((storedAssignments[0] as any).sourceIds).toEqual(assignedIds);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENG-1760 Blocker A4: context_quality_submit_source_evaluation preserves
// enhanced fields through the /source-evaluations/submit route
// ─────────────────────────────────────────────────────────────────────────────

describe('ENG-1760: context_quality_submit_source_evaluation enhanced fields', () => {
  it('POST /source-evaluations/submit persists all enhanced ENG-1760 fields', async () => {
    const payload = {
      sessionId: 'sess-submit-1',
      sourceType: 'context_usage_trace',
      sourceId: 'ca-submit-001',
      sourceKind: 'context_usage_trace',
      contextAttemptId: 'ca-submit-001',
      executionId: 'exec-submit-001',
      repoId: 'repo-submit',
      workerAssignmentId: 'assign-submit-001',
      decision: 'finding_created',
      status: 'completed',
      classification: 'missing_context',
      fixType: 'curated_context_create',
      confidence: 0.88,
      risk: 'medium',
      severity: 'warn',
      contextCorrect: false,
      contextVerdict: 'missing',
      contextIncomplete: true,
      contextIrrelevant: false,
      mandatoryMissing: true,
      mandatoryIncorrect: false,
      overFiltered: true,
      overInjected: false,
      wrongScope: false,
      staleContext: false,
      affectedRefIds: ['cognee:target'],
      expectedContextKinds: ['backend context-quality contract'],
      remediationHints: ['Replay retrieval and prefer targeted context-quality entries'],
      findingIds: ['finding-001', 'finding-002'],
      evidence: [{ kind: 'text', snippet: 'injectedCount=0' }],
      notes: 'No context was injected for this trace.',
    };

    const res = await supertest(app)
      .post('/api/context/quality/source-evaluations/submit')
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.evaluationId).toBeDefined();
    expect(res.body.workerAssignmentId).toBe('assign-submit-001');
    expect(res.body.contextCorrect).toBe(false);
    expect(res.body.contextVerdict).toBe('missing');
    expect(res.body.contextIncomplete).toBe(true);
    expect(res.body.mandatoryMissing).toBe(true);
    expect(res.body.overFiltered).toBe(true);
    expect(res.body.affectedRefIds).toEqual(['cognee:target']);
    expect(res.body.expectedContextKinds).toEqual(['backend context-quality contract']);
    expect(res.body.remediationHints).toHaveLength(1);
    expect(res.body.confidence).toBe(0.88);
    expect(res.body.risk).toBe('medium');
    expect(res.body.severity).toBe('warn');
    expect(res.body.findingIds).toHaveLength(2);
    expect(res.body.evidence).toHaveLength(1);
    expect(res.body.notes).toBe('No context was injected for this trace.');
    expect(res.body.classification).toBe('missing_context');
    expect(res.body.fixType).toBe('curated_context_create');

    // Verify DB storage
    const stored = await db.collection('context_source_evaluations').findOne({
      sourceKey: 'context_usage_trace:ca-submit-001',
    });
    expect(stored).not.toBeNull();
    expect((stored as any).workerAssignmentId).toBe('assign-submit-001');
    expect((stored as any).contextCorrect).toBe(false);
    expect((stored as any).contextVerdict).toBe('missing');
    expect((stored as any).mandatoryMissing).toBe(true);
    expect((stored as any).overFiltered).toBe(true);
    expect((stored as any).affectedRefIds).toEqual(['cognee:target']);
    expect((stored as any).confidence).toBe(0.88);
    expect((stored as any).evidence).toHaveLength(1);
  });

  it('POST /source-evaluations/submit requires sessionId, sourceType, sourceId, decision', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/source-evaluations/submit')
      .send({ sessionId: 'sess-x', sourceType: 'context_usage_trace' }); // missing sourceId and decision
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('no_issue decision also persists correctly via submit endpoint', async () => {
    const res = await supertest(app)
      .post('/api/context/quality/source-evaluations/submit')
      .send({
        sessionId: 'sess-submit-2',
        sourceType: 'context_usage_trace',
        sourceId: 'ca-submit-002',
        contextAttemptId: 'ca-submit-002',
        decision: 'no_issue',
        status: 'completed',
        contextCorrect: true,
        workerAssignmentId: 'assign-submit-002',
        notes: 'Context injection was correct.',
      });

    expect(res.status).toBe(201);
    expect(res.body.decision).toBe('no_issue');
    expect(res.body.contextCorrect).toBe(true);
    expect(res.body.workerAssignmentId).toBe('assign-submit-002');
  });
});

describe('ENG-1760: context_quality_replay_usage_trace route', () => {
  it('reconstructs captured refs and maps Cognee refs to curated entries', async () => {
    await db.collection('context_attempts').insertOne({
      contextAttemptId: 'ca-replay-1',
      executionId: 'exec-replay-1',
      repoId: 'repo-replay',
      repoName: 'repo',
      executionKind: 'workflow_node',
      status: 'ready',
      contextInjection: { injectedCount: 1, consideredCount: 3 },
      createdAt: new Date(),
    });
    await db.collection('context_refs').insertMany([
      {
        contextAttemptId: 'ca-replay-1',
        refId: 'cognee:desktop',
        title: 'Desktop Phase Status',
        path: 'knowledge-docs/docs/desktop-phase-status.md',
        providerId: 'cognee_memory',
        injectionPolicy: 'injectable',
        metadataSummary: { injectionDecision: 'snippet' },
        providerMetadata: { curationEntryId: 'entry-desktop', curationCategory: 'historical_note' },
        rank: 1,
      },
      {
        contextAttemptId: 'ca-replay-1',
        refId: 'cognee:targeted',
        title: 'Context Quality Contract',
        path: 'knowledge-docs/context-quality.md',
        providerId: 'cognee_memory',
        filterReason: 'skipped_budget',
        providerMetadata: { curationEntryId: 'entry-targeted', rejectionReason: 'skipped_budget' },
        rank: 2,
      },
    ]);
    await db.collection('repo_context_curation_entries').insertOne({
      repoId: 'repo-replay',
      entryId: 'entry-desktop',
      path: 'knowledge-docs/docs/desktop-phase-status.md',
      entry: { title: 'Desktop Phase Status', injectionPolicy: 'snippet' },
    });

    const res = await supertest(app)
      .get('/api/context/quality/usage-trace/replay')
      .query({ contextAttemptId: 'ca-replay-1' });

    expect(res.status).toBe(200);
    expect(res.body.replayId).toBe('captured:ca-replay-1');
    expect(res.body.liveReplay).toBe(false);
    expect(res.body.candidateRefs).toHaveLength(2);
    expect(res.body.injectedRefs.map((r: any) => r.refId)).toContain('cognee:desktop');
    expect(res.body.skippedBudgetRefs.map((r: any) => r.refId)).toContain('cognee:targeted');
    expect(res.body.curatedEntryMatches).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENG-1760 Blocker A3: context_quality_list_unevaluated_traces route
// ─────────────────────────────────────────────────────────────────────────────

describe('ENG-1760: context_quality_list_unevaluated_traces route', () => {
  it('GET /scheduler/unevaluated-traces returns unevaluated candidates', async () => {
    // Insert 3 context_attempts
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-ut-001', executionId: 'e1', repoId: 'r1', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
      { contextAttemptId: 'ca-ut-002', executionId: 'e2', repoId: 'r1', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
      { contextAttemptId: 'ca-ut-003', executionId: 'e3', repoId: 'r1', executionKind: 'workflow_node', status: 'ready', contextInjection: { injectedCount: 1, consideredCount: 2 }, createdAt: new Date() },
    ]);

    const res = await supertest(app)
      .get('/api/context/quality/scheduler/unevaluated-traces')
      .query({ limit: '20' });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(3);
    expect(res.body.count).toBe(3);
    for (const c of res.body.candidates) {
      expect(c.sourceKind).toBe('context_usage_trace');
      expect(c.contextAttemptId).toBeDefined();
    }
  });

  it('GET /scheduler/unevaluated-traces excludes already-evaluated traces', async () => {
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-ut-eval-1', executionId: 'e1', repoId: 'r1', executionKind: 'workflow_node', status: 'ready', contextInjection: {}, createdAt: new Date() },
      { contextAttemptId: 'ca-ut-eval-2', executionId: 'e2', repoId: 'r1', executionKind: 'workflow_node', status: 'ready', contextInjection: {}, createdAt: new Date() },
    ]);

    // Mark first as evaluated
    await db.collection('context_source_evaluations').insertOne({
      evaluationId: 'eval-x1',
      sessionId: 'sess-x',
      sourceType: 'context_usage_trace',
      sourceId: 'ca-ut-eval-1',
      sourceKey: 'context_usage_trace:ca-ut-eval-1',
      decision: 'no_issue',
      status: 'completed',
      evaluationVersion: 1,
      evaluatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await supertest(app)
      .get('/api/context/quality/scheduler/unevaluated-traces')
      .query({ limit: '20' });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].contextAttemptId).toBe('ca-ut-eval-2');
  });

  it('GET /scheduler/unevaluated-traces respects cursor parameter', async () => {
    await db.collection('context_attempts').insertMany([
      { contextAttemptId: 'ca-cursor-001', executionId: 'e1', repoId: 'r2', executionKind: 'workflow_node', status: 'ready', contextInjection: {}, createdAt: new Date() },
      { contextAttemptId: 'ca-cursor-002', executionId: 'e2', repoId: 'r2', executionKind: 'workflow_node', status: 'ready', contextInjection: {}, createdAt: new Date() },
      { contextAttemptId: 'ca-cursor-003', executionId: 'e3', repoId: 'r2', executionKind: 'workflow_node', status: 'ready', contextInjection: {}, createdAt: new Date() },
    ]);

    // Fetch with cursor = 'ca-cursor-001' — should only return 002 and 003
    const res = await supertest(app)
      .get('/api/context/quality/scheduler/unevaluated-traces')
      .query({ cursor: 'ca-cursor-001', limit: '20' });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(2);
    const ids = res.body.candidates.map((c: any) => c.contextAttemptId);
    expect(ids).toContain('ca-cursor-002');
    expect(ids).toContain('ca-cursor-003');
    expect(ids).not.toContain('ca-cursor-001');
  });

  it('GET /scheduler/unevaluated-traces limits results to max 20', async () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({
      contextAttemptId: `ca-limit-${String(i + 1).padStart(3, '0')}`,
      executionId: `el-${i}`,
      repoId: 'r-limit',
      executionKind: 'workflow_node',
      status: 'ready',
      contextInjection: {},
      createdAt: new Date(),
    }));
    await db.collection('context_attempts').insertMany(docs);

    const res = await supertest(app)
      .get('/api/context/quality/scheduler/unevaluated-traces')
      .query({ limit: '25' }); // request 25 but route caps at 20

    expect(res.status).toBe(200);
    expect(res.body.candidates.length).toBeLessThanOrEqual(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENG-1760: context_quality_list_source_evaluations route
// ─────────────────────────────────────────────────────────────────────────────

describe('ENG-1760: context_quality_list_source_evaluations route', () => {
  it('GET /source-evaluations returns evaluations for a session', async () => {
    const sessionId = 'sess-list-eval-1';
    await db.collection('context_source_evaluations').insertMany([
      { evaluationId: 'e1', sessionId, sourceType: 'context_usage_trace', sourceId: 'ca-l1', sourceKey: 'context_usage_trace:ca-l1', decision: 'no_issue', status: 'completed', evaluationVersion: 1, evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { evaluationId: 'e2', sessionId, sourceType: 'context_usage_trace', sourceId: 'ca-l2', sourceKey: 'context_usage_trace:ca-l2', decision: 'finding_created', status: 'completed', evaluationVersion: 1, evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { evaluationId: 'e3', sessionId: 'other-session', sourceType: 'context_usage_trace', sourceId: 'ca-l3', sourceKey: 'context_usage_trace:ca-l3', decision: 'no_issue', status: 'completed', evaluationVersion: 1, evaluatedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    ]);

    const res = await supertest(app)
      .get('/api/context/quality/source-evaluations')
      .query({ sessionId });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2); // only this session's evaluations
    const ids = res.body.map((e: any) => e.evaluationId);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
    expect(ids).not.toContain('e3');
  });

  it('GET /source-evaluations requires sessionId param', async () => {
    const res = await supertest(app)
      .get('/api/context/quality/source-evaluations'); // no sessionId
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});
