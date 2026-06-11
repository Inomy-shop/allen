// Tests for ContextJudgeOrchestratorService — LLM agent-owned orchestration boundary
// AC-11: orchestrator never creates Linear sync side effects
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextJudgeOrchestratorService } from '../../../services/context/judge/context-judge-orchestrator.service.js';
import type { AgentFindingInput } from '../../../services/context/judge/context-judge-orchestrator.service.js';
import type { ContextJudgeConfig } from '../../../services/context/judge/context-judge.types.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let service: ContextJudgeOrchestratorService;

const testConfig: ContextJudgeConfig = {
  configId: 'singleton',
  autoRemediationEnabled: false,
  autoRemediationThresholds: {
    minConfidence: 0.85,
    maxRisk: 'low',
    allowedFixTypes: [],
  },
  mandatoryHumanReview: {
    lowConfidenceThreshold: 0.5,
    highRiskLevels: ['high', 'critical'],
    alwaysForScopes: ['cross_repo', 'global'],
    alwaysForLearningDerived: true,
    alwaysForCodeFix: true,
  },
  updatedAt: new Date(),
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-orchestrator');
  service = new ContextJudgeOrchestratorService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_orchestration_sessions').deleteMany({});
  await db.collection('context_judge_runs').deleteMany({});
  await db.collection('context_findings').deleteMany({});
  await db.collection('context_review_tasks').deleteMany({});
  await db.collection('context_source_evaluations').deleteMany({});
  await db.collection('context_remediations').deleteMany({});
  await db.collection('context_review_worker_assignments').deleteMany({});
  await db.collection('context_trace_analysis_assignments').deleteMany({});
});

// ─── beginOrchestration ──────────────────────────────────────────────────────

describe('ContextJudgeOrchestratorService — agent-owned orchestration', () => {
  describe('beginOrchestration()', () => {
    it('creates a session with status="active"', async () => {
      const session = await service.beginOrchestration({
        scope: 'workflow',
        agentModel: 'claude-3-5-sonnet',
        agentProvider: 'anthropic',
        agentRationale: 'Testing orchestration',
      });

      expect(session.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(session.status).toBe('active');
      expect(session.scope).toBe('workflow');
      expect(session.agentModel).toBe('claude-3-5-sonnet');
      expect(session.agentProvider).toBe('anthropic');
      expect(session.findingIds).toEqual([]);
      expect(session.reviewTaskIds).toEqual([]);
      expect(session.agentDecisionLog).toEqual([]);
    });

    it('persists the session in the database', async () => {
      const session = await service.beginOrchestration({ scope: 'node' });
      const stored = await db
        .collection('context_orchestration_sessions')
        .findOne({ sessionId: session.sessionId });
      expect(stored).not.toBeNull();
      expect((stored as any).status).toBe('active');
    });
  });

  // ─── logAgentDecision ────────────────────────────────────────────────────────

  describe('logAgentDecision()', () => {
    it('appends to agentDecisionLog', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });

      await service.logAgentDecision(session.sessionId, {
        at: new Date(),
        kind: 'discovery',
        detail: 'Found 3 workflow runs with missing context indicators',
        metadata: { sourceCount: 3 },
      });

      const updated = await service.getSession(session.sessionId);
      expect(updated!.agentDecisionLog).toHaveLength(1);
      expect(updated!.agentDecisionLog[0].kind).toBe('discovery');
      expect(updated!.agentDecisionLog[0].detail).toContain('3 workflow runs');
    });

    it('appends multiple entries in order', async () => {
      const session = await service.beginOrchestration({ scope: 'learning' });

      await service.logAgentDecision(session.sessionId, {
        at: new Date(),
        kind: 'discovery',
        detail: 'First decision',
      });
      await service.logAgentDecision(session.sessionId, {
        at: new Date(),
        kind: 'classification',
        detail: 'Second decision',
      });

      const updated = await service.getSession(session.sessionId);
      expect(updated!.agentDecisionLog).toHaveLength(2);
      expect(updated!.agentDecisionLog[0].detail).toBe('First decision');
      expect(updated!.agentDecisionLog[1].detail).toBe('Second decision');
    });
  });

  // ─── submitFindings ──────────────────────────────────────────────────────────

  describe('submitFindings()', () => {
    it('creates judge run and findings and review tasks', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });

      const findings: AgentFindingInput[] = [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
          suggestedRemediation: 'Add curated entry',
          agentRationale: 'Context was absent in 3 of 5 samples',
        },
        {
          classification: 'stale_context',
          fixType: 'curated_context_edit',
          severity: 'info',
          risk: 'low',
          confidence: 0.75,
        },
      ];

      const result = await service.submitFindings(session.sessionId, findings, testConfig);

      expect(result.judgeRunId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.findingIds).toHaveLength(2);
      expect(result.reviewTaskIds).toHaveLength(2);

      // Verify session was updated
      const updatedSession = await service.getSession(session.sessionId);
      expect(updatedSession!.judgeRunId).toBe(result.judgeRunId);
      expect(updatedSession!.findingIds).toHaveLength(2);
      expect(updatedSession!.reviewTaskIds).toHaveLength(2);
    });

    it('throws if session is not active', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });
      await service.failSession(session.sessionId, 'test failure');

      await expect(
        service.submitFindings(session.sessionId, [], testConfig),
      ).rejects.toThrow('not active');
    });

    it('enforces code_fix requires human review (logs gate_check entry)', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });

      const findings: AgentFindingInput[] = [
        {
          classification: 'code_defect',
          fixType: 'code_fix',
          severity: 'error',
          risk: 'high',
          confidence: 0.9,
          agentRationale: 'Found a code bug',
        },
      ];

      await service.submitFindings(session.sessionId, findings, testConfig);

      const updated = await service.getSession(session.sessionId);
      const gateChecks = updated!.agentDecisionLog.filter((e) => e.kind === 'gate_check');
      expect(gateChecks.length).toBeGreaterThan(0);
      expect(gateChecks.some((e) => e.detail.includes('code_fix'))).toBe(true);

      // Verify review task has requiresHumanReview=true
      const tasks = await db
        .collection('context_review_tasks')
        .find({ taskId: { $in: updated!.reviewTaskIds } })
        .toArray();
      expect(tasks.every((t) => (t as any).requiresHumanReview === true)).toBe(true);
    });

    it('enforces cross_repo scope requires human review', async () => {
      const session = await service.beginOrchestration({ scope: 'cross_repo' });

      const findings: AgentFindingInput[] = [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'medium',
          confidence: 0.85,
        },
      ];

      await service.submitFindings(session.sessionId, findings, testConfig);

      const updated = await service.getSession(session.sessionId);
      const gateChecks = updated!.agentDecisionLog.filter((e) => e.kind === 'gate_check');
      expect(gateChecks.length).toBeGreaterThan(0);
      expect(gateChecks.some((e) => e.detail.includes('cross_repo'))).toBe(true);
    });
  });

  // ─── finalizeOrchestration ───────────────────────────────────────────────────

  describe('finalizeOrchestration()', () => {
    it('sets status="finalized" and logs summary entry', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });

      const finalized = await service.finalizeOrchestration(
        session.sessionId,
        'Evaluated 10 workflow runs, found 2 findings',
      );

      expect(finalized.status).toBe('finalized');
      expect(finalized.finalizedAt).toBeDefined();
      const summaryEntries = finalized.agentDecisionLog.filter((e) => e.kind === 'summary');
      expect(summaryEntries).toHaveLength(1);
      expect(summaryEntries[0].detail).toContain('10 workflow runs');
    });

    it('uses default summary if none provided', async () => {
      const session = await service.beginOrchestration({ scope: 'node' });
      const finalized = await service.finalizeOrchestration(session.sessionId);
      expect(finalized.status).toBe('finalized');
      const summaryEntries = finalized.agentDecisionLog.filter((e) => e.kind === 'summary');
      expect(summaryEntries).toHaveLength(1);
    });
  });

  // ─── getSession ──────────────────────────────────────────────────────────────

  describe('getSession()', () => {
    it('returns the session by sessionId', async () => {
      const session = await service.beginOrchestration({ scope: 'learning', repoId: 'repo-abc' });
      const fetched = await service.getSession(session.sessionId);
      expect(fetched).not.toBeNull();
      expect(fetched!.sessionId).toBe(session.sessionId);
      expect(fetched!.repoId).toBe('repo-abc');
    });

    it('returns null for unknown sessionId', async () => {
      const fetched = await service.getSession('nonexistent-session-id');
      expect(fetched).toBeNull();
    });
  });

  // ─── listSessions ────────────────────────────────────────────────────────────

  describe('listSessions()', () => {
    it('filters by status', async () => {
      const s1 = await service.beginOrchestration({ scope: 'workflow' });
      const s2 = await service.beginOrchestration({ scope: 'workflow' });
      await service.finalizeOrchestration(s1.sessionId);
      // s2 remains active

      const activeSessions = await service.listSessions({ status: 'active' });
      const finalizedSessions = await service.listSessions({ status: 'finalized' });

      expect(activeSessions.some((s) => s.sessionId === s2.sessionId)).toBe(true);
      expect(activeSessions.some((s) => s.sessionId === s1.sessionId)).toBe(false);
      expect(finalizedSessions.some((s) => s.sessionId === s1.sessionId)).toBe(true);
    });

    it('filters by scope', async () => {
      await service.beginOrchestration({ scope: 'workflow' });
      await service.beginOrchestration({ scope: 'learning' });

      const workflowSessions = await service.listSessions({ scope: 'workflow' });
      expect(workflowSessions.every((s) => s.scope === 'workflow')).toBe(true);
    });
  });

  // ─── failSession ─────────────────────────────────────────────────────────────

  describe('failSession()', () => {
    it('sets status="failed"', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });
      await service.failSession(session.sessionId, 'Agent encountered an error');

      const updated = await service.getSession(session.sessionId);
      expect(updated!.status).toBe('failed');
      const errorEntries = updated!.agentDecisionLog.filter((e) =>
        e.detail.includes('Agent encountered an error'),
      );
      expect(errorEntries).toHaveLength(1);
    });
  });

  // ─── AC-11: orchestrator never creates Linear sync side effects ─────────────

  describe('AC-11: orchestrator never creates Linear sync side effects', () => {
    it('submitFindings produces findings/tasks without any linear-related fields on sessions', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });

      const findings: AgentFindingInput[] = [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.9,
        },
        {
          classification: 'stale_context',
          fixType: 'curated_context_archive',
          severity: 'info',
          risk: 'low',
          confidence: 0.85,
        },
      ];

      const result = await service.submitFindings(session.sessionId, findings, testConfig);
      await service.finalizeOrchestration(session.sessionId, 'done');

      // Verify findings and review tasks were created
      expect(result.findingIds).toHaveLength(2);
      expect(result.reviewTaskIds).toHaveLength(2);

      // Verify no linear-related fields on the session
      const stored = await db
        .collection('context_orchestration_sessions')
        .findOne({ sessionId: session.sessionId }) as any;
      expect(stored).not.toBeNull();
      expect(stored.linearIssueId).toBeUndefined();
      expect(stored.linearUrl).toBeUndefined();
      expect(stored.linearSynced).toBeUndefined();

      // Verify no linear fields on findings
      const storedFindings = await db
        .collection('context_findings')
        .find({ findingId: { $in: result.findingIds } })
        .toArray();
      expect(storedFindings).toHaveLength(2);
      for (const f of storedFindings) {
        expect((f as any).linearIssueId).toBeUndefined();
        expect((f as any).linearUrl).toBeUndefined();
        expect((f as any).linearSynced).toBeUndefined();
      }

      // Verify no linear fields on review tasks
      const storedTasks = await db
        .collection('context_review_tasks')
        .find({ taskId: { $in: result.reviewTaskIds } })
        .toArray();
      expect(storedTasks).toHaveLength(2);
      for (const t of storedTasks) {
        expect((t as any).linearIssueId).toBeUndefined();
        expect((t as any).linearUrl).toBeUndefined();
        expect((t as any).linearSynced).toBeUndefined();
      }
    });
  });

  // ─── dry-run mode ────────────────────────────────────────────────────────────

  describe('dry-run mode', () => {
    it('beginOrchestration with dry_run=true sets dry_run on session', async () => {
      const session = await service.beginOrchestration({
        scope: 'workflow',
        dry_run: true,
        agentModel: 'claude-3-5-sonnet',
      });

      expect(session.dry_run).toBe(true);
      const stored = await db
        .collection('context_orchestration_sessions')
        .findOne({ sessionId: session.sessionId }) as any;
      expect(stored?.dry_run).toBe(true);
    });

    it('submitFindings in dry_run mode returns dryRun=true and does NOT write to DB', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow', dry_run: true });

      const findings: AgentFindingInput[] = [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
          suggestedRemediation: 'Add curated entry',
        },
        {
          classification: 'stale_context',
          fixType: 'curated_context_edit',
          severity: 'info',
          risk: 'low',
          confidence: 0.75,
        },
      ];

      const result = await service.submitFindings(session.sessionId, findings, testConfig) as any;

      // dry-run should return dryRun flag and NOT persist to DB
      expect(result.dryRun).toBe(true);
      expect(result.submittedCount).toBe(2);
      expect(result.findingIds).toEqual([]);
      expect(result.reviewTaskIds).toEqual([]);

      // Verify no judge runs were written to DB
      const judgeRuns = await db.collection('context_judge_runs').find({}).toArray();
      expect(judgeRuns).toHaveLength(0);

      // Verify no findings were written to DB
      const dbFindings = await db.collection('context_findings').find({}).toArray();
      expect(dbFindings).toHaveLength(0);

      // Verify no review tasks were written to DB
      const reviewTasks = await db.collection('context_review_tasks').find({}).toArray();
      expect(reviewTasks).toHaveLength(0);
    });

    it('dry_run=false (default) writes findings to DB', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' }); // dry_run defaults to false

      const findings: AgentFindingInput[] = [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
        },
      ];

      const result = await service.submitFindings(session.sessionId, findings, testConfig) as any;

      // Production mode should NOT set dryRun
      expect(result.dryRun).toBeUndefined();
      expect(result.judgeRunId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.findingIds).toHaveLength(1);

      // DB should have the finding
      const dbFindings = await db.collection('context_findings').find({}).toArray();
      expect(dbFindings).toHaveLength(1);
    });

    it('dry-run finalizeOrchestration returns dbSummary with dry_run=true and 0 counts', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow', dry_run: true });

      const findings: AgentFindingInput[] = [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
        },
      ];

      await service.submitFindings(session.sessionId, findings, testConfig);
      const finalized = await service.finalizeOrchestration(session.sessionId, 'dry run done') as any;

      expect(finalized.status).toBe('finalized');
      expect(finalized.dbSummary).toBeDefined();
      expect(finalized.dbSummary.dry_run).toBe(true);
      expect(finalized.dbSummary.dbDerivedFindingCount).toBe(0);
      expect(finalized.dbSummary.dbDerivedReviewTaskCount).toBe(0);
    });
  });

  // ─── DB-derived finalize summary ─────────────────────────────────────────────

  describe('DB-derived summary from finalizeOrchestration()', () => {
    it('returns dbSummary with actual DB counts after production submitFindings', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });

      const findings: AgentFindingInput[] = [
        {
          classification: 'missing_context',
          fixType: 'curated_context_create',
          severity: 'warn',
          risk: 'low',
          confidence: 0.8,
        },
        {
          classification: 'stale_context',
          fixType: 'curated_context_edit',
          severity: 'info',
          risk: 'low',
          confidence: 0.75,
        },
      ];

      const submitResult = await service.submitFindings(session.sessionId, findings, testConfig);
      const finalized = await service.finalizeOrchestration(session.sessionId, 'done') as any;

      expect(finalized.dbSummary).toBeDefined();
      expect(finalized.dbSummary.judgeRunId).toBe(submitResult.judgeRunId);
      expect(finalized.dbSummary.dry_run).toBe(false);
      // DB-derived count must match the actual findings written to DB
      expect(finalized.dbSummary.dbDerivedFindingCount).toBe(2);
      // Review tasks created for each finding
      expect(finalized.dbSummary.dbDerivedReviewTaskCount).toBe(2);
      // Worker assignments may be 0 (none created yet)
      expect(typeof finalized.dbSummary.dbDerivedAssignmentCount).toBe('number');
    });

    it('returns dbSummary with judgeRunId=null when no findings submitted', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });
      const finalized = await service.finalizeOrchestration(session.sessionId, 'nothing found') as any;

      expect(finalized.dbSummary).toBeDefined();
      expect(finalized.dbSummary.judgeRunId).toBeNull();
      expect(finalized.dbSummary.dbDerivedFindingCount).toBe(0);
    });

    it('dbSummary includes dbDerivedHumanReviewCount derived from DB (not local count)', async () => {
      const session = await service.beginOrchestration({ scope: 'workflow' });

      // Submit one code_fix finding — always requires human review
      const findings: AgentFindingInput[] = [
        {
          classification: 'code_defect',
          fixType: 'code_fix',
          severity: 'error',
          risk: 'high',
          confidence: 0.9,
        },
        {
          classification: 'stale_context',
          fixType: 'curated_context_edit',
          severity: 'info',
          risk: 'low',
          confidence: 0.9,
        },
      ];

      await service.submitFindings(session.sessionId, findings, testConfig);
      const finalized = await service.finalizeOrchestration(session.sessionId, 'done with human gates') as any;

      expect(finalized.dbSummary.dbDerivedFindingCount).toBe(2);
      expect(finalized.dbSummary.dbDerivedReviewTaskCount).toBe(2);
      // code_fix requires human review — DB count must be > 0
      expect(finalized.dbSummary.dbDerivedHumanReviewCount).toBeGreaterThan(0);
      // Auto-remediation count is the remainder
      expect(finalized.dbSummary.dbDerivedAutoRemediationCount).toBe(
        finalized.dbSummary.dbDerivedReviewTaskCount - finalized.dbSummary.dbDerivedHumanReviewCount,
      );
    });
  });
});

// ─── D: Run scope vs impact scope — repo run with per-finding impactScope ─────
// A repo-scoped run with impactScope='repo' on findings must NOT trigger the
// global/cross-repo mandatory human-review gate.
// A repo-scoped run with impactScope='global' on findings MUST trigger the gate.
