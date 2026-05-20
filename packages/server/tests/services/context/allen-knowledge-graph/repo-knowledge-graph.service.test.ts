import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { REPO_CONTEXT_LOADING_GUIDANCE } from '@allen/engine';
import {
  RepoKnowledgeGraphService,
  RepoKnowledgeGraphValidationError,
} from '../../../../src/services/context/allen-knowledge-graph/repo-knowledge-graph.service.js';
import { buildIndexerUserPrompt, buildSpawnedAgentRoleInventory, workflowRoleGuidance } from '../../../../src/services/context/allen-knowledge-graph/repo-knowledge-graph-indexer.js';
import type { KnowledgeCandidateInventory, WorkflowRoleInventoryEntry } from '../../../../src/services/context/allen-knowledge-graph/repo-knowledge-graph.types.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { repoRoutes } from '../../../../src/routes/repo.routes.js';

describe('RepoKnowledgeGraphService context packets', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let repoId: ObjectId;
  let repoPath: string;
  let previousContextProvider: string | undefined;
  let previousCogneeMandatoryGraph: string | undefined;

  beforeAll(async () => {
    previousContextProvider = process.env.ALLEN_CONTEXT_PROVIDER;
    previousCogneeMandatoryGraph = process.env.ALLEN_COGNEE_MANDATORY_GRAPH;
    process.env.ALLEN_CONTEXT_PROVIDER = 'graph';
    repoPath = mkdtempSync(join(tmpdir(), 'allen-knowledge-fixture-'));
    mkdirSync(join(repoPath, '.claude/skills/payments'), { recursive: true });
    mkdirSync(join(repoPath, 'docs'), { recursive: true });
    writeFileSync(join(repoPath, 'AGENTS.md'), 'Always read repo instructions before changes.\n');
    writeFileSync(join(repoPath, 'package.json'), '{"scripts":{"test":"vitest run"}}\n');
    writeFileSync(join(repoPath, '.claude/skills/payments/SKILL.md'), '# Payments Debugging Skill\n\nUse ledger-safe reconciliation steps.\n');
    writeFileSync(join(repoPath, 'docs/payments-production.md'), 'Refund reconciliation must remain idempotent.\n');
    writeFileSync(join(repoPath, 'docs/payments-guidelines.md'), 'Prefer small, precise mandatory repo rules over command profile summaries.\n');
    writeFileSync(join(repoPath, 'docs/huge-production.md'), `${'Large production context. '.repeat(4_000)}\n`);
    execFileSync('git', ['init'], { cwd: repoPath });
    execFileSync('git', ['add', '.'], { cwd: repoPath });

    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('allen-knowledge-test');
    repoId = new ObjectId();

    await db.collection('repos').insertOne({
      _id: repoId,
      name: 'fixture-repo',
      path: repoPath,
      status: 'active',
    });
    await db.collection('workflows').insertOne({
      name: 'bug-investigate-and-fix',
      archived: false,
      parsed: {
        name: 'bug-investigate-and-fix',
        nodes: {
          investigate: { type: 'agent', agent: 'bug-investigator' },
          implement: { type: 'agent', agent: 'backend-developer' },
          qa: { type: 'agent', agent: 'qa-lead' },
          review: { type: 'agent', agent: 'code-reviewer' },
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('agents').insertMany([
      { name: 'backend-developer', displayName: 'Backend Developer' },
      { name: 'frontend-developer', displayName: 'Frontend Developer' },
      { name: 'devops-engineer', displayName: 'DevOps Engineer' },
      { name: 'security-specialist', displayName: 'Security Specialist' },
      { name: 'test-writer', displayName: 'Test Writer' },
      { name: 'documentation-writer', displayName: 'Documentation Writer' },
    ]);
    await db.collection('repo_knowledge_indexes').insertOne({
      indexId: 'index-1',
      repoId: String(repoId),
      repoName: 'fixture-repo',
      sourceRepoPath: repoPath,
      headSha: 'abc123',
      indexVersion: 1,
      latest: true,
      indexedAt: new Date(),
      freshness: { status: 'fresh' },
    });
    await db.collection('knowledge_nodes').insertMany([
      {
        id: `${repoId}:repo`,
        stableKey: 'repo',
        repoId: String(repoId),
        indexId: 'index-1',
        kind: 'repo',
        title: 'fixture-repo',
        summary: 'A repo used by tests.',
        tags: ['repo'],
        source: { type: 'generated_summary', uri: 'generated://repo' },
        freshness: { lastSeenAt: new Date(), contentHash: '1', stale: false },
        access: { visibility: 'repo', injectPolicy: 'baseline' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: `${repoId}:root-agents`,
        stableKey: 'root-agents',
        repoId: String(repoId),
        indexId: 'index-1',
        kind: 'instruction_file',
        title: 'Root AGENTS.md',
        path: 'AGENTS.md',
        summary: 'Always read repo instructions before changes.',
        tags: ['instructions'],
        source: { type: 'repo_file', uri: 'repo://AGENTS.md' },
        freshness: { lastSeenAt: new Date(), contentHash: '2', stale: false },
        access: { visibility: 'repo', injectPolicy: 'baseline' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: `${repoId}:skill-payments`,
        stableKey: 'skill-payments',
        repoId: String(repoId),
        indexId: 'index-1',
        kind: 'skill',
        title: 'Payments Debugging Skill',
        path: '.claude/skills/payments/SKILL.md',
        summary: 'Use for payment reconciliation failures.',
        tags: ['payments', 'reconciliation'],
        moduleId: 'payments',
        source: { type: 'repo_file', uri: 'repo://.claude/skills/payments/SKILL.md' },
        freshness: { lastSeenAt: new Date(), contentHash: '3', stale: false },
        access: { visibility: 'repo', injectPolicy: 'on_demand' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: `${repoId}:prod-payments`,
        stableKey: 'prod-payments',
        repoId: String(repoId),
        indexId: 'index-1',
        kind: 'production_note',
        title: 'Payments Production Rules',
        path: 'docs/payments-production.md',
        summary: 'Refund reconciliation must remain idempotent.',
        tags: ['payments', 'refunds', 'production'],
        moduleId: 'payments',
        mandatoryForNodeRoles: ['backend-developer'],
        source: { type: 'repo_file', uri: 'repo://docs/payments-production.md' },
        freshness: { lastSeenAt: new Date(), contentHash: '4', stale: false },
        access: { visibility: 'repo', injectPolicy: 'on_demand' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: `${repoId}:command-package-json`,
        stableKey: 'command-package-json',
        repoId: String(repoId),
        indexId: 'index-1',
        kind: 'command_profile',
        title: 'Package scripts',
        path: 'package.json',
        summary: 'Vitest command profile for payment validation.',
        tags: ['payments', 'validation', 'scripts'],
        moduleId: 'payments',
        mandatoryForNodeRoles: ['backend-developer'],
        source: { type: 'repo_file', uri: 'repo://package.json' },
        freshness: { lastSeenAt: new Date(), contentHash: '5', stale: false },
        access: { visibility: 'repo', injectPolicy: 'on_demand' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: `${repoId}:guidelines-payments`,
        stableKey: 'guidelines-payments',
        repoId: String(repoId),
        indexId: 'index-1',
        kind: 'context_file',
        title: 'Payments Coding Guidelines',
        path: 'docs/payments-guidelines.md',
        summary: 'Small mandatory payment implementation guidelines.',
        tags: ['payments', 'guidelines'],
        moduleId: 'payments',
        mandatoryForNodeRoles: ['backend-developer'],
        source: { type: 'repo_file', uri: 'repo://docs/payments-guidelines.md' },
        freshness: { lastSeenAt: new Date(), contentHash: '6', stale: false },
        access: { visibility: 'repo', injectPolicy: 'on_demand' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: `${repoId}:huge-prod-payments`,
        stableKey: 'huge-prod-payments',
        repoId: String(repoId),
        indexId: 'index-1',
        kind: 'production_note',
        title: 'Huge Payments Production Context',
        path: 'docs/huge-production.md',
        summary: 'Oversized mandatory payment production context.',
        tags: ['payments', 'production'],
        moduleId: 'payments',
        mandatoryForNodeRoles: ['backend-developer'],
        source: { type: 'repo_file', uri: 'repo://docs/huge-production.md' },
        freshness: { lastSeenAt: new Date(), contentHash: '7', stale: false },
        access: { visibility: 'repo', injectPolicy: 'on_demand' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    if (previousContextProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
    else process.env.ALLEN_CONTEXT_PROVIDER = previousContextProvider;
    if (previousCogneeMandatoryGraph === undefined) delete process.env.ALLEN_COGNEE_MANDATORY_GRAPH;
    else process.env.ALLEN_COGNEE_MANDATORY_GRAPH = previousCogneeMandatoryGraph;
    await client.close();
    await mongo.stop();
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('builds and persists a node context packet from graph nodes', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const packet = await service.buildNodeContextPacket({
      executionId: 'exec-1',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: { repo_path: repoPath },
      prompt: 'Fix payment refund reconciliation mismatch',
    });

    expect(packet).not.toBeNull();
    expect(packet?.promptBlock).toContain('<repo_knowledge_packet');
    expect(packet?.promptBlock).toContain('<repo_context_selection>');
    expect(packet?.promptBlock).toContain('<repo_context_usage_reminder>');
    expect(packet?.promptBlock).not.toContain('<repo_context_usage_contract>');
    expect(packet?.promptBlock).toContain('<context_ref');
    expect(packet?.promptBlock).not.toContain('<loaded_repo_context>');
    expect(packet?.promptBlock).toContain('Payments Production Rules');
    expect(packet?.promptBlock).toContain('These entries are relevance hints unless Allen injected their full body');
    expect(packet?.systemPromptBlock).toContain('<allen_mandatory_repo_context');
    expect(packet?.systemPromptBlock).toContain('docs/payments-production.md');
    expect(packet?.systemPromptBlock).toContain('Refund reconciliation must remain idempotent');
    expect(packet?.traceSummary.systemPromptContextInjected).toBe(true);
    expect(packet?.traceSummary.mandatoryContextInjectedCount).toBeGreaterThan(0);
    expect(packet?.traceSummary.preselectedContextCount).toBeGreaterThan(0);
    expect(packet?.traceSummary.mandatoryCount).toBeGreaterThan(0);

    const stored = await db.collection('node_context_packets').findOne({ executionId: 'exec-1', nodeName: 'implement' });
    expect(stored?.packetId).toBe(packet?.packetId);
    expect(stored?.systemPromptBlock).toContain('<allen_mandatory_repo_context');
    expect(stored?.systemPromptBlockHash).toEqual(expect.any(String));
    expect(stored?.contextInjection?.injectedRefs?.length).toBeGreaterThan(0);
    expect(stored?.selectedRefs.filter((r: { kind: string }) => r.kind === 'production_note').length).toBeGreaterThan(0);
    expect(stored?.selectedRefs.length).toBeGreaterThan(0);
    expect(stored?.providerTraces.map((r: { decision: string }) => r.decision)).toContain('selected');
  });

  it('prioritizes injectable mandatory context without letting command profiles consume injection budget', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const packet = await service.buildNodeContextPacket({
      executionId: 'exec-command-profile-budget',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: { repo_path: repoPath },
      prompt: 'Fix payment refund reconciliation mismatch and run tests',
      provider: 'claude',
    });

    const stored = await db.collection('node_context_packets').findOne({ packetId: packet?.packetId });
    expect(stored?.selectedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: `${repoId}:command-package-json` }),
    ]));
    expect(stored?.contextInjection?.maxFileChars).toBe(60_000);
    expect(stored?.contextInjection?.maxTotalChars).toBe(180_000);
    expect(stored?.contextInjection?.maxInjectedRefs).toBe(12);
    expect(stored?.contextInjection?.injectedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: `${repoId}:guidelines-payments`, path: 'docs/payments-guidelines.md' }),
    ]));
    expect(stored?.contextInjection?.packingDecisions ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: `${repoId}:command-package-json`, path: 'package.json' }),
    ]));
    expect(stored?.contextInjection?.skippedOversizeRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: `${repoId}:huge-prod-payments`, path: 'docs/huge-production.md' }),
    ]));
  });

  it('records Allen system-injected mandatory context as verified loaded usage', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const packet = await service.buildNodeContextPacket({
      executionId: 'exec-system-injected',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: { repo_path: repoPath },
      prompt: 'Fix payment refund reconciliation mismatch',
      provider: 'claude',
    });

    const usage = await service.recordContextUsage({
      executionId: 'exec-system-injected',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: packet?.packetId,
      outputs: {
        repo_context_usage: {
          module_identified: 'payments',
          context_loaded: [],
          context_applied: [],
          context_skipped: [],
          validation_performed: [],
        },
      },
    });

    expect(usage?.loadedCount).toBeGreaterThan(0);
    const stored = await db.collection('context_usage_traces').findOne({ packetId: packet?.packetId });
    expect(stored?.loaded).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: `${repoId}:prod-payments`, source: 'allen_system_injection' }),
    ]));
    expect(stored?.unverifiedClaims).toHaveLength(0);
  });

  it('skips provider-native mandatory context from duplicate full-body injection', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const packet = await service.buildNodeContextPacket({
      executionId: 'exec-codex-native',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: { repo_path: repoPath },
      prompt: 'Fix payment refund reconciliation mismatch',
      provider: 'codex',
    });

    expect(packet?.systemPromptBlock).toContain('<allen_mandatory_repo_context');
    expect(packet?.systemPromptBlock).not.toContain('Always read repo instructions before changes.');
    expect(packet?.traceSummary.mandatoryContextSkippedProviderNativeCount).toBeGreaterThan(0);
    const stored = await db.collection('node_context_packets').findOne({ packetId: packet?.packetId });
    expect(stored?.contextInjection?.skippedProviderNativeRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'AGENTS.md' }),
    ]));
  });

  it('builds spawned-agent packets with parent context metadata', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const packet = await service.buildNodeContextPacket({
      executionId: 'exec-spawn-child',
      workflowName: 'implement:spawn_agent/backend-developer',
      nodeName: 'backend-developer',
      nodeRole: 'backend-developer',
      attempt: 2,
      state: { repo_path: repoPath },
      prompt: 'Implement payment reconciliation fix',
      parentPacketId: 'packet-parent',
      parentExecutionId: 'exec-parent',
      rootExecutionId: 'exec-root',
      provider: 'claude',
    });

    const stored = await db.collection('node_context_packets').findOne({ packetId: packet?.packetId });
    expect(stored).toEqual(expect.objectContaining({
      parentPacketId: 'packet-parent',
      parentExecutionId: 'exec-parent',
      rootExecutionId: 'exec-root',
    }));
    expect(stored?.contextInjection?.injectedRefs?.length).toBeGreaterThan(0);
  });

  it('skips semantic repo context for support/output nodes with no explicit mandatory mapping', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const packet = await service.buildNodeContextPacket({
      executionId: 'exec-open-pr-support',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'open_pr',
      nodeRole: 'pr-creator',
      attempt: 1,
      state: { repo_path: repoPath, changedFiles: ['src/payments/service.ts'] },
      prompt: 'Create the pull request from upstream artifacts',
      provider: 'claude',
    });

    expect(packet).toBeNull();
    await expect(db.collection('node_context_packets').findOne({ executionId: 'exec-open-pr-support' })).resolves.toBeNull();
  });

  it('injects only explicit mandatory role mappings for support/output nodes', async () => {
    const service = new RepoKnowledgeGraphService(db);
    writeFileSync(join(repoPath, 'docs/pr-policy.md'), 'PR titles must include the ticket key.\n');
    execFileSync('git', ['add', 'docs/pr-policy.md'], { cwd: repoPath });
    await db.collection('knowledge_nodes').insertOne({
      id: `${repoId}:pr-policy`,
      stableKey: 'pr-policy',
      repoId: String(repoId),
      indexId: 'index-1',
      kind: 'context_file',
      title: 'PR Policy',
      path: 'docs/pr-policy.md',
      summary: 'Always-load PR creation policy.',
      tags: ['pr', 'policy'],
      mandatoryForNodeRoles: ['pr-creator'],
      source: { type: 'repo_file', uri: 'repo://docs/pr-policy.md' },
      freshness: { lastSeenAt: new Date(), contentHash: '8', stale: false },
      access: { visibility: 'repo', injectPolicy: 'on_demand' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const packet = await service.buildNodeContextPacket({
      executionId: 'exec-open-pr-mandatory-only',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'open_pr',
      nodeRole: 'pr-creator',
      attempt: 1,
      state: { repo_path: repoPath, changedFiles: ['src/payments/service.ts'] },
      prompt: 'Create the pull request from upstream artifacts',
      provider: 'claude',
    });

    expect(packet).not.toBeNull();
    expect(packet?.systemPromptBlock).toContain('PR titles must include the ticket key');
    expect(packet?.systemPromptBlock).not.toContain('Always read repo instructions before changes.');
    expect(packet?.traceSummary).toEqual(expect.objectContaining({
      contextRetrievalMode: 'mandatory_only',
      retrievalProviders: expect.arrayContaining(['mandatory_graph']),
    }));
    expect(packet?.traceSummary.retrievalProviders).not.toContain('graph_keyword_metadata');
    const stored = await db.collection('node_context_packets').findOne({ packetId: packet?.packetId });
    expect(stored?.selectedRefs).toEqual([
      expect.objectContaining({ refId: `${repoId}:pr-policy`, providerId: 'mandatory_graph' }),
    ]);
  });

  it('keeps investigation and planning roles on full retrieval', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const packet = await service.buildNodeContextPacket({
      executionId: 'exec-investigation-full-context',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      state: { repo_path: repoPath },
      prompt: 'Investigate a payment refund mismatch',
      provider: 'claude',
    });

    expect(packet).not.toBeNull();
    expect(packet?.traceSummary).toEqual(expect.objectContaining({
      contextRetrievalMode: 'full',
      retrievalProviders: expect.arrayContaining(['mandatory_graph', 'graph_keyword_metadata']),
    }));
    expect(workflowRoleGuidance('solution-architect').category).toBe('repo-operating');
    expect(workflowRoleGuidance('technical-designer').category).toBe('repo-operating');
  });

  it('returns no context packet when a repo graph is missing', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await db.collection('repos').insertOne({
      _id: new ObjectId(),
      name: 'unindexed-repo',
      path: join(repoPath, 'missing-index'),
      status: 'active',
    });

    await expect(service.buildNodeContextPacket({
      executionId: 'exec-missing-index',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      state: { repo_path: join(repoPath, 'missing-index') },
      prompt: 'Investigate a bug',
    })).resolves.toBeNull();
  });

  it('does not build packets or record usage when the context provider is disabled', async () => {
    const previousProvider = process.env.ALLEN_CONTEXT_PROVIDER;
    process.env.ALLEN_CONTEXT_PROVIDER = 'disabled';
    const service = new RepoKnowledgeGraphService(db);
    const usageBefore = await db.collection('context_usage_traces').countDocuments();
    try {
      await expect(service.buildNodeContextPacket({
        executionId: 'exec-context-disabled',
        workflowName: 'bug-investigate-and-fix',
        nodeName: 'investigate',
        nodeRole: 'bug-investigator',
        attempt: 1,
        state: { repo_path: repoPath },
        prompt: 'Investigate a bug',
      })).resolves.toBeNull();

      await expect(service.recordContextUsage({
        executionId: 'exec-context-disabled',
        workflowName: 'bug-investigate-and-fix',
        nodeName: 'investigate',
        nodeRole: 'bug-investigator',
        attempt: 1,
        packetId: 'packet-disabled',
        outputs: {
          repo_context_usage: {
            context_loaded: [{ refId: `${repoId}:prod-payments`, source: 'get_repo_context_body' }],
          },
        },
      })).resolves.toBeNull();

      await expect(db.collection('context_usage_traces').countDocuments()).resolves.toBe(usageBefore);
    } finally {
      if (previousProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
      else process.env.ALLEN_CONTEXT_PROVIDER = previousProvider;
    }
  });

  it('builds a Cognee context packet without requiring a graph index', async () => {
    const previousProvider = process.env.ALLEN_CONTEXT_PROVIDER;
    const previousSidecar = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    const previousGraphExpansion = process.env.ALLEN_COGNEE_GRAPH_EXPANSION;
    const scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-packet-'));
    try {
      process.env.ALLEN_CONTEXT_PROVIDER = 'cognee';
      process.env.ALLEN_COGNEE_GRAPH_EXPANSION = 'off';
      const cogneeRepoId = new ObjectId();
      const cogneeRepoPath = join(repoPath, 'cognee-only-repo');
      mkdirSync(cogneeRepoPath, { recursive: true });
      await db.collection('repos').insertOne({
        _id: cogneeRepoId,
        name: 'cognee-only-repo',
        path: cogneeRepoPath,
        status: 'active',
      });

      const scriptPath = join(scriptDir, 'fake-cognee-search.py');
      writeFileSync(scriptPath, `#!/usr/bin/env python3
import json
import sys
json.load(sys.stdin)
print(json.dumps({
  "diagnostics": [{"code": "fake_cognee_search", "severity": "info"}],
  "results": [{
    "id": "payment-service-chunk",
    "title": "Payment Service",
    "kind": "source_file",
    "path": "src/payments/service.ts",
    "content": "export function refund() { return 'idempotent'; }",
    "score": 0.98,
    "externalMetadata": {
      "repoId": "${String(cogneeRepoId)}",
      "path": "src/payments/service.ts",
      "title": "Payment Service",
      "kind": "source_file"
    }
  }]
}))
`);
      process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = scriptPath;

      const service = new RepoKnowledgeGraphService(db);
      const packet = await service.buildNodeContextPacket({
        executionId: 'exec-cognee-no-graph',
        workflowName: 'bug-investigate-and-fix',
        nodeName: 'investigate',
        nodeRole: 'bug-investigator',
        attempt: 1,
        state: {
          worktree_path: join(repoPath, 'unmapped-worktree'),
          repo_path: cogneeRepoPath,
          changedFiles: ['src/payments/service.ts'],
        },
        prompt: 'Investigate refund idempotency in payment service',
        provider: 'claude',
      });

      expect(packet).not.toBeNull();
      expect(packet?.systemPromptBlock).toContain('<allen_mandatory_repo_context');
      expect(packet?.systemPromptBlock).toContain("return 'idempotent'");
      expect(packet?.traceSummary).toEqual(expect.objectContaining({
        contextProvider: 'cognee',
        indexId: `cognee:${String(cogneeRepoId)}`,
        indexFreshness: 'provider_runtime',
        systemPromptContextInjected: true,
      }));
      expect(packet?.traceSummary.retrievalProviders).toEqual(expect.arrayContaining(['cognee_memory']));
      expect(packet?.traceSummary.providerDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'cognee_mandatory_graph_missing', severity: 'warn' }),
        expect.objectContaining({ code: 'cognee_graph_expansion_disabled' }),
        expect.objectContaining({ code: 'fake_cognee_search' }),
      ]));

      const stored = await db.collection('node_context_packets').findOne({ packetId: packet?.packetId });
      expect(stored?.selectedRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ refId: 'cognee:payment-service-chunk', path: 'src/payments/service.ts' }),
      ]));
      expect(stored?.contextInjection?.injectedRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ refId: 'cognee:payment-service-chunk' }),
      ]));

      const usage = await service.recordContextUsage({
        executionId: 'exec-cognee-no-graph',
        workflowName: 'bug-investigate-and-fix',
        nodeName: 'investigate',
        nodeRole: 'bug-investigator',
        attempt: 1,
        packetId: packet?.packetId,
        outputs: {
          repo_context_usage: {
            context_loaded: [],
            context_applied: [],
            context_skipped: [],
          },
        },
      });
      expect(usage?.loadedCount).toBeGreaterThan(0);
    } finally {
      if (previousProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
      else process.env.ALLEN_CONTEXT_PROVIDER = previousProvider;
      if (previousSidecar === undefined) delete process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
      else process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = previousSidecar;
      if (previousGraphExpansion === undefined) delete process.env.ALLEN_COGNEE_GRAPH_EXPANSION;
      else process.env.ALLEN_COGNEE_GRAPH_EXPANSION = previousGraphExpansion;
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it('loads mandatory Allen graph context before Cognee semantic refs in Cognee mode', async () => {
    const previousProvider = process.env.ALLEN_CONTEXT_PROVIDER;
    const previousSidecar = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    const previousGraphExpansion = process.env.ALLEN_COGNEE_GRAPH_EXPANSION;
    const scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-graph-packet-'));
    try {
      process.env.ALLEN_CONTEXT_PROVIDER = 'cognee';
      delete process.env.ALLEN_COGNEE_MANDATORY_GRAPH;
      process.env.ALLEN_COGNEE_GRAPH_EXPANSION = 'off';
      const scriptPath = join(scriptDir, 'fake-cognee-search.py');
      writeFileSync(scriptPath, `#!/usr/bin/env python3
import json
import sys
json.load(sys.stdin)
print(json.dumps({
  "diagnostics": [{"code": "fake_cognee_search", "severity": "info"}],
  "results": [{
    "id": "payment-service-chunk",
    "title": "Payment Service",
    "kind": "source_file",
    "path": "src/payments/service.ts",
    "content": "export function refund() { return 'idempotent'; }",
    "score": 0.98,
    "externalMetadata": {
      "repoId": "${String(repoId)}",
      "path": "src/payments/service.ts",
      "title": "Payment Service",
      "kind": "source_file"
    }
  }]
}))
`);
      process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = scriptPath;

      const service = new RepoKnowledgeGraphService(db);
      const packet = await service.buildNodeContextPacket({
        executionId: 'exec-cognee-with-graph',
        workflowName: 'bug-investigate-and-fix',
        nodeName: 'implement',
        nodeRole: 'backend-developer',
        attempt: 1,
        state: {
          repo_path: repoPath,
          changedFiles: ['src/payments/service.ts'],
        },
        prompt: 'Implement refund idempotency in payment service',
        provider: 'claude',
      });

      expect(packet).not.toBeNull();
      expect(packet?.systemPromptBlock).toContain('Prefer small, precise mandatory repo rules');
      expect(packet?.traceSummary.retrievalProviders).toEqual(expect.arrayContaining(['mandatory_graph', 'cognee_memory']));
      expect(packet?.traceSummary.providerDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'cognee_mandatory_graph_loaded', indexId: 'index-1' }),
        expect.objectContaining({ code: 'cognee_graph_expansion_disabled' }),
      ]));

      const stored = await db.collection('node_context_packets').findOne({ packetId: packet?.packetId });
      expect(stored?.selectedRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerId: 'mandatory_graph', refId: `${repoId}:guidelines-payments` }),
        expect.objectContaining({ providerId: 'cognee_memory', refId: 'cognee:payment-service-chunk' }),
      ]));
    } finally {
      if (previousProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
      else process.env.ALLEN_CONTEXT_PROVIDER = previousProvider;
      if (previousSidecar === undefined) delete process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
      else process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = previousSidecar;
      if (previousGraphExpansion === undefined) delete process.env.ALLEN_COGNEE_GRAPH_EXPANSION;
      else process.env.ALLEN_COGNEE_GRAPH_EXPANSION = previousGraphExpansion;
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it('records usage from raw agent JSON even when workflow outputs omit usage fields', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const usage = await service.recordContextUsage({
      executionId: 'exec-1',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: 'packet-1',
      outputs: { fix_description: 'done' },
      rawResponse: `\`\`\`json
{
  "fix_description": "done",
  "module_identified": "payments",
  "context_loaded": [{"refId": "${repoId}:root-agents"}],
  "context_applied": [{"refId": "${repoId}:prod-payments", "summary": "Kept reconciliation idempotent"}],
  "context_skipped": [],
  "validation_performed": ["npm test -- payments"]
}
\`\`\``,
    });

    expect(usage).toEqual(expect.objectContaining({ loadedCount: 0, appliedCount: 0, skippedCount: 0 }));
    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-1' });
    expect(stored?.moduleIdentified).toBe('payments');
    expect(stored?.reportedLoaded).toHaveLength(1);
    expect(stored?.reportedApplied).toHaveLength(1);
    expect(stored?.loaded).toHaveLength(0);
    expect(stored?.claimedUsed).toHaveLength(0);
  });

  it('records usage from nested repo_context_usage blocks', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const usage = await service.recordContextUsage({
      executionId: 'exec-2',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'backend-developer',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: 'packet-2',
      outputs: {},
      rawResponse: `{
  "response": "done",
  "repo_context_usage": {
    "module_identified": "payments",
    "context_loaded": [{"refId": "${repoId}:skill-payments", "kind": "skill_body"}],
    "context_applied": [{"refId": "${repoId}:skill-payments", "summary": "Used reconciliation steps"}],
    "context_skipped": [],
    "validation_performed": ["npm test -- payments"]
  }
}`,
    });

    expect(usage).toEqual(expect.objectContaining({ loadedCount: 0, appliedCount: 0, skippedCount: 0 }));
    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-2' });
    expect(stored?.moduleIdentified).toBe('payments');
    expect(stored?.reportedLoaded?.[0]?.kind).toBe('skill_body');
    expect(stored?.loaded).toHaveLength(0);
  });

  it('records usage from nested workflow output objects', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const usage = await service.recordContextUsage({
      executionId: 'exec-nested-output',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-nested-output',
      outputs: {
        investigate_output: {
          module_identified: 'payments',
          context_loaded: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file' }],
          context_applied: [{ refId: `${repoId}:prod-payments`, summary: 'Kept production rule' }],
          context_skipped: [{ refId: `${repoId}:skill-payments`, reason: 'not needed' }],
          validation_performed: ['npm test -- payments'],
        },
      },
    });

    expect(usage).toEqual(expect.objectContaining({ loadedCount: 0, appliedCount: 0, skippedCount: 1 }));
    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-nested-output' });
    expect(stored?.moduleIdentified).toBe('payments');
    expect(stored?.reportedLoaded).toHaveLength(1);
    expect(stored?.reportedApplied).toHaveLength(1);
    expect(stored?.extractionSources).toContain('outputs.investigate_output');
  });

  it('records get_repo_skill_body tool calls as loaded skill body usage', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const usage = await service.recordContextUsage({
      executionId: 'exec-skill-tool',
      workflowName: 'implement:spawn_agent/backend-developer',
      nodeName: 'backend-developer',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: 'packet-skill-tool',
      outputs: { response: 'done' },
      rawResponse: '{"repo_context_usage":{"module_identified":"payments","context_loaded":[],"context_applied":[],"context_skipped":[],"validation_performed":[]}}',
      toolCalls: [{
        tool: 'mcp__allen__get_repo_skill_body',
        args: { ref_id: `${repoId}:skill-payments`, skill_path: '.claude/skills/payments/SKILL.md' },
        toolUseId: 'tool-1',
      }],
    });

    expect(usage).toEqual(expect.objectContaining({ loadedCount: 1 }));
    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-skill-tool' });
    expect(stored?.loaded?.[0]).toEqual(expect.objectContaining({ kind: 'skill_body', source: 'tool_call' }));
    expect(stored?.skillBodyLoads).toHaveLength(1);
  });

  it('records get_repo_context_body tool calls as loaded context body usage', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const usage = await service.recordContextUsage({
      executionId: 'exec-context-tool',
      workflowName: 'implement:spawn_agent/backend-developer',
      nodeName: 'backend-developer',
      nodeRole: 'backend-developer',
      attempt: 1,
      packetId: 'packet-context-tool',
      outputs: { response: 'done' },
      rawResponse: '{"repo_context_usage":{"module_identified":"payments","context_loaded":[],"context_applied":[],"context_skipped":[],"validation_performed":[]}}',
      toolCalls: [{
        tool: 'mcp__allen__get_repo_context_body',
        args: { ref_id: `${repoId}:prod-payments`, context_path: 'docs/payments-production.md' },
        result: { refId: `${repoId}:prod-payments`, kind: 'production_note', path: 'docs/payments-production.md' },
        toolUseId: 'tool-context-1',
      }],
    });

    expect(usage).toEqual(expect.objectContaining({ loadedCount: 1 }));
    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-context-tool' });
    expect(stored?.loaded?.[0]).toEqual(expect.objectContaining({ kind: 'production_note', source: 'tool_call' }));
    expect(stored?.contextBodyLoads).toHaveLength(1);
  });

  it('loads Cognee selected refs through get_repo_context_body without a separate MCP tool', async () => {
    const previous = process.env.ALLEN_CONTEXT_PROVIDER;
    process.env.ALLEN_CONTEXT_PROVIDER = 'cognee';
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-cognee-body',
      executionId: 'exec-cognee-body',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      repoId: String(repoId),
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{
        refId: 'cognee:chunk-payments',
        kind: 'doc',
        title: 'Payments Cognee Chunk',
        path: 'docs/payments-production.md',
        providerId: 'cognee_memory',
        itemType: 'repo_chunk',
        content: 'Cognee recalled exact payment chunk body.',
        providerMetadata: {
          datasetName: 'allen-fixture-repo-docmeta-v1',
          cogneeChunkId: 'chunk-payments',
          sourceMetadata: {
            path: 'docs/payments-production.md',
            fileHash: 'hash-payments',
          },
        },
      }],
      contextInjection: { injectedRefs: [], skippedRefs: [], totalChars: 0 },
      createdAt: new Date(),
    });

    try {
      const service = new RepoKnowledgeGraphService(db);
      const result = await service.getContextBody({
        repoPath,
        refId: 'cognee:chunk-payments',
      });

      expect(result).toEqual(expect.objectContaining({
        refId: 'cognee:chunk-payments',
        providerId: 'cognee_memory',
        bodySource: 'cognee_context_packet_chunk',
        content: 'Cognee recalled exact payment chunk body.',
        providerMetadata: expect.objectContaining({
          cogneeChunkId: 'chunk-payments',
          datasetName: 'allen-fixture-repo-docmeta-v1',
        }),
      }));
    } finally {
      if (previous === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
      else process.env.ALLEN_CONTEXT_PROVIDER = previous;
    }
  });

  it('stores summary-only usage separately from loaded context', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-summary-only',
      executionId: 'exec-summary-only',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: String(repoId),
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file', title: 'Root AGENTS.md', path: 'AGENTS.md', source: 'runtime_preselected' }],
      availableRefs: [],
      rejectedRefs: [],
      createdAt: new Date(),
    });

    await service.recordContextUsage({
      executionId: 'exec-summary-only',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-summary-only',
      outputs: {
        repo_context_usage: {
          module_identified: 'payments',
          context_summary_used: [{ refId: `${repoId}:root-agents`, reason: 'Inspected summary for relevance only; did not rely on it for final work' }],
          context_loaded: [],
          context_applied: [],
          context_skipped: [],
          validation_performed: [],
        },
      },
    });

    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-summary-only' });
    expect(stored?.contextPreselected).toHaveLength(1);
    expect(stored?.contextSummaryUsed).toHaveLength(1);
    expect(stored?.loaded).toHaveLength(0);
    expect(stored?.claimedUsed).toHaveLength(0);
    expect(stored?.unverifiedClaims).toHaveLength(0);
  });

  it('warns when a file-backed summary appears to influence work without a full body load', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-summary-relied',
      executionId: 'exec-summary-relied',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: String(repoId),
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file', title: 'Root AGENTS.md', path: 'AGENTS.md' }],
      availableRefs: [],
      rejectedRefs: [],
      createdAt: new Date(),
    });

    await service.recordContextUsage({
      executionId: 'exec-summary-relied',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-summary-relied',
      outputs: {
        repo_context_usage: {
          module_identified: 'payments',
          context_summary_used: [{ refId: `${repoId}:root-agents`, reason: 'Summary confirmed the backend rule and informed the recommendation' }],
          context_loaded: [],
          context_applied: [],
          context_skipped: [],
          validation_performed: [],
        },
      },
    });

    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-summary-relied' });
    expect(stored?.diagnostics?.map((d: { code: string }) => d.code)).toContain('context_summary_relied_without_body_load');
  });

  it('warns when file-backed preselected context appears to influence work without a full body load', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-preselected-relied',
      executionId: 'exec-preselected-relied',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: String(repoId),
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file', title: 'Root AGENTS.md', path: 'AGENTS.md' }],
      availableRefs: [],
      rejectedRefs: [],
      createdAt: new Date(),
    });

    await service.recordContextUsage({
      executionId: 'exec-preselected-relied',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-preselected-relied',
      outputs: {
        repo_context_usage: {
          module_identified: 'payments',
          context_preselected: [{ refId: `${repoId}:root-agents`, source: 'runtime_preselected', reason: 'Reviewed for backend workflow rules and followed the convention' }],
          context_loaded: [],
          context_applied: [],
          context_skipped: [],
          validation_performed: [],
        },
      },
    });

    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-preselected-relied' });
    expect(stored?.diagnostics?.map((d: { code: string }) => d.code)).toContain('context_preselected_relied_without_body_load');
  });

  it('marks file-backed loaded/applied claims without body-loader calls as unverified', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-unverified',
      executionId: 'exec-unverified',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: String(repoId),
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file', title: 'Root AGENTS.md', path: 'AGENTS.md' }],
      availableRefs: [],
      rejectedRefs: [],
      createdAt: new Date(),
    });

    await service.recordContextUsage({
      executionId: 'exec-unverified',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-unverified',
      outputs: {
        repo_context_usage: {
          module_identified: 'payments',
          context_loaded: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file', reason: 'Claimed load' }],
          context_applied: [{ refId: `${repoId}:root-agents`, summary: 'Claimed apply' }],
          context_skipped: [],
          validation_performed: [],
        },
      },
    });

    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-unverified' });
    expect(stored?.unverifiedClaims).toHaveLength(2);
    expect(stored?.diagnostics?.map((d: { code: string }) => d.code)).toEqual([
      'context_claimed_without_body_load',
      'context_claimed_without_body_load',
    ]);
  });

  it('quarantines path-only and missing-ref repo context usage claims', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-malformed-usage',
      executionId: 'exec-malformed-usage',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: String(repoId),
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file', title: 'Root AGENTS.md', path: 'AGENTS.md' }],
      availableRefs: [],
      rejectedRefs: [],
      createdAt: new Date(),
    });

    await service.recordContextUsage({
      executionId: 'exec-malformed-usage',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-malformed-usage',
      outputs: {
        repo_context_usage: {
          module_identified: 'payments',
          context_loaded: ['.claude/rules/coding-guidelines-frontend.md'],
          context_applied: [{ path: 'docs/payments-production.md', summary: 'Used production guidance' }],
          context_skipped: [],
          validation_performed: [],
        },
      },
    });

    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-malformed-usage' });
    expect(stored?.reportedLoaded).toHaveLength(0);
    expect(stored?.reportedApplied).toHaveLength(0);
    expect(stored?.loaded).toHaveLength(0);
    expect(stored?.claimedUsed).toHaveLength(0);
    expect(stored?.unverifiedClaims).toHaveLength(0);
    expect(stored?.malformedReportedUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'context_loaded', reason: 'row_not_object' }),
      expect.objectContaining({ field: 'context_applied', reason: 'missing_ref_id' }),
    ]));
    expect(stored?.diagnostics?.map((d: { code: string }) => d.code)).toEqual(expect.arrayContaining([
      'repo_context_usage_malformed_row',
      'repo_context_usage_unmapped_claim',
    ]));
  });

  it('quarantines reported loaded/applied claims that use non-Allen load sources', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-invalid-source-usage',
      executionId: 'exec-invalid-source-usage',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: String(repoId),
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file', title: 'Root AGENTS.md', path: 'AGENTS.md' }],
      availableRefs: [],
      rejectedRefs: [],
      createdAt: new Date(),
    });

    await service.recordContextUsage({
      executionId: 'exec-invalid-source-usage',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-invalid-source-usage',
      outputs: {
        repo_context_usage: {
          module_identified: 'payments',
          context_loaded: [{ refId: `${repoId}:root-agents`, kind: 'instruction_file', source: 'Read', reason: 'Read the file' }],
          context_applied: [{ refId: `${repoId}:root-agents`, source: 'Bash', summary: 'Applied after shell inspection' }],
          context_skipped: [],
          validation_performed: [],
        },
      },
    });

    const stored = await db.collection('context_usage_traces').findOne({ packetId: 'packet-invalid-source-usage' });
    expect(stored?.reportedLoaded).toHaveLength(0);
    expect(stored?.reportedApplied).toHaveLength(0);
    expect(stored?.loaded).toHaveLength(0);
    expect(stored?.claimedUsed).toHaveLength(0);
    expect(stored?.unverifiedClaims).toHaveLength(0);
    expect(stored?.malformedReportedUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'context_loaded', reason: 'invalid_loaded_source' }),
      expect.objectContaining({ field: 'context_applied', reason: 'invalid_loaded_source' }),
    ]));
    expect(stored?.diagnostics?.map((d: { code: string }) => d.code)).toEqual([
      'context_loaded_source_invalid',
      'context_loaded_source_invalid',
    ]);
  });

  it('publishes the repo context usage schema in system-level agent guidance', () => {
    expect(REPO_CONTEXT_LOADING_GUIDANCE).toContain('<repo_context_usage_schema>');
    expect(REPO_CONTEXT_LOADING_GUIDANCE).toContain('Every context_preselected, context_summary_used, context_loaded, context_applied, and context_skipped row MUST be an object with a refId');
    expect(REPO_CONTEXT_LOADING_GUIDANCE).toContain('"source": "allen_system_injection|get_repo_context_body|get_repo_skill_body"');
    expect(REPO_CONTEXT_LOADING_GUIDANCE).toContain('Do not report normal source-code Read, Grep, or shell file inspection as context_loaded');
  });

  it('loads git-tracked context body by production knowledge ref', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const body = await service.getContextBody({
      repoPath,
      refId: `${repoId}:prod-payments`,
    });

    expect(body.path).toBe('docs/payments-production.md');
    expect(body.kind).toBe('production_note');
    expect(body.content).toContain('Refund reconciliation must remain idempotent');
    expect(body.tokenEstimate).toBeGreaterThan(0);
  });

  it('reports context diagnostics for missing child packets and empty usage', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await db.collection('executions').insertMany([
      {
        id: 'exec-report-root',
        workflowName: 'bug-investigate-and-fix',
        input: { repo_path: repoPath },
        state: {},
        startedAt: new Date(),
      },
      {
        id: 'exec-report-child',
        workflowName: 'implement:spawn_agent/backend-developer',
        input: { repo_path: repoPath, agent_name: 'backend-developer' },
        meta: { cwd: repoPath },
        parentExecutionId: 'exec-report-root',
        parentCaller: 'implement',
        rootExecutionId: 'exec-report-root',
        startedAt: new Date(),
      },
    ]);
    await db.collection('execution_traces').insertMany([
      {
        executionId: 'exec-report-root',
        node: 'investigate',
        agent: 'bug-investigator',
        type: 'agent',
        attempt: 1,
        rawResponse: 'context_loaded: []',
      },
      {
        executionId: 'exec-report-child',
        node: 'backend-developer',
        agent: 'backend-developer',
        type: 'agent',
        attempt: 1,
        rawResponse: 'done',
      },
    ]);
    await db.collection('node_context_packets').insertOne({
      packetId: 'packet-report-root',
      executionId: 'exec-report-root',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      repoId: String(repoId),
      repoName: 'fixture-repo',
      indexId: 'index-1',
      selectedRefs: [{ refId: `${repoId}:skill-payments`, kind: 'skill', title: 'Payments Debugging Skill' }],
      availableRefs: [],
      rejectedRefs: [],
      createdAt: new Date(),
    });
    await db.collection('context_usage_traces').insertOne({
      traceId: 'usage-report-root',
      executionId: 'exec-report-root',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      packetId: 'packet-report-root',
      loaded: [],
      claimedUsed: [],
      skipped: [],
      validationPerformed: [],
      sawUsageKeys: true,
      createdAt: new Date(),
    });

    const report = await service.getExecutionContextUsageReport('exec-report-root');
    expect((report.diagnostics as Array<{ code: string }>).map((d) => d.code)).toEqual(expect.arrayContaining([
      'usage_extraction_failed',
      'skill_body_not_loaded',
      'child_context_missing',
    ]));
    expect(report.nodeSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ executionId: 'exec-report-child', diagnostics: expect.arrayContaining(['child_context_missing']) }),
    ]));
  });

  it('loads git-tracked skill body by knowledge ref', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const body = await service.getSkillBody({
      repoPath,
      refId: `${repoId}:skill-payments`,
    });

    expect(body.path).toBe('.claude/skills/payments/SKILL.md');
    expect(body.content).toContain('ledger-safe reconciliation');
    expect(body.tokenEstimate).toBeGreaterThan(0);
  });

  it('searches repo knowledge refs for follow-up context loading', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const result = await service.searchRepoKnowledge({
      repoPath,
      query: 'payment reconciliation production rules',
      nodeRole: 'backend-developer',
    });

    expect(result.refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: `${repoId}:prod-payments`, loadable: true }),
    ]));
  });

  it('saves generated graphs as temporal versions without overwriting old index nodes', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const first = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'api',
      graph: {
        repoSummary: 'first',
        nodes: [{ id: 'module-payments', kind: 'module', title: 'Payments', summary: 'first summary' }],
        edges: [],
      },
    });
    const second = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'api',
      graph: {
        repoSummary: 'second',
        nodes: [{ id: 'module-payments', kind: 'module', title: 'Payments', summary: 'second summary' }],
        edges: [],
      },
    });

    expect(first.indexId).not.toBe(second.indexId);
    const firstNode = await db.collection('knowledge_nodes').findOne({ repoId: String(repoId), indexId: first.indexId, stableKey: 'module-payments' });
    const secondNode = await db.collection('knowledge_nodes').findOne({ repoId: String(repoId), indexId: second.indexId, stableKey: 'module-payments' });
    expect(firstNode?.summary).toBe('first summary');
    expect(secondNode?.summary).toBe('second summary');
    const latest = await service.getLatestIndex(String(repoId));
    expect(latest?.indexId).toBe(second.indexId);
  });

  it('keeps latest indexes separate by graph mode', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const full = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'api',
      graphMode: 'full_graph',
      graph: {
        repoSummary: 'full graph',
        nodes: [{ id: 'module-full', kind: 'module', title: 'Full Module', summary: 'full graph node' }],
        edges: [],
      },
    });
    const mandatory = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'api',
      graphMode: 'mandatory_context_map',
      graph: {
        repoSummary: 'mandatory map',
        nodes: [{ id: 'root-agents', kind: 'instruction_file', title: 'Root AGENTS', path: 'AGENTS.md', summary: 'global repo instruction' }],
        edges: [],
      },
    });

    expect((await service.getLatestIndex(String(repoId), 'full_graph'))?.indexId).toBe(full.indexId);
    expect((await service.getLatestIndex(String(repoId), 'mandatory_context_map'))?.indexId).toBe(mandatory.indexId);
  });

  it('requires graph mode for manual agent-tool graph saves', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await expect(service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'agent_tool',
      graph: {
        repoSummary: 'missing mode',
        nodes: [],
        edges: [],
      },
    })).rejects.toThrow(/graph_mode is required/);
  });

  it('rejects generated graphs with wrong repo path casing before saving', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await expect(service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'agent_tool',
      graphMode: 'full_graph',
      graph: {
        repoSummary: 'bad casing',
        nodes: [{ id: 'root-agents-uppercase', kind: 'instruction_file', title: 'Root AGENTS', path: 'agents.md', summary: 'wrong path casing' }],
        edges: [],
      },
    })).rejects.toMatchObject({
      name: 'RepoKnowledgeGraphValidationError',
      payload: expect.objectContaining({
        ok: false,
        code: 'KNOWLEDGE_GRAPH_VALIDATION_FAILED',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'path_casing_mismatch',
            nodeId: 'root-agents-uppercase',
            path: 'agents.md',
            expectedPath: 'AGENTS.md',
          }),
        ]),
        repairHints: expect.arrayContaining([
          expect.stringMatching(/exact repo-relative paths/),
        ]),
      }),
    });
  });

  it('persists graph validation warnings with accepted graph versions', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const saved = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'api',
      graph: {
        repoSummary: 'validated',
        nodes: [
          { id: 'root-agents', kind: 'instruction_file', title: 'Root AGENTS', path: 'AGENTS.md', summary: 'global repo instruction' },
          { id: 'skill-payments', kind: 'skill', title: 'Payments Skill', path: '.claude/skills/payments/SKILL.md', summary: 'payment reconciliation' },
        ],
        edges: [],
      },
    });

    const latest = await service.getLatestIndex(String(repoId));
    expect(latest?.indexId).toBe(saved.indexId);
    expect(latest?.graphValidation?.status).toMatch(/warning|passed/);
    expect(latest?.graphValidation?.candidateCoverage).toBeTruthy();
  });

  it('instructs the indexer to reserve mandatory mappings for always-load guidelines only', () => {
    const inventory: KnowledgeCandidateInventory = {
      trackedPaths: ['AGENTS.md', 'docs/architecture.md', 'docs/coding-guidelines.md', 'package.json'],
      instructionFiles: ['AGENTS.md'],
      skillFiles: [],
      productionKnowledgeFiles: [],
      moduleRuleFiles: ['docs/coding-guidelines.md'],
      docsAndRunbooks: ['docs/architecture.md'],
      sourceModuleDirs: ['src'],
      packageScripts: [{ path: 'package.json', scripts: { test: 'vitest run' } }],
    };
    const workflowRoleInventory: WorkflowRoleInventoryEntry[] = [
      {
        role: 'engineering-lead',
        category: 'repo-operating',
        workflows: [{ workflowName: 'bug-investigate-and-fix', nodeName: 'implement' }],
        recommendedMandatoryContext: ['implementation workflow guidelines'],
        notes: 'Map mandatory context only for always-load engineering workflow guidelines.',
      },
    ];
    const spawnedAgentRoleInventory: WorkflowRoleInventoryEntry[] = [
      {
        role: 'devops-engineer',
        category: 'repo-operating',
        workflows: [],
        recommendedMandatoryContext: ['always-load coding guidelines', 'implementation process rules'],
        notes: 'Implementation-capable role; map only always-load guideline files as mandatory.',
      },
      {
        role: 'security-specialist',
        category: 'workflow-support',
        workflows: [],
        recommendedMandatoryContext: ['always-load process guidelines when available'],
        notes: 'Support role; map mandatory repo context only when a candidate file is an always-load guideline for the role.',
      },
      {
        role: 'test-writer',
        category: 'workflow-support',
        workflows: [],
        recommendedMandatoryContext: ['always-load process guidelines when available'],
        notes: 'Support role; map mandatory repo context only when a candidate file is an always-load guideline for the role.',
      },
      {
        role: 'documentation-writer',
        category: 'workflow-support',
        workflows: [],
        recommendedMandatoryContext: ['always-load process guidelines when available'],
        notes: 'Support role; map mandatory repo context only when a candidate file is an always-load guideline for the role.',
      },
    ];

    const prompt = buildIndexerUserPrompt('fixture-repo', repoPath, inventory, workflowRoleInventory, spawnedAgentRoleInventory);

    expect(prompt).toContain('MODE: full_graph');
    expect(prompt).toContain('mandatory_context_map');
    expect(prompt).toContain('mandatoryForNodeRoles means "always-load workflow node role guideline."');
    expect(prompt).toContain('Allen spawned specialist role inventory');
    expect(prompt).toContain('mandatoryForSpawnedAgentRoles');
    expect(prompt).toContain('mandatoryForSpawnerRoles');
    expect(prompt).toContain('It is valid for a role to have no mandatory mapping');
    expect(prompt).toContain('Do not mark architecture docs, module maps');
    expect(prompt).toContain('Command profile files such as package.json');
    expect(prompt).toContain('Cognee uses this graph only to identify Allen mandatory always-load context');
    expect(prompt).toContain('Workflow-support/output roles such as PR creation');
    expect(prompt).toContain('"role": "devops-engineer"');
    expect(prompt).toContain('"role": "security-specialist"');
    expect(prompt).toContain('"role": "test-writer"');
    expect(prompt).toContain('"role": "documentation-writer"');
    expect(prompt).toContain('"mandatoryForNodeRoles": []');
    expect(prompt).toContain('"mandatoryForSpawnedAgentRoles": []');
    expect(prompt).toContain('"mandatoryForSpawnerRoles": []');
    expect(prompt).not.toContain('"mandatoryForNodeRoles": ["backend-developer", "qa-lead"]');
    expect(prompt).not.toContain('map at least one mandatory context file');
    expect(prompt).not.toContain('every repo-operating role has at least one node');
    expect(workflowRoleGuidance('pr-creator')).toEqual(expect.objectContaining({
      category: 'workflow-support',
      recommendedMandatoryContext: [],
    }));
    expect(workflowRoleGuidance('security-specialist').category).toBe('repo-operating');
    expect(workflowRoleGuidance('test-writer').category).toBe('repo-operating');

    const mandatoryPrompt = buildIndexerUserPrompt('fixture-repo', repoPath, inventory, workflowRoleInventory, spawnedAgentRoleInventory, 'mandatory_context_map');
    expect(mandatoryPrompt).toContain('MODE: mandatory_context_map');
    expect(mandatoryPrompt).toContain('Build only always-load guideline/policy/process/safety context');
    expect(mandatoryPrompt).toContain('omit task-specific files from the output graph');
  });

  it('builds spawned-agent role inventory from seeded agents instead of a hard-coded subset', async () => {
    const inventory = await buildSpawnedAgentRoleInventory(db);
    const roles = inventory.map((entry) => entry.role);

    expect(roles).toEqual(expect.arrayContaining([
      'backend-developer',
      'frontend-developer',
      'devops-engineer',
      'security-specialist',
      'test-writer',
      'documentation-writer',
    ]));
  });

  it('accepts graphs without role mandatory mappings because only always-load guidelines should be mandatory', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const saved = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'api',
      graph: {
        repoSummary: 'role coverage',
        nodes: [
          {
            id: 'root-agents',
            kind: 'instruction_file',
            title: 'Root AGENTS',
            path: 'AGENTS.md',
            summary: 'global repo instruction',
          },
          {
            id: 'prod-payments',
            kind: 'production_note',
            title: 'Payments Production',
            path: 'docs/payments-production.md',
            summary: 'refund reconciliation production rule',
          },
        ],
        edges: [],
      },
    });

    const latest = await service.getLatestIndex(String(repoId));
    expect(latest?.indexId).toBe(saved.indexId);
    expect(latest?.graphValidation?.workflowRoleCoverage?.missingMandatoryMappingRoles).toEqual([]);
    const issueCodes = (latest?.graphValidation?.issues as Array<{ code: string }>).map((issue) => issue.code);
    expect(issueCodes).not.toContain('missing_mandatory_role_mapping');
    expect(issueCodes).not.toContain('workflow_role_missing_mandatory_mapping');
    expect(issueCodes).not.toContain('missing_mandatory_role_edges');
    expect(issueCodes).not.toContain('workflow_role_missing_mandatory_edge');
  });

  it('passes workflow role coverage when generated graph maps every active repo-operating role', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const saved = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'agent_tool',
      graphMode: 'full_graph',
      graph: {
        repoSummary: 'role coverage complete',
        nodes: [
          { id: 'root-agents', kind: 'instruction_file', title: 'Root AGENTS', path: 'AGENTS.md', summary: 'global repo instruction' },
          { id: 'role-backend-developer', kind: 'imported_agent', title: 'Allen workflow role: backend-developer', summary: 'Allen workflow node role.' },
          { id: 'role-bug-investigator', kind: 'imported_agent', title: 'Allen workflow role: bug-investigator', summary: 'Allen workflow node role.' },
          { id: 'role-qa-lead', kind: 'imported_agent', title: 'Allen workflow role: qa-lead', summary: 'Allen workflow node role.' },
          { id: 'role-code-reviewer', kind: 'imported_agent', title: 'Allen workflow role: code-reviewer', summary: 'Allen workflow node role.' },
          {
            id: 'prod-payments',
            kind: 'production_note',
            title: 'Payments Production',
            path: 'docs/payments-production.md',
            summary: 'refund reconciliation production rule',
            mandatoryForNodeRoles: ['backend-developer', 'bug-investigator', 'qa-lead', 'code-reviewer'],
          },
        ],
        edges: [
          { from: 'prod-payments', to: 'role-backend-developer', relation: 'MANDATORY_FOR_ROLE', confidence: 0.8, reason: 'Required by active workflow role backend-developer.' },
          { from: 'prod-payments', to: 'role-bug-investigator', relation: 'MANDATORY_FOR_ROLE', confidence: 0.8, reason: 'Required by active workflow role bug-investigator.' },
          { from: 'prod-payments', to: 'role-qa-lead', relation: 'MANDATORY_FOR_ROLE', confidence: 0.8, reason: 'Required by active workflow role qa-lead.' },
          { from: 'prod-payments', to: 'role-code-reviewer', relation: 'MANDATORY_FOR_ROLE', confidence: 0.8, reason: 'Required by active workflow role code-reviewer.' },
        ],
      },
    });

    const latest = await service.getLatestIndex(String(repoId));
    expect(latest?.indexId).toBe(saved.indexId);
    expect(latest?.graphValidation?.workflowRoleCoverage?.missingMandatoryMappingRoles).toEqual([]);
    expect((latest?.graphValidation?.issues as Array<{ code: string }>).map((issue) => issue.code)).not.toContain('workflow_role_missing_mandatory_mapping');
    expect((latest?.graphValidation?.issues as Array<{ code: string }>).map((issue) => issue.code)).not.toContain('missing_mandatory_role_edges');
    expect((latest?.graphValidation?.issues as Array<{ code: string }>).map((issue) => issue.code)).not.toContain('workflow_role_missing_mandatory_edge');
  });

  it('warns when broad task-specific graph nodes are marked mandatory', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const saved = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'api',
      graph: {
        repoSummary: 'broad mandatory warning',
        nodes: [
          {
            id: 'payments-production',
            kind: 'production_note',
            title: 'Payments Production',
            path: 'docs/payments-production.md',
            summary: 'refund reconciliation production notes',
            mandatoryForNodeRoles: ['backend-developer'],
          },
          { id: 'role-backend-developer', kind: 'imported_agent', title: 'Allen workflow role: backend-developer', summary: 'Allen workflow node role.' },
        ],
        edges: [
          { from: 'payments-production', to: 'role-backend-developer', relation: 'MANDATORY_FOR_ROLE', confidence: 0.8, reason: 'Broad production note incorrectly marked mandatory.' },
        ],
      },
    });

    const latest = await service.getLatestIndex(String(repoId));
    expect(latest?.indexId).toBe(saved.indexId);
    expect(latest?.graphValidation?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'broad_context_marked_mandatory',
        nodeId: 'payments-production',
        path: 'docs/payments-production.md',
      }),
    ]));
  });

  it('rejects agent-generated graphs that map mandatory context to repo-native non-workflow roles', async () => {
    const service = new RepoKnowledgeGraphService(db);
    try {
      await service.saveGeneratedGraph({
        repoId: String(repoId),
        source: 'agent_tool',
        graphMode: 'full_graph',
        graph: {
          repoSummary: 'bad role',
          nodes: [
            {
              id: 'prod-payments',
              kind: 'production_note',
              title: 'Payments Production',
              path: 'docs/payments-production.md',
              summary: 'refund reconciliation production rule',
              mandatoryForNodeRoles: ['incident-investigator'],
            },
          ],
          edges: [],
        },
      });
      throw new Error('Expected graph validation to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(RepoKnowledgeGraphValidationError);
      const payload = (err as RepoKnowledgeGraphValidationError).payload;
      expect(payload.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'unknown_mandatory_workflow_role',
          role: 'incident-investigator',
          actual: 'incident-investigator',
        }),
      ]));
      expect(payload.workflowRoleCoverage?.unknownMandatoryRoles).toEqual(['incident-investigator']);
      expect(payload.repairHints).toEqual(expect.arrayContaining([
        expect.stringMatching(/exact Allen workflow role names/),
      ]));
    }
  });

  it('accepts mandatory spawned-agent and spawner role mappings when roles are allowed', async () => {
    const service = new RepoKnowledgeGraphService(db);
    const saved = await service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'agent_tool',
      graphMode: 'mandatory_context_map',
      graph: {
        repoSummary: 'spawn role coverage',
        nodes: [
          {
            id: 'payments-guidelines',
            kind: 'context_file',
            title: 'Payments Coding Guidelines',
            path: 'docs/payments-guidelines.md',
            summary: 'Always-load implementation guidelines.',
            tags: ['guidelines', 'coding'],
            mandatoryForSpawnedAgentRoles: ['frontend-developer', 'security-specialist'],
            mandatoryForSpawnerRoles: ['backend-developer'],
          },
          { id: 'role-frontend-developer', kind: 'imported_agent', title: 'Allen spawned agent role: frontend-developer', summary: 'Spawned frontend implementation role.' },
          { id: 'role-security-specialist', kind: 'imported_agent', title: 'Allen spawned agent role: security-specialist', summary: 'Spawned security implementation role.' },
          { id: 'role-backend-developer', kind: 'imported_agent', title: 'Allen spawner role: backend-developer', summary: 'Workflow role that can spawn implementation agents.' },
        ],
        edges: [
          { from: 'payments-guidelines', to: 'role-frontend-developer', relation: 'MANDATORY_FOR_ROLE', confidence: 1, reason: 'Guideline is mandatory for spawned frontend implementation.' },
          { from: 'payments-guidelines', to: 'role-security-specialist', relation: 'MANDATORY_FOR_ROLE', confidence: 1, reason: 'Guideline is mandatory for spawned security implementation.' },
          { from: 'payments-guidelines', to: 'role-backend-developer', relation: 'MANDATORY_FOR_ROLE', confidence: 1, reason: 'Guideline is mandatory for backend-developer delegation.' },
        ],
      },
    });

    const latest = await service.getLatestIndex(String(repoId), 'mandatory_context_map');
    expect(latest?.indexId).toBe(saved.indexId);
    expect(latest?.graphValidation?.workflowRoleCoverage).toEqual(expect.objectContaining({
      mappedSpawnedAgentRoles: ['frontend-developer', 'security-specialist'],
      mappedSpawnerRoles: ['backend-developer'],
      unknownMandatorySpawnedRoles: [],
      unknownMandatorySpawnerRoles: [],
    }));
  });

  it('rejects unknown spawned-agent mandatory roles', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await expect(service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'agent_tool',
      graphMode: 'mandatory_context_map',
      graph: {
        repoSummary: 'bad spawned role',
        nodes: [
          {
            id: 'payments-guidelines',
            kind: 'context_file',
            title: 'Payments Coding Guidelines',
            path: 'docs/payments-guidelines.md',
            summary: 'Always-load implementation guidelines.',
            tags: ['guidelines', 'coding'],
            mandatoryForSpawnedAgentRoles: ['mobile-developer'],
          },
        ],
        edges: [],
      },
    })).rejects.toMatchObject({
      payload: expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'unknown_mandatory_spawned_agent_role',
            role: 'mobile-developer',
          }),
        ]),
      }),
    });
  });

  it('returns structured validation JSON from the repo graph save route', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/repos', repoRoutes(db));

    const res = await request(app)
      .post(`/api/repos/knowledge-graph?path=${encodeURIComponent(repoPath)}`)
      .send({
        graph_mode: 'full_graph',
        graph: {
          repoSummary: 'bad casing via route',
          nodes: [
            { id: 'root-agents-uppercase', kind: 'instruction_file', title: 'Root AGENTS', path: 'agents.md', summary: 'wrong path casing' },
          ],
          edges: [],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      ok: false,
      code: 'KNOWLEDGE_GRAPH_VALIDATION_FAILED',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'path_casing_mismatch',
          nodeId: 'root-agents-uppercase',
          path: 'agents.md',
          expectedPath: 'AGENTS.md',
        }),
      ]),
      repairHints: expect.arrayContaining([
        expect.stringMatching(/exact repo-relative paths/),
      ]),
    }));
  });

  it('returns broken edge details in structured validation payloads', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await expect(service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'agent_tool',
      graphMode: 'full_graph',
      graph: {
        repoSummary: 'bad edge',
        nodes: [
          {
            id: 'prod-payments',
            kind: 'production_note',
            title: 'Payments Production',
            path: 'docs/payments-production.md',
            summary: 'refund reconciliation production rule',
            mandatoryForNodeRoles: ['backend-developer'],
          },
        ],
        edges: [
          { from: 'prod-payments', to: 'role-backend-developer', relation: 'MANDATORY_FOR_ROLE', confidence: 0.8, reason: 'missing target node' },
        ],
      },
    })).rejects.toMatchObject({
      payload: expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'broken_edge_reference',
            edge: expect.objectContaining({
              from: 'prod-payments',
              to: 'role-backend-developer',
              relation: 'MANDATORY_FOR_ROLE',
            }),
          }),
        ]),
        repairHints: expect.arrayContaining([
          expect.stringMatching(/Every edge/),
        ]),
      }),
    });
  });

  it('rejects agent-generated mandatory mappings without role edges', async () => {
    const service = new RepoKnowledgeGraphService(db);
    await expect(service.saveGeneratedGraph({
      repoId: String(repoId),
      source: 'agent_tool',
      graphMode: 'full_graph',
      graph: {
        repoSummary: 'missing mandatory role edge',
        nodes: [
          {
            id: 'prod-payments',
            kind: 'production_note',
            title: 'Payments Production',
            path: 'docs/payments-production.md',
            summary: 'refund reconciliation production rule',
            mandatoryForNodeRoles: ['backend-developer'],
          },
        ],
        edges: [],
      },
    })).rejects.toMatchObject({
      payload: expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'missing_mandatory_role_edges' }),
          expect.objectContaining({ code: 'workflow_role_missing_mandatory_edge', role: 'backend-developer' }),
        ]),
      }),
    });
  });
});
