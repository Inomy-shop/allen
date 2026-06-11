import { Router } from 'express';
import type { Db } from 'mongodb';
import { ContextJudgeService } from '../services/context/judge/context-judge.service.js';
import { ContextFindingService } from '../services/context/judge/context-finding.service.js';
import { ContextReviewService } from '../services/context/judge/context-review.service.js';
import { ContextRemediationTaskService } from '../services/context/judge/context-remediation-task.service.js';
import { CuratedContextEditorService } from '../services/context/judge/curated-context-editor.service.js';
import { LearningPromotionService } from '../services/context/judge/learning-promotion.service.js';
import { ContextJudgeOrchestratorService } from '../services/context/judge/context-judge-orchestrator.service.js';
import { ContextReviewWorkerOrchestrator } from '../services/context/judge/context-review-worker-orchestrator.js';
import { ContextEvaluationScheduler } from '../services/context/judge/context-evaluation-scheduler.js';
import { ContextSourceEvaluationService } from '../services/context/judge/context-source-evaluation.service.js';
import { ContextTraceAnalysisAssignmentService } from '../services/context/judge/context-trace-analysis-assignment.service.js';
import {
  type IOrchestratorDispatchAdapter,
  AllenSpawnOrchestratorDispatchAdapter,
  NullOrchestratorDispatchAdapter,
} from '../services/context/judge/orchestrator-dispatch-adapter.js';
import { registerContextQualityJudgeReviewRoutes } from './context-quality.judge-review.routes.js';
import { registerContextQualityRemediationRoutes } from './context-quality.remediation.routes.js';
import { registerContextQualityOrchestratorRoutes } from './context-quality.orchestrator.routes.js';
import { registerContextQualityUsageRoutes } from './context-quality.usage.routes.js';
import { registerContextQualitySchedulerTraceRoutes } from './context-quality.scheduler-trace.routes.js';
import type { ContextQualityRouteDeps } from './context-quality.route-utils.js';

export function contextQualityRoutes(db: Db, dispatchAdapter?: IOrchestratorDispatchAdapter): Router {
  const router = Router();
  const resolvedAdapter: IOrchestratorDispatchAdapter =
    dispatchAdapter ??
    (process.env['ALLEN_AGENT_SPAWN_URL']
      ? new AllenSpawnOrchestratorDispatchAdapter(process.env['ALLEN_AGENT_SPAWN_URL'])
      : new NullOrchestratorDispatchAdapter());

  const deps: ContextQualityRouteDeps = {
    db,
    resolvedAdapter,
    judgeService: new ContextJudgeService(db),
    findingService: new ContextFindingService(db),
    reviewService: new ContextReviewService(db),
    remediationService: new ContextRemediationTaskService(db),
    editorService: new CuratedContextEditorService(db),
    promotionService: new LearningPromotionService(db),
    orchestratorService: new ContextJudgeOrchestratorService(db),
    workerOrchestrator: new ContextReviewWorkerOrchestrator(db),
    scheduler: new ContextEvaluationScheduler(db),
    sourceEvalService: new ContextSourceEvaluationService(db),
    traceAssignmentService: new ContextTraceAnalysisAssignmentService(db),
  };

  registerContextQualityJudgeReviewRoutes(router, deps);
  registerContextQualityRemediationRoutes(router, deps);
  registerContextQualityOrchestratorRoutes(router, deps);
  registerContextQualityUsageRoutes(router, deps);
  registerContextQualitySchedulerTraceRoutes(router, deps);

  return router;
}
