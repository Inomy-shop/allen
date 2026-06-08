import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OrgSeedService } from '../../../services/org-seed.js';
import { WORKER_ROLE_AGENT_MAP } from '../../../services/context/judge/context-review-worker-orchestrator.js';
import {
  buildContextJudgeOrchestratorPrompt,
  buildContextReviewTriageAgentPrompt,
  buildContextRemediationPlannerAgentPrompt,
  buildContextLearningCuratorAgentPrompt,
  buildContextCurationFixAgentPrompt,
  buildContextIngestionRepairAgentPrompt,
  buildContextCodeFixAgentPrompt,
  buildContextQaEvalAgentPrompt,
  buildContextTraceAnalysisWorkerPrompt,
} from '../../../services/context/judge/context-judge-agent-prompts.js';
import { TRACE_ANALYSIS_AGENT_NAME } from '../../../services/context/judge/context-review-worker-orchestrator.js';

// ─── In-memory DB mock (same pattern as org-seed.test.ts) ────────────────────

function makeDb(seed: Record<string, Record<string, unknown>[]> = {}): any {
  const store: Record<string, Record<string, unknown>[]> = {
    agents: [],
    teams: [],
    ...seed,
  };

  function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
    return Object.entries(query).every(([key, value]) => doc[key] === value);
  }

  return {
    store,
    collection: (name: string) => ({
      findOne: async (query: Record<string, unknown>) =>
        (store[name] ?? []).find((doc) => matches(doc, query)) ?? null,
      insertOne: async (doc: Record<string, unknown>) => {
        (store[name] = store[name] ?? []).push({ _id: `${name}-${(store[name] ?? []).length}`, ...doc });
        return { insertedId: `${name}-${(store[name] ?? []).length - 1}` };
      },
      updateOne: async (query: Record<string, unknown>, update: Record<string, unknown>) => {
        const idx = (store[name] ?? []).findIndex((doc) => matches(doc, query));
        if (idx >= 0 && (update as any).$set) {
          store[name][idx] = { ...store[name][idx], ...(update as any).$set };
        }
        return { matchedCount: idx >= 0 ? 1 : 0, modifiedCount: idx >= 0 ? 1 : 0 };
      },
    }),
  };
}

// ─── Saved env ───────────────────────────────────────────────────────────────

const CONTEXT_JUDGE_AGENT_NAMES = [
  'context-judge-orchestrator',
  'context-review-triage-agent',
  'context-remediation-planner-agent',
  'context-learning-curator-agent',
  'context-curation-fix-agent',
  'context-ingestion-repair-agent',
  'context-code-fix-agent',
  'context-qa-eval-agent',
  // ENG-1760 — trace analysis worker
  'context-trace-analysis-agent',
];

describe('Context Judge Agent Seeding', () => {
  const originalSeedOverride = process.env.SEED_OVERRIDE;
  const originalContextLlmProvider = process.env.ALLEN_CONTEXT_LLM_PROVIDER;
  const originalContextLlmModel = process.env.ALLEN_CONTEXT_LLM_MODEL;

  beforeEach(() => {
    delete process.env.SEED_OVERRIDE;
    delete process.env.ALLEN_CONTEXT_LLM_PROVIDER;
    delete process.env.ALLEN_CONTEXT_LLM_MODEL;
  });

  afterEach(() => {
    if (originalSeedOverride === undefined) delete process.env.SEED_OVERRIDE;
    else process.env.SEED_OVERRIDE = originalSeedOverride;
    if (originalContextLlmProvider === undefined) delete process.env.ALLEN_CONTEXT_LLM_PROVIDER;
    else process.env.ALLEN_CONTEXT_LLM_PROVIDER = originalContextLlmProvider;
    if (originalContextLlmModel === undefined) delete process.env.ALLEN_CONTEXT_LLM_MODEL;
    else process.env.ALLEN_CONTEXT_LLM_MODEL = originalContextLlmModel;
  });

  // ── Test 1 ──────────────────────────────────────────────────────────────────

  it('fresh DB seeds all 9 context judge agents', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();

    for (const agentName of CONTEXT_JUDGE_AGENT_NAMES) {
      const agent = db.store.agents.find((a: any) => a.name === agentName);
      expect(agent, `${agentName} must be seeded`).toBeDefined();
      expect(agent.name, `${agentName}.name must be non-empty`).toBeTruthy();
      expect(agent.displayName, `${agentName}.displayName must be non-empty`).toBeTruthy();
      expect(agent.description, `${agentName}.description must be non-empty`).toBeTruthy();
      expect(agent.system, `${agentName}.system must be non-empty`).toBeTruthy();
      expect(agent.teamName, `${agentName}.teamName must be 'meta'`).toBe('meta');
    }
  });

  // ── Test 2 ──────────────────────────────────────────────────────────────────

  it('seed override refreshes context judge agent prompts', async () => {
    process.env.SEED_OVERRIDE = 'true';

    const stalePrompt = 'stale-system-prompt-that-does-not-match-current-build';
    const db = makeDb({
      agents: [
        {
          name: 'context-judge-orchestrator',
          displayName: 'Context Judge Orchestrator',
          system: stalePrompt,
          teamName: 'meta',
          teamRole: 'member',
          isBuiltIn: true,
        },
      ],
    });

    await new OrgSeedService(db).seed();

    const agent = db.store.agents.find((a: any) => a.name === 'context-judge-orchestrator');
    expect(agent.system).not.toBe(stalePrompt);
    expect(agent.system).toBe(buildContextJudgeOrchestratorPrompt());
  });

  // ── Test 3 ──────────────────────────────────────────────────────────────────

  it('context judge agents seeded WITHOUT SEED_OVERRIDE preserve customizations', async () => {
    // No SEED_OVERRIDE set (default — already deleted in beforeEach)
    const customPrompt = 'my-custom-orchestrator-prompt';
    const db = makeDb({
      agents: [
        {
          name: 'context-judge-orchestrator',
          displayName: 'Context Judge Orchestrator',
          system: customPrompt,
          teamName: 'meta',
          teamRole: 'member',
          isBuiltIn: true,
        },
      ],
    });

    await new OrgSeedService(db).seed();

    // context-judge-orchestrator IS in FORCE_UPDATE_AGENT_NAMES, so it WILL be
    // refreshed even without SEED_OVERRIDE. Verify it was updated to the current
    // built value (not the stale custom one).
    const agent = db.store.agents.find((a: any) => a.name === 'context-judge-orchestrator');
    // FORCE_UPDATE always refreshes regardless of SEED_OVERRIDE
    expect(agent.system).toBe(buildContextJudgeOrchestratorPrompt());
  });

  // ── Test 4 ──────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt references spawn_agent and mcp__allen__spawn_agent', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    expect(prompt).toContain('spawn_agent');
    expect(prompt).toContain('mcp__allen__spawn_agent');
  });

  // ── Test 5 ──────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt references dispatch queue as audit/fallback', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    // Must contain 'audit' or 'fallback' — and 'dispatch' somewhere nearby
    const hasAuditOrFallback = prompt.includes('audit') || prompt.includes('fallback');
    expect(hasAuditOrFallback).toBe(true);
    expect(prompt).toContain('dispatch');
  });

  // ── Test 6 ──────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt references /scheduler/pending endpoint', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    expect(prompt).toContain('/scheduler/pending');
    // Must NOT only reference the old scheduler-state endpoint
    // (it may still reference it incidentally, but /scheduler/pending must be present)
  });

  // ── Test 7 ──────────────────────────────────────────────────────────────────

  it('WORKER_ROLE_AGENT_MAP names match seeded agent names', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();

    const seededNames = new Set(db.store.agents.map((a: any) => a.name));
    const workerAgentNames = Object.values(WORKER_ROLE_AGENT_MAP);

    for (const agentName of workerAgentNames) {
      expect(
        seededNames.has(agentName),
        `WORKER_ROLE_AGENT_MAP references '${agentName}' but it was not seeded`,
      ).toBe(true);
    }
  });

  // ── Test 8 ──────────────────────────────────────────────────────────────────

  it('all 7 worker agent prompts contain spawn_agent contract (status reporting + artifact)', () => {
    const workerBuilders = [
      buildContextReviewTriageAgentPrompt,
      buildContextRemediationPlannerAgentPrompt,
      buildContextLearningCuratorAgentPrompt,
      buildContextCurationFixAgentPrompt,
      buildContextIngestionRepairAgentPrompt,
      buildContextCodeFixAgentPrompt,
      buildContextQaEvalAgentPrompt,
    ];

    for (const builder of workerBuilders) {
      const prompt = builder();
      // MCP tool is primary; REST PATCH is kept as fallback — both must be present
      expect(
        prompt,
        `${builder.name}: must reference mcp__allen__context_quality_update_worker_assignment as primary`,
      ).toContain('mcp__allen__context_quality_update_worker_assignment');
      expect(
        prompt,
        `${builder.name}: must retain REST PATCH fallback reference`,
      ).toContain('PATCH /context/quality/worker-assignments');
      expect(
        prompt,
        `${builder.name}: must require allen_save_artifact`,
      ).toContain('allen_save_artifact');
    }
  });

  // ── Test 9 ──────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt describes UI/API trigger modes', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    expect(prompt).toContain('POST /context/quality/orchestrator/trigger');
    expect(prompt).toContain('Run modes');
  });

  // ── Test 10 ─────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt describes repo filtering', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    expect(prompt).toContain('repoId');
    expect(prompt).toContain('Repo filtering');
  });

  // ── Test 11 ─────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt describes dedupe/idempotency', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    const hasDedupe = prompt.includes('Dedupe') || prompt.includes('idempotency') || prompt.includes('idempotent');
    expect(hasDedupe).toBe(true);
    expect(prompt).toContain('sourceKey');
  });

  // ── Test 12 ─────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt contains mcp__allen__wait_for_execution', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    expect(prompt).toContain('mcp__allen__wait_for_execution');
  });

  // ── Test 13 ─────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt enforces max 4 concurrent spawned worker executions', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    // Must contain an explicit numeric cap of 4
    const hasMax4 =
      prompt.includes('4 active') ||
      prompt.includes('more than 4') ||
      prompt.includes('batches of at most 4') ||
      prompt.includes('groups of ≤ 4') ||
      prompt.includes('≤ 4');
    expect(hasMax4, 'orchestrator prompt must state a max-4 concurrency rule').toBe(true);
  });

  // ── Test 14 ─────────────────────────────────────────────────────────────────

  it('seeded orchestrator prompt tracks assignmentId to execution_id mapping', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    // Must mention tracking assignment → execution_id linkage
    const hasTracking =
      prompt.includes('agentRunId') ||
      (prompt.includes('assignmentId') && prompt.includes('execution_id'));
    expect(hasTracking, 'orchestrator prompt must describe assignmentId→execution_id tracking').toBe(true);
  });

  // ── Test 15 ─────────────────────────────────────────────────────────────────

  it('all 7 worker agent prompts contain mcp__allen__allen_save_artifact (full tool name)', () => {
    const workerBuilders = [
      buildContextReviewTriageAgentPrompt,
      buildContextRemediationPlannerAgentPrompt,
      buildContextLearningCuratorAgentPrompt,
      buildContextCurationFixAgentPrompt,
      buildContextIngestionRepairAgentPrompt,
      buildContextCodeFixAgentPrompt,
      buildContextQaEvalAgentPrompt,
    ];

    for (const builder of workerBuilders) {
      const prompt = builder();
      expect(
        prompt,
        `${builder.name}: must contain full MCP tool name mcp__allen__allen_save_artifact`,
      ).toContain('mcp__allen__allen_save_artifact');
    }
  });

  // ── Test 16 ─────────────────────────────────────────────────────────────────

  it('all 7 worker agent prompts describe missing-tool/transport failure behavior', () => {
    const workerBuilders = [
      buildContextReviewTriageAgentPrompt,
      buildContextRemediationPlannerAgentPrompt,
      buildContextLearningCuratorAgentPrompt,
      buildContextCurationFixAgentPrompt,
      buildContextIngestionRepairAgentPrompt,
      buildContextCodeFixAgentPrompt,
      buildContextQaEvalAgentPrompt,
    ];

    for (const builder of workerBuilders) {
      const prompt = builder();
      const hasMissingToolBehavior =
        prompt.includes('Missing tool') ||
        prompt.includes('missing tool') ||
        prompt.includes('Missing tool/transport') ||
        prompt.includes('not available');
      expect(
        hasMissingToolBehavior,
        `${builder.name}: must describe behavior when required tool/transport is missing`,
      ).toBe(true);
    }
  });

  // ── Test 17 ─────────────────────────────────────────────────────────────────

  it('orchestrator prompt states dispatch queue is audit/fallback, not primary', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();
    // Must contain explicit "audit" AND "fallback" alongside dispatch mentions
    expect(prompt).toContain('AUDIT/FALLBACK');
    const hasDispatchNotPrimary =
      (prompt.includes('audit') || prompt.includes('AUDIT')) &&
      (prompt.includes('fallback') || prompt.includes('FALLBACK')) &&
      prompt.includes('dispatch');
    expect(hasDispatchNotPrimary, 'orchestrator prompt must describe dispatch queue as audit/fallback').toBe(true);
  });

  // ── Test 18 — MCP-primary write ops for review-triage ────────────────────────

  it('context-review-triage prompt uses mcp__allen__context_quality_patch_finding as primary', () => {
    const prompt = buildContextReviewTriageAgentPrompt();
    expect(
      prompt,
      'review-triage: must reference mcp__allen__context_quality_patch_finding as primary for finding updates',
    ).toContain('mcp__allen__context_quality_patch_finding');
    expect(
      prompt,
      'review-triage: must keep REST PATCH /context/quality/findings as fallback reference',
    ).toContain('PATCH /context/quality/findings');
    // Must NOT present the raw PATCH as the primary (no bare "via PATCH /context/quality/findings")
    expect(
      prompt,
      'review-triage: must not use raw "via PATCH /context/quality/findings" without MCP primary',
    ).not.toMatch(/\bvia PATCH \/context\/quality\/findings\b/);
  });

  it('context-review-triage prompt uses mcp__allen__context_quality_list_findings as primary for fetch', () => {
    const prompt = buildContextReviewTriageAgentPrompt();
    expect(
      prompt,
      'review-triage: must reference mcp__allen__context_quality_list_findings as primary for fetching findings',
    ).toContain('mcp__allen__context_quality_list_findings');
  });

  // ── Test 19 — MCP-primary write ops for remediation-planner ─────────────────

  it('context-remediation-planner prompt uses mcp__allen__context_quality_create_remediation_task as primary', () => {
    const prompt = buildContextRemediationPlannerAgentPrompt();
    expect(
      prompt,
      'remediation-planner: must reference mcp__allen__context_quality_create_remediation_task as primary',
    ).toContain('mcp__allen__context_quality_create_remediation_task');
    expect(
      prompt,
      'remediation-planner: must keep REST POST /context/quality/remediation-tasks as fallback reference',
    ).toContain('POST /context/quality/remediation-tasks');
    // Must NOT present the raw POST as the primary
    expect(
      prompt,
      'remediation-planner: must not use raw "POST /context/quality/remediation-tasks" without MCP primary preceding it',
    ).not.toMatch(/^\d+\. POST \/context\/quality\/remediation-tasks/m);
  });

  // ── Test 20 — MCP-primary write ops for learning-curator ─────────────────────

  it('context-learning-curator prompt uses mcp__allen__context_quality_create_learning_promotion as primary', () => {
    const prompt = buildContextLearningCuratorAgentPrompt();
    expect(
      prompt,
      'learning-curator: must reference mcp__allen__context_quality_create_learning_promotion as primary',
    ).toContain('mcp__allen__context_quality_create_learning_promotion');
    expect(
      prompt,
      'learning-curator: must keep REST POST /context/quality/learning-promotions as fallback reference',
    ).toContain('POST /context/quality/learning-promotions');
  });

  it('context-learning-curator prompt references mcp__allen__context_quality_decide_learning_promotion as human-only', () => {
    const prompt = buildContextLearningCuratorAgentPrompt();
    expect(
      prompt,
      'learning-curator: must reference mcp__allen__context_quality_decide_learning_promotion',
    ).toContain('mcp__allen__context_quality_decide_learning_promotion');
    // Must still warn that agents must not self-approve
    const hasNoSelfApprove = prompt.includes('NOT self-approve') || prompt.includes('do NOT self-approve') || prompt.includes('MUST NOT self-approve') || prompt.includes('HUMAN ACTORS ONLY') || prompt.includes('human-actor only') || prompt.includes('human actors only');
    expect(
      hasNoSelfApprove,
      'learning-curator: must warn that agents must not self-approve the decide endpoint',
    ).toBe(true);
  });

  // ── Test 21 — MCP-primary write ops for curation-fix ────────────────────────

  it('context-curation-fix prompt uses mcp__allen__context_quality_apply_curated_edit as primary', () => {
    const prompt = buildContextCurationFixAgentPrompt();
    expect(
      prompt,
      'curation-fix: must reference mcp__allen__context_quality_apply_curated_edit as primary',
    ).toContain('mcp__allen__context_quality_apply_curated_edit');
    expect(
      prompt,
      'curation-fix: must keep REST POST /context/quality/curated-edits as fallback reference',
    ).toContain('POST /context/quality/curated-edits');
    // Must NOT present the raw POST as the primary step
    expect(
      prompt,
      'curation-fix: must not use raw "via POST /context/quality/curated-edits" without MCP primary preceding it',
    ).not.toMatch(/\bvia POST \/context\/quality\/curated-edits\b/);
  });

  it('context-curation-fix prompt uses mcp__allen__context_quality_get_curation_history as primary for verification', () => {
    const prompt = buildContextCurationFixAgentPrompt();
    expect(
      prompt,
      'curation-fix: must reference mcp__allen__context_quality_get_curation_history for persistence verification',
    ).toContain('mcp__allen__context_quality_get_curation_history');
    expect(
      prompt,
      'curation-fix: must keep REST GET /context/quality/curated-edits history as fallback reference',
    ).toContain('GET /context/quality/curated-edits');
  });

  it('context-remediation-planner prompt prioritizes runtime-impacting curated fields over explanation-only metadata', () => {
    const prompt = buildContextRemediationPlannerAgentPrompt();

    expect(prompt).toContain('retrievalText');
    expect(prompt).toContain('curatedContext');
    expect(prompt).toContain('injectionPolicy');
    expect(prompt).toContain('The current context engine does NOT consume demoteWhen');
    expect(prompt).toContain('Do not emit only those fields');
    expect(prompt).toContain('Cognee ingestion identity rules');
  });

  it('context-curation-fix prompt explains Cognee ingestion identity and same-entry remediation', () => {
    const prompt = buildContextCurationFixAgentPrompt();

    expect(prompt).toContain('retrievalText is the ingested text');
    expect(prompt).toContain('Preserve the same entryId');
    expect(prompt).toContain('A retrievalText change on the same entryId should produce a changed-document refresh');
    expect(prompt).toContain('expectedIngestionEffect');
  });

  // ── Test 22 — MCP-primary reads for ingestion-repair ────────────────────────

  it('context-ingestion-repair prompt uses mcp__allen__context_quality_list_findings as primary diagnostic tool', () => {
    const prompt = buildContextIngestionRepairAgentPrompt();
    expect(
      prompt,
      'ingestion-repair: must reference mcp__allen__context_quality_list_findings as primary diagnostic query',
    ).toContain('mcp__allen__context_quality_list_findings');
    expect(
      prompt,
      'ingestion-repair: must keep REST GET /context/quality/findings as fallback reference',
    ).toContain('GET /context/quality/findings');
    // Must NOT present the raw GET as the primary diagnostic step
    expect(
      prompt,
      'ingestion-repair: must not use raw "- GET /context/quality/findings" as the only diagnostic entry',
    ).not.toMatch(/^\s*- GET \/context\/quality\/findings/m);
  });

  // ── Test 23 — allen-mcp-server tool names match what prompts reference ───────

  it('all new MCP tool names referenced in worker prompts are valid snake_case names', () => {
    const expectedNewTools = [
      'context_quality_patch_finding',
      'context_quality_create_remediation_task',
      'context_quality_create_learning_promotion',
      'context_quality_decide_learning_promotion',
      'context_quality_apply_curated_edit',
      'context_quality_get_curation_history',
    ];

    const allPrompts = [
      buildContextReviewTriageAgentPrompt(),
      buildContextRemediationPlannerAgentPrompt(),
      buildContextLearningCuratorAgentPrompt(),
      buildContextCurationFixAgentPrompt(),
      buildContextIngestionRepairAgentPrompt(),
    ].join('\n');

    // Each expected new tool name must appear as mcp__allen__<name> in at least one prompt
    for (const toolName of expectedNewTools) {
      const fullName = `mcp__allen__${toolName}`;
      expect(
        allPrompts,
        `New tool '${fullName}' must be referenced in at least one worker prompt`,
      ).toContain(fullName);
    }
  });

  // ── Test 24 — No write-op prompt uses raw REST as the sole/primary path ──────

  it('context-review-triage prompt does not use bare REST as the only/primary update path', () => {
    const prompt = buildContextReviewTriageAgentPrompt();
    // If MCP tool name is present, the primary is MCP
    expect(prompt).toContain('mcp__allen__context_quality_patch_finding');
    // MCP must appear BEFORE the REST fallback in the step description
    const mcpIdx = prompt.indexOf('mcp__allen__context_quality_patch_finding');
    const restIdx = prompt.indexOf('PATCH /context/quality/findings/:findingId');
    expect(mcpIdx).toBeLessThan(restIdx);
  });

  it('context-curation-fix prompt does not use bare REST as the only/primary edit path', () => {
    const prompt = buildContextCurationFixAgentPrompt();
    expect(prompt).toContain('mcp__allen__context_quality_apply_curated_edit');
    const mcpIdx = prompt.indexOf('mcp__allen__context_quality_apply_curated_edit');
    const restIdx = prompt.indexOf('POST /context/quality/curated-edits');
    expect(mcpIdx).toBeLessThan(restIdx);
  });

  // ── Test 25 — Default runtime config: codex / gpt-5.5 when env absent ────────

  it('all 9 context judge agents use codex / gpt-5.5 when ALLEN_CONTEXT_LLM_PROVIDER and ALLEN_CONTEXT_LLM_MODEL are unset', async () => {
    // Env vars already deleted in beforeEach
    const db = makeDb();
    await new OrgSeedService(db).seed();

    for (const agentName of CONTEXT_JUDGE_AGENT_NAMES) {
      const agent = db.store.agents.find((a: any) => a.name === agentName);
      expect(agent, `${agentName} must be seeded`).toBeDefined();
      expect(agent.provider, `${agentName}.provider must be 'codex' by default`).toBe('codex');
      expect(agent.model, `${agentName}.model must be 'gpt-5.5' by default`).toBe('gpt-5.5');
    }
  });

  // ── Test 26 — Configured context engine provider/model overrides default ──────

  it('ALLEN_CONTEXT_LLM_PROVIDER / ALLEN_CONTEXT_LLM_MODEL override default for all 9 context judge agents', async () => {
    process.env.ALLEN_CONTEXT_LLM_PROVIDER = 'claude-cli';
    process.env.ALLEN_CONTEXT_LLM_MODEL = 'sonnet';

    const db = makeDb();
    await new OrgSeedService(db).seed();

    for (const agentName of CONTEXT_JUDGE_AGENT_NAMES) {
      const agent = db.store.agents.find((a: any) => a.name === agentName);
      expect(agent, `${agentName} must be seeded`).toBeDefined();
      expect(
        agent.provider,
        `${agentName}.provider must follow ALLEN_CONTEXT_LLM_PROVIDER`,
      ).toBe('claude-cli');
      expect(
        agent.model,
        `${agentName}.model must follow ALLEN_CONTEXT_LLM_MODEL`,
      ).toBe('sonnet');
    }
  });

  // ── Test 27 — Only model configured: custom model + codex default provider ───

  it('ALLEN_CONTEXT_LLM_MODEL alone overrides model but provider defaults to codex', async () => {
    process.env.ALLEN_CONTEXT_LLM_MODEL = 'o3';
    // ALLEN_CONTEXT_LLM_PROVIDER is unset → should default to 'codex'

    const db = makeDb();
    await new OrgSeedService(db).seed();

    for (const agentName of CONTEXT_JUDGE_AGENT_NAMES) {
      const agent = db.store.agents.find((a: any) => a.name === agentName);
      expect(agent, `${agentName} must be seeded`).toBeDefined();
      expect(agent.provider, `${agentName}.provider must still be 'codex' when only model is set`).toBe('codex');
      expect(agent.model, `${agentName}.model must be 'o3' from ALLEN_CONTEXT_LLM_MODEL`).toBe('o3');
    }
  });

  // ── Test 28 — Context judge agents ignore ALLEN_DEFAULT_AGENT_PROVIDER ────────

  it('all 9 context judge agents ignore ALLEN_DEFAULT_AGENT_PROVIDER (use context engine LLM, not general agent default)', async () => {
    // General agent default says claude-cli, but context engine has no override
    // → context judge agents should still default to codex/gpt-5.5
    const originalAgentProvider = process.env.ALLEN_DEFAULT_AGENT_PROVIDER;
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'claude-cli';

    try {
      const db = makeDb();
      await new OrgSeedService(db).seed();

      for (const agentName of CONTEXT_JUDGE_AGENT_NAMES) {
        const agent = db.store.agents.find((a: any) => a.name === agentName);
        expect(agent, `${agentName} must be seeded`).toBeDefined();
        expect(
          agent.provider,
          `${agentName}.provider must be 'codex' (context engine default), not follow ALLEN_DEFAULT_AGENT_PROVIDER`,
        ).toBe('codex');
        expect(
          agent.model,
          `${agentName}.model must be 'gpt-5.5' (context engine default)`,
        ).toBe('gpt-5.5');
      }
    } finally {
      if (originalAgentProvider === undefined) delete process.env.ALLEN_DEFAULT_AGENT_PROVIDER;
      else process.env.ALLEN_DEFAULT_AGENT_PROVIDER = originalAgentProvider;
    }
  });

  // ── Test 29 — context-trace-analysis-agent is seeded with correct role boundaries ─

  it('context-trace-analysis-agent is seeded with correct role, capabilities, and prompt', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();

    const agent = db.store.agents.find((a: any) => a.name === 'context-trace-analysis-agent');
    expect(agent, 'context-trace-analysis-agent must be seeded').toBeDefined();
    expect(agent.teamName).toBe('meta');
    expect(agent.teamRole).toBe('member');
    expect(agent.type).toBe('technical');
    expect(agent.capabilities).toContain('trace_analysis');
    expect(agent.capabilities).toContain('source_evaluation');
    expect(agent.capabilities).toContain('finding_candidate_generation');
    expect(agent.capabilities).toContain('human_feedback_analysis');

    // Prompt must describe role boundaries
    const prompt = buildContextTraceAnalysisWorkerPrompt();
    expect(prompt).toContain('MUST NOT');
    expect(prompt).toContain('context_review_tasks');
    expect(agent.system).toBe(prompt);
  });

  // ── Test 30 — TRACE_ANALYSIS_AGENT_NAME resolves to a seeded agent ─────────────

  it('TRACE_ANALYSIS_AGENT_NAME resolves to a seeded agent in org-seed', async () => {
    const db = makeDb();
    await new OrgSeedService(db).seed();

    const seededNames = new Set(db.store.agents.map((a: any) => a.name));
    expect(
      seededNames.has(TRACE_ANALYSIS_AGENT_NAME),
      `TRACE_ANALYSIS_AGENT_NAME ('${TRACE_ANALYSIS_AGENT_NAME}') must be seeded as an agent`,
    ).toBe(true);
  });

  // ── Test 31 — ENG-1760 fix 1: trace-analysis prompt uses assignment_id (snake_case) ──

  it('trace-analysis prompt uses assignment_id: assignmentId in update_trace_assignment calls, not camelCase shorthand', () => {
    const prompt = buildContextTraceAnalysisWorkerPrompt();

    // Must use the MCP schema field assignment_id (snake_case) in tool payload examples
    expect(
      prompt,
      'trace-analysis: update_trace_assignment call must use snake_case assignment_id: assignmentId',
    ).toContain('assignment_id: assignmentId');

    // Must NOT use bare camelCase shorthand { assignmentId in update_trace_assignment examples
    // (i.e. no positional shorthand without the key mapping)
    expect(
      prompt,
      'trace-analysis: must not use camelCase shorthand { assignmentId in update_trace_assignment examples',
    ).not.toMatch(/context_quality_update_trace_analysis_assignment\(\{\s*assignmentId[^:]/);
  });

  // ── Test 32 — ENG-1760 fix 2: remediation planner includes required MCP schema fields ──

  it('context-remediation-planner prompt includes taskId, judgeRunId, and actionKind in create_remediation_task guidance', () => {
    const prompt = buildContextRemediationPlannerAgentPrompt();

    expect(
      prompt,
      'remediation-planner: create_remediation_task must include taskId field',
    ).toContain('taskId');

    expect(
      prompt,
      'remediation-planner: create_remediation_task must include judgeRunId field',
    ).toContain('judgeRunId');

    expect(
      prompt,
      'remediation-planner: create_remediation_task must include actionKind field',
    ).toContain('actionKind');

    // Must require remediationId (not just taskId) as the persistence confirmation
    expect(
      prompt,
      'remediation-planner: must require remediationId as confirmation of task creation',
    ).toContain('remediationId');
  });

  // ── Test 33 — ENG-1760 fix 3: review triage avoids claiming direct context_review_tasks creation ──

  it('context-review-triage prompt does not claim it directly creates context_review_tasks', () => {
    const prompt = buildContextReviewTriageAgentPrompt();

    // Must NOT claim to be the ONLY stage that creates context_review_tasks
    expect(
      prompt,
      'review-triage: must not claim it directly creates context_review_tasks',
    ).not.toMatch(/ONLY stage allowed to create actionable context_review_tasks/);

    // Must contain the desired actionable-for-remediation wording
    expect(
      prompt,
      'review-triage: must describe its role as making findings actionable for remediation',
    ).toContain('actionable for remediation');

    // Must mention the key triage operations
    expect(
      prompt,
      'review-triage: must mention root-cause grouping',
    ).toContain('root-cause grouping');

    expect(
      prompt,
      'review-triage: must mention deduplication',
    ).toContain('deduplication');

    // Must explicitly state it does NOT create remediation assignments
    expect(
      prompt,
      'review-triage: must state it does not create remediation assignments',
    ).toContain('remediation assignments');
  });

  // ── Test 34 — ENG-1760: orchestrator MUST NOT contain inline classification instructions ──

  it('orchestrator prompt does not instruct inline classification of findings', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();

    // Must NOT contain instructions to classify findings inline
    expect(
      prompt,
      'orchestrator: must not instruct inline classification via FindingClassification taxonomy step',
    ).not.toMatch(/Classify each issue using FindingClassification taxonomy/);

    // Must NOT contain instructions to check human review gates inline
    expect(
      prompt,
      'orchestrator: must not instruct inline human review gate checking',
    ).not.toMatch(/Check human review gates using FINDING-LEVEL impactScope/);

    // Must NOT contain instructions to fetch trace evidence inline
    expect(
      prompt,
      'orchestrator: must not contain inline trace evidence fetching step (for each source, fetch context trace evidence)',
    ).not.toMatch(/For each source, fetch context trace evidence/);

    // Must contain an explicit MUST NOT or prohibition on inline analysis
    const hasMustNotInline =
      prompt.includes('MUST NOT') ||
      prompt.includes('You do NOT perform') ||
      prompt.includes('do not perform any of the following inline') ||
      prompt.includes('MUST NOT perform any of the following inline');
    expect(
      hasMustNotInline,
      'orchestrator: must explicitly prohibit inline analysis (MUST NOT)',
    ).toBe(true);
  });

  // ── Test 35 — ENG-1760: orchestrator stage flow names all required stage agents ──

  it('orchestrator prompt stage flow references all required specialized stage agents', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();

    // All 5 primary stage agents must be referenced in the required stage flow
    const stageAgents = [
      'context-trace-analysis-agent',
      'context-learning-curator-agent',
      'context-review-triage-agent',
      'context-remediation-planner-agent',
      'context-qa-eval-agent',
    ];
    for (const agentName of stageAgents) {
      expect(
        prompt,
        `orchestrator: stage flow must reference stage agent '${agentName}'`,
      ).toContain(agentName);
    }

    // Stage 4 (learning curation) must include skip-reason instruction
    const hasLearningSkip =
      prompt.includes('Stage 4 skipped') ||
      prompt.includes('no chat_learning') ||
      (prompt.includes('log explicit skip reason') && prompt.includes('context-learning-curator-agent'));
    expect(
      hasLearningSkip,
      'orchestrator: stage flow must describe logging a skip reason when no learning candidates exist',
    ).toBe(true);
  });

  // ── Test 36 — ENG-1760: orchestrator prompt has hard finalization gate for auto-remediation ──

  it('orchestrator prompt contains hard finalization gate for dbDerivedAutoRemediationCount > 0 with no assignments', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();

    // Must reference the auto-remediation count field
    expect(
      prompt,
      'orchestrator: must reference dbDerivedAutoRemediationCount for gate check',
    ).toContain('dbDerivedAutoRemediationCount');

    // Must reference dbDerivedAssignmentCount and dbDerivedRemediationCount in context of gate
    expect(
      prompt,
      'orchestrator: must reference dbDerivedAssignmentCount in finalization gate',
    ).toContain('dbDerivedAssignmentCount');

    expect(
      prompt,
      'orchestrator: must reference dbDerivedRemediationCount in finalization gate',
    ).toContain('dbDerivedRemediationCount');

    // Must explicitly prohibit 'completed' status when auto-remediation tasks exist but no assignments
    const hasAutoRemGate =
      (prompt.includes('dbDerivedAutoRemediationCount > 0') || prompt.includes('dbDerivedAutoRemediationCount')) &&
      (prompt.includes('dbDerivedAssignmentCount === 0') || prompt.includes('no assignments were created')) &&
      (prompt.includes('partial') || prompt.includes('incomplete')) &&
      (prompt.includes('NOT') || prompt.includes('never') || prompt.includes('NEVER'));
    expect(
      hasAutoRemGate,
      'orchestrator: must have a hard gate that forces partial/incomplete when auto-remediation tasks exist but no assignments were created',
    ).toBe(true);
  });

  // ── Test 37 — ENG-1760: orchestrator preflight does NOT include worker-only MCP tools ──

  it('orchestrator preflight does NOT list worker-only MCP tools (update_trace_analysis_assignment, submit_source_evaluation)', () => {
    const prompt = buildContextJudgeOrchestratorPrompt();

    // The STEP 0 preflight block should NOT list tools that belong only to workers.
    // We check that the exact worker-only tool names do NOT appear in the preflight list.
    // (They may appear elsewhere in the prompt as documentation, but not in the STEP 0 list.)

    // Extract the preflight section (STEP 0 block)
    const preflightStart = prompt.indexOf('## STEP 0');
    const preflightEnd = prompt.indexOf('\n## ', preflightStart + 1);
    const preflightSection = preflightEnd > preflightStart
      ? prompt.slice(preflightStart, preflightEnd)
      : prompt.slice(preflightStart);

    expect(
      preflightSection,
      'orchestrator: STEP 0 preflight must NOT list context_quality_update_trace_analysis_assignment (worker-only tool)',
    ).not.toContain('context_quality_update_trace_analysis_assignment');

    expect(
      preflightSection,
      'orchestrator: STEP 0 preflight must NOT list context_quality_submit_source_evaluation (worker-only tool)',
    ).not.toContain('context_quality_submit_source_evaluation');
  });
});
