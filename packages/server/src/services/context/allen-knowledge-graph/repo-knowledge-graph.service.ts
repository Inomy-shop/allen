import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Collection, Db } from 'mongodb';
import { withArtifactsGuidance, withNonInteractiveGuidance, normalizeModelAlias, loadAllMcpServers } from '@allen/engine';
import type { SystemAction } from '../../cron.types.js';
import {
  MandatoryGraphProvider,
  RepoContextEngine,
  type RepoContextProvider,
} from '../core/repo-context-engine.js';
import {
  WorkflowContextInjectionAdapter,
  summarizeInjection,
} from '../core/workflow-context-injection-adapter.js';
import {
  KNOWLEDGE_GRAPH_INDEX_VERSION,
  type KnowledgeEdgeRecord,
  type KnowledgeGraphMode,
  type KnowledgeNodeKind,
  type KnowledgeNodeRecord,
  type ParsedUsage,
  type RawGraphNode,
  type RawKnowledgeGraph,
  type UsageToolCall,
} from './repo-knowledge-graph.types.js';
import { buildIndexerUserPrompt, buildKnowledgeCandidateInventory, buildSpawnedAgentRoleInventory, buildWorkflowRoleInventory, workflowRoleGuidance } from './repo-knowledge-graph-indexer.js';
import { resolveContextLlmConfig } from '../config/context-llm-config.js';
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
import { arrayOfStrings, firstString, hashJson, isRecord, normalizeKind, normalizeRelation, sha256, stableNodeKey } from './repo-knowledge-graph-utils.js';
import { ContextEvaluationService } from '../evaluation/context-evaluation.service.js';
import { ContextWorkflowEvaluationService } from '../evaluation/context-workflow-evaluation.service.js';
import { ContextLifecycleStore } from '../lifecycle/context-lifecycle-store.js';
import {
  cogneeMandatoryGraphMode,
  configuredContextProvider,
  contextIndexGraphModeForProvider,
  contextProviderDisabledError,
  isContextEngineEnabled,
  isCogneeContextEnabled,
  isGraphContextEnabled,
} from '../config/context-provider-config.js';

export { KNOWLEDGE_GRAPH_INDEX_VERSION } from './repo-knowledge-graph.types.js';
export type { KnowledgeEdgeRecord, KnowledgeNodeRecord } from './repo-knowledge-graph.types.js';
export type { RepoKnowledgeGraphValidationErrorPayload } from './repo-knowledge-graph-validation.js';
export { RepoKnowledgeGraphValidationError, isRepoKnowledgeGraphValidationError } from './repo-knowledge-graph-validation.js';

const INDEX_TIMEOUT_MS = 60 * 60 * 1000;
const SEARCH_REPO_KNOWLEDGE_LIMIT = 12;

function normalizeGraphMode(value: unknown): KnowledgeGraphMode | null {
  if (value === 'full_graph' || value === 'mandatory_context_map') return value;
  return null;
}

function isCogneeRefId(refId: string): boolean {
  return /^cognee(?::|$)/i.test(refId);
}

function findPacketRef(packet: Record<string, unknown> | null | undefined, refId: string): Record<string, unknown> | null {
  if (!packet) return null;
  const sections = [
    packet.selectedRefs,
    packet.injectableRefs,
    isRecord(packet.contextInjection) ? packet.contextInjection.injectedRefs : undefined,
    isRecord(packet.contextInjection) ? packet.contextInjection.skippedRefs : undefined,
  ];
  for (const section of sections) {
    for (const item of normalizeUsageArray(section)) {
      if (firstString(item.refId, item.ref_id, item.id) === refId) return item;
    }
  }
  return null;
}

export class RepoKnowledgeGraphService {
  private repos: Collection;
  private indexes: Collection;
  private nodes: Collection<KnowledgeNodeRecord>;
  private edges: Collection<KnowledgeEdgeRecord>;
  private lifecycle: ContextLifecycleStore;

  constructor(private db: Db) {
    this.repos = db.collection('repos');
    this.indexes = db.collection('repo_knowledge_indexes');
    this.nodes = db.collection<KnowledgeNodeRecord>('knowledge_nodes');
    this.edges = db.collection<KnowledgeEdgeRecord>('knowledge_edges');
    this.lifecycle = new ContextLifecycleStore(db);
  }

  async scheduleIndex(repoId: string): Promise<{ scheduled: boolean; reason?: string; executionId?: string }> {
    if (!isGraphContextEnabled()) return { scheduled: false, reason: 'Allen context provider is disabled' };
    return this.scheduleIndexForMode(repoId, 'full_graph');
  }

  async scheduleProviderContextIndex(repoId: string): Promise<{ scheduled: boolean; reason?: string; executionId?: string; graphMode?: KnowledgeGraphMode }> {
    const graphMode = normalizeGraphMode(contextIndexGraphModeForProvider());
    if (!graphMode) return { scheduled: false, reason: 'Context provider is disabled' };
    const result = await this.scheduleIndexForMode(repoId, graphMode);
    return { ...result, graphMode };
  }

  private async scheduleIndexForMode(repoId: string, graphMode: KnowledgeGraphMode): Promise<{ scheduled: boolean; reason?: string; executionId?: string }> {
    if (graphMode === 'full_graph' && !isGraphContextEnabled()) return { scheduled: false, reason: 'Allen context provider is disabled' };
    if (graphMode === 'mandatory_context_map' && !isCogneeContextEnabled()) return { scheduled: false, reason: 'Cognee context provider is disabled' };
    const { ObjectId } = await import('mongodb');
    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo) return { scheduled: false, reason: 'Repo not found' };

    const claim = await this.repos.updateOne(
      { _id: new ObjectId(repoId), 'knowledgeGraphIndex.status': { $ne: 'indexing' } },
      { $set: { knowledgeGraphIndex: { status: 'indexing', startedAt: new Date() } } },
    );
    if (claim.matchedCount === 0) return { scheduled: false, reason: 'Index already in progress' };

    const executionId = randomUUID();
    this.runIndex(repoId, repo.path as string, repo.name as string, executionId, graphMode).catch((err) => {
      console.error(`[repo-knowledge-graph] index failed for ${repoId}:`, err);
    });
    return { scheduled: true, executionId };
  }

  async getLatestIndex(repoId: string, graphMode: KnowledgeGraphMode = 'full_graph'): Promise<Record<string, unknown> | null> {
    const graphModeFilter = graphMode === 'full_graph'
      ? { $or: [{ graphMode: 'full_graph' }, { graphMode: { $exists: false } }] }
      : { graphMode };
    return this.indexes.findOne({ repoId, latest: true, ...graphModeFilter }, { sort: { indexedAt: -1 } });
  }

  async getLatestGraph(repoId: string, graphMode: KnowledgeGraphMode = 'full_graph'): Promise<Record<string, unknown> | null> {
    const index = await this.getLatestIndex(repoId, graphMode);
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
    graphMode?: KnowledgeGraphMode | string;
    sourceExecutionId?: string;
    source?: 'api' | 'agent_tool';
  }): Promise<{ repoId: string; indexId: string; nodeCount: number; edgeCount: number; latest: true }> {
    if (!isContextEngineEnabled()) throw contextProviderDisabledError();
    const graphMode = normalizeGraphMode(input.graphMode);
    if (!graphMode && (input.source ?? 'api') === 'agent_tool') {
      throw new Error('graph_mode is required. Use "full_graph" or "mandatory_context_map".');
    }
    const resolvedGraphMode = graphMode ?? 'full_graph';
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
      graphMode: resolvedGraphMode,
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
    executionKind?: 'workflow_node' | 'spawned_agent' | 'chat_agent';
    targetRole?: string;
    callerRole?: string;
    attempt: number;
    state: Record<string, unknown>;
    prompt?: string;
    parentPacketId?: string;
    parentExecutionId?: string | null;
    rootExecutionId?: string;
    provider?: RepoContextProvider;
  }): Promise<{ packetId: string; promptBlock: string; systemPromptBlock: string; traceSummary: any } | null> {
    const configuredProvider = configuredContextProvider();
    if (!configuredProvider) return null;
    const repo = await this.resolveRepoForContextPacket(input.state);
    if (!repo) return null;
    const repoId = String(repo._id);
    const cogneeGraphMode = cogneeMandatoryGraphMode();
    const cogneeGraphEnabled = (configuredProvider === 'cognee' || configuredProvider === 'cognee_memory') && cogneeGraphMode !== 'off';
    const graphFallbackEnabled = (process.env.ALLEN_CONTEXT_PROVIDER_FALLBACK ?? '').toLowerCase() === 'graph';
    const graphUseful = configuredProvider === 'allen' || graphFallbackEnabled || cogneeGraphEnabled;
    const primaryGraphMode: KnowledgeGraphMode = configuredProvider === 'allen' || (graphFallbackEnabled && !cogneeGraphEnabled)
      ? 'full_graph'
      : 'mandatory_context_map';
    let index = graphUseful
      ? await this.getLatestIndex(repoId, primaryGraphMode)
      : null;
    if (!index && cogneeGraphEnabled && cogneeGraphMode === 'auto') {
      index = await this.getLatestIndex(repoId, 'full_graph');
    }
    if (configuredProvider === 'allen' && !index) return null;
    if (cogneeGraphEnabled && cogneeGraphMode === 'required' && !index) {
      throw new Error(`Cognee mandatory graph is required, but repo ${repoId} has no latest Allen knowledge graph index.`);
    }

    const indexId = index ? String(index.indexId) : `${configuredProvider}:${repoId}`;
    const allNodes = index ? await this.nodes.find({ repoId, indexId }).toArray() : [];
    if (configuredProvider === 'allen' && allNodes.length === 0) return null;
    if (cogneeGraphEnabled && cogneeGraphMode === 'required' && allNodes.length === 0) {
      throw new Error(`Cognee mandatory graph is required, but repo ${repoId} index ${indexId} has no knowledge nodes.`);
    }
    const graphDiagnostics = cogneeGraphEnabled
      ? cogneeMandatoryGraphDiagnostics({
        mode: cogneeGraphMode,
        repoId,
        indexId,
        indexFound: Boolean(index),
        nodeCount: allNodes.length,
      })
      : [];

    const currentFiles = collectCurrentFiles(input.state, input.prompt);
    const packetId = randomUUID();
    const provider = normalizeRepoContextProvider(input.provider);
    const contextRetrievalMode = contextRetrievalModeForNode(input);
    const contextEngine = contextRetrievalMode === 'mandatory_only'
      ? new RepoContextEngine([new MandatoryGraphProvider({ includeBaseline: false, includeGlobs: false })], undefined, { db: this.db })
      : new RepoContextEngine(undefined, undefined, { db: this.db });
    const adapter = new WorkflowContextInjectionAdapter();
    const packet = await contextEngine.buildPacket({
      packetId,
      executionId: input.executionId,
      repoId,
      repoName: String(repo.name ?? ''),
      repoPath: String(repo.path ?? ''),
      indexId,
      indexFreshness: index ? ((index.freshness as { status?: string } | undefined)?.status ?? 'fresh') : 'provider_runtime',
      workflowName: input.workflowName,
      nodeName: input.nodeName,
      nodeRole: input.nodeRole,
      executionKind: input.executionKind,
      targetRole: input.targetRole,
      callerRole: input.callerRole,
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
    packet.providerDiagnostics.push({
      code: 'repo_context_retrieval_mode',
      severity: 'info',
      mode: contextRetrievalMode,
      message: contextRetrievalMode === 'mandatory_only'
        ? 'Support/output node skipped semantic context retrieval; only explicit mandatory role mappings are eligible.'
        : 'Repo-operating node used full configured context retrieval.',
    });
    if (contextRetrievalMode === 'mandatory_only' && packet.selectedRefs.length === 0) {
      return null;
    }
    if (graphDiagnostics.length) packet.providerDiagnostics.push(...graphDiagnostics);
    const injection = await adapter.buildInjection({
      packet,
      provider,
      repoPath: String(repo.path ?? ''),
      worktreePath: firstString(input.state.worktree_path, input.state.repo_path, input.state.repository_path),
    });
    const systemPromptBlock = adapter.renderSystemPromptBlock(injection);
    const promptBlock = adapter.renderContextPacket(packet);
    const contextInjection = summarizeInjection(injection);
    await this.lifecycle.saveAttemptFromPacket({
      packet,
      injection,
      contextInjection,
      promptBlock,
      systemPromptBlock,
      contextProvider: configuredProvider,
      contextRetrievalMode,
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
      injectableContextCount: packet.injectableRefs?.length ?? 0,
      injectedContextCount: injection.injectedRefs.length,
      skippedContextCount: injection.skippedRefs.length,
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
      contextProvider: configuredProvider,
      contextRetrievalMode,
      retrievalContextProvider: packet.retrievalProviders[0],
      executionKind: packet.executionKind,
      targetRole: packet.targetRole,
      callerRole: packet.callerRole,
    };

    return {
      packetId,
      traceSummary,
      systemPromptBlock,
      promptBlock,
    };
  }

  private async resolveRepoForContextPacket(state: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const repoId = firstString(
      state.repoId,
      state.repo_id,
      state.repositoryId,
      state.repository_id,
      isRecord(state.repo) ? state.repo.repoId : undefined,
      isRecord(state.repository) ? state.repository.repoId : undefined,
    );
    if (repoId) {
      const repo = await this.repoById(repoId).catch(() => null);
      if (repo) return repo;
    }

    for (const pathHint of contextPacketPathHints(state)) {
      const repo = await resolveRepoFromPath(this.db, pathHint);
      if (repo) return repo;
    }
    return null;
  }

  async recordContextUsage(input: {
    executionId: string;
    executionTraceId?: string;
    workflowName: string;
    nodeName: string;
    nodeRole?: string;
    executionKind?: 'workflow_node' | 'spawned_agent' | 'chat_agent';
    targetRole?: string;
    callerRole?: string;
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
    if (!isContextEngineEnabled()) return null;
    if (!input.packetId) return null;
    const parsed = extractUsage(input.outputs, input.rawResponse, input.toolCalls);
    const packet = await this.lifecycle.getAttemptPacketView(input.packetId).catch(() => null);
    addSystemInjectedContextUsage(parsed, packet as Record<string, unknown> | null);
    const verification = verifyContextUsageClaims(parsed, packet as Record<string, unknown> | null);
    const traceId = randomUUID();
    await this.lifecycle.recordUsage({
      contextAttemptId: input.packetId,
      usageTraceId: traceId,
      executionId: input.executionId,
      executionTraceId: input.executionTraceId,
      nodeName: input.nodeName,
      attempt: input.attempt,
      parsed: {
        ...parsed,
        loaded: parsed.loaded,
        applied: parsed.applied,
        reportedLoaded: parsed.reportedLoaded,
        reportedApplied: parsed.reportedApplied,
        skipped: parsed.skipped,
        contextBodyLoads: parsed.contextBodyLoads,
        skillBodyLoads: parsed.skillBodyLoads,
      },
      diagnostics: [...parsed.diagnostics, ...verification.diagnostics],
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
    return this.lifecycle.getExecutionContextUsageReport(executionId);
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
    if (!isGraphContextEnabled()) throw contextProviderDisabledError('Allen context provider is disabled.');
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
    providerId?: string;
    providerMetadata?: Record<string, unknown>;
    bodySource?: string;
  }> {
    if (!isContextEngineEnabled()) throw contextProviderDisabledError('Allen context provider is disabled.');
    const repo = await resolveRepoFromPath(this.db, input.repoPath);
    if (!repo) throw new Error('Repo not found');
    const repoId = String(repo._id);
    const refId = input.refId?.trim();
    const requestedPath = input.contextPath?.trim();
    if (refId) {
      const cogneeBody = await this.getCogneeContextBodyFromPacket({
        repoId,
        repoName: String(repo.name ?? ''),
        repoPath: input.repoPath,
        registeredRepoPath: String(repo.path ?? input.repoPath),
        refId,
      });
      if (cogneeBody) return cogneeBody;
      if (isCogneeRefId(refId)) {
        throw new Error(`Cognee ref not found in persisted context packets: ${refId}`);
      }
    }

    if (!isGraphContextEnabled() && !requestedPath) {
      throw new Error(`Ref ${refId ?? ''} is not a Cognee ref and Allen graph context is not enabled`);
    }
    const index = await this.getLatestIndex(repoId);
    if (!index) throw new Error('No knowledge graph index found for repo');
    const indexId = String(index.indexId);

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
      bodySource: 'allen_knowledge_graph',
    };
  }

  private async getCogneeContextBodyFromPacket(input: {
    repoId: string;
    repoName?: string;
    repoPath: string;
    registeredRepoPath: string;
    refId: string;
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
    providerId?: string;
    providerMetadata?: Record<string, unknown>;
    bodySource?: string;
  } | null> {
    const ref = await this.db.collection('context_refs').findOne(
      {
        repoId: input.repoId,
        refId: input.refId,
      },
      { sort: { createdAt: -1 } },
    );
    if (!ref) return null;
    const providerId = firstString(ref.providerId);
    if (providerId !== 'cognee_memory' && !isCogneeRefId(input.refId)) return null;

    const metadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : {};
    const sourceMetadata = isRecord(metadata.sourceMetadata) ? metadata.sourceMetadata : {};
    const path = sanitizeRepoRelativePath(firstString(ref.path, sourceMetadata.path) ?? '');
    const contentArtifact = firstString(ref.contentArtifactHash)
      ? await this.db.collection('context_artifacts').findOne({ hash: firstString(ref.contentArtifactHash) })
      : null;
    const content = firstString(ref.content, contentArtifact?.content);
    if (content) {
      return {
        repoId: input.repoId,
        repoName: input.repoName,
        indexId: firstString(ref.indexId) ?? 'cognee',
        refId: input.refId,
        kind: normalizeKind(firstString(ref.kind) ?? 'historical_learning') as KnowledgeNodeKind,
        title: firstString(ref.title),
        path: path || input.refId,
        content,
        tokenEstimate: Math.ceil(content.length / 4),
        providerId,
        providerMetadata: metadata,
        bodySource: 'cognee_context_packet_chunk',
      };
    }
    if (!path) return null;

    const requestedBase = input.repoPath && existsSync(join(input.repoPath, path))
      ? input.repoPath
      : input.registeredRepoPath;
    const absolutePath = join(requestedBase, path);
    if (!isPathInside(requestedBase, absolutePath)) throw new Error('Resolved Cognee source path escapes repo root');
    if (!(await isGitTracked(requestedBase, path))) {
      throw new Error(`Cognee source file is not git-tracked in repo: ${path}`);
    }
    const fallbackContent = await readFile(absolutePath, 'utf8');
    return {
      repoId: input.repoId,
      repoName: input.repoName,
      indexId: firstString(ref.indexId) ?? 'cognee',
      refId: input.refId,
      kind: normalizeKind(firstString(ref.kind) ?? 'doc') as KnowledgeNodeKind,
      title: firstString(ref.title),
      path,
      content: fallbackContent,
      tokenEstimate: Math.ceil(fallbackContent.length / 4),
      providerId,
      providerMetadata: metadata,
      bodySource: 'cognee_source_file_fallback',
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
    if (!isGraphContextEnabled()) throw contextProviderDisabledError('Allen context provider is disabled.');
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

  private async runIndex(repoId: string, repoPath: string, repoName: string, executionId: string, graphMode: KnowledgeGraphMode): Promise<void> {
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
      const contextLlm = resolveContextLlmConfig({ purpose: 'knowledge_graph_indexer' });
      model = contextLlm.provider === 'claude-cli'
        ? normalizeModelAlias(contextLlm.model) ?? normalizeModelAlias((agent.model as string) ?? 'sonnet') ?? 'sonnet'
        : normalizeModelAlias((agent.model as string) ?? 'sonnet') ?? 'sonnet';

      await this.db.collection('executions').insertOne({
        id: executionId,
        workflowName: 'chat:spawn_agent/repo-knowledge-graph-indexer',
        workflowId: null,
        workflowVersion: 0,
        status: 'running',
        source: 'chat',
        input: { prompt: `repo-knowledge-graph-index: ${repoName}; mode: ${graphMode}`, agent_name: 'repo-knowledge-graph-indexer', repo_path: repoPath, graph_mode: graphMode },
        meta: {
          cwd: repoPath,
          provider: 'claude',
          model,
          spawnedBy: 'repo-knowledge-graph-indexer',
          graphMode,
          contextLlmProvider: contextLlm.provider,
          contextLlmModel: contextLlm.model,
          contextLlmApplied: contextLlm.provider === 'claude-cli',
        },
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
        const spawnedAgentRoleInventory = await buildSpawnedAgentRoleInventory(this.db);
        const prompt = buildIndexerUserPrompt(repoName, repoPath, inventory, workflowRoleInventory, spawnedAgentRoleInventory, graphMode);
        const spawnContextEnv = {
          ALLEN_PARENT_EXECUTION_ID: executionId,
          ALLEN_PARENT_CALLER: 'repo-knowledge-graph-indexer',
          ALLEN_ROOT_EXECUTION_ID: executionId,
          ALLEN_ARTIFACT_ROOT_TYPE: 'agent',
          ALLEN_ARTIFACT_ROOT_ID: executionId,
          ALLEN_ARTIFACT_AGENT_NAME: 'repo-knowledge-graph-indexer',
          ALLEN_ARTIFACT_AGENT_EXECUTION_ID: executionId,
          ALLEN_ARTIFACT_PARENT_ID: executionId,
        };
        const mcpServers = await loadAllMcpServers(this.db, {
          extraEnv: spawnContextEnv,
          externalServerNames: [],
        });
        if (!mcpServers.allen) {
          throw new Error('repo-knowledge-graph-indexer requires the built-in Allen MCP server for save_repo_knowledge_graph');
        }
        for await (const msg of query({
          prompt,
          options: {
            model,
            permissionMode: 'bypassPermissions',
            cwd: repoPath,
            env: { ...process.env, ...spawnContextEnv },
            mcpServers,
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
      await this.persistGraph({ repoId, repoName, repoPath, headSha, graph, graphMode, executionId, costUsd, source: 'agent_tool' });

      await this.db.collection('executions').updateOne(
        { id: executionId },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            durationMs: Date.now() - startedAt.getTime(),
            state: { indexed: true, graphMode },
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
              ? { status: 'failed', completedAt: new Date(), error, headSha, executionId, graphMode }
              : { status: 'completed', completedAt: new Date(), indexedAt: new Date(), error: null, headSha, executionId, graphMode },
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
    graphMode: KnowledgeGraphMode;
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
    const spawnedAgentRoleInventory = await buildSpawnedAgentRoleInventory(this.db);
    const validation = validateRawGraphForPersistence(rawNodes, input.graph.edges ?? [], inventory, workflowRoleInventory, spawnedAgentRoleInventory, {
      strictWorkflowRoleCoverage: input.source === 'agent_tool',
      mandatoryContextMapMode: input.graphMode === 'mandatory_context_map',
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
        mandatoryForSpawnedAgentRoles: arrayOfStrings(raw.mandatoryForSpawnedAgentRoles),
        mandatoryForSpawnerRoles: arrayOfStrings(raw.mandatoryForSpawnerRoles),
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

    const latestFilter = input.graphMode === 'full_graph'
      ? { repoId: input.repoId, latest: true, $or: [{ graphMode: 'full_graph' }, { graphMode: { $exists: false } }] }
      : { repoId: input.repoId, latest: true, graphMode: input.graphMode };
    await this.indexes.updateMany(latestFilter, { $set: { latest: false } });
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
      graphMode: input.graphMode,
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

function cogneeMandatoryGraphDiagnostics(input: {
  mode: string;
  repoId: string;
  indexId: string;
  indexFound: boolean;
  nodeCount: number;
}): Array<Record<string, unknown>> {
  if (input.indexFound && input.nodeCount > 0) {
    return [{
      code: 'cognee_mandatory_graph_loaded',
      severity: 'info',
      mode: input.mode,
      repoId: input.repoId,
      indexId: input.indexId,
      nodeCount: input.nodeCount,
      message: 'Cognee provider loaded Allen mandatory context before semantic retrieval.',
      detail: 'This is Allen repo knowledge graph mandatory context, not Cognee graph expansion.',
    }];
  }
  return [{
    code: 'cognee_mandatory_graph_missing',
    severity: input.mode === 'required' ? 'error' : 'warn',
    mode: input.mode,
    repoId: input.repoId,
    indexId: input.indexId,
    reason: input.indexFound ? 'no_nodes' : 'no_latest_index',
    message: 'Cognee provider did not find Allen mandatory context; semantic Cognee retrieval will continue in auto mode.',
    detail: 'This checks Allen repo knowledge graph mandatory mappings only. Cognee graph expansion is controlled separately.',
  }];
}

function contextPacketPathHints(state: Record<string, unknown>): string[] {
  return uniqueStrings([
    firstString(state.repo_path),
    firstString(state.repoPath),
    firstString(state.repository_path),
    firstString(state.repositoryPath),
    firstString(state.source_path),
    firstString(state.sourcePath),
    isRecord(state.repo) ? firstString(state.repo.repoPath, state.repo.path, state.repo.sourcePath) : undefined,
    isRecord(state.repository) ? firstString(state.repository.repoPath, state.repository.path, state.repository.sourcePath) : undefined,
    firstString(state.worktree_path),
    firstString(state.worktreePath),
  ]);
}

type ContextRetrievalMode = 'full' | 'mandatory_only';

function contextRetrievalModeForNode(input: {
  workflowName: string;
  nodeName: string;
  nodeRole?: string;
  targetRole?: string;
  prompt?: string;
}): ContextRetrievalMode {
  const nodeName = normalizeNodeName(input.nodeName);
  const role = normalizeRoleName(firstString(input.targetRole, input.nodeRole));
  if (isSupportOutputNodeName(nodeName) || isSummaryModePrompt(input.prompt)) {
    return 'mandatory_only';
  }
  if (role && workflowRoleGuidance(role).category === 'workflow-support') {
    return 'mandatory_only';
  }
  return 'full';
}

function isSupportOutputNodeName(nodeName: string): boolean {
  return [
    'open_pr',
    'create_pr',
    'create_pull_request',
    'open_pull_request',
    'final_summary',
    'summary',
    'run_summary',
    'workflow_summary',
    'pr_workspace_resolver',
    'workspace_resolver',
  ].includes(nodeName);
}

function isSummaryModePrompt(prompt?: string): boolean {
  return Boolean(prompt && /(^|\n)\s*MODE:\s*summary\b/i.test(prompt));
}

function normalizeNodeName(value?: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
}

function normalizeRoleName(value?: string): string {
  return String(value ?? '').trim().toLowerCase();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
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
    description: 'Rebuild provider-specific repo context indexes for active repos whose base-branch HEAD has changed.',
    async run() {
      const graphMode = normalizeGraphMode(contextIndexGraphModeForProvider());
      if (!graphMode) return 'Skipped: context provider is disabled.';
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
          const latest = await service.getLatestIndex(repoId, graphMode);
          if (latest?.headSha && headSha && latest.headSha === headSha) {
            skipped.push(`${repo.name}: ${graphMode} HEAD unchanged (${headSha.slice(0, 8)})`);
            continue;
          }
          const result = await service.scheduleProviderContextIndex(repoId);
          if (result.scheduled) queued.push(`${repo.name}: queued ${graphMode}`);
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
