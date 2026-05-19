import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Collection, Db } from 'mongodb';
import { withArtifactsGuidance, withNonInteractiveGuidance, normalizeModelAlias } from '@allen/engine';
import type { SystemAction } from './cron.types.js';
import {
  RepoContextEngine,
  type RepoContextProvider,
} from './repo-context-engine.js';
import {
  WorkflowContextInjectionAdapter,
  summarizeInjection,
} from './workflow-context-injection-adapter.js';
import {
  KNOWLEDGE_GRAPH_INDEX_VERSION,
  type KnowledgeEdgeRecord,
  type KnowledgeNodeKind,
  type KnowledgeNodeRecord,
  type ParsedUsage,
  type RawGraphNode,
  type RawKnowledgeGraph,
  type UsageToolCall,
} from './repo-knowledge-graph.types.js';
import { buildIndexerPrompt, buildKnowledgeCandidateInventory, buildWorkflowRoleInventory } from './repo-knowledge-graph-indexer.js';
import {
  collectCurrentFiles,
  gitHeadSha,
  hasMeaningfulRepoPath,
  isGitTracked,
  isPathInside,
  normalizeRepoContextProvider,
  resolveRepoFromPath,
  sanitizeRepoRelativePath,
} from './repo-knowledge-graph-paths.js';
import {
  RepoKnowledgeGraphValidationError,
  isRepoKnowledgeGraphValidationError,
  determineInjectPolicy,
  isFileBackedContextKind,
  isContextBodyLoadableKind,
  parseGraphJson,
  validateRawGraphForPersistence,
} from './repo-knowledge-graph-validation.js';
import {
  addSystemInjectedContextUsage,
  collectContextBodyLoadsFromUsage,
  collectPreselectedContextFromPacket,
  collectSkillBodyLoadsFromUsage,
  contextDiagnostic,
  extractUsage,
  knowledgeRefKindMap,
  mergeUsageArrays,
  normalizeUsageArray,
  verifyContextUsageClaims,
} from './repo-knowledge-graph-usage.js';
import { arrayOfStrings, firstString, hashJson, normalizeKind, normalizeRelation, sha256, stableNodeKey } from './repo-knowledge-graph-utils.js';
import { ContextEvaluationService } from './context-evaluation.service.js';
import { ContextWorkflowEvaluationService } from './context-workflow-evaluation.service.js';

export { KNOWLEDGE_GRAPH_INDEX_VERSION } from './repo-knowledge-graph.types.js';
export type { KnowledgeEdgeRecord, KnowledgeNodeRecord } from './repo-knowledge-graph.types.js';
export type { RepoKnowledgeGraphValidationErrorPayload } from './repo-knowledge-graph-validation.js';
export { RepoKnowledgeGraphValidationError, isRepoKnowledgeGraphValidationError } from './repo-knowledge-graph-validation.js';

const INDEX_TIMEOUT_MS = 60 * 60 * 1000;
const SEARCH_REPO_KNOWLEDGE_LIMIT = 12;

export class RepoKnowledgeGraphService {
  private repos: Collection;
  private indexes: Collection;
  private nodes: Collection<KnowledgeNodeRecord>;
  private edges: Collection<KnowledgeEdgeRecord>;
  private packets: Collection;
  private usage: Collection;

  constructor(private db: Db) {
    this.repos = db.collection('repos');
    this.indexes = db.collection('repo_knowledge_indexes');
    this.nodes = db.collection<KnowledgeNodeRecord>('knowledge_nodes');
    this.edges = db.collection<KnowledgeEdgeRecord>('knowledge_edges');
    this.packets = db.collection('node_context_packets');
    this.usage = db.collection('context_usage_traces');
  }

  async scheduleIndex(repoId: string): Promise<{ scheduled: boolean; reason?: string; executionId?: string }> {
    const { ObjectId } = await import('mongodb');
    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo) return { scheduled: false, reason: 'Repo not found' };

    const claim = await this.repos.updateOne(
      { _id: new ObjectId(repoId), 'knowledgeGraphIndex.status': { $ne: 'indexing' } },
      { $set: { knowledgeGraphIndex: { status: 'indexing', startedAt: new Date() } } },
    );
    if (claim.matchedCount === 0) return { scheduled: false, reason: 'Index already in progress' };

    const executionId = randomUUID();
    this.runIndex(repoId, repo.path as string, repo.name as string, executionId).catch((err) => {
      console.error(`[repo-knowledge-graph] index failed for ${repoId}:`, err);
    });
    return { scheduled: true, executionId };
  }

  async getLatestIndex(repoId: string): Promise<Record<string, unknown> | null> {
    return this.indexes.findOne({ repoId, latest: true }, { sort: { indexedAt: -1 } });
  }

  async getLatestGraph(repoId: string): Promise<Record<string, unknown> | null> {
    const index = await this.getLatestIndex(repoId);
    if (!index) return null;
    const indexId = String(index.indexId);
    const [nodes, edges] = await Promise.all([
      this.nodes.find({ repoId, indexId }).toArray(),
      this.edges.find({ repoId, indexId }).toArray(),
    ]);
    return { index, nodes, edges };
  }

  async saveGeneratedGraph(input: {
    repoId?: string;
    repoPath?: string;
    graph?: RawKnowledgeGraph;
    graphJson?: string;
    sourceExecutionId?: string;
    source?: 'api' | 'agent_tool';
  }): Promise<{ repoId: string; indexId: string; nodeCount: number; edgeCount: number; latest: true }> {
    const repo = input.repoId
      ? await this.repoById(input.repoId)
      : await resolveRepoFromPath(this.db, input.repoPath);
    if (!repo) throw new Error('Repo not found');

    const graph = input.graph ?? (input.graphJson ? parseGraphJson(input.graphJson) : undefined);
    if (!graph || !Array.isArray(graph.nodes)) {
      throw new Error('graph or graphJson with a nodes array is required');
    }

    const repoId = String(repo._id);
    const repoPath = String(repo.path ?? input.repoPath ?? '');
    const headSha = repoPath ? await gitHeadSha(repoPath) : undefined;
    return this.persistGraph({
      repoId,
      repoName: String(repo.name ?? repoId),
      repoPath,
      headSha,
      graph,
      executionId: input.sourceExecutionId,
      costUsd: 0,
      source: input.source ?? 'api',
    });
  }

  async buildNodeContextPacket(input: {
    executionId: string;
    workflowName: string;
    nodeName: string;
    nodeRole?: string;
    attempt: number;
    state: Record<string, unknown>;
    prompt?: string;
    parentPacketId?: string;
    parentExecutionId?: string | null;
    rootExecutionId?: string;
    provider?: RepoContextProvider;
  }): Promise<{ packetId: string; promptBlock: string; systemPromptBlock: string; traceSummary: any } | null> {
    const pathHint = firstString(input.state.worktree_path, input.state.repo_path, input.state.repository_path);
    const repo = await resolveRepoFromPath(this.db, pathHint);
    if (!repo) return null;
    const repoId = String(repo._id);
    const index = await this.getLatestIndex(repoId);
    if (!index) return null;

    const indexId = String(index.indexId);
    const allNodes = await this.nodes.find({ repoId, indexId }).toArray();
    if (allNodes.length === 0) return null;

    const currentFiles = collectCurrentFiles(input.state, input.prompt);
    const packetId = randomUUID();
    const provider = normalizeRepoContextProvider(input.provider);
    const contextEngine = new RepoContextEngine(undefined, undefined, { db: this.db });
    const adapter = new WorkflowContextInjectionAdapter();
    const packet = await contextEngine.buildPacket({
      packetId,
      executionId: input.executionId,
      repoId,
      repoName: String(repo.name ?? ''),
      repoPath: String(repo.path ?? ''),
      indexId,
      indexFreshness: ((index.freshness as { status?: string } | undefined)?.status ?? 'fresh'),
      workflowName: input.workflowName,
      nodeName: input.nodeName,
      nodeRole: input.nodeRole,
      attempt: input.attempt,
      state: input.state,
      prompt: input.prompt,
      provider,
      currentFiles,
      nodes: allNodes,
      worktreePath: input.state.worktree_path,
      parentPacketId: input.parentPacketId,
      parentExecutionId: input.parentExecutionId,
      rootExecutionId: input.rootExecutionId,
    });
    const injection = await adapter.buildInjection({
      packet,
      provider,
      repoPath: String(repo.path ?? ''),
      worktreePath: firstString(input.state.worktree_path, input.state.repo_path, input.state.repository_path),
    });
    const systemPromptBlock = adapter.renderSystemPromptBlock(injection);
    const promptBlock = adapter.renderContextPacket(packet);
    const contextInjection = summarizeInjection(injection);
    await this.packets.insertOne({
      ...packet,
      diagnostics: packet.providerDiagnostics,
      contextInjection,
      systemPromptBlockHash: systemPromptBlock ? sha256(systemPromptBlock) : undefined,
      systemPromptBlockChars: systemPromptBlock.length,
      systemPromptBlock,
    });

    const traceSummary = {
      packetId,
      repoId,
      repoName: repo.name,
      indexId,
      indexFreshness: packet.indexFreshness,
      retrievalProviders: packet.retrievalProviders,
      providerDiagnostics: packet.providerDiagnostics,
      rerankerProviders: packet.rerankerProviders,
      rerankerDiagnostics: packet.rerankerDiagnostics,
      selectedContextCount: packet.selectedRefs.length,
      injectedContextCount: injection.injectedRefs.length,
      providerTextContextCount: packet.selectedRefs.filter((ref) => ref.itemType === 'provider_text' || ref.itemType === 'provider_generated').length,
      repoBackedContextCount: packet.selectedRefs.filter((ref) => ref.grounding === 'repo_backed').length,
      mandatoryCount: packet.selectedRefs.filter((ref) => ref.mandatory).length,
      recommendedCount: packet.selectedRefs.filter((ref) => !ref.mandatory).length,
      skillCount: packet.selectedRefs.filter((ref) => ref.kind === 'skill' || ref.kind === 'skill_reference').length,
      productionKnowledgeCount: packet.selectedRefs.filter((ref) => ref.kind === 'production_note' || ref.kind === 'runbook').length,
      preselectedContextCount: packet.selectedRefs.length,
      availableContextCount: packet.availableRefs.length,
      contextInjection,
      mandatoryContextInjected: injection.injectedRefs.length > 0,
      mandatoryContextInjectedCount: injection.injectedRefs.length,
      mandatoryContextSkippedProviderNativeCount: injection.providerNativeRefs.length,
      mandatoryContextSkippedOversizeCount: injection.skippedRefs.filter((ref) => ref.skipReason === 'oversize').length,
      mandatoryContextSkippedBudgetCount: injection.skippedRefs.filter((ref) => ref.skipReason === 'budget').length,
      mandatoryContextTargetLayer: injection.targetLayer,
      systemPromptContextInjected: systemPromptBlock.length > 0,
      contextProvider: packet.retrievalProviders[0],
    };

    return {
      packetId,
      traceSummary,
      systemPromptBlock,
      promptBlock,
    };
  }

  async recordContextUsage(input: {
    executionId: string;
    executionTraceId?: string;
    workflowName: string;
    nodeName: string;
    nodeRole?: string;
    attempt: number;
    packetId?: string;
    outputs: Record<string, unknown>;
    rawResponse?: string;
    toolCalls?: UsageToolCall[];
    parentPacketId?: string | null;
    parentExecutionId?: string | null;
    rootExecutionId?: string;
    parentNodeName?: string;
    agentName?: string;
  }): Promise<{
    traceId: string;
    preselectedCount: number;
    loadedCount: number;
    appliedCount: number;
    skippedCount: number;
    repoContextUsage: Record<string, unknown>;
    contextEvaluation?: Record<string, unknown>;
  } | null> {
    if (!input.packetId) return null;
    const parsed = extractUsage(input.outputs, input.rawResponse, input.toolCalls);
    const packet = await this.packets.findOne({ packetId: input.packetId }).catch(() => null);
    addSystemInjectedContextUsage(parsed, packet as Record<string, unknown> | null);
    const verification = verifyContextUsageClaims(parsed, packet as Record<string, unknown> | null);
    const traceId = randomUUID();
    await this.usage.insertOne({
      traceId,
      executionId: input.executionId,
      executionTraceId: input.executionTraceId,
      workflowName: input.workflowName,
      nodeName: input.nodeName,
      nodeRole: input.nodeRole,
      attempt: input.attempt,
      packetId: input.packetId,
      parentPacketId: input.parentPacketId,
      parentExecutionId: input.parentExecutionId,
      rootExecutionId: input.rootExecutionId,
      parentNodeName: input.parentNodeName,
      agentName: input.agentName,
      moduleIdentified: parsed.moduleIdentified,
      contextPreselected: mergeUsageArrays(collectPreselectedContextFromPacket(packet as Record<string, unknown> | null), parsed.preselected),
      contextSummaryUsed: parsed.summaryUsed,
      loaded: parsed.loaded,
      claimedUsed: parsed.applied,
      reportedLoaded: parsed.reportedLoaded,
      reportedApplied: parsed.reportedApplied,
      skipped: parsed.skipped,
      validationPerformed: parsed.validationPerformed,
      usageSummary: parsed.usageSummary,
      extractionSources: parsed.extractionSources,
      skillBodyLoads: parsed.skillBodyLoads,
      contextBodyLoads: parsed.contextBodyLoads,
      unverifiedClaims: verification.unverifiedClaims,
      malformedReportedUsage: parsed.malformedReportedUsage,
      diagnostics: [...parsed.diagnostics, ...verification.diagnostics],
      sawUsageKeys: parsed.sawUsageKeys,
      createdAt: new Date(),
    });
    const evaluationService = new ContextEvaluationService(this.db);
    const evaluation = await evaluationService.evaluateUsageTrace({
      executionId: input.executionId,
      executionTraceId: input.executionTraceId,
      nodeName: input.nodeName,
      attempt: input.attempt,
      packetId: input.packetId,
      usageTraceId: traceId,
    }).catch((err) => {
      console.warn('[repo-knowledge-graph] context evaluation failed:', (err as Error).message);
      return null;
    });
    return {
      traceId,
      loadedCount: parsed.loaded.length,
      appliedCount: parsed.applied.length,
      skippedCount: parsed.skipped.length,
      preselectedCount: collectPreselectedContextFromPacket(packet as Record<string, unknown> | null).length,
      repoContextUsage: buildSynthesizedRepoContextUsage(parsed, packet as Record<string, unknown> | null, verification),
      contextEvaluation: evaluation ? summarizeContextEvaluationForTrace(evaluation) : undefined,
    };
  }

  async getExecutionContextUsageReport(executionId: string): Promise<Record<string, unknown>> {
    const descendants = await this.db.collection('executions')
      .find(
        {
          $or: [
            { parentExecutionId: executionId },
            { rootExecutionId: executionId },
          ],
        },
        { projection: { id: 1, workflowName: 1, input: 1, meta: 1, parentExecutionId: 1, parentCaller: 1, rootExecutionId: 1, completedNodes: 1, currentNodes: 1 } },
      )
      .toArray();
    const executionIds = Array.from(new Set([
      executionId,
      ...descendants.map((row) => String(row.id)).filter(Boolean),
    ]));

    const evaluationService = new ContextEvaluationService(this.db);
    const workflowEvaluationService = new ContextWorkflowEvaluationService(this.db);
    const [packets, usage, traces, executions, evaluations, workflowSemanticEvaluation] = await Promise.all([
      this.packets.find({ executionId: { $in: executionIds } }).sort({ createdAt: 1 }).toArray(),
      this.usage.find({
        $or: [
          { executionId: { $in: executionIds } },
          { parentExecutionId: executionId },
          { rootExecutionId: executionId },
        ],
      }).sort({ createdAt: 1 }).toArray(),
      this.db.collection('execution_traces').find(
        { executionId: { $in: executionIds }, type: 'agent' },
        { projection: { executionId: 1, node: 1, agent: 1, attempt: 1, rawResponse: 1, repoKnowledgeInjected: 1, contextUsage: 1, toolCalls: 1 } },
      ).toArray(),
      this.db.collection('executions').find(
        { id: { $in: executionIds } },
        { projection: { id: 1, workflowName: 1, input: 1, meta: 1, parentExecutionId: 1, parentCaller: 1, rootExecutionId: 1, completedNodes: 1, currentNodes: 1, feedbackEntries: 1 } },
      ).toArray(),
      evaluationService.getEvaluationsForExecutions(executionIds),
      workflowEvaluationService.getForExecution(executionId),
    ]);

    const packetKey = (executionIdValue: string, nodeName: string, attempt?: number) => `${executionIdValue}:${nodeName}:${attempt ?? 1}`;
    const packetByKey = new Map<string, any>();
    for (const packet of packets) packetByKey.set(packetKey(String(packet.executionId), String(packet.nodeName), Number(packet.attempt ?? 1)), packet);
    const usageByKey = new Map<string, any>();
    for (const row of usage) usageByKey.set(packetKey(String(row.executionId), String(row.nodeName), Number(row.attempt ?? 1)), row);
    const evaluationByKey = new Map<string, any>();
    for (const row of evaluations) evaluationByKey.set(packetKey(String(row.executionId), String(row.nodeName), Number(row.attempt ?? 1)), row);
    const execById = new Map(executions.map((row) => [String(row.id), row]));

    const diagnostics: Array<Record<string, unknown>> = [];
    const contextPreselected: Array<Record<string, unknown>> = [];
    const skillBodyLoads: Array<Record<string, unknown>> = [];
    const contextBodyLoads: Array<Record<string, unknown>> = [];
    const nodeSummaries = traces.map((trace) => {
      const exec = execById.get(String(trace.executionId));
      const nodeName = String(trace.node ?? trace.agent ?? '');
      const attempt = Number(trace.attempt ?? 1);
      const packet = packetByKey.get(packetKey(String(trace.executionId), nodeName, attempt));
      const usageRow = usageByKey.get(packetKey(String(trace.executionId), nodeName, attempt));
      const evaluationRow = evaluationByKey.get(packetKey(String(trace.executionId), nodeName, attempt));
      const codes: string[] = [];
      const hasRepoPath = hasMeaningfulRepoPath(
        firstString(
          (exec?.input as Record<string, unknown> | undefined)?.repo_path,
          (exec?.meta as Record<string, unknown> | undefined)?.cwd,
        ),
      );

      if (!packet && hasRepoPath) {
        const code = exec?.parentExecutionId ? 'child_context_missing' : 'context_packet_missing';
        codes.push(code);
        diagnostics.push(contextDiagnostic(code, 'warn', trace, packet, `${nodeName} did not have a repo knowledge packet.`));
      }

      if (packet && !usageRow) {
        codes.push('usage_missing');
        diagnostics.push(contextDiagnostic('usage_missing', 'warn', trace, packet, `${nodeName} had a context packet but no usage trace.`));
      }

      const loadedCount = Array.isArray(usageRow?.loaded) ? usageRow.loaded.length : 0;
      const preselectedCount = Array.isArray(usageRow?.contextPreselected)
        ? usageRow.contextPreselected.length
        : Array.isArray(packet?.selectedRefs)
          ? packet.selectedRefs.length
          : 0;
      const appliedCount = Array.isArray(usageRow?.claimedUsed) ? usageRow.claimedUsed.length : 0;
      const skippedCount = Array.isArray(usageRow?.skipped) ? usageRow.skipped.length : 0;
      const validationCount = Array.isArray(usageRow?.validationPerformed) ? usageRow.validationPerformed.length : 0;
      for (const diagnostic of normalizeUsageArray(usageRow?.diagnostics)) {
        const code = firstString(diagnostic.code);
        if (!code) continue;
        codes.push(code);
        diagnostics.push({
          ...diagnostic,
          executionId: String(trace.executionId ?? ''),
          nodeName,
          agentName: trace.agent,
          packetId: packet?.packetId,
        });
      }
      if (usageRow && loadedCount === 0 && appliedCount === 0 && skippedCount === 0 && validationCount === 0 && !usageRow.moduleIdentified) {
        const code = usageRow.sawUsageKeys ? 'usage_extraction_failed' : 'usage_empty';
        codes.push(code);
        diagnostics.push(contextDiagnostic(code, 'warn', trace, packet, `${nodeName} produced an empty context usage trace.`));
      }

      const preselectedRows = normalizeUsageArray(usageRow?.contextPreselected ?? packet?.selectedRefs);
      const reportedSkillLoads = collectSkillBodyLoadsFromUsage(usageRow, String(trace.executionId), nodeName, String(trace.agent ?? nodeName));
      skillBodyLoads.push(...reportedSkillLoads);
      const selectedRefs = normalizeUsageArray(packet?.selectedRefs);
      const skillRefs = selectedRefs.filter((ref) => ref.kind === 'skill' || ref.kind === 'skill_reference');
      if (packet && skillRefs.length > 0 && reportedSkillLoads.length === 0) {
        const code = 'skill_body_not_loaded';
        codes.push(code);
        diagnostics.push(contextDiagnostic(code, 'info', trace, packet, `${nodeName} had skill refs available but no skill body load was recorded.`));
      }

      const reportedContextLoads = collectContextBodyLoadsFromUsage(usageRow, String(trace.executionId), nodeName, String(trace.agent ?? nodeName));
      contextBodyLoads.push(...reportedContextLoads);
      for (const item of preselectedRows) {
        contextPreselected.push({
          executionId: String(trace.executionId),
          nodeName,
          agentName: trace.agent,
          refId: item.refId,
          path: item.path,
          kind: item.kind,
          source: 'runtime_preselected',
        });
      }
      const contextLoadRefIds = new Set(reportedContextLoads.map((row) => String(row.refId ?? '')).filter(Boolean));
      const contextRefKindsById = knowledgeRefKindMap(packet);
      const productionRefs = selectedRefs.filter((ref) => ref.kind === 'production_note' || ref.kind === 'runbook');
      if (packet && productionRefs.length > 0 && reportedContextLoads.length === 0) {
        const code = 'production_context_body_not_loaded';
        codes.push(code);
        diagnostics.push(contextDiagnostic(code, 'info', trace, packet, `${nodeName} had production knowledge refs available but no context body load was recorded.`));
      }
      for (const item of [...normalizeUsageArray(usageRow?.loaded), ...normalizeUsageArray(usageRow?.claimedUsed)]) {
        const refId = firstString(item.refId, item.ref_id);
        if (!refId) continue;
        const kind = contextRefKindsById.get(refId);
        if (kind && isFileBackedContextKind(kind) && !contextLoadRefIds.has(refId)) {
          const code = 'context_claimed_without_body_load';
          codes.push(code);
          diagnostics.push(contextDiagnostic(code, 'warn', trace, packet, `${nodeName} claimed ${refId} as loaded/applied but no get_repo_context_body call was recorded.`));
        }
      }

      return {
        executionId: String(trace.executionId),
        nodeName,
        nodeRole: packet?.nodeRole ?? trace.agent,
        agentName: trace.agent,
        parentExecutionId: exec?.parentExecutionId ?? packet?.parentExecutionId ?? null,
        parentNodeName: exec?.parentCaller ?? packet?.parentNodeName ?? null,
        packetId: packet?.packetId,
        parentPacketId: packet?.parentPacketId ?? null,
        usageTraceId: usageRow?.traceId,
        contextInjection: packet?.contextInjection,
        contextEvaluation: evaluationRow ? {
          traceId: evaluationRow.traceId,
          status: evaluationRow.status,
          scores: evaluationRow.scores,
          semantic: evaluationRow.semantic,
          diagnostics: normalizeUsageArray(evaluationRow.diagnostics).map((diag) => diag.code).filter(Boolean),
          feedbackEvidenceCount: normalizeUsageArray(evaluationRow.feedbackEvidence).length,
        } : undefined,
        preselectedCount,
        loadedCount,
        appliedCount,
        skippedCount,
        validationCount,
        diagnostics: codes,
      };
    });

    return {
      executionId,
      executionIds,
      packets,
      usage,
      evaluations,
      evaluationSummary: evaluationService.rollup(evaluations as Array<Record<string, unknown>>),
      workflowSemanticEvaluation,
      nodeSummaries,
      diagnostics,
      contextPreselected,
      skillBodyLoads,
      contextBodyLoads,
      contextInjections: packets
        .filter((packet) => packet.contextInjection)
        .map((packet) => ({
          packetId: packet.packetId,
          executionId: packet.executionId,
          nodeName: packet.nodeName,
          nodeRole: packet.nodeRole,
          ...(packet.contextInjection as Record<string, unknown>),
        })),
    };
  }

  async getSkillBody(input: {
    repoPath: string;
    refId?: string;
    skillPath?: string;
  }): Promise<{
    repoId: string;
    repoName?: string;
    indexId: string;
    refId?: string;
    title?: string;
    path: string;
    content: string;
    tokenEstimate: number;
  }> {
    const repo = await resolveRepoFromPath(this.db, input.repoPath);
    if (!repo) throw new Error('Repo not found');
    const repoId = String(repo._id);
    const index = await this.getLatestIndex(repoId);
    if (!index) throw new Error('No knowledge graph index found for repo');
    const indexId = String(index.indexId);

    const refId = input.refId?.trim();
    const requestedPath = input.skillPath?.trim();
    const node = refId
      ? await this.nodes.findOne({ repoId, indexId, id: refId })
      : requestedPath
        ? await this.nodes.findOne({ repoId, indexId, path: sanitizeRepoRelativePath(requestedPath) })
        : null;
    const skillPath = sanitizeRepoRelativePath(String(node?.path ?? requestedPath ?? ''));
    if (!skillPath) throw new Error('refId or skillPath must identify a repo skill file');
    if (node && !['skill', 'skill_reference'].includes(node.kind)) {
      throw new Error(`Knowledge node ${node.id} is ${node.kind}, not a skill`);
    }
    if (!skillPath.endsWith('SKILL.md') && !skillPath.endsWith('/skill.md') && !skillPath.endsWith('/SKILL.md')) {
      throw new Error('Only skill markdown files can be loaded with get_repo_skill_body');
    }

    const requestedBase = input.repoPath && existsSync(join(input.repoPath, skillPath))
      ? input.repoPath
      : String(repo.path ?? input.repoPath);
    const absolutePath = join(requestedBase, skillPath);
    if (!isPathInside(requestedBase, absolutePath)) throw new Error('Resolved skill path escapes repo root');
    if (!(await isGitTracked(requestedBase, skillPath))) {
      throw new Error(`Skill file is not git-tracked in repo: ${skillPath}`);
    }

    const content = await readFile(absolutePath, 'utf8');
    return {
      repoId,
      repoName: String(repo.name ?? ''),
      indexId,
      refId: node?.id,
      title: node?.title,
      path: skillPath,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
    };
  }

  async getContextBody(input: {
    repoPath: string;
    refId?: string;
    contextPath?: string;
  }): Promise<{
    repoId: string;
    repoName?: string;
    indexId: string;
    refId?: string;
    kind?: KnowledgeNodeKind;
    title?: string;
    path: string;
    content: string;
    tokenEstimate: number;
  }> {
    const repo = await resolveRepoFromPath(this.db, input.repoPath);
    if (!repo) throw new Error('Repo not found');
    const repoId = String(repo._id);
    const index = await this.getLatestIndex(repoId);
    if (!index) throw new Error('No knowledge graph index found for repo');
    const indexId = String(index.indexId);

    const refId = input.refId?.trim();
    const requestedPath = input.contextPath?.trim();
    const node = refId
      ? await this.nodes.findOne({ repoId, indexId, id: refId })
      : requestedPath
        ? await this.nodes.findOne({ repoId, indexId, path: sanitizeRepoRelativePath(requestedPath) })
        : null;
    const contextPath = sanitizeRepoRelativePath(String(node?.path ?? requestedPath ?? ''));
    if (!contextPath) throw new Error('refId or contextPath must identify a repo context file');
    if (node && ['skill', 'skill_reference'].includes(node.kind)) {
      throw new Error(`Knowledge node ${node.id} is a skill; use get_repo_skill_body instead`);
    }
    if (node && !isContextBodyLoadableKind(node.kind)) {
      throw new Error(`Knowledge node ${node.id} is ${node.kind}, not a loadable context file`);
    }

    const requestedBase = input.repoPath && existsSync(join(input.repoPath, contextPath))
      ? input.repoPath
      : String(repo.path ?? input.repoPath);
    const absolutePath = join(requestedBase, contextPath);
    if (!isPathInside(requestedBase, absolutePath)) throw new Error('Resolved context path escapes repo root');
    if (!(await isGitTracked(requestedBase, contextPath))) {
      throw new Error(`Context file is not git-tracked in repo: ${contextPath}`);
    }

    const content = await readFile(absolutePath, 'utf8');
    return {
      repoId,
      repoName: String(repo.name ?? ''),
      indexId,
      refId: node?.id,
      kind: node?.kind,
      title: node?.title,
      path: contextPath,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
    };
  }

  async searchRepoKnowledge(input: {
    repoPath: string;
    query: string;
    nodeRole?: string;
    currentFiles?: string[];
    limit?: number;
  }): Promise<{
    repoId: string;
    repoName?: string;
    indexId: string;
    refs: Array<Record<string, unknown>>;
  }> {
    const repo = await resolveRepoFromPath(this.db, input.repoPath);
    if (!repo) throw new Error('Repo not found');
    const repoId = String(repo._id);
    const index = await this.getLatestIndex(repoId);
    if (!index) throw new Error('No knowledge graph index found for repo');
    const indexId = String(index.indexId);
    const limit = Math.max(1, Math.min(Number(input.limit ?? SEARCH_REPO_KNOWLEDGE_LIMIT), 30));
    const nodes = await this.nodes.find({ repoId, indexId }).toArray();
    const refs = new RepoContextEngine()
      .search({
        repoId,
        repoName: String(repo.name ?? ''),
        repoPath: String(repo.path ?? input.repoPath),
        indexId,
        indexFreshness: ((index.freshness as { status?: string } | undefined)?.status ?? 'fresh'),
        workflowName: 'search_repo_knowledge',
        nodeName: input.nodeRole ?? 'search',
        nodeRole: input.nodeRole,
        attempt: 1,
        state: { repo_path: input.repoPath },
        provider: 'unknown',
        currentFiles: input.currentFiles ?? [],
        nodes,
        query: input.query,
        limit,
      })
      .map((ref) => ({ ...ref, why: ref.reason }));
    return {
      repoId,
      repoName: String(repo.name ?? ''),
      indexId,
      refs,
    };
  }

  private async runIndex(repoId: string, repoPath: string, repoName: string, executionId: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    const startedAt = new Date();
    let headSha: string | undefined;
    let costUsd = 0;
    let error: string | undefined;
    let rawResponse = '';
    let model = 'sonnet';

    try {
      headSha = await gitHeadSha(repoPath);
      const agent = await this.db.collection('agents').findOne({ name: 'repo-knowledge-graph-indexer' });
      if (!agent) throw new Error('repo-knowledge-graph-indexer agent not seeded');
      model = normalizeModelAlias((agent.model as string) ?? 'sonnet') ?? 'sonnet';

      await this.db.collection('executions').insertOne({
        id: executionId,
        workflowName: 'chat:spawn_agent/repo-knowledge-graph-indexer',
        workflowId: null,
        workflowVersion: 0,
        status: 'running',
        source: 'chat',
        input: { prompt: `repo-knowledge-graph-index: ${repoName}`, agent_name: 'repo-knowledge-graph-indexer', repo_path: repoPath },
        meta: { cwd: repoPath, provider: 'claude', model, spawnedBy: 'repo-knowledge-graph-indexer' },
        state: {},
        sessions: {},
        retryCounts: {},
        currentNodes: ['repo-knowledge-graph-indexer'],
        completedNodes: [],
        cost: { actual: null, estimated: 0 },
        durationMs: 0,
        startedAt,
      });

      const { query } = await import('@anthropic-ai/claude-code');
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), INDEX_TIMEOUT_MS);
      try {
        const inventory = await buildKnowledgeCandidateInventory(repoPath);
        const workflowRoleInventory = await buildWorkflowRoleInventory(this.db);
        const prompt = buildIndexerPrompt(repoName, repoPath, inventory, workflowRoleInventory);
        for await (const msg of query({
          prompt,
          options: {
            model,
            permissionMode: 'bypassPermissions',
            cwd: repoPath,
            customSystemPrompt: withNonInteractiveGuidance(withArtifactsGuidance(agent.system as string)),
            abortController,
          } as any,
        })) {
          if (msg.type === 'assistant') {
            const blocks = (msg as any).message?.content as Array<{ type: string; text?: string }> ?? [];
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
            if (text) rawResponse = text;
          }
          if (msg.type === 'result') {
            costUsd = (msg as any).total_cost_usd ?? 0;
            if ((msg as any).result) rawResponse = (msg as any).result;
          }
        }
      } finally {
        clearTimeout(timer);
      }

      const graph = parseGraphJson(rawResponse);
      await this.persistGraph({ repoId, repoName, repoPath, headSha, graph, executionId, costUsd, source: 'agent_tool' });

      await this.db.collection('executions').updateOne(
        { id: executionId },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            durationMs: Date.now() - startedAt.getTime(),
            state: { indexed: true },
            cost: { actual: costUsd, estimated: costUsd },
          },
        },
      );
    } catch (err) {
      error = (err as Error).message ?? String(err);
      await this.db.collection('executions').updateOne(
        { id: executionId },
        {
          $set: {
            status: 'failed',
            errorMessage: error,
            completedAt: new Date(),
            durationMs: Date.now() - startedAt.getTime(),
          },
        },
        { upsert: true },
      );
    } finally {
      await this.repos.updateOne(
        { _id: new ObjectId(repoId) },
        {
          $set: {
            knowledgeGraphIndex: error
              ? { status: 'failed', completedAt: new Date(), error, headSha, executionId }
              : { status: 'completed', completedAt: new Date(), indexedAt: new Date(), error: null, headSha, executionId },
          },
        },
      );
    }
  }

  private async persistGraph(input: {
    repoId: string;
    repoName: string;
    repoPath: string;
    headSha?: string;
    graph: RawKnowledgeGraph;
    executionId?: string;
    costUsd: number;
    source: 'api' | 'agent_tool';
  }): Promise<{ repoId: string; indexId: string; nodeCount: number; edgeCount: number; latest: true }> {
    const now = new Date();
    const indexId = randomUUID();
    const rawNodes = [
      {
      id: 'repo',
      kind: 'repo',
      title: input.repoName,
      summary: input.graph.repoSummary || `Repository ${input.repoName}`,
      tags: ['repo'],
      } satisfies RawGraphNode,
      ...(input.graph.nodes ?? []),
    ];
    const inventory = await buildKnowledgeCandidateInventory(input.repoPath);
    const workflowRoleInventory = await buildWorkflowRoleInventory(this.db);
    const validation = validateRawGraphForPersistence(rawNodes, input.graph.edges ?? [], inventory, workflowRoleInventory, {
      strictWorkflowRoleCoverage: input.source === 'agent_tool',
    });
    const validationErrors = validation.issues.filter((issue) => issue.severity === 'error');
    if (validationErrors.length > 0) {
      throw new RepoKnowledgeGraphValidationError(validation);
    }

    const idMap = new Map<string, string>();
    const nodeRefs: string[] = [];
    for (const raw of rawNodes) {
      const kind = normalizeKind(raw.kind);
      const path = raw.path ? sanitizeRepoRelativePath(String(raw.path)) : undefined;
      const stableKey = stableNodeKey(raw);
      const id = `${input.repoId}:${stableKey}`;
      idMap.set(String(raw.id ?? stableKey), id);
      nodeRefs.push(id);
      const doc: KnowledgeNodeRecord = {
        id,
        stableKey,
        repoId: input.repoId,
        indexId,
        headSha: input.headSha,
        kind,
        title: String(raw.title || raw.path || raw.id || stableKey),
        path,
        summary: String(raw.summary || ''),
        tags: arrayOfStrings(raw.tags),
        moduleId: raw.moduleId,
        appliesToGlobs: arrayOfStrings(raw.appliesToGlobs),
        mandatoryForGlobs: arrayOfStrings(raw.mandatoryForGlobs),
        mandatoryForNodeRoles: arrayOfStrings(raw.mandatoryForNodeRoles),
        source: {
          type: path ? 'repo_file' : 'generated_summary',
          uri: path ? `repo://${path}` : `generated://${stableKey}`,
        },
        freshness: {
          lastSeenAt: now,
          contentHash: hashJson(raw),
          stale: false,
        },
        access: {
          visibility: 'repo',
          injectPolicy: determineInjectPolicy(raw, kind, path),
        },
        createdAt: now,
        updatedAt: now,
      };
      await this.nodes.updateOne(
        { repoId: input.repoId, indexId, stableKey },
        { $set: doc },
        { upsert: true },
      );
    }

    const edges: KnowledgeEdgeRecord[] = [];
    for (const raw of input.graph.edges ?? []) {
      const fromNodeId = idMap.get(String(raw.from ?? ''));
      const toNodeId = idMap.get(String(raw.to ?? ''));
      if (!fromNodeId || !toNodeId) continue;
      edges.push({
        id: randomUUID(),
        repoId: input.repoId,
        indexId,
        fromNodeId,
        toNodeId,
        relation: normalizeRelation(raw.relation),
        confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.7,
        reason: String(raw.reason || ''),
        createdBy: 'daily_indexer',
        createdAt: now,
      });
    }
    if (edges.length > 0) await this.edges.insertMany(edges);

    await this.indexes.updateMany({ repoId: input.repoId, latest: true }, { $set: { latest: false } });
    const rootRefs = rawNodes
      .map((raw) => idMap.get(String(raw.id ?? stableNodeKey(raw))))
      .filter((id, idx): id is string => {
        if (!id) return false;
        const raw = rawNodes[idx];
        const kind = normalizeKind(raw?.kind);
        const path = raw?.path ? sanitizeRepoRelativePath(String(raw.path)) : undefined;
        return determineInjectPolicy(raw ?? {}, kind, path) === 'baseline';
      });

    await this.indexes.insertOne({
      indexId,
      repoId: input.repoId,
      repoName: input.repoName,
      sourceRepoPath: input.repoPath,
      headSha: input.headSha,
      indexVersion: KNOWLEDGE_GRAPH_INDEX_VERSION,
      indexedAt: now,
      latest: true,
      rootRefs,
      nodeRefs,
      edgeCount: edges.length,
      graphValidation: {
        status: validationErrors.length > 0 ? 'failed' : validation.issues.some((issue) => issue.severity === 'warn') ? 'warning' : 'passed',
        issues: validation.issues,
        candidateCoverage: validation.candidateCoverage,
        workflowRoleCoverage: validation.workflowRoleCoverage,
        validatedAt: now,
      },
      scanAgentExecutionId: input.executionId,
      scanCostUsd: input.costUsd,
      source: input.source,
      freshness: { status: 'fresh' },
    });
    return { repoId: input.repoId, indexId, nodeCount: nodeRefs.length, edgeCount: edges.length, latest: true };
  }

  private async repoById(repoId: string): Promise<Record<string, unknown> | null> {
    const { ObjectId } = await import('mongodb');
    return this.repos.findOne({ _id: new ObjectId(repoId) });
  }

}

function buildSynthesizedRepoContextUsage(
  parsed: ParsedUsage,
  packet: Record<string, unknown> | null,
  verification: { unverifiedClaims: Array<Record<string, unknown>>; diagnostics: Array<Record<string, unknown>> },
): Record<string, unknown> {
  const preselected = mergeUsageArrays(
    collectPreselectedContextFromPacket(packet),
    parsed.preselected,
  );
  const diagnostics = [
    ...parsed.diagnostics,
    ...verification.diagnostics,
    ...(parsed.sawUsageKeys ? [] : [{
      code: 'repo_context_usage_agent_missing',
      severity: 'warn',
      message: 'Agent did not emit repo_context_usage; Allen synthesized this report from context packet and tool-call evidence.',
    }]),
    ...(verification.unverifiedClaims.length > 0 ? [{
      code: 'repo_context_usage_agent_claim_mismatch',
      severity: 'warn',
      message: `${verification.unverifiedClaims.length} agent context usage claim(s) had no matching body-load evidence.`,
    }] : []),
  ];
  return {
    module_identified: parsed.moduleIdentified ?? null,
    context_preselected: preselected,
    context_summary_used: parsed.summaryUsed,
    context_loaded: parsed.loaded,
    context_applied: parsed.applied,
    context_skipped: parsed.skipped,
    validation_performed: parsed.validationPerformed,
    context_usage_summary: parsed.usageSummary ?? null,
    agent_reported_usage: parsed.sawUsageKeys,
    synthesized_by_allen: true,
    malformed_reported_usage: parsed.malformedReportedUsage,
    diagnostics,
  };
}

function summarizeContextEvaluationForTrace(evaluation: Record<string, unknown>): Record<string, unknown> {
  return {
    traceId: evaluation.traceId,
    status: evaluation.status,
    scores: evaluation.scores,
    semantic: evaluation.semantic,
    diagnostics: normalizeUsageArray(evaluation.diagnostics).slice(0, 10),
    feedbackEvidenceCount: normalizeUsageArray(evaluation.feedbackEvidence).length,
  };
}

export function createRepoKnowledgeGraphIndexIfChangedAction(db: Db): SystemAction {
  return {
    name: 'repo-knowledge-graph-index-if-changed',
    description: 'Rebuild repo knowledge graph indexes for active repos whose base-branch HEAD has changed.',
    async run() {
      const service = new RepoKnowledgeGraphService(db);
      const repos = await db.collection('repos').find({ status: 'active' }).toArray();
      const queued: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];
      for (const repo of repos) {
        const repoId = String(repo._id);
        const repoPath = repo.path as string;
        try {
          const headSha = await gitHeadSha(repoPath);
          const latest = await service.getLatestIndex(repoId);
          if (latest?.headSha && headSha && latest.headSha === headSha) {
            skipped.push(`${repo.name}: HEAD unchanged (${headSha.slice(0, 8)})`);
            continue;
          }
          const result = await service.scheduleIndex(repoId);
          if (result.scheduled) queued.push(`${repo.name}: queued`);
          else skipped.push(`${repo.name}: ${result.reason ?? 'not scheduled'}`);
        } catch (err) {
          errors.push(`${repo.name}: ${(err as Error).message}`);
        }
      }
      return [
        queued.length ? `Queued: ${queued.join('; ')}` : null,
        skipped.length ? `Skipped: ${skipped.join('; ')}` : null,
        errors.length ? `Errors: ${errors.join('; ')}` : null,
      ].filter(Boolean).join(' | ') || 'No active repos found.';
    },
  };
}
