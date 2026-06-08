// Tests for ContextJudgeService — AC-01 through AC-08, AC-20, AC-21
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextJudgeService } from '../../../services/context/judge/context-judge.service.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let service: ContextJudgeService;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-judge');
  service = new ContextJudgeService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_judge_runs').deleteMany({});
  await db.collection('context_findings').deleteMany({});
});

// ─── AC-01: Default scope is 'workflow' ─────────────────────────────────────

describe('AC-01: default scope is workflow', () => {
  it('judge({}) with no scope → result.scope === "workflow"', async () => {
    const result = await service.judge({});
    expect(result.scope).toBe('workflow');
  });

  it('judge({}) with no scope → stored run has scope "workflow"', async () => {
    const result = await service.judge({});
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run).not.toBeNull();
    expect(run!.scope).toBe('workflow');
  });

  it('result contains judgeRunId (UUID)', async () => {
    const result = await service.judge({});
    expect(result.judgeRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// ─── AC-02: Per-node judging ──────────────────────────────────────────────────

describe('AC-02: per-node judging with scope="node"', () => {
  it('judge({ scope: "node" }) → result.scope === "node"', async () => {
    const result = await service.judge({ scope: 'node' });
    expect(result.scope).toBe('node');
  });

  it('judge({ scope: "node" }) → stored run has scope "node"', async () => {
    const result = await service.judge({ scope: 'node' });
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run!.scope).toBe('node');
  });
});

// ─── AC-03: Learning scope ────────────────────────────────────────────────────

describe('AC-03: learning scope', () => {
  it('judge({ scope: "learning" }) → result.scope === "learning"', async () => {
    const result = await service.judge({ scope: 'learning' });
    expect(result.scope).toBe('learning');
  });

  it('stored run has scope "learning"', async () => {
    const result = await service.judge({ scope: 'learning' });
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run!.scope).toBe('learning');
  });
});

// ─── AC-04: Deterministic scores are calibrated (advisory only) ───────────────

describe('AC-04: deterministic scores are calibrated — advisory only', () => {
  it('score 0.75 → reliabilityLabel "needs_judge" in result (advisory, not pass/fail)', async () => {
    const result = await service.judge({
      deterministicScores: [{ dimension: 'precision', rawScore: 0.75 }],
    });
    expect(result.reliabilityLabel).toBe('needs_judge');
  });

  it('score 0.75 → stored run deterministicReliability[0].reliabilityLabel === "needs_judge"', async () => {
    const result = await service.judge({
      deterministicScores: [{ dimension: 'precision', rawScore: 0.75 }],
    });
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run!.deterministicReliability).toHaveLength(1);
    expect(run!.deterministicReliability[0].dimension).toBe('precision');
    expect(run!.deterministicReliability[0].rawScore).toBe(0.75);
    expect(run!.deterministicReliability[0].reliabilityLabel).toBe('needs_judge');
  });

  it('reliabilityLabel is advisory — stored run.status is still "completed"', async () => {
    const result = await service.judge({
      deterministicScores: [{ dimension: 'completeness', rawScore: 0.10 }],
    });
    const run = await service.getJudgeRun(result.judgeRunId);
    // A "rejected" advisory label does not fail the run
    expect(run!.status).toBe('completed');
    expect(result.reliabilityLabel).toBe('rejected');
  });
});

// ─── AC-05: All 4 reliability labels ─────────────────────────────────────────

describe('AC-05: all 4 reliability labels from deterministic scores', () => {
  it('score 0.9 → reliabilityLabel "confirmed"', async () => {
    const result = await service.judge({
      deterministicScores: [{ dimension: 'x', rawScore: 0.9 }],
    });
    expect(result.reliabilityLabel).toBe('confirmed');
  });

  it('score 0.6 → reliabilityLabel "needs_judge"', async () => {
    const result = await service.judge({
      deterministicScores: [{ dimension: 'x', rawScore: 0.6 }],
    });
    expect(result.reliabilityLabel).toBe('needs_judge');
  });

  it('score 0.3 → reliabilityLabel "signal_only"', async () => {
    const result = await service.judge({
      deterministicScores: [{ dimension: 'x', rawScore: 0.3 }],
    });
    expect(result.reliabilityLabel).toBe('signal_only');
  });

  it('score 0.1 → reliabilityLabel "rejected"', async () => {
    const result = await service.judge({
      deterministicScores: [{ dimension: 'x', rawScore: 0.1 }],
    });
    expect(result.reliabilityLabel).toBe('rejected');
  });

  it('no deterministicScores → reliabilityLabel defaults to "signal_only" (empty aggregate)', async () => {
    const result = await service.judge({});
    expect(result.reliabilityLabel).toBe('signal_only');
  });
});

// ─── AC-08: Findings created with all required fields ─────────────────────────

describe('AC-08: findings created with all required fields', () => {
  it('finding stored in DB has all required fields', async () => {
    const result = await service.judge({
      rawFindings: [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'medium',
          confidence: 0.8,
          evidence: [{ kind: 'text', snippet: 'Missing relevant context block' }],
          suggestedRemediation: 'Add context entry for X',
        },
      ],
    });

    expect(result.findingIds).toHaveLength(1);

    const finding = await db
      .collection('context_findings')
      .findOne({ findingId: result.findingIds[0] });

    expect(finding).not.toBeNull();
    expect(finding!.classification).toBe('missing_context');
    expect(finding!.fixType).toBe('curated_context_create');
    expect(finding!.severity).toBe('warn');
    expect(finding!.risk).toBe('medium');
    expect(finding!.confidence).toBe(0.8);
    expect(finding!.reliabilityLabel).toBeDefined();
    expect(finding!.evidence).toHaveLength(1);
    expect(finding!.status).toBe('open');
    expect(finding!.active).toBe(true);
    expect(finding!.judgeRunId).toBe(result.judgeRunId);
  });

  it('no rawFindings → findingIds is empty array', async () => {
    const result = await service.judge({});
    expect(result.findingIds).toEqual([]);
  });

  it('multiple rawFindings → each stored with unique findingId', async () => {
    const result = await service.judge({
      rawFindings: [
        {
          classification: 'missing_context',
          fixType: 'no_action',
          severity: 'info',
          risk: 'low',
          confidence: 0.7,
        },
        {
          classification: 'stale_context',
          fixType: 'curated_context_edit',
          severity: 'error',
          risk: 'high',
          confidence: 0.9,
        },
      ],
    });

    expect(result.findingIds).toHaveLength(2);
    expect(result.findingIds[0]).not.toBe(result.findingIds[1]);

    const count = await db.collection('context_findings').countDocuments({
      judgeRunId: result.judgeRunId,
    });
    expect(count).toBe(2);
  });
});

// ─── AC-07: Learning linkage ──────────────────────────────────────────────────

describe('AC-07: learning linkage', () => {
  it('rawFinding with learningId → stored finding has learningId', async () => {
    const result = await service.judge({
      rawFindings: [
        {
          classification: 'learning_candidate',
          fixType: 'learning_promotion',
          severity: 'info',
          risk: 'low',
          confidence: 0.75,
          learningId: 'learning-123',
        },
      ],
    });

    const finding = await db
      .collection('context_findings')
      .findOne({ findingId: result.findingIds[0] });

    expect(finding!.learningId).toBe('learning-123');
  });

  it('rawFinding without learningId → stored finding has no learningId', async () => {
    const result = await service.judge({
      rawFindings: [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
        },
      ],
    });

    const finding = await db
      .collection('context_findings')
      .findOne({ findingId: result.findingIds[0] });

    // MongoDB serialises `undefined` values to `null` in BSON, so the stored
    // document will have learningId: null when no learningId was provided.
    expect(finding!.learningId == null).toBe(true);
  });
});

// ─── AC-20: Supersession preserves history ────────────────────────────────────

describe('AC-20: supersession preserves history', () => {
  it('second judge() call with same sourceId supersedes the first run', async () => {
    const runA = await service.judge({
      sourceId: 'exec-1',
      rawFindings: [
        {
          classification: 'missing_context',
          fixType: 'no_action',
          severity: 'info',
          risk: 'low',
          confidence: 0.7,
        },
      ],
    });

    const runB = await service.judge({
      sourceId: 'exec-1',
      rawFindings: [
        {
          classification: 'stale_context',
          fixType: 'curated_context_edit',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
        },
      ],
    });

    // B knows it superseded A
    expect(runB.supersededRunId).toBe(runA.judgeRunId);
  });

  it('first run is deactivated — active=false, validTo set, supersededBy=B', async () => {
    const runA = await service.judge({ sourceId: 'exec-2' });
    const runB = await service.judge({ sourceId: 'exec-2' });

    const storedA = await service.getJudgeRun(runA.judgeRunId);
    expect(storedA!.active).toBe(false);
    expect(storedA!.validTo).toBeInstanceOf(Date);
    expect(storedA!.supersededBy).toBe(runB.judgeRunId);
  });

  it('second run is active', async () => {
    await service.judge({ sourceId: 'exec-3' });
    const runB = await service.judge({ sourceId: 'exec-3' });

    const storedB = await service.getJudgeRun(runB.judgeRunId);
    expect(storedB!.active).toBe(true);
  });

  it('first run findings are superseded (active=false)', async () => {
    const runA = await service.judge({
      sourceId: 'exec-4',
      rawFindings: [
        {
          classification: 'wrong_context',
          fixType: 'curated_context_edit',
          severity: 'warn',
          risk: 'low',
          confidence: 0.7,
        },
      ],
    });

    await service.judge({ sourceId: 'exec-4' });

    // A's finding must now be inactive and superseded
    const findingA = await db
      .collection('context_findings')
      .findOne({ findingId: runA.findingIds[0] });

    expect(findingA!.active).toBe(false);
    expect(findingA!.status).toBe('superseded');
    expect(findingA!.supersededAt).toBeInstanceOf(Date);
  });

  it('second run findings are active', async () => {
    await service.judge({ sourceId: 'exec-5' });
    const runB = await service.judge({
      sourceId: 'exec-5',
      rawFindings: [
        {
          classification: 'bloated_context',
          fixType: 'curated_context_archive',
          severity: 'info',
          risk: 'low',
          confidence: 0.85,
        },
      ],
    });

    const findingB = await db
      .collection('context_findings')
      .findOne({ findingId: runB.findingIds[0] });

    expect(findingB!.active).toBe(true);
  });

  it('different sourceIds do not interfere with each other', async () => {
    const runX = await service.judge({ sourceId: 'exec-x' });
    const runY = await service.judge({ sourceId: 'exec-y' });

    // Neither should have supersededRunId because they have different sourceIds
    expect(runX.supersededRunId).toBeUndefined();
    expect(runY.supersededRunId).toBeUndefined();
  });

  it('history is preserved — old run still retrievable after supersession', async () => {
    const runA = await service.judge({ sourceId: 'exec-6' });
    await service.judge({ sourceId: 'exec-6' });

    const storedA = await service.getJudgeRun(runA.judgeRunId);
    expect(storedA).not.toBeNull();
    expect(storedA!.judgeRunId).toBe(runA.judgeRunId);
  });
});

// ─── AC-21: Audit trail ───────────────────────────────────────────────────────

describe('AC-21: audit trail', () => {
  it('after judge(), judge run row exists in DB', async () => {
    const result = await service.judge({});
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run).not.toBeNull();
    expect(run!.judgeRunId).toBe(result.judgeRunId);
  });

  it('judge run row has status "completed"', async () => {
    const result = await service.judge({});
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run!.status).toBe('completed');
  });

  it('judge run row has timestamps (createdAt, updatedAt, validFrom)', async () => {
    const result = await service.judge({});
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run!.createdAt).toBeInstanceOf(Date);
    expect(run!.updatedAt).toBeInstanceOf(Date);
    expect(run!.validFrom).toBeInstanceOf(Date);
  });

  it('finding rows exist for each rawFinding', async () => {
    const result = await service.judge({
      rawFindings: [
        {
          classification: 'retrieval_miss',
          fixType: 'retrieval_tune',
          severity: 'error',
          risk: 'medium',
          confidence: 0.65,
        },
      ],
    });

    const findingInDb = await db
      .collection('context_findings')
      .findOne({ findingId: result.findingIds[0] });

    expect(findingInDb).not.toBeNull();
    expect(findingInDb!.judgeRunId).toBe(result.judgeRunId);
  });

  it('findingsSummary on run reflects rawFindings count', async () => {
    const result = await service.judge({
      rawFindings: [
        {
          classification: 'missing_context',
          fixType: 'no_action',
          severity: 'info',
          risk: 'low',
          confidence: 0.7,
        },
        {
          classification: 'stale_context',
          fixType: 'curated_context_edit',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
        },
      ],
    });
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run!.findingsSummary.total).toBe(2);
  });
});

// ─── listJudgeRuns filtering ──────────────────────────────────────────────────

describe('listJudgeRuns filtering', () => {
  it('filter by scope returns only matching runs', async () => {
    await service.judge({ scope: 'workflow' });
    await service.judge({ scope: 'node' });
    await service.judge({ scope: 'node' });

    const nodeRuns = await service.listJudgeRuns({ scope: 'node' });
    expect(nodeRuns.length).toBe(2);
    for (const r of nodeRuns) {
      expect(r.scope).toBe('node');
    }
  });

  it('filter by active=true returns only active runs', async () => {
    // Create run A, then supersede with run B (A becomes inactive)
    await service.judge({ sourceId: 'list-filter-src', scope: 'workflow' });
    const runB = await service.judge({ sourceId: 'list-filter-src', scope: 'workflow' });

    const activeRuns = await service.listJudgeRuns({ active: true, scope: 'workflow' });
    const activeIds = activeRuns.map((r) => r.judgeRunId);

    expect(activeIds).toContain(runB.judgeRunId);
  });

  it('filter by active=false returns superseded runs', async () => {
    const runA = await service.judge({ sourceId: 'list-filter-src2', scope: 'learning' });
    await service.judge({ sourceId: 'list-filter-src2', scope: 'learning' });

    const inactiveRuns = await service.listJudgeRuns({ active: false, scope: 'learning' });
    const ids = inactiveRuns.map((r) => r.judgeRunId);
    expect(ids).toContain(runA.judgeRunId);
  });

  it('listJudgeRuns with no filters returns all runs', async () => {
    await service.judge({ scope: 'chat_turn' });
    await service.judge({ scope: 'spawned_agent' });

    const all = await service.listJudgeRuns({});
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── sourceKey idempotency ────────────────────────────────────────────────────

describe('sourceKey idempotency', () => {
  it('returns existing completed run without creating duplicate when sourceKey matches', async () => {
    // Create first run
    const r1 = await service.judge({
      scope: 'workflow',
      sourceId: 'src-idem-1',
      sourceKind: 'workflow_run',
      trigger: 'auto',
    });
    // Second call with same sourceId/sourceKind, non-rejudge
    const r2 = await service.judge({
      scope: 'workflow',
      sourceId: 'src-idem-1',
      sourceKind: 'workflow_run',
      trigger: 'auto',
    });
    expect(r2.alreadyEvaluated).toBe(true);
    expect(r2.judgeRunId).toBe(r1.judgeRunId);
  });

  it('rejudge trigger creates new run even when sourceKey exists', async () => {
    const r1 = await service.judge({
      scope: 'workflow',
      sourceId: 'src-rejudge-idem',
      sourceKind: 'workflow_run',
      trigger: 'auto',
    });
    const r2 = await service.judge({
      scope: 'workflow',
      sourceId: 'src-rejudge-idem',
      sourceKind: 'workflow_run',
      trigger: 'rejudge',
    });
    expect(r2.judgeRunId).not.toBe(r1.judgeRunId);
    expect(r2.alreadyEvaluated).toBeFalsy();
  });

  it('stores sourceKey on the judge run document', async () => {
    const result = await service.judge({
      scope: 'workflow',
      sourceId: 'src-key-test',
      sourceKind: 'workflow_run',
      trigger: 'auto',
    });
    const run = await service.getJudgeRun(result.judgeRunId);
    expect(run?.sourceKey).toBe('workflow_run:src-key-test');
  });

  it('no idempotency check when sourceKind is absent', async () => {
    // Without sourceKind, each call should create a new run
    const r1 = await service.judge({ scope: 'workflow', sourceId: 'src-no-kind' });
    const r2 = await service.judge({ scope: 'workflow', sourceId: 'src-no-kind' });
    // Without sourceKind, the idempotency block is skipped — r2 supersedes r1
    expect(r2.judgeRunId).not.toBe(r1.judgeRunId);
    expect(r2.alreadyEvaluated).toBeFalsy();
  });
});

// ─── Fix 6: Reliability calibration from confidence ──────────────────────────
// When no deterministicScores are provided, per-finding reliability should be
// derived from confidence — NOT defaulted to 'signal_only'.

describe('Fix 6: per-finding reliability from confidence when no deterministicScores', () => {
  it('high confidence (0.9) → finding reliabilityLabel=confirmed when no deterministicScores', async () => {
    const result = await service.judge({
      scope: 'workflow',
      // No deterministicScores — should derive from confidence
      rawFindings: [
        { classification: 'retrieval_gap', fixType: 'retrieval_fix', severity: 'warn', risk: 'low', confidence: 0.9 },
      ],
    });
    const finding = await db.collection('context_findings').findOne({ judgeRunId: result.judgeRunId });
    expect(finding?.reliabilityLabel).toBe('confirmed');
  });

  it('medium confidence (0.65) → finding reliabilityLabel=needs_judge when no deterministicScores', async () => {
    const result = await service.judge({
      scope: 'workflow',
      rawFindings: [
        { classification: 'retrieval_gap', fixType: 'retrieval_fix', severity: 'warn', risk: 'low', confidence: 0.65 },
      ],
    });
    const finding = await db.collection('context_findings').findOne({ judgeRunId: result.judgeRunId });
    expect(finding?.reliabilityLabel).toBe('needs_judge');
  });

  it('low confidence (0.3) → finding reliabilityLabel=signal_only when no deterministicScores', async () => {
    const result = await service.judge({
      scope: 'workflow',
      rawFindings: [
        { classification: 'retrieval_gap', fixType: 'retrieval_fix', severity: 'warn', risk: 'low', confidence: 0.3 },
      ],
    });
    const finding = await db.collection('context_findings').findOne({ judgeRunId: result.judgeRunId });
    expect(finding?.reliabilityLabel).toBe('signal_only');
  });

  it('when deterministicScores present, uses aggregate (not confidence)', async () => {
    // Deterministic score 0.3 → signal_only even if confidence is high (weakest-link)
    const result = await service.judge({
      scope: 'workflow',
      deterministicScores: [{ dimension: 'precision', rawScore: 0.3 }],
      rawFindings: [
        { classification: 'retrieval_gap', fixType: 'retrieval_fix', severity: 'warn', risk: 'low', confidence: 0.95 },
      ],
    });
    const finding = await db.collection('context_findings').findOne({ judgeRunId: result.judgeRunId });
    // Aggregate of [0.3] → signal_only, overrides the confidence-based label
    expect(finding?.reliabilityLabel).toBe('signal_only');
  });
});

// ─── Fix 3: runScope and impactScope on findings ─────────────────────────────

describe('Fix 3: runScope persisted on judge run; impactScope on finding', () => {
  it('repo-scoped run (repoId set) → run.runScope=repo', async () => {
    const result = await service.judge({
      scope: 'workflow',
      repoId: 'repo-abc',
      rawFindings: [
        { classification: 'retrieval_gap', fixType: 'retrieval_fix', severity: 'warn', risk: 'low', confidence: 0.8 },
      ],
    });
    const run = await db.collection('context_judge_runs').findOne({ judgeRunId: result.judgeRunId });
    expect(run?.runScope).toBe('repo');
  });

  it('global run (no repoId) → run.runScope=global', async () => {
    const result = await service.judge({
      scope: 'global',
      rawFindings: [
        { classification: 'retrieval_gap', fixType: 'retrieval_fix', severity: 'warn', risk: 'low', confidence: 0.8 },
      ],
    });
    const run = await db.collection('context_judge_runs').findOne({ judgeRunId: result.judgeRunId });
    expect(run?.runScope).toBe('global');
  });

  it('finding persists impactScope when provided', async () => {
    const result = await service.judge({
      scope: 'workflow',
      repoId: 'repo-xyz',
      rawFindings: [
        {
          classification: 'retrieval_gap',
          fixType: 'retrieval_fix',
          severity: 'warn',
          risk: 'high',
          confidence: 0.8,
          impactScope: 'cross_repo',
          primarySourceId: 'src-abc',
          executionId: 'exec-abc',
        },
      ],
    });
    const finding = await db.collection('context_findings').findOne({ judgeRunId: result.judgeRunId });
    expect(finding?.impactScope).toBe('cross_repo');
    expect(finding?.primarySourceId).toBe('src-abc');
    expect(finding?.executionId).toBe('exec-abc');
  });
});

// ─── Fix 5: Source traceability fields on findings ───────────────────────────

describe('Fix 5: source traceability persisted on findings', () => {
  it('persists contextAttemptId, executionId, sourceRefs on finding', async () => {
    const result = await service.judge({
      scope: 'workflow',
      sourceId: 'exec-trace-test',
      sourceKind: 'workflow_run',
      rawFindings: [
        {
          classification: 'retrieval_gap',
          fixType: 'retrieval_fix',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
          contextAttemptId: 'ca-trace-test',
          executionId: 'exec-trace-test',
          sourceRefs: ['ca-trace-test', 'ref-b'],
        },
      ],
    });
    const finding = await db.collection('context_findings').findOne({ judgeRunId: result.judgeRunId });
    expect(finding?.contextAttemptId).toBe('ca-trace-test');
    expect(finding?.executionId).toBe('exec-trace-test');
    expect(finding?.sourceRefs).toEqual(['ca-trace-test', 'ref-b']);
  });

  it('primarySourceId defaults to sourceId when not explicitly set', async () => {
    const result = await service.judge({
      scope: 'workflow',
      sourceId: 'exec-primary-src',
      sourceKind: 'workflow_run',
      rawFindings: [
        { classification: 'retrieval_gap', fixType: 'retrieval_fix', severity: 'warn', risk: 'low', confidence: 0.8 },
      ],
    });
    const finding = await db.collection('context_findings').findOne({ judgeRunId: result.judgeRunId });
    expect(finding?.primarySourceId).toBe('exec-primary-src');
  });
});
