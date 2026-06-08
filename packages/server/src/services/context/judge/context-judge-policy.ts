import type { Risk } from './context-judge.types.js';

export const AUTO_CURATION_CONFIDENCE_THRESHOLD = 0.65;

export type ContextWorkerRole =
  | 'context_review_triage'
  | 'context_remediation_planner'
  | 'context_learning_curator'
  | 'context_curation_fix'
  | 'context_ingestion_repair'
  | 'context_code_fix'
  | 'context_qa_eval';

const ROLE_ALIASES: Record<string, ContextWorkerRole> = {
  context_review_triage: 'context_review_triage',
  context_remediation_planner: 'context_remediation_planner',
  context_learning_curator: 'context_learning_curator',
  context_curation_fix: 'context_curation_fix',
  context_ingestion_repair: 'context_ingestion_repair',
  context_code_fix: 'context_code_fix',
  context_qa_eval: 'context_qa_eval',
  review_triage: 'context_review_triage',
  remediation_planner: 'context_remediation_planner',
  learning_curator: 'context_learning_curator',
  curation_fix: 'context_curation_fix',
  ingestion_repair: 'context_ingestion_repair',
  code_fix: 'context_code_fix',
  qa_eval: 'context_qa_eval',
};

export function normalizeContextWorkerRole(role: string | undefined | null): ContextWorkerRole | undefined {
  if (!role) return undefined;
  return ROLE_ALIASES[role];
}

export function isCodeChangingWorkerRole(role: string | undefined | null): boolean {
  return normalizeContextWorkerRole(role) === 'context_code_fix';
}

export function requiresHumanGate(input: {
  confidence?: number;
  risk?: Risk | string;
  workerRole?: string;
  actionKind?: string;
  destructive?: boolean;
  ambiguous?: boolean;
}): boolean {
  if (input.workerRole && isCodeChangingWorkerRole(input.workerRole)) return true;
  if (input.actionKind === 'code_change_pr') return true;
  if (input.destructive || input.ambiguous) return true;
  if (input.risk === 'high' || input.risk === 'critical') return true;
  if (typeof input.confidence === 'number' && input.confidence < AUTO_CURATION_CONFIDENCE_THRESHOLD) return true;
  return false;
}

export function sourceEvaluationKey(input: {
  sourceType: string;
  sourceId: string;
  repoId?: string;
  scopeType?: 'repo' | 'global';
}): string {
  if (input.sourceType === 'chat_learning') {
    const scopeType = input.scopeType ?? (input.repoId ? 'repo' : 'global');
    const scopeKey = scopeType === 'repo' ? input.repoId : 'global';
    return `${input.sourceType}:${scopeType}:${scopeKey ?? 'global'}:${input.sourceId}`;
  }
  return `${input.sourceType}:${input.sourceId}`;
}
