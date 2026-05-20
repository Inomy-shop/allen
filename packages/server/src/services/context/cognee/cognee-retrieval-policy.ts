import { createHash } from 'node:crypto';
import type { KnowledgeCandidateRef, KnowledgeRetrievalInput } from '../core/repo-context-engine.js';
import { isRecord } from '../allen-knowledge-graph/repo-knowledge-graph-utils.js';
import type { CogneeInjectionDecision } from './cognee-metadata-enrichment.js';

export const DEFAULT_COGNEE_CANDIDATE_LIMIT = 30;
const TASK_SIGNAL_MAX_CHARS = 3600;
const RAW_PROMPT_FALLBACK_MAX_CHARS = 2400;
const PROMPT_SECTION_MAX_CHARS = 850;
const RENDERED_COGNEE_QUERY_MAX_CHARS = 5000;

export type RetrievalIntentEnvelope = {
  schemaVersion: number;
  role: string;
  roleFamily: string;
  roleFocus: string[];
  rawRole: string;
  task: string;
  querySignalSources: string[];
  querySignalSections: string[];
  querySignalLength: number;
  expectedOutput?: string;
  currentFiles: string[];
  changedFiles: string[];
  requiredCategories: string[];
  preferredCategories: string[];
  exclusionCategories: string[];
  pathHints: string[];
  moduleHints: string[];
  externalContextEligible: boolean;
};

export function buildCogneeQuery(input: KnowledgeRetrievalInput): string {
  const envelope = buildRetrievalIntentEnvelope(input);
  return capRenderedQuery([
    `Workflow: ${input.workflowName}`,
    `Node: ${input.nodeName}`,
    `Role: ${envelope.role}`,
    `Role family: ${envelope.roleFamily}`,
    envelope.rawRole !== envelope.role ? `Raw role: ${envelope.rawRole}` : '',
    envelope.roleFocus.length ? `Role search intent: ${envelope.roleFocus.join('; ')}` : '',
    envelope.requiredCategories.length ? `Required context categories: ${envelope.requiredCategories.join(', ')}` : '',
    envelope.preferredCategories.length ? `Preferred context categories: ${envelope.preferredCategories.join(', ')}` : '',
    envelope.exclusionCategories.length ? `Excluded context categories: ${envelope.exclusionCategories.join(', ')}` : '',
    envelope.currentFiles.length ? `Current files: ${envelope.currentFiles.join(', ')}` : '',
    envelope.changedFiles.length ? `Changed files: ${envelope.changedFiles.join(', ')}` : '',
    envelope.pathHints.length ? `Path hints: ${envelope.pathHints.join(', ')}` : '',
    envelope.moduleHints.length ? `Module hints: ${envelope.moduleHints.join(', ')}` : '',
    envelope.task ? `Task signal: ${envelope.task}` : '',
  ].filter(Boolean).join('\n'), RENDERED_COGNEE_QUERY_MAX_CHARS);
}

export function retrievalEnvelopeHash(envelope: RetrievalIntentEnvelope): string {
  return sha256(stableStringify(envelope));
}

export function renderedQueryHash(query: string): string {
  return sha256(query);
}

export function buildGraphExpansionQuery(input: KnowledgeRetrievalInput, seeds: KnowledgeCandidateRef[]): string {
  return [
    buildCogneeQuery(input),
    'Find directly related repo documents for the selected seed references. Return source-backed documents or chunks only.',
    `Seed refs: ${seeds.map((seed) => [seed.path, seed.title].filter(Boolean).join(' - ')).join('; ')}`,
  ].join('\n');
}

export function buildRetrievalIntentEnvelope(input: KnowledgeRetrievalInput): RetrievalIntentEnvelope {
  const rawRole = input.nodeRole ?? input.nodeName;
  const role = normalizeRoleName(rawRole) || normalizeRoleName(input.nodeName) || 'unknown';
  const taskSignal = buildTaskSignal(input);
  const task = taskSignal.text;
  const currentFiles = input.currentFiles.filter((path) => !isGeneratedWorkflowArtifactPath(path));
  const taskHaystack = `${input.workflowName} ${input.nodeName} ${rawRole} ${task}`.toLowerCase();
  const roleFamily = roleFamilyFor(role, taskHaystack);
  const requiredCategories: string[] = [];
  const preferredCategories: string[] = [];
  const exclusionCategories: string[] = ['generated_doc'];

  if (['backend', 'frontend', 'implementation'].includes(roleFamily)) {
    requiredCategories.push('source', 'guideline');
    preferredCategories.push('design', 'runbook');
  } else if (roleFamily === 'investigation') {
    requiredCategories.push('source', 'runbook');
    preferredCategories.push('guideline', 'design');
  } else if (roleFamily === 'qa' || roleFamily === 'review') {
    requiredCategories.push('source', 'guideline');
    preferredCategories.push('runbook', 'design');
  } else if (roleFamily === 'planning') {
    requiredCategories.push('guideline');
    preferredCategories.push('design', 'source', 'runbook');
  }

  if (/\b(bug|fix|debug|investigat|implement|code|coding|developer|backend|frontend|refactor|test|tests)\b/.test(taskHaystack)) {
    requiredCategories.push('source', 'guideline');
    preferredCategories.push('design', 'runbook');
  }
  if (/\b(prd|product|requirement|requirements|acceptance criteria|user story|spec)\b/.test(taskHaystack)) {
    requiredCategories.push('prd');
    preferredCategories.push('design', 'guideline');
  }
  if (/\b(runbook|incident|production|ops|deploy|operat)\b/.test(taskHaystack)) {
    requiredCategories.push('guideline', 'runbook');
    preferredCategories.push('production_note');
  }
  if (roleFamily !== 'agent_persona_author') exclusionCategories.push('agent_persona');
  if (!requiredCategories.length) preferredCategories.push('guideline', 'design', 'source');
  return {
    schemaVersion: 1,
    role,
    roleFamily,
    roleFocus: roleFocusFor(roleFamily),
    rawRole,
    task,
    querySignalSources: taskSignal.sources,
    querySignalSections: taskSignal.sections,
    querySignalLength: task.length,
    expectedOutput: firstString(input.state.expectedOutput, input.state.expected_output),
    currentFiles,
    changedFiles: stringArray(input.state.changedFiles, input.state.changed_files, input.state.files_changed),
    requiredCategories: uniqueStrings(requiredCategories),
    preferredCategories: uniqueStrings(preferredCategories),
    exclusionCategories: uniqueStrings(exclusionCategories),
    pathHints: pathHintsFor(currentFiles),
    moduleHints: moduleHintsFor(currentFiles),
    externalContextEligible: false,
  };
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
  const scoredEntries = candidates.map((ref, originalRank) => scoreCogneeRef(ref, input, envelope, originalRank, retrievalStage));
  const scored = scoredEntries
    .filter((entry) => !entry.rejectedByHardFilter)
    .sort((a, b) => b.score - a.score || a.originalRank - b.originalRank);
  const hardRejected = scoredEntries
    .filter((entry) => entry.rejectedByHardFilter)
    .map((entry) => withRetrievalPolicy(entry.ref, {
      ...entry,
      selected: false,
      injectable: false,
      injectionDecision: entry.injectionDecision,
    }));
  const selectedRefs = scored.map((entry, selectedRank) => {
    const injectable = entry.injectionDecision === 'mandatory_full' || entry.injectionDecision === 'snippet';
    return withRetrievalPolicy(entry.ref, {
      ...entry,
      selected: true,
      selectedRank,
      injectable,
      injectionDecision: entry.injectionDecision,
    });
  });
  const rejectedRefs = hardRejected;
  return {
    candidates: scored.map((entry) => withRetrievalPolicy(entry.ref, {
      ...entry,
      selected: false,
      injectable: false,
      injectionDecision: 'manifest_only',
    })),
    selectedRefs,
    rejectedRefs,
    diagnostics: [{
      code: 'cognee_retrieval_policy_applied',
      severity: 'info',
      retrievalStage,
      candidateCount: candidates.length,
      selectedCount: selectedRefs.length,
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
      renderedQueryLength: buildCogneeQuery(input).length,
      retrievalEnvelopeHash: retrievalEnvelopeHash(envelope),
      renderedQueryHash: renderedQueryHash(buildCogneeQuery(input)),
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

function scoreCogneeRef(
  ref: KnowledgeCandidateRef,
  input: KnowledgeRetrievalInput,
  envelope: RetrievalIntentEnvelope,
  originalRank: number,
  retrievalStage: 'primary' | 'graph_expansion',
): {
  ref: KnowledgeCandidateRef;
  score: number;
  originalRank: number;
  category: string;
  reasons: string[];
  rejectedByHardFilter: boolean;
  injectionDecision: CogneeInjectionDecision;
  retrievalStage: string;
} {
  const sourceMetadata = isRecord(ref.providerMetadata?.sourceMetadata) ? ref.providerMetadata.sourceMetadata : {};
  const metadataRepoId = firstString(sourceMetadata.repoId, sourceMetadata.repo_id);
  if (metadataRepoId && metadataRepoId !== input.repoId) {
    return {
      ref,
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
  const effectiveCategories = uniqueStrings([category, ...metadataCategories, isAgentSystemDoc(ref) ? 'agent_system_doc' : '']);
  const hardNoisyCategory = effectiveCategories.some((candidateCategory) => envelope.exclusionCategories.includes(candidateCategory) && candidateCategory !== 'generated_doc');
  if (hardNoisyCategory) {
    return {
      ref,
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
      score: -Infinity,
      originalRank,
      category: 'agent_system_doc',
      reasons: ['Rejected agent system doc for implementation task without explicit agent-system intent.'],
      rejectedByHardFilter: true,
      injectionDecision: 'never_full_auto',
      retrievalStage,
    };
  }
  let score = normalizeCandidateScore(ref.score) + Math.max(0, 1 - originalRank * 0.02);
  const reasons = [`base=${round(score)}`];
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
    category: string;
    reasons: string[];
    originalRank: number;
    selected?: boolean;
    selectedRank?: number;
    injectable?: boolean;
    injectionDecision: CogneeInjectionDecision;
    retrievalStage: string;
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
      retrievalScore: policy.score,
      retrievalReasons: policy.reasons,
      originalCogneeRank: policy.originalRank,
      selectedRank: policy.selectedRank,
      injectionDecision: policy.injectionDecision,
      injectionPolicy,
      injectable: policy.injectable === true,
    },
  };
}

function normalizeCandidateScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0.25;
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

function pathHintsFor(paths: string[]): string[] {
  return uniqueStrings(paths.flatMap((path) => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1) return [];
    return [parts.slice(0, -1).join('/'), parts.slice(0, Math.min(2, parts.length - 1)).join('/')].filter(Boolean);
  }));
}

function moduleHintsFor(paths: string[]): string[] {
  return uniqueStrings(paths.map((path) => path.replace(/\\/g, '/').split('/').filter(Boolean)[0]).filter(Boolean));
}

function normalizeRoleName(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function roleFamilyFor(role: string, task: string): string {
  const haystack = `${role} ${task}`;
  if (/\b(agent-persona|persona-author|agent-author)\b/.test(role)) return 'agent_persona_author';
  if (/\b(investigat|debug|bug|incident)\b/.test(role)) return 'investigation';
  if (/\b(review|reviewer)\b/.test(role)) return 'review';
  if (/\b(qa|test|tester|quality|validator)\b/.test(role)) return 'qa';
  if (/\b(backend|api|database|db|server)\b/.test(role)) return 'backend';
  if (/\b(frontend|ui|ux|browser|react)\b/.test(role)) return 'frontend';
  if (/\b(plan|architect|design|lead)\b/.test(role)) return 'planning';
  if (/\b(implement|developer|engineer|coder|fullstack)\b/.test(role)) return 'implementation';
  if (/\b(agent-persona|persona-author|agent-author)\b/.test(haystack)) return 'agent_persona_author';
  if (/\b(investigat|debug|bug|incident)\b/.test(haystack)) return 'investigation';
  if (/\b(backend|api|database|db|server)\b/.test(haystack)) return 'backend';
  if (/\b(frontend|ui|ux|browser|react)\b/.test(haystack)) return 'frontend';
  if (/\b(prd|product|requirement|requirements|pm)\b/.test(haystack)) return 'product';
  return 'general';
}

function roleFocusFor(roleFamily: string): string[] {
  if (roleFamily === 'backend') return ['backend implementation', 'source files', 'API/data contracts', 'repo coding guidelines'];
  if (roleFamily === 'frontend') return ['frontend implementation', 'UI source files', 'design guidance', 'repo coding guidelines'];
  if (roleFamily === 'investigation') return ['bug evidence', 'related source files', 'runbooks', 'production notes'];
  if (roleFamily === 'review') return ['changed source files', 'repo guidelines', 'design constraints', 'test expectations'];
  if (roleFamily === 'qa') return ['test expectations', 'validation commands', 'source files under test', 'repo guidelines'];
  if (roleFamily === 'planning') return ['architecture guidance', 'repo guidelines', 'design docs', 'implementation constraints'];
  if (roleFamily === 'product') return ['requirements', 'product specs', 'acceptance criteria', 'design docs'];
  if (roleFamily === 'agent_persona_author') return ['agent persona docs', 'role instructions', 'workflow guidance'];
  return ['repo guidelines', 'source files', 'design context'];
}

function decideInjection(ref: KnowledgeCandidateRef, score: number): CogneeInjectionDecision {
  const metadata = isRecord(ref.providerMetadata?.allenMetadata) ? ref.providerMetadata.allenMetadata : {};
  const metadataWarnings = Array.isArray(ref.providerMetadata?.metadataWarnings) ? ref.providerMetadata.metadataWarnings.map(String) : [];
  const defaultDecision = injectionDecisionValue(metadata.injectionDecision);
  if (defaultDecision === 'never_full_auto') return 'never_full_auto';
  if (ref.mandatory || ref.targetLayer === 'system_prompt') return 'mandatory_full';
  if (defaultDecision === 'mandatory_full' && score >= 0.9) return 'mandatory_full';
  if (metadataWarnings.includes('metadata_missing_path')) return 'manifest_only';
  if (ref.content && score >= 0.55) return 'snippet';
  if (defaultDecision === 'snippet' && ref.grounding === 'repo_backed' && score >= 0.7) return 'snippet';
  return 'manifest_only';
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

function stringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
  }
  return [];
}

function buildTaskSignal(input: KnowledgeRetrievalInput): { text: string; sources: string[]; sections: string[] } {
  const structured = structuredTaskSignals(input);
  const sectionSignals = promptSectionSignals(input.prompt);
  const pathSignal = buildPathSignals(input);
  const entries = [...structured.entries, ...pathSignal.entries, ...sectionSignals.entries];
  const sources = uniqueStrings([...structured.sources, ...pathSignal.sources, ...sectionSignals.sources]);
  const sections = uniqueStrings(sectionSignals.sections);
  if (entries.length > 0) {
    return {
      text: compactTaskText(entries.join(' | '), TASK_SIGNAL_MAX_CHARS),
      sources,
      sections,
    };
  }
  return {
    text: compactTaskText(firstString(input.prompt) ?? `${input.workflowName} ${input.nodeName} ${input.nodeRole ?? ''}`, RAW_PROMPT_FALLBACK_MAX_CHARS),
    sources: ['raw_prompt_fallback'],
    sections: [],
  };
}

function structuredTaskSignals(input: KnowledgeRetrievalInput): { entries: string[]; sources: string[] } {
  const entries: string[] = [];
  const sources: string[] = [];
  const changedFiles = stringArray(input.state.changedFiles, input.state.changed_files, input.state.files_changed);
  if (changedFiles.length > 0) {
    entries.push(`Changed files: ${changedFiles.join(', ')}`);
    sources.push('state.changed_files');
  }
  for (const key of [
    'severity',
    'confidence',
    'self_judge_verdict',
    'any_failures',
    'qa_verdict',
    'qa_failure_details',
    'bug_summary',
    'bugSummary',
    'root_cause',
    'rootCause',
    'fix_description',
    'fixDescription',
    'reproduction_steps',
    'reproductionSteps',
    'files_to_touch',
    'filesToTouch',
    'affected_components',
    'affectedComponents',
    'expected_behavior',
    'expectedBehavior',
  ]) {
    const value = signalValue(input.state[key]);
    if (value) {
      entries.push(`${humanizeKey(key)}: ${value}`);
      sources.push(`state.${key}`);
    }
  }
  const usage = isRecord(input.state.repo_context_usage) ? input.state.repo_context_usage : undefined;
  const moduleIdentified = usage ? firstString(usage.module_identified, usage.moduleIdentified) : undefined;
  if (moduleIdentified) {
    entries.push(`Module identified: ${moduleIdentified}`);
    sources.push('state.repo_context_usage.module_identified');
  }
  for (const [key, value] of Object.entries(input.state)) {
    if (!/_artifact_url$/.test(key)) continue;
    const label = key.replace(/_artifact_url$/, '').replace(/_/g, ' ');
    entries.push(`Prior ${label} artifact is available for this workflow.`);
    sources.push(`state.${key}`);
  }
  return { entries, sources };
}

function buildPathSignals(input: KnowledgeRetrievalInput): { entries: string[]; sources: string[] } {
  const entries: string[] = [];
  const sources: string[] = [];
  const currentFiles = input.currentFiles.filter((path) => !isGeneratedWorkflowArtifactPath(path));
  if (currentFiles.length > 0) {
    entries.push(`Current files: ${currentFiles.join(', ')}`);
    entries.push(`Path terms: ${pathTermsFor(currentFiles).join(', ')}`);
    sources.push('input.currentFiles');
  }
  const promptPaths = repoPathsFromText(input.prompt).filter((path) => !isGeneratedWorkflowArtifactPath(path));
  if (promptPaths.length > 0) {
    entries.push(`Prompt file references: ${promptPaths.join(', ')}`);
    entries.push(`Prompt path terms: ${pathTermsFor(promptPaths).join(', ')}`);
    sources.push('prompt.repo_paths');
  }
  return { entries, sources };
}

function promptSectionSignals(prompt: unknown): { entries: string[]; sources: string[]; sections: string[] } {
  const text = firstString(prompt);
  if (!text) return { entries: [], sources: [], sections: [] };
  const matches: Array<{ label: string; index: number; end: number }> = [];
  const labelPattern = /^\s*(BUG REPORT|BUG SUMMARY|Bug summary|ROOT CAUSE|Expected behavior|Known repro(?:\/evidence clues from ticket\/context)?|Required investigation path|FILES CHANGED|FILES TO TOUCH|ROUTING PRIMITIVES|IMPLEMENTATION PLAN|ACCEPTANCE CRITERIA|CODING STANDARDS|QA REPORT|INVESTIGATION REPORT)\s*:/gim;
  const headingPattern = /^\s*#{1,2}\s+(BUG REPORT|BUG SUMMARY|ROOT CAUSE|EXPECTED BEHAVIOR|KNOWN REPRO(?:\/EVIDENCE CLUES FROM TICKET\/CONTEXT)?|REQUIRED INVESTIGATION PATH|FILES CHANGED|FILES TO TOUCH|ROUTING PRIMITIVES|IMPLEMENTATION PLAN|ACCEPTANCE CRITERIA|CODING STANDARDS|QA REPORT|INVESTIGATION REPORT)\b[^\n]*$/gim;
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(text))) {
    matches.push({ label: normalizeSectionLabel(match[1]), index: match.index, end: labelPattern.lastIndex });
  }
  while ((match = headingPattern.exec(text))) {
    matches.push({ label: normalizeSectionLabel(match[1]), index: match.index, end: headingPattern.lastIndex });
  }
  matches.sort((a, b) => a.index - b.index || a.end - b.end);
  const entries: string[] = [];
  const sections: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const sectionText = compactTaskText(cleanPromptSection(current.label, text.slice(current.end, next?.index ?? text.length)), PROMPT_SECTION_MAX_CHARS);
    if (!sectionText || isLowSignalSection(current.label, sectionText)) continue;
    entries.push(`${current.label}: ${sectionText}`);
    sections.push(current.label);
  }
  return {
    entries,
    sources: entries.length ? ['prompt.sections'] : [],
    sections,
  };
}

function signalValue(value: unknown): string | undefined {
  if (typeof value === 'string') return compactTaskText(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return compactTaskText(value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(', '), 700);
  if (isRecord(value)) return compactTaskText(JSON.stringify(value), 700);
  return undefined;
}

function cleanPromptSection(label: string, value: string): string {
  let text = value;
  if (label === 'BUG REPORT') {
    text = text.split(/\n\s*User instructions and constraints\s*:/i)[0] ?? text;
  }
  return text;
}

function repoPathsFromText(value: unknown): string[] {
  const text = firstString(value);
  if (!text) return [];
  const matches = text.match(/\b(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+\b/g) ?? [];
  return uniqueStrings(matches.map((path) => path.replace(/[),.;:]+$/g, '')));
}

function pathTermsFor(paths: string[]): string[] {
  return uniqueStrings(paths.flatMap((path) => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const file = parts.at(-1) ?? '';
    const basename = file.replace(/\.[^.]+$/, '');
    return [
      normalized,
      ...parts.filter((part) => part.includes('-')),
      basename,
      ...basename.split(/[-_.]/).filter((part) => part.length > 2),
    ];
  })).slice(0, 30);
}

function isGeneratedWorkflowArtifactPath(path: string): boolean {
  return /^(investigation|implementation|qa|reports|plans|summary)\//.test(path.replace(/\\/g, '/'));
}

function isLowSignalSection(label: string, text: string): boolean {
  if (label === 'ROUTING PRIMITIVES') return false;
  if (label.endsWith('REPORT') && /^https?:\/\//.test(text)) return true;
  return false;
}

function normalizeSectionLabel(label: string): string {
  const normalized = label.replace(/\s+/g, ' ').trim();
  const upper = normalized.toUpperCase();
  if (upper === 'BUG SUMMARY') return 'BUG SUMMARY';
  if (upper === 'BUG REPORT') return 'BUG REPORT';
  if (upper === 'ROOT CAUSE') return 'ROOT CAUSE';
  if (upper === 'EXPECTED BEHAVIOR') return 'Expected behavior';
  if (upper === 'KNOWN REPRO/EVIDENCE CLUES FROM TICKET/CONTEXT') return 'Known repro/evidence clues from ticket/context';
  if (upper === 'REQUIRED INVESTIGATION PATH') return 'Required investigation path';
  if (upper === 'FILES CHANGED') return 'FILES CHANGED';
  if (upper === 'FILES TO TOUCH') return 'FILES TO TOUCH';
  if (upper === 'ROUTING PRIMITIVES') return 'ROUTING PRIMITIVES';
  if (upper === 'IMPLEMENTATION PLAN') return 'IMPLEMENTATION PLAN';
  if (upper === 'ACCEPTANCE CRITERIA') return 'ACCEPTANCE CRITERIA';
  if (upper === 'CODING STANDARDS') return 'CODING STANDARDS';
  if (upper === 'QA REPORT') return 'QA REPORT';
  if (upper === 'INVESTIGATION REPORT') return 'INVESTIGATION REPORT';
  return normalized;
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

function compactTaskText(value: string, maxLength = 1200): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function capRenderedQuery(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
