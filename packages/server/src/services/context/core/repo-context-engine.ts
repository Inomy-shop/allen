import { createConfiguredContextReranker, type ContextReranker } from './repo-context-reranker.js';
import { CogneeMemoryProvider } from '../cognee/repo-context-cognee-provider.js';
import {
  boundedScoreEnv,
  DEFAULT_COGNEE_MIN_INJECTION_SCORE,
  DEFAULT_COGNEE_MIN_SELECTION_SCORE,
  DEFAULT_CURATED_CONTEXT_MIN_INJECTION_SCORE,
  DEFAULT_CURATED_CONTEXT_MIN_SELECTION_SCORE,
} from '../cognee/cognee-retrieval-policy.js';
import { configuredContextProvider } from '../config/context-provider-config.js';
import {
  buildContextQueryIntent,
  contextQueryIntentHash,
  type AgentRoleSignal,
  renderedContextQueryHash,
  renderContextQuery,
  renderSemanticContextQuery,
  semanticContextQueryHash,
  type ContextQueryIntent,
} from './context-query-intent.js';
import type { Db } from 'mongodb';
import { firstString } from '../common/context-utils.js';

const DEFAULT_CONTEXT_MIN_RERANK_SCORE = 0.1;
const DEFAULT_CONTEXT_MIN_FINAL_SCORE = 0.24;

export type RepoContextProvider = 'claude' | 'codex' | 'unknown';

export type KnowledgeNodeKind =
  | 'repo'
  | 'module'
  | 'source_file'
  | 'context_file'
  | 'doc'
  | 'runbook'
  | 'skill'
  | 'skill_reference'
  | 'production_note'
  | 'instruction_file'
  | 'command'
  | 'command_profile'
  | 'imported_agent'
  | 'historical_learning';

export interface KnowledgeNodeLike {
  id: string;
  kind: KnowledgeNodeKind;
  title: string;
  path?: string;
  summary: string;
  tags: string[];
  moduleId?: string;
  mandatoryForGlobs?: string[];
  mandatoryForNodeRoles?: string[];
  mandatoryForSpawnedAgentRoles?: string[];
  mandatoryForSpawnerRoles?: string[];
  access: {
    injectPolicy: 'baseline' | 'on_demand' | 'never_auto';
  };
}

export interface KnowledgeRetrievalInput {
  repoId: string;
  repoName?: string;
  repoPath: string;
  indexId: string;
  indexFreshness: string;
  executionTraceId?: string;
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
  provider: RepoContextProvider;
  currentFiles: string[];
  nodes: KnowledgeNodeLike[];
  agentRoleSignals?: AgentRoleSignal[];
  parentPacketId?: string;
  parentExecutionId?: string | null;
  rootExecutionId?: string;
  contextQueryIntent?: ContextQueryIntent;
  renderedContextQuery?: string;
  contextQueryIntentHash?: string;
  renderedContextQueryHash?: string;
  renderedContextQueryLength?: number;
  semanticContextQuery?: string;
  semanticContextQueryHash?: string;
  semanticContextQueryLength?: number;
}

export interface KnowledgeCandidateRef {
  refId: string;
  kind: KnowledgeNodeKind;
  title: string;
  path?: string;
  summary?: string;
  tags?: string[];
  providerId: string;
  source: string;
  reason: string;
  score?: number;
  loadable: boolean;
  mandatory: boolean;
  itemType?: 'repo_file' | 'repo_chunk' | 'provider_text' | 'provider_generated' | 'workflow_memory' | 'human_feedback' | 'evaluation_finding';
  grounding?: 'repo_backed' | 'provider_text' | 'provider_generated';
  content?: string;
  contentSha256?: string;
  providerMetadata?: Record<string, unknown>;
  targetLayer?: 'system_prompt' | 'user_prompt';
  rerank?: Record<string, unknown>;
  packing?: Record<string, unknown>;
}

export interface KnowledgeRetrievalTrace {
  providerId: string;
  refId: string;
  kind: KnowledgeNodeKind;
  title: string;
  path?: string;
  itemType?: KnowledgeCandidateRef['itemType'];
  grounding?: KnowledgeCandidateRef['grounding'];
  score?: number;
  decision: 'selected' | 'rejected';
  reason: string;
  providerMetadata?: Record<string, unknown>;
}

export interface KnowledgeRetrievalResult {
  providerId: string;
  candidates: KnowledgeCandidateRef[];
  selectedRefs: KnowledgeCandidateRef[];
  injectableRefs?: KnowledgeCandidateRef[];
  rejectedRefs: KnowledgeCandidateRef[];
  diagnostics: Array<Record<string, unknown>>;
  trace: KnowledgeRetrievalTrace[];
}

export interface KnowledgeRetrievalProvider {
  readonly providerId: string;
  retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult>;
}

export interface RepoContextPacket {
  packetId: string;
  executionId: string;
  executionTraceId?: string;
  workflowName: string;
  nodeName: string;
  nodeRole?: string;
  executionKind?: 'workflow_node' | 'spawned_agent' | 'chat_agent';
  targetRole?: string;
  callerRole?: string;
  attempt: number;
  repoId: string;
  repoName?: string;
  repoPath: string;
  worktreePath?: unknown;
  parentPacketId?: string;
  parentExecutionId?: string | null;
  rootExecutionId?: string;
  indexId: string;
  indexFreshness: string;
  taskPrompt?: string;
  selectedRefs: KnowledgeCandidateRef[];
  injectableRefs?: KnowledgeCandidateRef[];
  rejectedRefs: KnowledgeCandidateRef[];
  availableRefs: KnowledgeCandidateRef[];
  candidateRefs?: KnowledgeCandidateRef[];
  providerTraces: KnowledgeRetrievalTrace[];
  providerDiagnostics: Array<Record<string, unknown>>;
  rerankerTraces: Array<Record<string, unknown>>;
  rerankerDiagnostics: Array<Record<string, unknown>>;
  rerankerProviders: string[];
  retrievalProviders: string[];
  currentFiles: string[];
  agentRoleSignals?: AgentRoleSignal[];
  contextQueryIntent?: ContextQueryIntent;
  renderedContextQuery?: string;
  contextQueryIntentHash?: string;
  renderedContextQueryHash?: string;
  renderedContextQueryLength?: number;
  semanticContextQuery?: string;
  semanticContextQueryHash?: string;
  semanticContextQueryLength?: number;
  createdAt: Date;
}

export class MandatoryGraphProvider implements KnowledgeRetrievalProvider {
  readonly providerId = 'mandatory_graph';

  constructor(private readonly options: { includeBaseline?: boolean; includeGlobs?: boolean } = {}) {}

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    const includeBaseline = this.options.includeBaseline ?? true;
    const includeGlobs = this.options.includeGlobs ?? true;
    const baseline = includeBaseline
      ? input.nodes.filter((node) => node.kind === 'repo' || node.access.injectPolicy === 'baseline')
      : [];
    const roleMandatory = input.nodes.filter((node) => mandatoryContextMatch(node, input).matched);
    const globMandatory = includeGlobs
      ? input.nodes.filter((node) => nodeMatchesMandatoryGlobs(node, input.currentFiles))
      : [];
    const selectedRefs = uniqueByRefId([...baseline, ...roleMandatory, ...globMandatory])
      .sort((a, b) => mandatoryContextCandidatePriority(b, input) - mandatoryContextCandidatePriority(a, input))
      .map((node) => toCandidateRef({
        node,
        providerId: this.providerId,
        source: 'mandatory_graph',
        mandatory: true,
        score: mandatoryContextCandidatePriority(node, input),
        reason: mandatoryContextReason(node, input, input.currentFiles),
      }));

    return resultFromSelected(this.providerId, selectedRefs);
  }
}

export class MandatoryContextMappingProvider implements KnowledgeRetrievalProvider {
  readonly providerId = 'mandatory_context_mapping';

  constructor(private readonly db?: Db) {}

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    if (!this.db) {
      return {
        providerId: this.providerId,
        candidates: [],
        selectedRefs: [],
        rejectedRefs: [],
        diagnostics: [{ code: 'mandatory_context_db_unavailable', severity: 'warn', message: 'Mandatory context mapping provider has no DB handle.' }],
        trace: [],
      };
    }
    const roleCandidates = Array.from(new Set([
      input.executionKind === 'spawned_agent' ? input.targetRole : input.nodeRole,
      input.targetRole,
      input.nodeRole,
      input.callerRole,
    ].filter((value): value is string => Boolean(value))));
    if (!roleCandidates.length) {
      return resultFromSelected(this.providerId, []);
    }
    const rows = await this.db.collection('repo_mandatory_context_mappings')
      .find({ repoId: input.repoId, enabled: true, agentName: { $in: roleCandidates } }, { sort: { agentName: 1, sourcePath: 1, title: 1 } })
      .toArray();
    const selectedRefs = rows.map((row, index) => {
      const content = stringValue(row.content) ?? '';
      const sourcePath = stringValue(row.sourcePath);
      const title = stringValue(row.title) ?? sourcePath ?? `Mandatory context ${index + 1}`;
      return {
        refId: `mandatory:${String(row.mappingId ?? row._id ?? index)}`,
        kind: 'instruction_file' as KnowledgeNodeKind,
        title,
        path: sourcePath,
        summary: stringValue(row.reasoning) ?? content.slice(0, 500),
        tags: ['mandatory_context', String(row.agentName ?? '')].filter(Boolean),
        providerId: this.providerId,
        source: 'mandatory_context_mapping',
        reason: `Mandatory context mapped to Allen agent ${String(row.agentName ?? 'unknown')}.`,
        score: 10_000 - index,
        loadable: true,
        mandatory: true,
        itemType: 'provider_text' as const,
        grounding: sourcePath ? 'repo_backed' as const : 'provider_text' as const,
        content,
        contentSha256: stringValue(row.contentHash),
        targetLayer: 'system_prompt' as const,
        providerMetadata: {
          mappingId: String(row.mappingId ?? row._id ?? ''),
          agentName: row.agentName,
          sourcePath,
          sourceHash: row.sourceHash,
          sourceType: row.sourceType,
          injectionDecision: 'mandatory_full',
          injectionPolicy: 'mandatory_full',
        },
      };
    });
    return resultFromSelected(this.providerId, selectedRefs);
  }
}

export class GraphKeywordMetadataProvider implements KnowledgeRetrievalProvider {
  readonly providerId = 'graph_keyword_metadata';

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    const taskText = `${input.workflowName} ${input.nodeName} ${input.nodeRole ?? ''} ${input.prompt ?? ''}`.toLowerCase();
    const entries = input.nodes
      .map((node) => ({ node, score: scoreNode(node, taskText, input.nodeRole) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    const selectedRefs = entries.map((entry) => toCandidateRef({
      node: entry.node,
      providerId: this.providerId,
      source: 'graph_keyword_metadata',
      mandatory: false,
      score: entry.score,
      reason: searchWhy(entry.node, entry.score, input.nodeRole),
    }));

    return resultFromSelected(this.providerId, selectedRefs);
  }
}

export class RepoContextEngine {
  private providers: KnowledgeRetrievalProvider[];
  private reranker: ContextReranker;
  private db?: Db;

  constructor(
    providers?: KnowledgeRetrievalProvider[],
    reranker: ContextReranker = createConfiguredContextReranker(),
    options: { db?: Db } = {},
  ) {
    this.providers = providers ?? createConfiguredKnowledgeProviders(options);
    this.reranker = reranker;
    this.db = options.db;
  }

  async buildPacket(input: KnowledgeRetrievalInput & { packetId: string; executionId: string; worktreePath?: unknown }): Promise<RepoContextPacket> {
    const agentRoleSignals = input.agentRoleSignals ?? await this.resolveAgentRoleSignals(input);
    const inputWithAgentSignals = { ...input, agentRoleSignals };
    const contextQueryIntent = input.contextQueryIntent ?? buildContextQueryIntent(inputWithAgentSignals);
    const renderedContextQuery = input.renderedContextQuery ?? renderContextQuery(contextQueryIntent);
    const semanticContextQuery = input.semanticContextQuery ?? renderSemanticContextQuery(contextQueryIntent);
    const queryInput = {
      ...inputWithAgentSignals,
      currentFiles: contextQueryIntent.currentFiles,
      contextQueryIntent,
      renderedContextQuery,
      semanticContextQuery,
      contextQueryIntentHash: input.contextQueryIntentHash ?? contextQueryIntentHash(contextQueryIntent),
      renderedContextQueryHash: input.renderedContextQueryHash ?? renderedContextQueryHash(renderedContextQuery),
      renderedContextQueryLength: input.renderedContextQueryLength ?? renderedContextQuery.length,
      semanticContextQueryHash: input.semanticContextQueryHash ?? semanticContextQueryHash(semanticContextQuery),
      semanticContextQueryLength: input.semanticContextQueryLength ?? semanticContextQuery.length,
    };
    const results: KnowledgeRetrievalResult[] = [];
    for (const provider of this.providers) {
      try {
        results.push(await provider.retrieve(queryInput));
      } catch (err) {
        results.push({
          providerId: provider.providerId,
          candidates: [],
          selectedRefs: [],
          rejectedRefs: [],
          diagnostics: [{
            code: 'retrieval_provider_failed',
            severity: 'warn',
            providerId: provider.providerId,
            message: (err as Error).message,
          }],
          trace: [],
        });
      }
    }

    const allCandidates = results.flatMap((result) => result.selectedRefs);
    const reranked = await this.reranker.rerank({
      repoId: queryInput.repoId,
      repoName: queryInput.repoName,
      repoPath: queryInput.repoPath,
      indexId: queryInput.indexId,
      indexFreshness: queryInput.indexFreshness,
      workflowName: queryInput.workflowName,
      nodeName: queryInput.nodeName,
      nodeRole: queryInput.nodeRole,
      executionKind: queryInput.executionKind,
      targetRole: queryInput.targetRole,
      callerRole: queryInput.callerRole,
      attempt: queryInput.attempt,
      state: queryInput.state,
      prompt: queryInput.prompt,
      provider: queryInput.provider,
      currentFiles: queryInput.currentFiles,
      parentPacketId: queryInput.parentPacketId,
      parentExecutionId: queryInput.parentExecutionId,
      rootExecutionId: queryInput.rootExecutionId,
      contextQueryIntent: queryInput.contextQueryIntent,
      renderedContextQuery: queryInput.renderedContextQuery,
      semanticContextQuery: queryInput.semanticContextQuery,
      contextQueryIntentHash: queryInput.contextQueryIntentHash,
      renderedContextQueryHash: queryInput.renderedContextQueryHash,
      renderedContextQueryLength: queryInput.renderedContextQueryLength,
      semanticContextQueryHash: queryInput.semanticContextQueryHash,
      semanticContextQueryLength: queryInput.semanticContextQueryLength,
      candidates: allCandidates,
    });
    const composed = composeProviderResults(results, reranked.rankedRefs);
    return {
      packetId: input.packetId,
      executionId: input.executionId,
      executionTraceId: input.executionTraceId,
      workflowName: input.workflowName,
      nodeName: input.nodeName,
      nodeRole: input.nodeRole,
      executionKind: input.executionKind,
      targetRole: input.targetRole,
      callerRole: input.callerRole,
      attempt: input.attempt,
      repoId: input.repoId,
      repoName: input.repoName,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      parentPacketId: input.parentPacketId,
      parentExecutionId: input.parentExecutionId,
      rootExecutionId: input.rootExecutionId,
      indexId: input.indexId,
      indexFreshness: input.indexFreshness,
      taskPrompt: input.prompt,
      selectedRefs: composed.selectedRefs,
      injectableRefs: composed.injectableRefs,
      rejectedRefs: composed.rejectedRefs,
      availableRefs: composed.availableRefs,
      candidateRefs: composed.candidateRefs,
      providerTraces: results.flatMap((result) => result.trace),
      providerDiagnostics: [...results.flatMap((result) => result.diagnostics), ...reranked.diagnostics, ...composed.diagnostics],
      rerankerTraces: reranked.traces,
      rerankerDiagnostics: reranked.diagnostics,
      rerankerProviders: [reranked.providerId],
      retrievalProviders: [...results.map((result) => result.providerId), reranked.providerId],
      currentFiles: input.currentFiles,
      agentRoleSignals,
      contextQueryIntent: queryInput.contextQueryIntent,
      renderedContextQuery: queryInput.renderedContextQuery,
      contextQueryIntentHash: queryInput.contextQueryIntentHash,
      renderedContextQueryHash: queryInput.renderedContextQueryHash,
      renderedContextQueryLength: queryInput.renderedContextQueryLength,
      semanticContextQuery: queryInput.semanticContextQuery,
      semanticContextQueryHash: queryInput.semanticContextQueryHash,
      semanticContextQueryLength: queryInput.semanticContextQueryLength,
      createdAt: new Date(),
    };
  }

  private async resolveAgentRoleSignals(input: KnowledgeRetrievalInput): Promise<AgentRoleSignal[] | undefined> {
    if (!this.db) return undefined;
    const rawRoleInputs: Array<{ roleSlot: AgentRoleSignal['roleSlot']; roleName?: string }> = [
      { roleSlot: 'nodeRole', roleName: input.nodeRole },
      { roleSlot: 'targetRole', roleName: input.targetRole },
      { roleSlot: 'callerRole', roleName: input.callerRole },
    ];
    const roleInputs: Array<{ roleSlot: AgentRoleSignal['roleSlot']; roleName: string }> = rawRoleInputs
      .filter((entry): entry is { roleSlot: AgentRoleSignal['roleSlot']; roleName: string } => Boolean(entry.roleName));
    if (!roleInputs.length) return undefined;
    const uniqueNames = Array.from(new Set(roleInputs.map((entry) => entry.roleName)));
    const docs = await this.db.collection('agents')
      .find({ name: { $in: uniqueNames } })
      .project({ name: 1, description: 1, provider: 1, tags: 1, teamName: 1, teamRole: 1, systemPrompt: 1, prompt: 1, instructions: 1, body: 1 })
      .toArray()
      .catch(() => []);
    const byName = new Map(docs.map((doc) => [String(doc.name ?? ''), doc]));
    const signals: AgentRoleSignal[] = [];
    for (const roleInput of roleInputs) {
      const roleName = roleInput.roleName;
      const doc = byName.get(roleName);
      if (!doc) continue;
      const description = stringValue(doc.description);
      const instructionSummary = compactRoleSignal(firstString(doc.systemPrompt, doc.prompt, doc.instructions, doc.body), 500);
      const tags = Array.isArray(doc.tags) ? doc.tags.map(String).filter(Boolean).slice(0, 16) : [];
      const parts = [
        `name ${String(doc.name ?? roleName)}`,
        description ? `description ${description}` : undefined,
        tags.length ? `tags ${tags.join(', ')}` : undefined,
        stringValue(doc.teamName) ? `team ${stringValue(doc.teamName)}` : undefined,
        stringValue(doc.teamRole) ? `team role ${stringValue(doc.teamRole)}` : undefined,
        instructionSummary ? `instructions ${instructionSummary}` : undefined,
      ].filter(Boolean);
      if (!parts.length) continue;
      signals.push({
        roleSlot: roleInput.roleSlot,
        roleName,
        agentName: stringValue(doc.name) ?? roleName,
        provider: stringValue(doc.provider),
        teamName: stringValue(doc.teamName),
        teamRole: stringValue(doc.teamRole),
        description,
        tags,
        instructionSummary,
        signalText: compactRoleSignal(parts.join(' | '), 1200) ?? roleName,
      });
    }
    return signals.length ? signals : undefined;
  }

}

export function createConfiguredKnowledgeProviders(options: { db?: Db } = {}): KnowledgeRetrievalProvider[] {
  const provider = configuredContextProvider();
  if (!provider) return [];
  if (provider === 'cognee' || provider === 'cognee_memory') {
    const providers: KnowledgeRetrievalProvider[] = [new MandatoryContextMappingProvider(options.db)];
    providers.push(new CogneeMemoryProvider(options.db));
    return providers;
  }
  if (provider === 'allen') return [new MandatoryContextMappingProvider(options.db)];
  return [];
}

function composeProviderResults(results: KnowledgeRetrievalResult[], rankedRefs: KnowledgeCandidateRef[]): {
  selectedRefs: KnowledgeCandidateRef[];
  injectableRefs: KnowledgeCandidateRef[];
  rejectedRefs: KnowledgeCandidateRef[];
  availableRefs: KnowledgeCandidateRef[];
  candidateRefs: KnowledgeCandidateRef[];
  diagnostics: Array<Record<string, unknown>>;
} {
  const selected: KnowledgeCandidateRef[] = [];
  const rejected: KnowledgeCandidateRef[] = [];
  const thresholds = contextRelevanceThresholds();
  const seenRefIds = new Set<string>();
  const seenContentHashes = new Set<string>();
  const orderedRefs = [...rankedRefs].sort((a, b) => {
    if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
    return Number((a.rerank as Record<string, unknown> | undefined)?.finalRank ?? 0)
      - Number((b.rerank as Record<string, unknown> | undefined)?.finalRank ?? 0);
  });

  for (const ref of orderedRefs) {
    const thresholdRejection = contextRefThresholdRejection(ref, thresholds);
    if (thresholdRejection) {
      rejected.push(withThresholdRejection(ref, thresholdRejection));
      continue;
    }
    if (seenRefIds.has(ref.refId)) {
      rejected.push({ ...ref, reason: `Duplicate context ref skipped after reranking: ${ref.reason}` });
      continue;
    }
    if (ref.contentSha256 && seenContentHashes.has(ref.contentSha256)) {
      rejected.push({ ...ref, reason: `Duplicate provider text skipped after reranking: ${ref.reason}` });
      continue;
    }
    seenRefIds.add(ref.refId);
    if (ref.contentSha256) seenContentHashes.add(ref.contentSha256);
    selected.push(ref);
  }

  rejected.push(...results.flatMap((result) => result.rejectedRefs));
  const explicitInjectableIds = new Set(results.flatMap((result) => result.injectableRefs ?? []).map((ref) => ref.refId));
  const injectableRefs = selected.filter((ref) => {
    if (ref.mandatory || ref.targetLayer === 'system_prompt') return true;
    if (isCuratedSnippetRef(ref)) return true;
    if (!passesInjectionThreshold(ref, thresholds)) return false;
    if (explicitInjectableIds.has(ref.refId)) return true;
    return ref.providerMetadata?.injectionDecision === 'mandatory_full'
      || ref.providerMetadata?.injectionDecision === 'snippet'
      || ref.providerMetadata?.injectionPolicy === 'injectable';
  });
  const injectableIds = new Set(injectableRefs.map((ref) => ref.refId));
  const selectedRefs = selected.map((ref) => withFinalInjectionDecision(ref, injectableIds.has(ref.refId) ? injectionDecisionFor(ref) : 'manifest_only'));
  const finalInjectableRefs = injectableRefs.map((ref) => withFinalInjectionDecision(ref, injectionDecisionFor(ref)));
  rejected.push(...selected
    .filter((ref) => isOptionalCogneeRef(ref) && !isCuratedSnippetRef(ref) && isInjectableDecision(ref) && !passesInjectionThreshold(ref, thresholds))
    .map((ref) => withThresholdRejection(ref, {
      code: 'below_injection_threshold',
      threshold: isCuratedContextRef(ref) ? thresholds.minCuratedInjectionScore : thresholds.minInjectionScore,
    })));
  return {
    selectedRefs,
    injectableRefs: finalInjectableRefs,
    rejectedRefs: rejected,
    availableRefs: selectedRefs.filter((ref) => !ref.mandatory),
    candidateRefs: results.flatMap((result) => result.candidates),
    diagnostics: [{
      code: 'context_relevance_thresholds_applied',
      severity: 'info',
      minCogneeSelectionScore: thresholds.minCogneeSelectionScore,
      minCuratedSelectionScore: thresholds.minCuratedSelectionScore,
      minRerankScore: thresholds.minRerankScore,
      minCuratedRerankScore: thresholds.minCuratedRerankScore,
      minFinalScore: thresholds.minFinalScore,
      minCuratedFinalScore: thresholds.minCuratedFinalScore,
      minInjectionScore: thresholds.minInjectionScore,
      minCuratedInjectionScore: thresholds.minCuratedInjectionScore,
      thresholdRejectedCount: rejected.filter((ref) => typeof ref.providerMetadata?.rejectionReason === 'string' && String(ref.providerMetadata.rejectionReason).startsWith('below_')).length,
      selectedCount: selected.length,
      injectableCount: finalInjectableRefs.length,
      message: 'Optional Cognee context was filtered using retrieval and reranker relevance thresholds.',
    }],
  };
}

function withFinalInjectionDecision(ref: KnowledgeCandidateRef, decision: string): KnowledgeCandidateRef {
  return {
    ...ref,
    providerMetadata: {
      ...ref.providerMetadata,
      finalInjectionDecision: decision,
    },
  };
}

function injectionDecisionFor(ref: KnowledgeCandidateRef): string {
  const decision = ref.providerMetadata?.curatedInjectionPolicy ?? ref.providerMetadata?.injectionDecision ?? ref.providerMetadata?.injectionPolicy;
  if (decision === 'injectable') return 'snippet';
  if (typeof decision === 'string' && decision) return decision;
  return ref.mandatory || ref.targetLayer === 'system_prompt' ? 'mandatory_full' : 'manifest_only';
}

function contextRelevanceThresholds(): {
  minCogneeSelectionScore: number;
  minCuratedSelectionScore: number;
  minRerankScore: number;
  minCuratedRerankScore: number;
  minFinalScore: number;
  minCuratedFinalScore: number;
  minInjectionScore: number;
  minCuratedInjectionScore: number;
} {
  return {
    minCogneeSelectionScore: boundedScoreEnv('ALLEN_COGNEE_MIN_SELECTION_SCORE', DEFAULT_COGNEE_MIN_SELECTION_SCORE),
    minCuratedSelectionScore: boundedScoreEnv('ALLEN_CURATED_CONTEXT_MIN_SELECTION_SCORE', DEFAULT_CURATED_CONTEXT_MIN_SELECTION_SCORE),
    minRerankScore: boundedScoreEnv('ALLEN_CONTEXT_MIN_RERANK_SCORE', DEFAULT_CONTEXT_MIN_RERANK_SCORE),
    minCuratedRerankScore: boundedScoreEnv('ALLEN_CURATED_CONTEXT_MIN_RERANK_SCORE', 0.2),
    minFinalScore: boundedScoreEnv('ALLEN_CONTEXT_MIN_FINAL_SCORE', DEFAULT_CONTEXT_MIN_FINAL_SCORE),
    minCuratedFinalScore: boundedScoreEnv('ALLEN_CURATED_CONTEXT_MIN_FINAL_SCORE', 0.25),
    minInjectionScore: boundedScoreEnv('ALLEN_COGNEE_MIN_INJECTION_SCORE', DEFAULT_COGNEE_MIN_INJECTION_SCORE),
    minCuratedInjectionScore: boundedScoreEnv('ALLEN_CURATED_CONTEXT_MIN_INJECTION_SCORE', DEFAULT_CURATED_CONTEXT_MIN_INJECTION_SCORE),
  };
}

function contextRefThresholdRejection(
  ref: KnowledgeCandidateRef,
  thresholds: ReturnType<typeof contextRelevanceThresholds>,
): { code: string; threshold: number } | null {
  if (!isOptionalCogneeRef(ref)) return null;
  const selectionThreshold = isCuratedContextRef(ref) ? thresholds.minCuratedSelectionScore : thresholds.minCogneeSelectionScore;
  const rerankThreshold = isCuratedContextRef(ref) ? thresholds.minCuratedRerankScore : thresholds.minRerankScore;
  const finalThreshold = isCuratedContextRef(ref) ? thresholds.minCuratedFinalScore : thresholds.minFinalScore;
  if (retrievalScoreFor(ref) < selectionThreshold) {
    return { code: 'below_cognee_selection_threshold', threshold: selectionThreshold };
  }
  if (rerankScoreFor(ref) < rerankThreshold) {
    return { code: 'below_rerank_threshold', threshold: rerankThreshold };
  }
  if (finalRelevanceScoreFor(ref) < finalThreshold) {
    return { code: 'below_final_score_threshold', threshold: finalThreshold };
  }
  return null;
}

function passesInjectionThreshold(
  ref: KnowledgeCandidateRef,
  thresholds: ReturnType<typeof contextRelevanceThresholds>,
): boolean {
  if (!isOptionalCogneeRef(ref)) return true;
  const injectionThreshold = isCuratedContextRef(ref) ? thresholds.minCuratedInjectionScore : thresholds.minInjectionScore;
  const rerankThreshold = isCuratedContextRef(ref) ? thresholds.minCuratedRerankScore : thresholds.minRerankScore;
  const finalThreshold = isCuratedContextRef(ref) ? thresholds.minCuratedFinalScore : thresholds.minFinalScore;
  return retrievalScoreFor(ref) >= injectionThreshold
    && rerankScoreFor(ref) >= rerankThreshold
    && finalRelevanceScoreFor(ref) >= finalThreshold;
}

function withThresholdRejection(ref: KnowledgeCandidateRef, rejection: { code: string; threshold: number }): KnowledgeCandidateRef {
  return {
    ...ref,
    reason: `${ref.reason} Rejected by context relevance threshold: ${rejection.code} (${thresholdScoreFor(ref, rejection.code)} < ${rejection.threshold}).`,
    providerMetadata: {
      ...ref.providerMetadata,
      thresholdRejected: true,
      rejectionReason: rejection.code,
      rejectionThreshold: rejection.threshold,
    },
  };
}

function thresholdScoreFor(ref: KnowledgeCandidateRef, code: string): number {
  if (code === 'below_rerank_threshold') return rerankScoreFor(ref);
  if (code === 'below_final_score_threshold') return finalRelevanceScoreFor(ref);
  return retrievalScoreFor(ref);
}

function isOptionalCogneeRef(ref: KnowledgeCandidateRef): boolean {
  return !ref.mandatory && (ref.providerId === 'cognee_memory' || ref.providerMetadata?.retrievalStage === 'primary' || ref.providerMetadata?.retrievalStage === 'graph_expansion');
}

function isInjectableDecision(ref: KnowledgeCandidateRef): boolean {
  const decision = ref.providerMetadata?.curatedInjectionPolicy ?? ref.providerMetadata?.injectionDecision ?? ref.providerMetadata?.injectionPolicy;
  return decision === 'mandatory_full' || decision === 'snippet' || decision === 'injectable';
}

function isCuratedContextRef(ref: KnowledgeCandidateRef): boolean {
  return typeof ref.providerMetadata?.curatedInjectionPolicy === 'string'
    || typeof ref.providerMetadata?.curationEntryId === 'string';
}

function isCuratedSnippetRef(ref: KnowledgeCandidateRef): boolean {
  return isCuratedContextRef(ref) && ref.providerMetadata?.curatedInjectionPolicy === 'snippet';
}

function retrievalScoreFor(ref: KnowledgeCandidateRef): number {
  const metadataScore = Number(ref.providerMetadata?.retrievalScore ?? ref.providerMetadata?.retrievalPolicyScore);
  return Number.isFinite(metadataScore) ? clampUnitScore(metadataScore) : normalizeRawScore(ref.score);
}

function rerankScoreFor(ref: KnowledgeCandidateRef): number {
  const rerank = ref.rerank as Record<string, unknown> | undefined;
  const rerankScore = Number(rerank?.rerankScore);
  if (Number.isFinite(rerankScore)) return clampUnitScore(rerankScore);
  const semanticScore = Number(rerank?.semanticScore ?? rerank?.score);
  return Number.isFinite(semanticScore) ? normalizeRawScore(semanticScore) : retrievalScoreFor(ref);
}

function finalRelevanceScoreFor(ref: KnowledgeCandidateRef): number {
  const rerank = ref.rerank as Record<string, unknown> | undefined;
  const finalRelevanceScore = Number(rerank?.finalRelevanceScore);
  return Number.isFinite(finalRelevanceScore) ? clampUnitScore(finalRelevanceScore) : rerankScoreFor(ref);
}

function normalizeRawScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return Math.min(1, score / 100);
  return score;
}

function clampUnitScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function resultFromSelected(providerId: string, selectedRefs: KnowledgeCandidateRef[]): KnowledgeRetrievalResult {
  return {
    providerId,
    candidates: selectedRefs,
    selectedRefs,
    rejectedRefs: [],
    diagnostics: [],
    trace: selectedRefs.map((ref) => ({
      providerId,
      refId: ref.refId,
      kind: ref.kind,
      title: ref.title,
      path: ref.path,
      itemType: ref.itemType,
      grounding: ref.grounding,
      score: ref.score,
      decision: 'selected',
      reason: ref.reason,
      providerMetadata: ref.providerMetadata,
    })),
  };
}

function toCandidateRef(input: {
  node: KnowledgeNodeLike;
  providerId: string;
  source: string;
  mandatory: boolean;
  reason: string;
  score?: number;
}): KnowledgeCandidateRef {
  return {
    refId: input.node.id,
    kind: input.node.kind,
    title: input.node.title,
    path: input.node.path,
    summary: input.node.summary.slice(0, 500),
    tags: input.node.tags,
    providerId: input.providerId,
    source: input.source,
    reason: input.reason,
    score: input.score,
    loadable: isPreloadLoadableKind(input.node.kind),
    mandatory: input.mandatory,
    itemType: input.node.path ? 'repo_file' : 'provider_generated',
    grounding: input.node.path ? 'repo_backed' : 'provider_generated',
    targetLayer: input.mandatory ? 'system_prompt' : undefined,
  };
}

function contextRefPriority(ref: KnowledgeCandidateRef): number {
  let priority = ref.score ?? 0;
  if (ref.mandatory) priority += 10_000;
  if (ref.providerId === 'mandatory_graph') priority += 1_000;
  if (ref.kind === 'instruction_file') priority += 90;
  if (ref.kind === 'context_file') priority += 80;
  if (ref.kind === 'runbook') priority += 70;
  if (ref.kind === 'production_note') priority += 60;
  if (ref.kind === 'doc') priority += 50;
  if (ref.kind === 'skill' || ref.kind === 'skill_reference') priority += 40;
  return priority;
}

function mandatoryContextCandidatePriority(node: KnowledgeNodeLike, input: Pick<KnowledgeRetrievalInput, 'nodeRole' | 'targetRole' | 'executionKind'>): number {
  let priority = 0;
  const match = mandatoryContextMatch(node, input);
  if (match.field === 'mandatoryForNodeRoles') priority += 1_000;
  if (match.field === 'mandatoryForSpawnedAgentRoles') priority += 1_000;
  if (match.field === 'mandatoryForSpawnerRoles') priority += 900;
  if (node.mandatoryForGlobs?.length) priority += 50;
  if (node.access.injectPolicy === 'baseline') priority += 500;
  if (node.access.injectPolicy === 'never_auto') priority -= 1_000;
  if (!node.path || !isPreloadLoadableKind(node.kind)) priority -= 500;
  return priority + contextRefPriority(toCandidateRef({
    node,
    providerId: 'mandatory_graph',
    source: 'mandatory_graph',
    mandatory: true,
    reason: '',
  }));
}

function mandatoryContextReason(node: KnowledgeNodeLike, input: Pick<KnowledgeRetrievalInput, 'nodeRole' | 'targetRole' | 'executionKind'>, currentFiles?: string[]): string {
  if (node.access.injectPolicy === 'baseline') return 'Baseline mandatory repo context selected by Allen before agent startup.';
  const match = mandatoryContextMatch(node, input);
  if (match.field === 'mandatoryForNodeRoles') return `Mandatory for workflow node role ${match.role}.`;
  if (match.field === 'mandatoryForSpawnedAgentRoles') return `Mandatory for spawned agent role ${match.role}.`;
  if (match.field === 'mandatoryForSpawnerRoles') return `Mandatory for spawner role ${match.role}.`;
  if (node.mandatoryForGlobs?.length && currentFiles?.length) return `Mandatory for matched repo files: ${currentFiles.slice(0, 5).join(', ')}.`;
  return 'Mandatory repo context selected by Allen before agent startup.';
}

function mandatoryContextMatch(
  node: KnowledgeNodeLike,
  input: Pick<KnowledgeRetrievalInput, 'nodeRole' | 'targetRole' | 'executionKind'>,
): { matched: boolean; field?: 'mandatoryForNodeRoles' | 'mandatoryForSpawnedAgentRoles' | 'mandatoryForSpawnerRoles'; role?: string } {
  const nodeRole = input.nodeRole ?? input.targetRole;
  const targetRole = input.targetRole ?? input.nodeRole;
  if (nodeRole && node.mandatoryForNodeRoles?.includes(nodeRole)) {
    return { matched: true, field: 'mandatoryForNodeRoles', role: nodeRole };
  }
  if (input.executionKind === 'spawned_agent' && targetRole && node.mandatoryForSpawnedAgentRoles?.includes(targetRole)) {
    return { matched: true, field: 'mandatoryForSpawnedAgentRoles', role: targetRole };
  }
  if (input.executionKind !== 'spawned_agent' && targetRole && node.mandatoryForSpawnerRoles?.includes(targetRole)) {
    return { matched: true, field: 'mandatoryForSpawnerRoles', role: targetRole };
  }
  return { matched: false };
}

function nodeMatchesMandatoryGlobs(node: KnowledgeNodeLike, currentFiles: string[]): boolean {
  if (!node.mandatoryForGlobs?.length || currentFiles.length === 0) return false;
  return node.mandatoryForGlobs.some((glob) => currentFiles.some((file) => globMatches(glob, file)));
}

function globMatches(glob: string, value: string): boolean {
  const normalizedGlob = glob.replace(/\\/g, '/');
  const normalizedValue = value.replace(/\\/g, '/');
  let pattern = '';
  for (let i = 0; i < normalizedGlob.length; i++) {
    const ch = normalizedGlob[i];
    if (ch === '*') {
      if (normalizedGlob[i + 1] === '*') {
        pattern += '.*';
        i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`).test(normalizedValue);
}

function scoreNode(node: KnowledgeNodeLike, taskText: string, role?: string): number {
  let score = 0;
  const haystack = `${node.title} ${node.path ?? ''} ${node.summary} ${node.tags.join(' ')} ${node.moduleId ?? ''}`.toLowerCase();
  for (const token of taskText.split(/[^a-z0-9_-]+/).filter((t) => t.length > 2)) {
    if (haystack.includes(token)) score += 1;
  }
  if (role && node.mandatoryForNodeRoles?.includes(role)) score += 5;
  if (role && node.mandatoryForSpawnedAgentRoles?.includes(role)) score += 5;
  if (role && node.mandatoryForSpawnerRoles?.includes(role)) score += 4;
  if (node.kind === 'production_note') score += 2;
  if (node.kind === 'skill') score += 1;
  return score;
}

function searchWhy(node: KnowledgeNodeLike, score: number, role?: string): string {
  if (node.access.injectPolicy === 'baseline') return `Baseline repo knowledge matched the query with score ${score}.`;
  if (role && node.mandatoryForNodeRoles?.includes(role)) return `Mandatory for role ${role} and matched the query with score ${score}.`;
  if (role && node.mandatoryForSpawnedAgentRoles?.includes(role)) return `Mandatory for spawned role ${role} and matched the query with score ${score}.`;
  if (role && node.mandatoryForSpawnerRoles?.includes(role)) return `Mandatory for spawner role ${role} and matched the query with score ${score}.`;
  if (node.kind === 'production_note' || node.kind === 'runbook') return `Production/runbook context matched the query with score ${score}.`;
  if (node.kind === 'skill' || node.kind === 'skill_reference') return `Skill context matched the query with score ${score}.`;
  return `Knowledge graph ref matched the query with score ${score}.`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compactRoleSignal(value: unknown, maxChars: number): string | undefined {
  const text = firstString(value)?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function isPreloadLoadableKind(kind: KnowledgeNodeKind): boolean {
  return ['instruction_file', 'context_file', 'doc', 'runbook', 'production_note', 'skill', 'skill_reference'].includes(kind);
}

function uniqueByRefId<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
