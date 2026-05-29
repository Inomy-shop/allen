import { createHash } from 'node:crypto';
import type { KnowledgeRetrievalInput } from './repo-context-engine.js';
import { firstString, isRecord } from '../common/context-utils.js';

const TASK_SIGNAL_MAX_CHARS = 3600;
const RAW_PROMPT_FALLBACK_MAX_CHARS = 2400;
const PROMPT_SECTION_MAX_CHARS = 850;
const RENDERED_CONTEXT_QUERY_MAX_CHARS = 5000;
const SEMANTIC_CONTEXT_QUERY_MAX_CHARS = 3000;

export type ContextQueryIntent = {
  schemaVersion: number;
  workflowName: string;
  nodeName: string;
  role: string;
  roleFamily: string;
  roleFocus: string[];
  rawRole: string;
  task: string;
  userPromptSignal?: string;
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
  pathScopes: string[];
  moduleHints: string[];
  domainHints?: string[];
  groundingPreferences?: string[];
  categoryDiagnostics?: Array<Record<string, unknown>>;
  ignoredExecutionConstraints?: string[];
  agentRoleSignals?: AgentRoleSignal[];
  externalContextEligible: boolean;
};

export type AgentRoleSignal = {
  roleSlot: 'nodeRole' | 'targetRole' | 'callerRole';
  roleName: string;
  agentName?: string;
  provider?: string;
  teamName?: string;
  teamRole?: string;
  description?: string;
  tags?: string[];
  instructionSummary?: string;
  signalText: string;
};

type AllenContextQueryBlock = {
  user_request?: string;
  task_type?: string;
  requirements: string[];
  target_files: string[];
  path_hints: string[];
  topics: string[];
  required_categories: string[];
  preferred_categories: string[];
};

type ContextTaskSignal = {
  text: string;
  sources: string[];
  sections: string[];
  ignoredExecutionConstraints?: string[];
};

export function buildContextQueryIntent(input: KnowledgeRetrievalInput): ContextQueryIntent {
  const rawRole = input.nodeRole ?? input.nodeName;
  const role = normalizeRoleName(rawRole) || normalizeRoleName(input.nodeName) || 'unknown';
  const structuredQuery = normalizeContextQueryBlock(input.contextQuery);
  const taskSignal = structuredQuery ? structuredContextQuerySignal(structuredQuery) : buildTaskSignal(input);
  const task = taskSignal.text;
  const structuredTargetFiles = stringArray(structuredQuery?.target_files);
  const structuredCurrentFiles = structuredTargetFiles
    .filter((path) => isConcreteRepoFilePath(path))
    .filter((path) => !isGeneratedWorkflowArtifactPath(path));
  const pathScopes = uniqueStrings([
    ...structuredTargetFiles.filter((path) => !isConcreteRepoFilePath(path)),
    ...stringArray(structuredQuery?.path_hints),
  ].map(normalizePathScope).filter(Boolean));
  const currentFiles = uniqueStrings([
    ...input.currentFiles,
    ...structuredCurrentFiles,
  ]).filter((path) => !isGeneratedWorkflowArtifactPath(path));
  const agentRoleSignals = normalizeAgentRoleSignals(input.agentRoleSignals);
  const agentRoleText = agentRoleSignals.map((signal) => signal.signalText).join(' ');
  const userPromptSignal = firstString(structuredQuery?.user_request)
    ?? promptTaskSignal(input.prompt).entries[0]?.replace(/^User request:\s*/, '');
  const taskHaystack = `${input.workflowName} ${input.nodeName} ${rawRole} ${userPromptSignal ?? ''} ${task} ${agentRoleText}`.toLowerCase();
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

  if (/\b(bug|fix|debug|investigat|implement|update|modify|change|add|build|code|coding|developer|backend|frontend|refactor|test|tests)\b/.test(taskHaystack)) {
    requiredCategories.push('source', 'guideline');
    preferredCategories.push('design', 'runbook');
  }
  if (/\b(prd|requirements?|acceptance criteria|user story|spec|specification|product spec|product requirements?|product planning|product manager|pm)\b/.test(taskHaystack)) {
    requiredCategories.push('prd');
    preferredCategories.push('design', 'guideline');
  }
  if (/\b(runbook|incident|production|ops|deploy|operat)\b/.test(taskHaystack)) {
    requiredCategories.push('guideline', 'runbook');
    preferredCategories.push('production_note');
  }
  if (roleFamily !== 'agent_persona_author') exclusionCategories.push('agent_persona');
  if (!requiredCategories.length) preferredCategories.push('guideline', 'design', 'source');
  const normalizedRequired = normalizeContextCategories(stringArray(structuredQuery?.required_categories));
  const normalizedPreferred = normalizeContextCategories(stringArray(structuredQuery?.preferred_categories));
  requiredCategories.push(...normalizedRequired.categories);
  preferredCategories.push(...normalizedPreferred.categories);
  const categoryDiagnostics = [...normalizedRequired.diagnostics, ...normalizedPreferred.diagnostics];
  const groundingPreferences = uniqueStrings([...normalizedRequired.groundingPreferences, ...normalizedPreferred.groundingPreferences]);
  const domainHints = uniqueStrings([...normalizedRequired.domainHints, ...normalizedPreferred.domainHints]);

  return {
    schemaVersion: 1,
    workflowName: input.workflowName,
    nodeName: input.nodeName,
    role,
    roleFamily,
    roleFocus: roleFocusFor(roleFamily),
    rawRole,
    task,
    userPromptSignal,
    querySignalSources: taskSignal.sources,
    querySignalSections: taskSignal.sections,
    querySignalLength: task.length,
    expectedOutput: firstString(input.state.expectedOutput, input.state.expected_output),
    currentFiles,
    changedFiles: stringArray(input.state.changedFiles, input.state.changed_files, input.state.files_changed),
    requiredCategories: uniqueStrings(requiredCategories),
    preferredCategories: uniqueStrings(preferredCategories),
    exclusionCategories: uniqueStrings(exclusionCategories),
    pathHints: uniqueStrings([...pathHintsFor(currentFiles), ...pathScopes]),
    pathScopes,
    moduleHints: moduleHintsFor(currentFiles),
    domainHints: domainHints.length ? domainHints : undefined,
    groundingPreferences: groundingPreferences.length ? groundingPreferences : undefined,
    categoryDiagnostics: categoryDiagnostics.length ? categoryDiagnostics : undefined,
    ignoredExecutionConstraints: taskSignal.ignoredExecutionConstraints?.length ? taskSignal.ignoredExecutionConstraints : undefined,
    agentRoleSignals: agentRoleSignals.length ? agentRoleSignals : undefined,
    externalContextEligible: false,
  };
}

function normalizeContextQueryBlock(value: unknown): AllenContextQueryBlock | null {
  if (!isRecord(value)) return null;
  const block: AllenContextQueryBlock = {
    user_request: firstString(value.user_request, value.userRequest),
    task_type: firstString(value.task_type, value.taskType),
    requirements: fieldStringArray(value, 'requirements'),
    target_files: fieldStringArray(value, 'target_files', 'targetFiles'),
    path_hints: fieldStringArray(value, 'path_hints', 'pathHints', 'path_scopes', 'pathScopes'),
    topics: fieldStringArray(value, 'topics'),
    required_categories: fieldStringArray(value, 'required_categories', 'requiredCategories'),
    preferred_categories: fieldStringArray(value, 'preferred_categories', 'preferredCategories'),
  };
  const hasRetrievalSignal = Boolean(
    block.user_request
    || block.task_type
    || block.requirements.length
    || block.target_files.length
    || block.path_hints.length
    || block.topics.length
  );
  return hasRetrievalSignal ? block : null;
}

function structuredContextQuerySignal(block: AllenContextQueryBlock): ContextTaskSignal {
  const entries: string[] = [];
  const taskType = firstString(block.task_type);
  if (taskType) entries.push(`Task type: ${taskType}`);
  const { retrievalRequirements, ignoredExecutionConstraints } = splitRetrievalRequirements(block.requirements);
  const requirements = retrievalRequirements;
  if (requirements.length) entries.push(`Requirements: ${requirements.join(' | ')}`);
  const topics = block.topics;
  if (topics.length) entries.push(`Topics: ${topics.join(', ')}`);
  return {
    text: compactTaskText(entries.join(' | '), TASK_SIGNAL_MAX_CHARS),
    sources: ['context_query'],
    sections: ['context_query'],
    ignoredExecutionConstraints,
  };
}

export function renderContextQuery(intent: ContextQueryIntent): string {
  const retrievalSignals = renderableRetrievalSignals(intent);
  return capRenderedQuery([
    `Workflow: ${intent.workflowName}`,
    `Node: ${intent.nodeName}`,
    `Role: ${intent.role}`,
    `Role family: ${intent.roleFamily}`,
    intent.rawRole !== intent.role ? `Raw role: ${intent.rawRole}` : '',
    intent.roleFocus.length ? `Role search intent: ${intent.roleFocus.join('; ')}` : '',
    intent.userPromptSignal ? `User request: ${intent.userPromptSignal}` : '',
    intent.requiredCategories.length ? `Required context categories: ${intent.requiredCategories.join(', ')}` : '',
    intent.preferredCategories.length ? `Preferred context categories: ${intent.preferredCategories.join(', ')}` : '',
    intent.exclusionCategories.length ? `Excluded context categories: ${intent.exclusionCategories.join(', ')}` : '',
    intent.currentFiles.length ? `Current files: ${intent.currentFiles.join(', ')}` : '',
    intent.changedFiles.length ? `Changed files: ${intent.changedFiles.join(', ')}` : '',
    intent.pathHints.length ? `Path hints: ${intent.pathHints.join(', ')}` : '',
    intent.pathScopes.length ? `Path scopes: ${intent.pathScopes.join(', ')}` : '',
    intent.moduleHints.length ? `Module hints: ${intent.moduleHints.join(', ')}` : '',
    intent.domainHints?.length ? `Domain hints: ${intent.domainHints.join(', ')}` : '',
    retrievalSignals ? `Retrieval signals: ${retrievalSignals}` : '',
  ].filter(Boolean).join('\n'), RENDERED_CONTEXT_QUERY_MAX_CHARS);
}

export function renderSemanticContextQuery(intent: ContextQueryIntent): string {
  const semanticTask = semanticTaskText(renderableRetrievalSignals(intent));
  return capRenderedQuery([
    `Role: ${intent.role}`,
    `Role family: ${intent.roleFamily}`,
    intent.roleFocus.length ? `Role search intent: ${intent.roleFocus.join('; ')}` : '',
    intent.userPromptSignal ? `User request: ${intent.userPromptSignal}` : '',
    intent.requiredCategories.length ? `Required context categories: ${intent.requiredCategories.join(', ')}` : '',
    intent.preferredCategories.length ? `Preferred context categories: ${intent.preferredCategories.join(', ')}` : '',
    intent.domainHints?.length ? `Domain hints: ${intent.domainHints.join(', ')}` : '',
    semanticTask ? `Retrieval signals: ${semanticTask}` : '',
  ].filter(Boolean).join('\n'), SEMANTIC_CONTEXT_QUERY_MAX_CHARS);
}

export function contextQueryIntentHash(intent: ContextQueryIntent): string {
  return sha256(stableStringify(intent));
}

export function renderedContextQueryHash(query: string): string {
  return sha256(query);
}

export function semanticContextQueryHash(query: string): string {
  return sha256(query);
}

function buildTaskSignal(input: KnowledgeRetrievalInput): ContextTaskSignal {
  const promptSignal = promptTaskSignal(input.prompt);
  const structured = structuredTaskSignals(input);
  const sectionSignals = promptSectionSignals(input.prompt);
  const pathSignal = buildPathSignals(input);
  const agentSignals = agentRoleTaskSignals(input);
  const entries = [...promptSignal.entries, ...structured.entries, ...sectionSignals.entries];
  const sources = uniqueStrings([...promptSignal.sources, ...structured.sources, ...pathSignal.sources, ...sectionSignals.sources, ...agentSignals.sources]);
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

function promptTaskSignal(prompt: unknown): { entries: string[]; sources: string[] } {
  const text = compactTaskText(firstString(prompt) ?? '', RAW_PROMPT_FALLBACK_MAX_CHARS);
  return text ? { entries: [`User request: ${text}`], sources: ['prompt.user_request'] } : { entries: [], sources: [] };
}

function agentRoleTaskSignals(input: KnowledgeRetrievalInput): { entries: string[]; sources: string[] } {
  const signals = normalizeAgentRoleSignals(input.agentRoleSignals);
  return {
    entries: [],
    sources: signals.map((signal) => `agent.${signal.roleSlot}`),
  };
}

function normalizeAgentRoleSignals(value: unknown): AgentRoleSignal[] {
  if (!Array.isArray(value)) return [];
  const out: AgentRoleSignal[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const roleSlot = item.roleSlot === 'nodeRole' || item.roleSlot === 'targetRole' || item.roleSlot === 'callerRole' ? item.roleSlot : undefined;
    const roleName = firstString(item.roleName);
    const signalText = compactTaskText(firstString(item.signalText) ?? '', 420);
    if (!roleSlot || !roleName || !signalText) continue;
    const key = `${roleSlot}:${roleName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      roleSlot,
      roleName,
      agentName: firstString(item.agentName),
      provider: firstString(item.provider),
      teamName: firstString(item.teamName),
      teamRole: firstString(item.teamRole),
      description: firstString(item.description),
      tags: stringArray(item.tags),
      instructionSummary: firstString(item.instructionSummary),
      signalText,
    });
  }
  return out;
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
  const usage = !isSpawnedAgentWorkflow(input.workflowName) && isRecord(input.state.repo_context_usage) ? input.state.repo_context_usage : undefined;
  const moduleIdentified = usage ? firstString(usage.module_identified, usage.moduleIdentified) : undefined;
  if (moduleIdentified) {
    entries.push(`Module identified: ${moduleIdentified}`);
    sources.push('state.repo_context_usage.module_identified');
  }
  for (const [key] of Object.entries(input.state)) {
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
  const labelPattern = /^\s*(USER PROMPT|USER REQUEST|BUG REPORT|BUG SUMMARY|Bug summary|ROOT CAUSE|Expected behavior|Known repro(?:\/evidence clues from ticket\/context)?|Required investigation path|FILES CHANGED|FILES TO TOUCH|ROUTING PRIMITIVES|IMPLEMENTATION PLAN|ACCEPTANCE CRITERIA|CODING STANDARDS|QA REPORT|INVESTIGATION REPORT)\s*:/gim;
  const headingPattern = /^\s*#{1,2}\s+(USER PROMPT|USER REQUEST|BUG REPORT|BUG SUMMARY|ROOT CAUSE|EXPECTED BEHAVIOR|KNOWN REPRO(?:\/EVIDENCE CLUES FROM TICKET\/CONTEXT)?|REQUIRED INVESTIGATION PATH|FILES CHANGED|FILES TO TOUCH|ROUTING PRIMITIVES|IMPLEMENTATION PLAN|ACCEPTANCE CRITERIA|CODING STANDARDS|QA REPORT|INVESTIGATION REPORT)\b[^\n]*$/gim;
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

function isGeneratedWorkflowArtifactPath(path: string): boolean {
  return /^(analysis|investigation|implementation|qa|reports|plans|summary)\//.test(path.replace(/\\/g, '/'));
}

function isLowSignalSection(label: string, text: string): boolean {
  if (label === 'ROUTING PRIMITIVES') return false;
  if (label.endsWith('REPORT') && /^https?:\/\//.test(text)) return true;
  return false;
}

function normalizeSectionLabel(label: string): string {
  const normalized = label.replace(/\s+/g, ' ').trim();
  const upper = normalized.toUpperCase();
  if (upper === 'USER PROMPT') return 'USER PROMPT';
  if (upper === 'USER REQUEST') return 'USER REQUEST';
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
  if (/\b(implement|update|modify|change|add|build|developer|engineer|coder|fullstack)\b/.test(role)) return 'implementation';
  if (/\b(agent-persona|persona-author|agent-author)\b/.test(haystack)) return 'agent_persona_author';
  if (/\b(investigat|debug|bug|incident)\b/.test(haystack)) return 'investigation';
  if (/\b(backend|api|database|db|server)\b/.test(haystack)) return 'backend';
  if (/\b(frontend|ui|browser|react)\b/.test(haystack)) return 'frontend';
  if (/\b(implement|update|modify|change|add|build|developer|engineer|coder|fullstack)\b/.test(haystack)) return 'implementation';
  if (/\b(prd|requirements?|acceptance criteria|user story|spec|specification|product spec|product requirements?|product planning|product manager|pm)\b/.test(haystack)) return 'product';
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

function stringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
  }
  return [];
}

function normalizeContextCategories(values: string[]): {
  categories: string[];
  groundingPreferences: string[];
  domainHints: string[];
  diagnostics: Array<Record<string, unknown>>;
} {
  const categories: string[] = [];
  const groundingPreferences: string[] = [];
  const domainHints: string[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const aliases: Record<string, string> = {
    repo_code: 'source',
    repo_source: 'source',
    source_code: 'source',
    code: 'source',
    repo_docs: 'doc',
    repo_doc: 'doc',
    docs: 'doc',
    documents: 'doc',
  };
  const allowed = new Set([
    'source',
    'guideline',
    'prd',
    'runbook',
    'design',
    'production_note',
    'source_doc',
    'module_rule',
    'spec',
    'architecture',
    'doc',
    'mandatory_guidance',
  ]);
  for (const raw of values) {
    const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized) continue;
    if (normalized === 'repo_backed') {
      groundingPreferences.push('repo_backed');
      diagnostics.push({ code: 'category_is_grounding_preference', category: raw, mappedTo: 'groundingPreferences.repo_backed' });
      continue;
    }
    const mapped = aliases[normalized] ?? normalized;
    if (allowed.has(mapped)) {
      categories.push(mapped);
      if (mapped !== normalized) diagnostics.push({ code: 'category_alias_mapped', category: raw, mappedTo: mapped });
    } else {
      domainHints.push(raw.trim());
      diagnostics.push({ code: 'category_as_domain_hint', category: raw, mappedTo: 'domainHints' });
    }
  }
  return {
    categories: uniqueStrings(categories),
    groundingPreferences: uniqueStrings(groundingPreferences),
    domainHints: uniqueStrings(domainHints),
    diagnostics,
  };
}

function fieldStringArray(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
  }
  return [];
}

function splitRetrievalRequirements(requirements: string[]): { retrievalRequirements: string[]; ignoredExecutionConstraints: string[] } {
  const retrievalRequirements: string[] = [];
  const ignoredExecutionConstraints: string[] = [];
  for (const requirement of requirements) {
    if (isExecutionOnlyConstraint(requirement)) ignoredExecutionConstraints.push(requirement);
    else retrievalRequirements.push(requirement);
  }
  return { retrievalRequirements, ignoredExecutionConstraints };
}

function isExecutionOnlyConstraint(value: string): boolean {
  const text = value.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /\b(read only|analysis only|do not implement|no implementation)\b/.test(text)
    || /\b(no|do not|don't|never)\s+(file\s+)?(edit|edits|editing|change|changes|write|writes|writing|modify|modifies|modifying)\b/.test(text)
    || /\b(no|do not|don't|never)\s+(commit|commits|branch|branches|pr|prs|pull request|pull requests|migration|migrations|patch|patches)\b/.test(text)
    || /\b(do not|don't|never)\s+run\s+(formatters?|commands? that write|write commands?)\b/.test(text)
    || /\bsave\b.*\b(artifact|report|analysis)\b/.test(text)
    || /\ballen_save_artifact\b/.test(text);
}

function isConcreteRepoFilePath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, '/');
  return Boolean(normalized)
    && !normalized.endsWith('/')
    && !normalized.includes('*')
    && /\.[A-Za-z0-9]+$/.test(normalized);
}

function normalizePathScope(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\*\*?$/, '').replace(/\/+$/, '');
}

function compactTaskText(value: string, maxLength = 1200): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function capRenderedQuery(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function semanticTaskText(task: string): string {
  return task
    .split(/\s+\|\s+/)
    .filter((entry) => !isPathOnlyTaskEntry(entry))
    .join(' | ');
}

function renderableRetrievalSignals(intent: ContextQueryIntent): string {
  const userPrompt = normalizeComparableSignal(intent.userPromptSignal ?? '');
  const entries = intent.task
    .split(/\s+\|\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      const userRequest = entry.replace(/^User request:\s*/i, '');
      return normalizeComparableSignal(userRequest) !== userPrompt;
    });
  return entries.join(' | ');
}

function normalizeComparableSignal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isSpawnedAgentWorkflow(workflowName: string): boolean {
  return workflowName.includes(':spawn_agent/');
}

function isPathOnlyTaskEntry(entry: string): boolean {
  return /^(Current files|Changed files|Path terms|Prompt file references|Prompt path terms|Target files|Path hints|Path scopes|Module hints|FILES CHANGED|FILES TO TOUCH)\s*:/i.test(entry.trim());
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
