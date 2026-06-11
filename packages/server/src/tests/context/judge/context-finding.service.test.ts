// Tests for ContextFindingService — AC-05, AC-06, AC-07, AC-08, AC-18, AC-20
// Uses MongoMemoryServer for in-memory MongoDB isolation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContextFindingService } from '../../../services/context/judge/context-finding.service.js';
import type { CreateFindingInput } from '../../../services/context/judge/context-finding.service.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let service: ContextFindingService;

// Minimal valid finding input that can be overridden per test
const baseFinding: CreateFindingInput = {
  judgeRunId: 'run-base',
  scope: 'workflow',
  classification: 'missing_context',
  fixType: 'curated_context_create',
  severity: 'warn',
  risk: 'low',
  confidence: 0.75,
  reliabilityLabel: 'needs_judge',
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('test-findings');
  service = new ContextFindingService(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('context_findings').deleteMany({});
});

// ─── AC-08: Create finding with all required fields ───────────────────────────

describe('AC-08: create finding with all required fields', () => {
  it('creates a finding and returns it with a UUID findingId', async () => {
    const finding = await service.create(baseFinding);

    expect(finding.findingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('status is "open" and active is true on creation', async () => {
    const finding = await service.create(baseFinding);
    expect(finding.status).toBe('open');
    expect(finding.active).toBe(true);
  });

  it('all input fields are reflected in the returned finding', async () => {
    const finding = await service.create({
      judgeRunId: 'run-001',
      scope: 'node',
      repoId: 'repo-abc',
      sourceId: 'exec-xyz',
      classification: 'wrong_context',
      fixType: 'curated_context_edit',
      severity: 'error',
      risk: 'medium',
      confidence: 0.88,
      reliabilityLabel: 'confirmed',
      evidence: [{ kind: 'text', snippet: 'Wrong context injected' }],
      suggestedRemediation: 'Archive the stale context entry',
    });

    expect(finding.judgeRunId).toBe('run-001');
    expect(finding.scope).toBe('node');
    expect(finding.repoId).toBe('repo-abc');
    expect(finding.sourceId).toBe('exec-xyz');
    expect(finding.classification).toBe('wrong_context');
    expect(finding.fixType).toBe('curated_context_edit');
    expect(finding.severity).toBe('error');
    expect(finding.risk).toBe('medium');
    expect(finding.confidence).toBe(0.88);
    expect(finding.reliabilityLabel).toBe('confirmed');
    expect(finding.evidence).toHaveLength(1);
    expect(finding.suggestedRemediation).toBe('Archive the stale context entry');
  });

  it('evidence defaults to empty array when not provided', async () => {
    const finding = await service.create(baseFinding);
    expect(finding.evidence).toEqual([]);
  });

  it('finding is retrievable by getById', async () => {
    const created = await service.create(baseFinding);
    const fetched = await service.getById(created.findingId);
    expect(fetched).not.toBeNull();
    expect(fetched!.findingId).toBe(created.findingId);
  });

  it('getById returns null for unknown id', async () => {
    const result = await service.getById('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('version starts at 1', async () => {
    const finding = await service.create(baseFinding);
    expect(finding.version).toBe(1);
  });

  it('timestamps are set on creation', async () => {
    const finding = await service.create(baseFinding);
    expect(finding.createdAt).toBeInstanceOf(Date);
    expect(finding.updatedAt).toBeInstanceOf(Date);
    expect(finding.validFrom).toBeInstanceOf(Date);
  });
});

// ─── AC-06: All 8 scope values ────────────────────────────────────────────────

describe('AC-06: all 8 scope values', () => {
  const allScopes = [
    'workflow',
    'node',
    'chat_turn',
    'spawned_agent',
    'learning',
    'cross_repo',
    'global',
    'user_preference',
  ] as const;

  for (const scope of allScopes) {
    it(`scope="${scope}" → creates and lists correctly`, async () => {
      await service.create({ ...baseFinding, scope, judgeRunId: `run-${scope}` });

      const results = await service.list({ scope });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((f) => f.scope === scope)).toBe(true);
    });
  }
});

// ─── AC-07: Learning linkage ──────────────────────────────────────────────────

describe('AC-07: learning linkage', () => {
  it('create with learningId → stored finding has learningId', async () => {
    const finding = await service.create({
      ...baseFinding,
      learningId: 'learn-abc',
      judgeRunId: 'run-learn',
    });
    expect(finding.learningId).toBe('learn-abc');
  });

  it('list with learningId filter → returns the finding', async () => {
    await service.create({ ...baseFinding, learningId: 'learn-xyz', judgeRunId: 'run-learn2' });
    const results = await service.list({ learningId: 'learn-xyz' });
    expect(results).toHaveLength(1);
    expect(results[0].learningId).toBe('learn-xyz');
  });

  it('list without learningId filter → also returns learning-linked finding', async () => {
    await service.create({ ...baseFinding, learningId: 'learn-no-filter', judgeRunId: 'run-l3' });
    const all = await service.list({});
    const found = all.find((f) => f.learningId === 'learn-no-filter');
    expect(found).toBeDefined();
  });

  it('learningId filter is specific — different learningId is excluded', async () => {
    await service.create({ ...baseFinding, learningId: 'learn-a', judgeRunId: 'run-la' });
    await service.create({ ...baseFinding, learningId: 'learn-b', judgeRunId: 'run-lb' });

    const results = await service.list({ learningId: 'learn-a' });
    expect(results.every((f) => f.learningId === 'learn-a')).toBe(true);
  });
});

// ─── AC-05: All 4 reliability labels ─────────────────────────────────────────

describe('AC-05: all 4 reliability labels', () => {
  const labels = ['signal_only', 'needs_judge', 'confirmed', 'rejected'] as const;

  for (const label of labels) {
    it(`reliabilityLabel="${label}" → list filter returns correct subset`, async () => {
      await service.create({
        ...baseFinding,
        reliabilityLabel: label,
        judgeRunId: `run-label-${label}`,
      });

      const results = await service.list({ reliabilityLabel: label });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((f) => f.reliabilityLabel === label)).toBe(true);
    });
  }
});

// ─── Update finding ───────────────────────────────────────────────────────────

describe('update finding', () => {
  it('updates status to "in_review" and getById reflects the change', async () => {
    const finding = await service.create(baseFinding);
    const updated = await service.update(finding.findingId, { status: 'in_review' });
    expect(updated).toBe(true);

    const fetched = await service.getById(finding.findingId);
    expect(fetched!.status).toBe('in_review');
  });

  it('update on non-existent findingId returns false', async () => {
    const result = await service.update('00000000-0000-0000-0000-000000000000', {
      status: 'in_review',
    });
    expect(result).toBe(false);
  });

  it('update sets updatedAt to a new date', async () => {
    const finding = await service.create(baseFinding);
    const originalUpdatedAt = finding.updatedAt;

    // Small wait to ensure Date difference
    await new Promise((r) => setTimeout(r, 5));

    await service.update(finding.findingId, { status: 'in_review' });
    const fetched = await service.getById(finding.findingId);
    expect(fetched!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('can update suggestedRemediation', async () => {
    const finding = await service.create(baseFinding);
    await service.update(finding.findingId, { suggestedRemediation: 'Do X instead of Y' });
    const fetched = await service.getById(finding.findingId);
    expect(fetched!.suggestedRemediation).toBe('Do X instead of Y');
  });
});

// ─── AC-20: Supersession preserves history ────────────────────────────────────

describe('AC-20: supersession preserves history', () => {
  it('supersede() sets active=false, status="superseded", supersededAt, supersededBy on old finding', async () => {
    const findingA = await service.create({ ...baseFinding, judgeRunId: 'run-super-a' });
    const findingB = await service.create({ ...baseFinding, judgeRunId: 'run-super-b' });

    const result = await service.supersede(findingA.findingId, findingB.findingId);
    expect(result).toBe(true);

    const updatedA = await service.getById(findingA.findingId);
    expect(updatedA!.active).toBe(false);
    expect(updatedA!.status).toBe('superseded');
    expect(updatedA!.supersededAt).toBeInstanceOf(Date);
    expect(updatedA!.supersededBy).toBe(findingB.findingId);
  });

  it('supersede() sets validTo on old finding', async () => {
    const findingA = await service.create({ ...baseFinding, judgeRunId: 'run-super-c' });
    const findingB = await service.create({ ...baseFinding, judgeRunId: 'run-super-d' });

    await service.supersede(findingA.findingId, findingB.findingId);

    const updatedA = await service.getById(findingA.findingId);
    expect(updatedA!.validTo).toBeInstanceOf(Date);
  });

  it('history is preserved — old finding still retrievable after supersession', async () => {
    const findingA = await service.create({ ...baseFinding, judgeRunId: 'run-history-1' });
    const findingB = await service.create({ ...baseFinding, judgeRunId: 'run-history-2' });
    await service.supersede(findingA.findingId, findingB.findingId);

    const fetched = await service.getById(findingA.findingId);
    expect(fetched).not.toBeNull();
    expect(fetched!.findingId).toBe(findingA.findingId);
  });

  it('supersede() on non-existent findingId returns false', async () => {
    const result = await service.supersede(
      '00000000-0000-0000-0000-000000000000',
      'some-new-id',
    );
    expect(result).toBe(false);
  });

  it('supersede() on already-inactive finding returns false', async () => {
    const findingA = await service.create({ ...baseFinding, judgeRunId: 'run-inactive-1' });
    const findingB = await service.create({ ...baseFinding, judgeRunId: 'run-inactive-2' });

    // First supersession — should succeed
    await service.supersede(findingA.findingId, findingB.findingId);

    // Second supersession of already-inactive finding — should return false
    const result = await service.supersede(findingA.findingId, 'yet-another-id');
    expect(result).toBe(false);
  });
});

// ─── AC-18: Routing decisions ─────────────────────────────────────────────────

describe('AC-18: routing decisions — mandatory human review conditions', () => {
  it('low confidence (0.3) → requiresHumanReview=true, reason="low_confidence"', () => {
    const decision = service.routingDecision({
      confidence: 0.3,
      risk: 'low',
      scope: 'workflow',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reason).toBe('low_confidence');
    expect(decision.autoRemediationAllowed).toBe(false);
  });

  it('confidence below auto-curation threshold (0.5) → requiresHumanReview=true, reason="low_confidence"', () => {
    const decision = service.routingDecision({
      confidence: 0.5,
      risk: 'low',
      scope: 'workflow',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reason).toBe('low_confidence');
    expect(decision.autoRemediationAllowed).toBe(false);
  });

  it('high risk → requiresHumanReview=true, reason="high_risk"', () => {
    const decision = service.routingDecision({
      confidence: 0.9,
      risk: 'high',
      scope: 'workflow',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reason).toBe('high_risk');
    expect(decision.autoRemediationAllowed).toBe(false);
  });

  it('critical risk → requiresHumanReview=true, reason="high_risk"', () => {
    const decision = service.routingDecision({
      confidence: 0.9,
      risk: 'critical',
      scope: 'workflow',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reason).toBe('high_risk');
  });

  it('cross_repo impactScope → requiresHumanReview=true, reason="cross_repo_or_global_impact"', () => {
    const decision = service.routingDecision({
      confidence: 0.9,
      risk: 'low',
      scope: 'workflow',
      impactScope: 'cross_repo',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reason).toBe('cross_repo_or_global_impact');
    expect(decision.autoRemediationAllowed).toBe(false);
  });

  it('global impactScope → requiresHumanReview=true, reason="cross_repo_or_global_impact"', () => {
    const decision = service.routingDecision({
      confidence: 0.9,
      risk: 'low',
      scope: 'workflow',
      impactScope: 'global',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reason).toBe('cross_repo_or_global_impact');
  });

  it('cross_repo run scope alone does not force human review without cross_repo impactScope', () => {
    const decision = service.routingDecision({
      confidence: 0.9,
      risk: 'low',
      scope: 'cross_repo',
      impactScope: 'repo',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(false);
    expect(decision.autoRemediationAllowed).toBe(true);
  });

  it('learningId present does not force review by itself when confidence/risk/fix gates are clear', () => {
    const decision = service.routingDecision({
      confidence: 0.9,
      risk: 'low',
      scope: 'workflow',
      fixType: 'curated_context_edit',
      learningId: 'some-learning-id',
    });
    expect(decision.requiresHumanReview).toBe(false);
    expect(decision.reason).toBeUndefined();
    expect(decision.autoRemediationAllowed).toBe(true);
  });

  it('fixType="code_fix" → requiresHumanReview=true, reason="code_fix"', () => {
    const decision = service.routingDecision({
      confidence: 0.9,
      risk: 'low',
      scope: 'workflow',
      fixType: 'code_fix',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reason).toBe('code_fix');
    expect(decision.autoRemediationAllowed).toBe(false);
  });

  it('all conditions clear → autoRemediationAllowed=true, requiresHumanReview=false', () => {
    const decision = service.routingDecision({
      confidence: 0.9,
      risk: 'low',
      scope: 'workflow',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(false);
    expect(decision.autoRemediationAllowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it('medium risk + high confidence + workflow scope + no learningId → autoRemediationAllowed=true', () => {
    const decision = service.routingDecision({
      confidence: 0.85,
      risk: 'medium',
      scope: 'node',
      fixType: 'curated_context_archive',
      learningId: undefined,
    });
    expect(decision.requiresHumanReview).toBe(false);
    expect(decision.autoRemediationAllowed).toBe(true);
  });

  it('routing checks priority: low confidence checked before risk', () => {
    // Even if risk is high, low confidence is checked first
    const decision = service.routingDecision({
      confidence: 0.1,   // triggers low_confidence
      risk: 'high',      // would also trigger high_risk
      scope: 'workflow',
      fixType: 'curated_context_edit',
      learningId: undefined,
    });
    expect(decision.reason).toBe('low_confidence');
  });
});

// ─── List pagination ───────────────────────────────────────────────────────────

describe('list pagination', () => {
  it('limit=2 returns only 2 results from 3 findings', async () => {
    await service.create({ ...baseFinding, judgeRunId: 'run-p1' });
    await service.create({ ...baseFinding, judgeRunId: 'run-p2' });
    await service.create({ ...baseFinding, judgeRunId: 'run-p3' });

    const page1 = await service.list({ limit: 2 });
    expect(page1).toHaveLength(2);
  });

  it('offset=2, limit=10 returns the remaining 1 result', async () => {
    await service.create({ ...baseFinding, judgeRunId: 'run-p4' });
    await service.create({ ...baseFinding, judgeRunId: 'run-p5' });
    await service.create({ ...baseFinding, judgeRunId: 'run-p6' });

    const page2 = await service.list({ offset: 2, limit: 10 });
    expect(page2).toHaveLength(1);
  });

  it('list with no filters returns all findings', async () => {
    await service.create({ ...baseFinding, judgeRunId: 'run-all-1' });
    await service.create({ ...baseFinding, judgeRunId: 'run-all-2' });

    const all = await service.list({});
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('list with active=true only returns active findings', async () => {
    const fa = await service.create({ ...baseFinding, judgeRunId: 'run-act-a' });
    const fb = await service.create({ ...baseFinding, judgeRunId: 'run-act-b' });
    await service.supersede(fa.findingId, fb.findingId);

    const active = await service.list({ active: true });
    const ids = active.map((f) => f.findingId);
    expect(ids).not.toContain(fa.findingId);
    expect(ids).toContain(fb.findingId);
  });
});
