
import type { Db } from 'mongodb';
import type { CuratedContextPatch } from '../services/context/judge/curated-context-editor.service.js';
import type { ContextEvaluationScheduler } from '../services/context/judge/context-evaluation-scheduler.js';
import type { ContextFindingService } from '../services/context/judge/context-finding.service.js';
import type { ContextJudgeOrchestratorService } from '../services/context/judge/context-judge-orchestrator.service.js';
import type { ContextJudgeService } from '../services/context/judge/context-judge.service.js';
import type { ContextRemediationTaskService } from '../services/context/judge/context-remediation-task.service.js';
import type { ContextReviewWorkerOrchestrator } from '../services/context/judge/context-review-worker-orchestrator.js';
import type { ContextReviewService } from '../services/context/judge/context-review.service.js';
import type { ContextSourceEvaluationService } from '../services/context/judge/context-source-evaluation.service.js';
import type { ContextTraceAnalysisAssignmentService } from '../services/context/judge/context-trace-analysis-assignment.service.js';
import type { CuratedContextEditorService } from '../services/context/judge/curated-context-editor.service.js';
import type { LearningPromotionService } from '../services/context/judge/learning-promotion.service.js';
import type { IOrchestratorDispatchAdapter } from '../services/context/judge/orchestrator-dispatch-adapter.js';

export interface ContextQualityRouteDeps {
  db: Db;
  resolvedAdapter: IOrchestratorDispatchAdapter;
  judgeService: ContextJudgeService;
  findingService: ContextFindingService;
  reviewService: ContextReviewService;
  remediationService: ContextRemediationTaskService;
  editorService: CuratedContextEditorService;
  promotionService: LearningPromotionService;
  orchestratorService: ContextJudgeOrchestratorService;
  workerOrchestrator: ContextReviewWorkerOrchestrator;
  scheduler: ContextEvaluationScheduler;
  sourceEvalService: ContextSourceEvaluationService;
  traceAssignmentService: ContextTraceAnalysisAssignmentService;
}

export function contextProviderDisabledPayload(): Record<string, unknown> {
  return {
    error: 'Context provider is disabled. Set ALLEN_CONTEXT_PROVIDER to enable context engine flows.',
    code: 'CONTEXT_PROVIDER_DISABLED',
  };
}

export function parseStringList(value: unknown): string[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(String);
  const raw = String(value);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through to comma-separated parsing
  }
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

export function normalizeCuratedEditPatch(input: Record<string, unknown>): CuratedContextPatch {
  const allowed = [
    'chunks',
    'curatedContext',
    'retrievalText',
    'title',
    'category',
    'description',
    'summary',
    'inclusion',
    'injectionPolicy',
    'authority',
    'freshness',
    'memoryType',
    'appliesToAgents',
    'appliesToGlobs',
    'appliesToTaskKinds',
    'positiveTaskHints',
    'negativeTaskHints',
    'demoteWhen',
    'requirePositiveSignals',
    'budgetPolicy',
  ];
  const out: Record<string, unknown> = {};
  const merge = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    merge(record['metadataUpdates']);
    for (const key of allowed) {
      if (record[key] !== undefined) out[key] = record[key];
    }
  };
  merge(input['patch']);
  merge(input['proposedPatch']);
  merge(input['metadataUpdates']);
  for (const key of allowed) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  if (out['chunks'] === undefined && typeof input['content'] === 'string') {
    out['chunks'] = [{ text: input['content'] }];
  }
  return out as CuratedContextPatch;
}

export function curatedContextQualityWarnings(patch: CuratedContextPatch): string[] {
  const text = typeof patch.curatedContext === 'string' ? patch.curatedContext.trim() : '';
  if (!text) return [];
  const lower = text.toLowerCase();
  const routingSignals = [
    'use when',
    'prefer for',
    'prefer this',
    'do not inject',
    'avoid using',
    'only for explicit',
    'displace',
    'match for',
    'routing',
  ];
  if (!routingSignals.some((signal) => lower.includes(signal))) return [];
  if (text.length < 280) {
    return ['curatedContext may be too routing-oriented; verify it remains directly useful as injected agent guidance.'];
  }
  return ['curatedContext contains routing/applicability language; retrievalText should carry search and routing terms unless this text is also useful when injected.'];
}
