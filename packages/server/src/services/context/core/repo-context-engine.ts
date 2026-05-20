import { createConfiguredContextReranker, type ContextReranker } from './repo-context-reranker.js';
import { CogneeMemoryProvider } from '../cognee/repo-context-cognee-provider.js';
import { cogneeMandatoryGraphMode, configuredContextProvider } from '../config/context-provider-config.js';
import type { Db } from 'mongodb';

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
  workflowName: string;
  nodeName: string;
  nodeRole?: string;
  executionKind?: 'workflow_node' | 'spawned_agent' | 'chat_agent';
  targetRole?: string;
  callerRole?: string;
  attempt: number;
  state: Record<string, unknown>;
  prompt?: string;
  provider: RepoContextProvider;
  currentFiles: string[];
  nodes: KnowledgeNodeLike[];
  parentPacketId?: string;
  parentExecutionId?: string | null;
  rootExecutionId?: string;
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
  targetLayer?: 'system_prompt';
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

  constructor(
    providers?: KnowledgeRetrievalProvider[],
    reranker: ContextReranker = createConfiguredContextReranker(),
    options: { db?: Db } = {},
  ) {
    this.providers = providers ?? createConfiguredKnowledgeProviders(options);
    this.reranker = reranker;
  }

  async buildPacket(input: KnowledgeRetrievalInput & { packetId: string; executionId: string; worktreePath?: unknown }): Promise<RepoContextPacket> {
    const results: KnowledgeRetrievalResult[] = [];
    for (const provider of this.providers) {
      try {
        results.push(await provider.retrieve(input));
      } catch (err) {
        const mandatoryGraphRequired = provider.providerId === 'mandatory_graph'
          && (contextProviderFallback() === 'graph' || cogneeMandatoryGraphMode() === 'required');
        results.push({
          providerId: provider.providerId,
          candidates: [],
          selectedRefs: [],
          rejectedRefs: [],
          diagnostics: [{
            code: 'retrieval_provider_failed',
            severity: mandatoryGraphRequired ? 'error' : 'warn',
            providerId: provider.providerId,
            message: (err as Error).message,
          }],
          trace: [],
        });
      }
    }

    const allCandidates = results.flatMap((result) => result.selectedRefs);
    const reranked = await this.reranker.rerank({
      repoId: input.repoId,
      repoName: input.repoName,
      repoPath: input.repoPath,
      indexId: input.indexId,
      indexFreshness: input.indexFreshness,
      workflowName: input.workflowName,
      nodeName: input.nodeName,
      nodeRole: input.nodeRole,
      executionKind: input.executionKind,
      targetRole: input.targetRole,
      callerRole: input.callerRole,
      attempt: input.attempt,
      state: input.state,
      prompt: input.prompt,
      provider: input.provider,
      currentFiles: input.currentFiles,
      parentPacketId: input.parentPacketId,
      parentExecutionId: input.parentExecutionId,
      rootExecutionId: input.rootExecutionId,
      candidates: allCandidates,
    });
    const composed = composeProviderResults(results, reranked.rankedRefs);
    return {
      packetId: input.packetId,
      executionId: input.executionId,
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
      providerDiagnostics: [...results.flatMap((result) => result.diagnostics), ...reranked.diagnostics],
      rerankerTraces: reranked.traces,
      rerankerDiagnostics: reranked.diagnostics,
      rerankerProviders: [reranked.providerId],
      retrievalProviders: [...results.map((result) => result.providerId), reranked.providerId],
      currentFiles: input.currentFiles,
      createdAt: new Date(),
    };
  }

  search(input: KnowledgeRetrievalInput & { query: string; limit: number }): KnowledgeCandidateRef[] {
    const taskText = `${input.query} ${input.currentFiles.join(' ')}`.toLowerCase();
    return input.nodes
      .map((node) => {
        const score = scoreNode(node, taskText, input.nodeRole)
          + (node.path && input.currentFiles.includes(node.path) ? 5 : 0)
          + (node.access.injectPolicy === 'baseline' ? 1 : 0);
        return { node, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit)
      .map((entry) => toCandidateRef({
        node: entry.node,
        providerId: 'graph_keyword_metadata',
        source: 'search_repo_knowledge',
        mandatory: false,
        score: entry.score,
        reason: searchWhy(entry.node, entry.score, input.nodeRole),
      }));
  }
}

export function createConfiguredKnowledgeProviders(options: { db?: Db } = {}): KnowledgeRetrievalProvider[] {
  const provider = configuredContextProvider();
  if (!provider) return [];
  if (provider === 'cognee' || provider === 'cognee_memory') {
    const providers: KnowledgeRetrievalProvider[] = [];
    const graphFallbackEnabled = contextProviderFallback() === 'graph';
    if (cogneeMandatoryGraphMode() !== 'off' || graphFallbackEnabled) providers.push(new MandatoryGraphProvider());
    providers.push(new CogneeMemoryProvider(options.db));
    if (graphFallbackEnabled) providers.push(new GraphKeywordMetadataProvider());
    return providers;
  }
  if (provider === 'allen') return [new MandatoryGraphProvider(), new GraphKeywordMetadataProvider()];
  return [];
}

function contextProviderFallback(): string {
  return (process.env.ALLEN_CONTEXT_PROVIDER_FALLBACK ?? 'none').toLowerCase();
}

function composeProviderResults(results: KnowledgeRetrievalResult[], rankedRefs: KnowledgeCandidateRef[]): {
  selectedRefs: KnowledgeCandidateRef[];
  injectableRefs: KnowledgeCandidateRef[];
  rejectedRefs: KnowledgeCandidateRef[];
  availableRefs: KnowledgeCandidateRef[];
  candidateRefs: KnowledgeCandidateRef[];
} {
  const selected: KnowledgeCandidateRef[] = [];
  const rejected: KnowledgeCandidateRef[] = [];
  const seenRefIds = new Set<string>();
  const seenContentHashes = new Set<string>();
  const orderedRefs = [...rankedRefs].sort((a, b) => {
    if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
    return Number((a.rerank as Record<string, unknown> | undefined)?.finalRank ?? 0)
      - Number((b.rerank as Record<string, unknown> | undefined)?.finalRank ?? 0);
  });

  for (const ref of orderedRefs) {
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
    if (explicitInjectableIds.has(ref.refId)) return true;
    return ref.providerMetadata?.injectionDecision === 'mandatory_full'
      || ref.providerMetadata?.injectionDecision === 'snippet'
      || ref.providerMetadata?.injectionPolicy === 'injectable';
  });
  return {
    selectedRefs: selected,
    injectableRefs,
    rejectedRefs: rejected,
    availableRefs: selected.filter((ref) => !ref.mandatory),
    candidateRefs: results.flatMap((result) => result.candidates),
  };
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
