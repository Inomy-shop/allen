import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Collection, Db } from 'mongodb';
import {
  MandatoryContextMappingProvider,
  RepoContextEngine,
  type KnowledgeNodeKind,
  type RepoContextProvider,
} from './repo-context-engine.js';
import {
  WorkflowContextInjectionAdapter,
  summarizeInjection,
} from './workflow-context-injection-adapter.js';
import type { ParsedUsage, UsageToolCall } from '../common/context-usage.types.js';
import { workflowRoleGuidance } from '../common/context-role-inventory.js';
import {
  collectCurrentFiles,
  isGitTracked,
  isPathInside,
  normalizeRepoContextProvider,
  resolveRepoFromPath,
  sanitizeRepoRelativePath,
} from '../common/repo-context-paths.js';
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
} from '../common/context-usage-utils.js';
import { firstString, isRecord } from '../common/context-utils.js';
import { ContextEvaluationService } from '../evaluation/context-evaluation.service.js';
import { ContextWorkflowEvaluationService } from '../evaluation/context-workflow-evaluation.service.js';
import { ContextLifecycleStore, type ContextUsageReportOptions } from '../lifecycle/context-lifecycle-store.js';
import {
  configuredContextProvider,
  contextProviderDisabledError,
  isContextEngineEnabled,
} from '../config/context-provider-config.js';

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

export class RepoContextPacketService {
  private repos: Collection;
  private lifecycle: ContextLifecycleStore;

  constructor(private db: Db) {
    this.repos = db.collection('repos');
    this.lifecycle = new ContextLifecycleStore(db);
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
    contextQuery?: unknown;
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
    const indexId = `${configuredProvider}:${repoId}`;

    const currentFiles = collectCurrentFiles(input.state, input.prompt);
    const packetId = randomUUID();
    const provider = normalizeRepoContextProvider(input.provider);
    const contextRetrievalMode = contextRetrievalModeForNode(input);
    await this.lifecycle.recordAttemptBuildStarted({
      contextAttemptId: packetId,
      executionId: input.executionId,
      workflowName: input.workflowName,
      nodeName: input.nodeName,
      nodeRole: input.nodeRole,
      executionKind: input.executionKind,
      targetRole: input.targetRole,
      callerRole: input.callerRole,
      attempt: input.attempt,
      repoId,
      repoName: String(repo.name ?? ''),
      repoPath: String(repo.path ?? ''),
      worktreePath: input.state.worktree_path,
      parentContextAttemptId: input.parentPacketId,
      parentExecutionId: input.parentExecutionId,
      rootExecutionId: input.rootExecutionId,
      indexId,
      indexFreshness: 'provider_runtime',
      taskPrompt: firstString(input.prompt),
      currentFiles,
      contextProvider: configuredProvider,
      contextRetrievalMode,
    });
    const contextEngine = contextRetrievalMode === 'mandatory_only'
      ? new RepoContextEngine([new MandatoryContextMappingProvider(this.db)], undefined, { db: this.db })
      : new RepoContextEngine(undefined, undefined, { db: this.db });
    const adapter = new WorkflowContextInjectionAdapter();
    let packet;
    try {
      packet = await withTimeout(contextEngine.buildPacket({
        packetId,
        executionId: input.executionId,
        repoId,
        repoName: String(repo.name ?? ''),
        repoPath: String(repo.path ?? ''),
        indexId,
        indexFreshness: 'provider_runtime',
        workflowName: input.workflowName,
        nodeName: input.nodeName,
        nodeRole: input.nodeRole,
        executionKind: input.executionKind,
        targetRole: input.targetRole,
        callerRole: input.callerRole,
        attempt: input.attempt,
        state: input.state,
        prompt: input.prompt,
        contextQuery: input.contextQuery,
        provider,
        currentFiles,
        nodes: [],
        worktreePath: input.state.worktree_path,
        parentPacketId: input.parentPacketId,
        parentExecutionId: input.parentExecutionId,
        rootExecutionId: input.rootExecutionId,
      }), contextPacketBuildTimeoutMs(), 'repo context packet build timed out');
    } catch (err) {
      const message = (err as Error).message;
      await this.lifecycle.markAttemptBuildStatus(
        packetId,
        isTimeoutError(err) ? 'timed_out' : 'failed',
        { error: message },
      );
      return null;
    }
    packet.providerDiagnostics.push({
      code: 'repo_context_retrieval_mode',
      severity: 'info',
      mode: contextRetrievalMode,
      message: contextRetrievalMode === 'mandatory_only'
        ? 'Support/output node skipped semantic context retrieval; only explicit mandatory role mappings are eligible.'
        : 'Repo-operating node used full configured context retrieval.',
    });
    if (contextRetrievalMode === 'mandatory_only' && packet.selectedRefs.length === 0) {
      await this.lifecycle.markAttemptBuildStatus(packetId, 'skipped', { error: 'No mandatory context mapping selected for this node.' });
      return null;
    }
    let injection;
    let systemPromptBlock;
    let promptBlock;
    let contextInjection;
    try {
      injection = await adapter.buildInjection({
        packet,
        provider,
        repoPath: String(repo.path ?? ''),
        worktreePath: firstString(input.state.worktree_path, input.state.repo_path, input.state.repository_path),
      });
      systemPromptBlock = adapter.renderSystemPromptBlock(injection);
      promptBlock = adapter.renderContextPacket(packet);
      contextInjection = summarizeInjection(injection);
      await this.lifecycle.saveAttemptFromPacket({
        packet,
        injection,
        contextInjection,
        promptBlock,
        systemPromptBlock,
        contextProvider: configuredProvider,
        contextRetrievalMode,
      });
    } catch (err) {
      await this.lifecycle.markAttemptBuildStatus(packetId, 'failed', { error: (err as Error).message });
      return null;
    }

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
      console.warn('[repo-context-packet] context evaluation failed:', (err as Error).message);
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

  async getExecutionContextUsageReport(executionId: string, options: ContextUsageReportOptions = {}): Promise<Record<string, unknown>> {
    return this.lifecycle.getExecutionContextUsageReport(executionId, options);
  }

  async getAttemptEvidence(contextAttemptId: string): Promise<Record<string, unknown> | null> {
    return this.lifecycle.getAttemptEvidence(contextAttemptId);
  }

  async getAttemptEvidenceBatch(contextAttemptIds: string[]): Promise<Record<string, unknown>> {
    return this.lifecycle.getAttemptEvidenceBatch(contextAttemptIds);
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
    if (!isContextEngineEnabled()) throw contextProviderDisabledError('Allen context provider is disabled.');
    const repo = await resolveRepoFromPath(this.db, input.repoPath);
    if (!repo) throw new Error('Repo not found');
    const repoId = String(repo._id);

    const refId = input.refId?.trim();
    const requestedPath = input.skillPath?.trim();
    if (refId && !requestedPath) {
      throw new Error('Graph-backed skill refs are no longer supported; pass skill_path to load a repo skill body.');
    }
    const skillPath = sanitizeRepoRelativePath(String(requestedPath ?? ''));
    if (!skillPath) throw new Error('skill_path must identify a repo skill file');
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
      indexId: 'repo_context_body',
      refId,
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

    if (refId && !requestedPath) {
      throw new Error(`Ref ${refId} is not a persisted Cognee ref. Graph-backed refs are no longer supported; pass context_path to load a repo file.`);
    }

    const contextPath = sanitizeRepoRelativePath(String(requestedPath ?? ''));
    if (!contextPath) throw new Error('context_path must identify a repo context file');

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
      indexId: 'repo_context_body',
      refId,
      kind: inferContextKind(contextPath),
      path: contextPath,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      bodySource: 'repo_file_path',
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
        kind: normalizeContextKind(firstString(ref.kind) ?? 'historical_learning'),
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
      kind: normalizeContextKind(firstString(ref.kind) ?? 'doc'),
      title: firstString(ref.title),
      path,
      content: fallbackContent,
      tokenEstimate: Math.ceil(fallbackContent.length / 4),
      providerId,
      providerMetadata: metadata,
      bodySource: 'cognee_source_file_fallback',
    };
  }

  private async repoById(repoId: string): Promise<Record<string, unknown> | null> {
    const { ObjectId } = await import('mongodb');
    return this.repos.findOne({ _id: new ObjectId(repoId) });
  }

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

function normalizeContextKind(value: unknown): KnowledgeNodeKind {
  const kind = String(value ?? '');
  const supported = new Set([
    'repo',
    'module',
    'source_file',
    'context_file',
    'doc',
    'runbook',
    'skill',
    'skill_reference',
    'production_note',
    'instruction_file',
    'command',
    'command_profile',
    'imported_agent',
    'historical_learning',
  ]);
  return (supported.has(kind) ? kind : 'doc') as KnowledgeNodeKind;
}

function inferContextKind(path: string): KnowledgeNodeKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('/skill.md') || lower.endsWith('skill.md')) return 'skill';
  if (lower.includes('/runbook') || lower.includes('/runbooks/')) return 'runbook';
  if (lower === 'agents.md' || lower === 'claude.md' || lower.includes('/instructions') || lower.includes('/rules/')) return 'instruction_file';
  if (lower.includes('/knowledge/') || lower.includes('/production') || lower.includes('/incident')) return 'production_note';
  return 'doc';
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

function contextPacketBuildTimeoutMs(): number {
  const value = Number(process.env.ALLEN_CONTEXT_PACKET_BUILD_TIMEOUT_MS ?? process.env.ALLEN_SPAWN_CONTEXT_BUILD_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 120_000;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      (error as Error & { code?: string }).code = 'CONTEXT_PACKET_BUILD_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isTimeoutError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'CONTEXT_PACKET_BUILD_TIMEOUT'
    || /timed?\s*out|timeout/i.test((error as Error | null)?.message ?? '');
}
