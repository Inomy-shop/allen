import { createHash } from 'node:crypto';
import type { KnowledgeRetrievalInput } from './repo-context-engine.js';
import { firstString, isRecord } from '../common/context-utils.js';

const TASK_SIGNAL_MAX_CHARS = 3600;
const RAW_PROMPT_FALLBACK_MAX_CHARS = 2400;
const PROMPT_SECTION_MAX_CHARS = 850;
const RENDERED_CONTEXT_QUERY_MAX_CHARS = 5000;

export type ContextQueryIntent = {
  schemaVersion: number;
  workflowName: string;
  nodeName: string;
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

export function buildContextQueryIntent(input: KnowledgeRetrievalInput): ContextQueryIntent {
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
    workflowName: input.workflowName,
    nodeName: input.nodeName,
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

export function renderContextQuery(intent: ContextQueryIntent): string {
  return capRenderedQuery([
    `Workflow: ${intent.workflowName}`,
    `Node: ${intent.nodeName}`,
    `Role: ${intent.role}`,
    `Role family: ${intent.roleFamily}`,
    intent.rawRole !== intent.role ? `Raw role: ${intent.rawRole}` : '',
    intent.roleFocus.length ? `Role search intent: ${intent.roleFocus.join('; ')}` : '',
    intent.requiredCategories.length ? `Required context categories: ${intent.requiredCategories.join(', ')}` : '',
    intent.preferredCategories.length ? `Preferred context categories: ${intent.preferredCategories.join(', ')}` : '',
    intent.exclusionCategories.length ? `Excluded context categories: ${intent.exclusionCategories.join(', ')}` : '',
    intent.currentFiles.length ? `Current files: ${intent.currentFiles.join(', ')}` : '',
    intent.changedFiles.length ? `Changed files: ${intent.changedFiles.join(', ')}` : '',
    intent.pathHints.length ? `Path hints: ${intent.pathHints.join(', ')}` : '',
    intent.moduleHints.length ? `Module hints: ${intent.moduleHints.join(', ')}` : '',
    intent.task ? `Task signal: ${intent.task}` : '',
  ].filter(Boolean).join('\n'), RENDERED_CONTEXT_QUERY_MAX_CHARS);
}

export function contextQueryIntentHash(intent: ContextQueryIntent): string {
  return sha256(stableStringify(intent));
}

export function renderedContextQueryHash(query: string): string {
  return sha256(query);
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
  if (/\b(implement|developer|engineer|coder|fullstack)\b/.test(role)) return 'implementation';
  if (/\b(agent-persona|persona-author|agent-author)\b/.test(haystack)) return 'agent_persona_author';
  if (/\b(investigat|debug|bug|incident)\b/.test(haystack)) return 'investigation';
  if (/\b(backend|api|database|db|server)\b/.test(haystack)) return 'backend';
  if (/\b(frontend|ui|browser|react)\b/.test(haystack)) return 'frontend';
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

function stringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
  }
  return [];
}

function compactTaskText(value: string, maxLength = 1200): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function capRenderedQuery(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
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
