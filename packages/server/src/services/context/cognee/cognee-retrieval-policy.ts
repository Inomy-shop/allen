import type { KnowledgeCandidateRef, KnowledgeRetrievalInput } from '../core/repo-context-engine.js';
import {
  buildContextQueryIntent,
  contextQueryIntentHash,
  renderedContextQueryHash,
  renderSemanticContextQuery,
  semanticContextQueryHash,
  type ContextQueryIntent,
} from '../core/context-query-intent.js';
import { firstString, isRecord } from '../common/context-utils.js';
import type { CogneeInjectionDecision } from './cognee-metadata-enrichment.js';

export const DEFAULT_COGNEE_CANDIDATE_LIMIT = 30;
export const DEFAULT_COGNEE_MIN_SELECTION_SCORE = 0.45;
export const DEFAULT_COGNEE_MIN_INJECTION_SCORE = 0.6;
export const DEFAULT_CURATED_CONTEXT_MIN_SELECTION_SCORE = 0.3;
export const DEFAULT_CURATED_CONTEXT_MIN_INJECTION_SCORE = 0.55;

export type RetrievalIntentEnvelope = ContextQueryIntent;

export function buildCogneeQuery(input: KnowledgeRetrievalInput): string {
  return input.semanticContextQuery ?? renderSemanticContextQuery(buildRetrievalIntentEnvelope(input));
}

export function retrievalEnvelopeHash(envelope: RetrievalIntentEnvelope): string {
  return contextQueryIntentHash(envelope);
}

export function renderedQueryHash(query: string): string {
  return renderedContextQueryHash(query);
}

export function semanticQueryHash(query: string): string {
  return semanticContextQueryHash(query);
}

export function buildGraphExpansionQuery(input: KnowledgeRetrievalInput, seeds: KnowledgeCandidateRef[]): string {
  return [
    buildCogneeQuery(input),
    'Find directly related repo documents for the selected seed references. Return source-backed documents or chunks only.',
    `Seed refs: ${seeds.map((seed) => [seed.path, seed.title].filter(Boolean).join(' - ')).join('; ')}`,
  ].join('\n');
}

export function buildRetrievalIntentEnvelope(input: KnowledgeRetrievalInput): RetrievalIntentEnvelope {
  return input.contextQueryIntent ?? buildContextQueryIntent(input);
}

export function selectCogneeRefs(
  candidates: KnowledgeCandidateRef[],
  input: KnowledgeRetrievalInput,
  envelope: RetrievalIntentEnvelope,
  retrievalStage: 'primary' | 'graph_expansion',
): {
  candidates: KnowledgeCandidateRef[];
  selectedRefs: KnowledgeCandidateRef[];
  rejectedRefs: KnowledgeCandidateRef[];
  diagnostics: Array<Record<string, unknown>>;
} {
  const minSelectionScore = boundedScoreEnv('ALLEN_COGNEE_MIN_SELECTION_SCORE', DEFAULT_COGNEE_MIN_SELECTION_SCORE);
  const minInjectionScore = boundedScoreEnv('ALLEN_COGNEE_MIN_INJECTION_SCORE', DEFAULT_COGNEE_MIN_INJECTION_SCORE);
  const minCuratedSelectionScore = boundedScoreEnv('ALLEN_CURATED_CONTEXT_MIN_SELECTION_SCORE', DEFAULT_CURATED_CONTEXT_MIN_SELECTION_SCORE);
  const minCuratedInjectionScore = boundedScoreEnv('ALLEN_CURATED_CONTEXT_MIN_INJECTION_SCORE', DEFAULT_CURATED_CONTEXT_MIN_INJECTION_SCORE);
  const scoredEntries = candidates.map((ref, originalRank) => scoreCogneeRef(ref, input, envelope, originalRank, retrievalStage));
  const scored = scoredEntries
    .filter((entry) => !entry.rejectedByHardFilter)
    .sort((a, b) => b.score - a.score || a.originalRank - b.originalRank);
  const selectedEntries = scored.filter((entry) => entry.ref.mandatory || entry.score >= selectionThresholdFor(entry.ref, { minSelectionScore, minCuratedSelectionScore }));
  const scoreRejected = scored
    .filter((entry) => !entry.ref.mandatory && entry.score < selectionThresholdFor(entry.ref, { minSelectionScore, minCuratedSelectionScore }))
    .map((entry) => withRetrievalPolicy(entry.ref, {
      ...entry,
      selected: false,
      injectable: false,
      injectionDecision: 'manifest_only',
      thresholdRejected: true,
      rejectionReason: 'below_cognee_selection_threshold',
      minSelectionScore: selectionThresholdFor(entry.ref, { minSelectionScore, minCuratedSelectionScore }),
      minInjectionScore: injectionThresholdFor(entry.ref, { minInjectionScore, minCuratedInjectionScore }),
    }));
  const hardRejected = scoredEntries
    .filter((entry) => entry.rejectedByHardFilter)
    .map((entry) => withRetrievalPolicy(entry.ref, {
      ...entry,
      selected: false,
      injectable: false,
      injectionDecision: entry.injectionDecision,
    }));
  const selectedRefs = selectedEntries.map((entry, selectedRank) => {
    const injectable = (entry.injectionDecision === 'mandatory_full' || entry.injectionDecision === 'snippet')
      && (entry.ref.mandatory || entry.score >= injectionThresholdFor(entry.ref, { minInjectionScore, minCuratedInjectionScore }));
    return withRetrievalPolicy(entry.ref, {
      ...entry,
      selected: true,
      selectedRank,
      injectable,
      injectionDecision: injectable ? entry.injectionDecision : 'manifest_only',
      minSelectionScore: selectionThresholdFor(entry.ref, { minSelectionScore, minCuratedSelectionScore }),
      minInjectionScore: injectionThresholdFor(entry.ref, { minInjectionScore, minCuratedInjectionScore }),
      injectionRejectedReason: injectable ? undefined : 'below_injection_threshold',
    });
  });
  const rejectedRefs = [...hardRejected, ...scoreRejected];
  return {
    candidates: scored.map((entry) => withRetrievalPolicy(entry.ref, {
      ...entry,
      selected: false,
      injectable: false,
      injectionDecision: entry.score >= injectionThresholdFor(entry.ref, { minInjectionScore, minCuratedInjectionScore }) ? entry.injectionDecision : 'manifest_only',
      thresholdRejected: !entry.ref.mandatory && entry.score < selectionThresholdFor(entry.ref, { minSelectionScore, minCuratedSelectionScore }),
      rejectionReason: !entry.ref.mandatory && entry.score < selectionThresholdFor(entry.ref, { minSelectionScore, minCuratedSelectionScore }) ? 'below_cognee_selection_threshold' : undefined,
      minSelectionScore: selectionThresholdFor(entry.ref, { minSelectionScore, minCuratedSelectionScore }),
      minInjectionScore: injectionThresholdFor(entry.ref, { minInjectionScore, minCuratedInjectionScore }),
    })),
    selectedRefs,
    rejectedRefs,
    diagnostics: [{
      code: 'cognee_retrieval_policy_applied',
      severity: 'info',
      retrievalStage,
      candidateCount: candidates.length,
      eligibleCount: scored.length,
      selectedCount: selectedRefs.length,
      rejectedCount: rejectedRefs.length,
      thresholdRejectedCount: scoreRejected.length,
      minSelectionScore,
      minInjectionScore,
      minCuratedSelectionScore,
      minCuratedInjectionScore,
      injectableCount: selectedRefs.filter((ref) => isInjectableDecision(ref.providerMetadata?.injectionDecision ?? ref.providerMetadata?.injectionPolicy)).length,
      manifestOnlyCount: selectedRefs.filter((ref) => ref.providerMetadata?.injectionPolicy === 'manifest_only').length,
      injectionDecisionCounts: countInjectionDecisions(selectedRefs),
      role: envelope.role,
      roleFamily: envelope.roleFamily,
      requiredCategories: envelope.requiredCategories,
      preferredCategories: envelope.preferredCategories,
      exclusionCategories: envelope.exclusionCategories,
      querySignalSources: envelope.querySignalSources,
      querySignalSections: envelope.querySignalSections,
      querySignalLength: envelope.querySignalLength,
      semanticQueryLength: buildCogneeQuery(input).length,
      renderedQueryLength: input.renderedContextQueryLength ?? input.renderedContextQuery?.length ?? buildCogneeQuery(input).length,
      retrievalEnvelopeHash: retrievalEnvelopeHash(envelope),
      semanticQueryHash: semanticQueryHash(buildCogneeQuery(input)),
      renderedQueryHash: input.renderedContextQueryHash ?? renderedQueryHash(input.renderedContextQuery ?? buildCogneeQuery(input)),
      message: 'Cognee candidates were selected with Allen retrieval envelope scoring before injection.',
    }],
  };
}

export function uniqueCogneeRefs(refs: KnowledgeCandidateRef[]): KnowledgeCandidateRef[] {
  const seenRefIds = new Set<string>();
  const seenContentHashes = new Set<string>();
  return refs.filter((ref) => {
    if (seenRefIds.has(ref.refId)) return false;
    if (ref.contentSha256 && seenContentHashes.has(ref.contentSha256)) return false;
    seenRefIds.add(ref.refId);
    if (ref.contentSha256) seenContentHashes.add(ref.contentSha256);
    return true;
  });
}

export function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function boundedScoreEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function scoreCogneeRef(
  ref: KnowledgeCandidateRef,
  input: KnowledgeRetrievalInput,
  envelope: RetrievalIntentEnvelope,
  originalRank: number,
  retrievalStage: 'primary' | 'graph_expansion',
): {
  ref: KnowledgeCandidateRef;
  cogneeRawScore?: number;
  score: number;
  originalRank: number;
  category: string;
  reasons: string[];
  rejectedByHardFilter: boolean;
  injectionDecision: CogneeInjectionDecision;
  retrievalStage: string;
  thresholdRejected?: boolean;
  rejectionReason?: string;
  minSelectionScore?: number;
  minInjectionScore?: number;
  injectionRejectedReason?: string;
} {
  const cogneeRawScore = normalizeCandidateScore(ref.score);
  const sourceMetadata = isRecord(ref.providerMetadata?.sourceMetadata) ? ref.providerMetadata.sourceMetadata : {};
  const metadataRepoId = firstString(sourceMetadata.repoId, sourceMetadata.repo_id);
  if (metadataRepoId && metadataRepoId !== input.repoId) {
    return {
      ref,
      cogneeRawScore,
      score: -Infinity,
      originalRank,
      category: 'foreign_repo',
      reasons: [`Rejected because source repoId ${metadataRepoId} does not match ${input.repoId}.`],
      rejectedByHardFilter: true,
      injectionDecision: 'manifest_only',
      retrievalStage,
    };
  }
  const category = documentRole(ref);
  const metadata = isRecord(ref.providerMetadata?.allenMetadata) ? ref.providerMetadata.allenMetadata : {};
  const metadataCategories = Array.isArray(metadata.categories) ? metadata.categories.map(String) : [];
  const curationCategory = firstString(ref.providerMetadata?.curationCategory);
  const effectiveCategories = uniqueStrings([category, ...(curationCategory ? [curationCategory] : []), ...metadataCategories, isAgentSystemDoc(ref) ? 'agent_system_doc' : '']);
  const curatedPolicy = curatedInjectionPolicy(ref);
  if (curatedPolicy === 'never_full_auto') {
    return {
      ref,
      cogneeRawScore,
      score: -Infinity,
      originalRank,
      category,
      reasons: ['curated_policy:never_full_auto'],
      rejectedByHardFilter: true,
      injectionDecision: 'never_full_auto',
      retrievalStage,
    };
  }
  const hardNoisyCategory = effectiveCategories.some((candidateCategory) => envelope.exclusionCategories.includes(candidateCategory) && candidateCategory !== 'generated_doc');
  if (hardNoisyCategory) {
    return {
      ref,
      cogneeRawScore,
      score: -Infinity,
      originalRank,
      category,
      reasons: [`Rejected noisy category: ${effectiveCategories.filter((item) => envelope.exclusionCategories.includes(item)).join(', ')}`],
      rejectedByHardFilter: true,
      injectionDecision: 'never_full_auto',
      retrievalStage,
    };
  }
  if (isAgentSystemDoc(ref) && isImplementationLikeRole(envelope.roleFamily) && !taskExplicitlyNeedsAgentSystemContext(envelope)) {
    return {
      ref,
      cogneeRawScore,
      score: -Infinity,
      originalRank,
      category: 'agent_system_doc',
      reasons: ['Rejected agent system doc for implementation task without explicit agent-system intent.'],
      rejectedByHardFilter: true,
      injectionDecision: 'never_full_auto',
      retrievalStage,
    };
  }
  const rankBonus = Math.max(0, 0.12 - originalRank * 0.01);
  let score = (cogneeRawScore ?? 0) + rankBonus;
  const reasons = [cogneeRawScore == null ? 'missing_cognee_score' : `cognee_raw=${round(cogneeRawScore)}`, `rank_bonus=${round(rankBonus)}`];
  const curationResolutionMethod = firstString(ref.providerMetadata?.curationResolutionMethod);
  if (curationResolutionMethod && curationResolutionMethod !== 'unresolved') {
    reasons.push(`${curationResolutionMethod}_resolved`);
  }
  if (curatedPolicy) {
    reasons.push(`curated_policy:${curatedPolicy}`);
    score += 0.08;
  }
  if (effectiveCategories.some((candidateCategory) => envelope.requiredCategories.includes(candidateCategory))) {
    score += 0.35;
    reasons.push(`required_category:${effectiveCategories.filter((item) => envelope.requiredCategories.includes(item)).join('|')}`);
  } else if (effectiveCategories.some((candidateCategory) => envelope.preferredCategories.includes(candidateCategory))) {
    score += 0.18;
    reasons.push(`preferred_category:${effectiveCategories.filter((item) => envelope.preferredCategories.includes(item)).join('|')}`);
  } else if (effectiveCategories.includes('generated_doc')) {
    score -= 0.2;
    reasons.push('downrank_generated_doc');
  }
  if (ref.path && envelope.currentFiles.includes(ref.path)) {
    score += 0.45;
    reasons.push('current_file_exact_match');
  } else if (ref.path && envelope.pathHints.some((hint) => ref.path?.startsWith(hint))) {
    score += 0.16;
    reasons.push('path_scope_match');
  }
  if (ref.grounding === 'repo_backed') {
    score += 0.12;
    reasons.push('repo_backed');
  } else if (ref.grounding === 'provider_generated') {
    score -= 0.35;
    reasons.push('provider_generated_downranked');
  }
  if (ref.providerMetadata?.graphExpansion) {
    score -= 0.08;
    reasons.push('graph_expansion_candidate');
  }
  const injectionDecision = decideInjection(ref, score);
  return {
    ref,
    cogneeRawScore,
    score: round(score),
    originalRank,
    category,
    reasons,
    rejectedByHardFilter: false,
    injectionDecision,
    retrievalStage,
  };
}

function withRetrievalPolicy(
  ref: KnowledgeCandidateRef,
  policy: {
    score: number;
    cogneeRawScore?: number;
    category: string;
    reasons: string[];
    originalRank: number;
    selected?: boolean;
    selectedRank?: number;
    injectable?: boolean;
    injectionDecision: CogneeInjectionDecision;
    retrievalStage: string;
    thresholdRejected?: boolean;
    rejectionReason?: string;
    minSelectionScore?: number;
    minInjectionScore?: number;
    injectionRejectedReason?: string;
  },
): KnowledgeCandidateRef {
  const injectionPolicy = legacyInjectionPolicy(policy.injectionDecision);
  return {
    ...ref,
    score: Number.isFinite(policy.score) ? policy.score : ref.score,
    reason: policy.reasons.length ? `${ref.reason} Retrieval policy: ${policy.reasons.join(', ')}.` : ref.reason,
    providerMetadata: {
      ...ref.providerMetadata,
      retrievalStage: policy.retrievalStage,
      retrievalCategory: policy.category,
      cogneeRawScore: policy.cogneeRawScore,
      retrievalScore: policy.score,
      retrievalPolicyScore: policy.score,
      retrievalReasons: policy.reasons,
      originalCogneeRank: policy.originalRank,
      selectedRank: policy.selectedRank,
      thresholdRejected: policy.thresholdRejected === true,
      rejectionReason: policy.rejectionReason,
      minSelectionScore: policy.minSelectionScore,
      minInjectionScore: policy.minInjectionScore,
      injectionRejectedReason: policy.injectionRejectedReason,
      injectionDecision: policy.injectionDecision,
      injectionPolicy,
      injectable: policy.injectable === true,
    },
  };
}

function normalizeCandidateScore(value: unknown): number | undefined {
  const score = Number(value);
  if (!Number.isFinite(score)) return undefined;
  if (score < 0) return 0;
  if (score > 1) return Math.min(1, score / 100);
  return score;
}

function documentRole(ref: KnowledgeCandidateRef): string {
  if (typeof ref.providerMetadata?.documentRole === 'string') return ref.providerMetadata.documentRole;
  const categories = ref.providerMetadata?.metadataCategories;
  if (Array.isArray(categories) && typeof categories[0] === 'string') return categories[0];
  return 'unknown';
}

function decideInjection(ref: KnowledgeCandidateRef, score: number): CogneeInjectionDecision {
  const metadata = isRecord(ref.providerMetadata?.allenMetadata) ? ref.providerMetadata.allenMetadata : {};
  const metadataWarnings = Array.isArray(ref.providerMetadata?.metadataWarnings) ? ref.providerMetadata.metadataWarnings.map(String) : [];
  const defaultDecision = injectionDecisionValue(metadata.injectionDecision);
  if (ref.mandatory || ref.targetLayer === 'system_prompt') return 'mandatory_full';
  const curatedPolicy = curatedInjectionPolicy(ref);
  if (curatedPolicy) return curatedPolicy;
  if (defaultDecision === 'never_full_auto') return 'never_full_auto';
  if (defaultDecision === 'mandatory_full' && score >= 0.9) return 'mandatory_full';
  if (metadataWarnings.includes('metadata_missing_path')) return 'manifest_only';
  if (ref.content && score >= 0.55) return 'snippet';
  if (defaultDecision === 'snippet' && ref.grounding === 'repo_backed' && score >= 0.7) return 'snippet';
  return 'manifest_only';
}

function curatedInjectionPolicy(ref: KnowledgeCandidateRef): CogneeInjectionDecision | undefined {
  const value = ref.providerMetadata?.curatedInjectionPolicy;
  if (value === 'snippet' || value === 'manifest_only' || value === 'never_full_auto') return value;
  return undefined;
}

function selectionThresholdFor(ref: KnowledgeCandidateRef, thresholds: { minSelectionScore: number; minCuratedSelectionScore: number }): number {
  return curatedInjectionPolicy(ref) ? thresholds.minCuratedSelectionScore : thresholds.minSelectionScore;
}

function injectionThresholdFor(ref: KnowledgeCandidateRef, thresholds: { minInjectionScore: number; minCuratedInjectionScore: number }): number {
  return curatedInjectionPolicy(ref) ? thresholds.minCuratedInjectionScore : thresholds.minInjectionScore;
}

function legacyInjectionPolicy(decision: CogneeInjectionDecision): 'injectable' | 'manifest_only' | 'never_full_auto' {
  if (decision === 'mandatory_full' || decision === 'snippet') return 'injectable';
  if (decision === 'never_full_auto') return 'never_full_auto';
  return 'manifest_only';
}

function isInjectableDecision(value: unknown): boolean {
  return value === 'mandatory_full' || value === 'snippet' || value === 'injectable';
}

function countInjectionDecisions(refs: KnowledgeCandidateRef[]): Record<string, number> {
  return refs.reduce<Record<string, number>>((acc, ref) => {
    const decision = String(ref.providerMetadata?.injectionDecision ?? ref.providerMetadata?.injectionPolicy ?? 'manifest_only');
    acc[decision] = (acc[decision] ?? 0) + 1;
    return acc;
  }, {});
}

function injectionDecisionValue(value: unknown): CogneeInjectionDecision {
  if (value === 'mandatory_full' || value === 'snippet' || value === 'manifest_only' || value === 'never_full_auto') return value;
  if (value === 'injectable') return 'snippet';
  return 'manifest_only';
}

function isImplementationLikeRole(roleFamily: string): boolean {
  return ['backend', 'frontend', 'implementation', 'qa', 'review'].includes(roleFamily);
}

function isAgentSystemDoc(ref: KnowledgeCandidateRef): boolean {
  const haystack = `${ref.path ?? ''} ${ref.title ?? ''}`.toLowerCase();
  return [
    'agent_architecture',
    'agent architecture',
    'prd_agent_management_ui',
    'agent organization management',
    'architecture-self-healing-agent',
    'data-flow-self-healing-agent',
    'self-healing codebase agent',
    'agent-org-roster',
    'agent organization specification',
    'agent-migration-plan',
    'sub-agent-execution-tracking',
    'e2e-testing-agent-readiness',
  ].some((needle) => haystack.includes(needle));
}

function taskExplicitlyNeedsAgentSystemContext(envelope: RetrievalIntentEnvelope): boolean {
  const haystack = `${envelope.rawRole} ${envelope.task}`.toLowerCase();
  return [
    'allen agent architecture',
    'agent architecture',
    'agent management',
    'agent organization',
    'self-healing agent',
    'sub-agent execution',
    'spawned agent',
    'spawn agent',
    '.claude/agents',
    'repo knowledge graph',
    'context engine',
  ].some((needle) => haystack.includes(needle));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
