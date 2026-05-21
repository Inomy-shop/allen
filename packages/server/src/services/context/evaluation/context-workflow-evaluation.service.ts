import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Collection, Db } from 'mongodb';
import { logger } from '../../../logger.js';
import { firstString, isRecord } from '../allen-knowledge-graph/repo-knowledge-graph-utils.js';
import { normalizeUsageArray } from '../allen-knowledge-graph/repo-knowledge-graph-usage.js';
import { WORKFLOW_EVIDENCE_PACKING_VERSION, buildWorkflowSemanticEvaluationPromptArtifacts } from './context-workflow-evaluation-prompt.js';
import { resolveAllenPython } from '../../python-runtime.js';
import { isContextEngineEnabled } from '../config/context-provider-config.js';
import { resolveContextLlmConfig } from '../config/context-llm-config.js';
import { ContextLifecycleStore } from '../lifecycle/context-lifecycle-store.js';

type WorkflowSemanticStatus = 'queued' | 'running' | 'completed' | 'failed';

type WorkflowSemanticJob = {
  jobId: string;
  evaluationId?: string;
  traceId?: string;
  executionId: string;
  rootExecutionId: string;
  workflowName?: string;
  provider: 'deepeval';
  mode: 'workflow_summary';
  scope?: 'workflow';
  active?: boolean;
  status: WorkflowSemanticStatus;
  attempts: number;
  maxAttempts: number;
  queuedAt: Date;
  lastAttemptAt?: Date;
  completedAt?: Date;
  nextRetryAt?: Date;
  result?: Record<string, unknown>;
  promptPreview?: string;
  promptChars?: number;
  promptSha256?: string;
  evidencePayload?: Record<string, unknown>;
  packedEvidencePayload?: Record<string, unknown>;
  evidenceTruncated?: boolean;
  evidenceStats?: Record<string, unknown>;
  rawJudgeResponse?: string;
  judgeProvider?: string;
  judgeModel?: string;
  judgeDurationMs?: number;
  judgeCostUsd?: number;
  artifactHashes?: Record<string, unknown>;
  error?: string;
  diagnostics?: Array<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const WORKFLOW_AUTO_EVALUATION_STATUSES = new Set(['completed', 'failed']);

type WorkflowEvaluationEnqueueOptions = {
  force?: boolean;
  allowAnyExecutionStatus?: boolean;
};

export class ContextWorkflowEvaluationService {
  private jobs: Collection<WorkflowSemanticJob>;
  private executions: Collection;
  private packets: Collection;
  private usage: Collection;
  private nodeEvaluations: Collection;
  private traces: Collection;
  private interventions: Collection;
  private lifecycle: ContextLifecycleStore;

  constructor(private db: Db) {
    this.jobs = db.collection<WorkflowSemanticJob>('context_evaluations');
    this.executions = db.collection('executions');
    this.packets = db.collection('context_attempts');
    this.usage = db.collection('context_ref_events');
    this.nodeEvaluations = db.collection('context_evaluations');
    this.traces = db.collection('execution_traces');
    this.interventions = db.collection('workflow_interventions');
    this.lifecycle = new ContextLifecycleStore(db);
  }

  async enqueueForExecution(executionId: string, reason = 'workflow_terminal', options: WorkflowEvaluationEnqueueOptions = {}): Promise<WorkflowSemanticJob | null> {
    if (!isWorkflowDeepEvalEnabled()) return null;
    const exec = await this.executions.findOne({ id: executionId });
    if (!exec) return null;
    if (!options.allowAnyExecutionStatus && !WORKFLOW_AUTO_EVALUATION_STATUSES.has(String(exec.status))) return null;
    const rootExecutionId = firstString(exec.rootExecutionId, exec.parentExecutionId, exec.id) ?? executionId;
    const existing = await this.jobs.findOne({ executionId, provider: 'deepeval', mode: 'workflow_summary', scope: 'workflow', active: true });
    const now = new Date();
    if (!options.force && (existing?.status === 'running' || existing?.status === 'queued')) return existing;
    const resetExisting = options.force && existing != null;
    if (resetExisting) {
      await this.jobs.updateMany(
        { executionId, provider: 'deepeval', mode: 'workflow_summary', scope: 'workflow', active: true },
        { $set: { active: false, validTo: now, supersededAt: now } },
      );
    }
    const job: WorkflowSemanticJob = {
      jobId: resetExisting ? randomUUID() : firstString(existing?.jobId) ?? randomUUID(),
      evaluationId: randomUUID(),
      traceId: randomUUID(),
      executionId,
      rootExecutionId,
      workflowName: firstString(exec.workflowName),
      provider: 'deepeval',
      mode: 'workflow_summary',
      scope: 'workflow',
      active: true,
      status: 'queued',
      attempts: resetExisting ? 0 : Number(existing?.attempts ?? 0),
      maxAttempts: workflowSemanticMaxAttempts(),
      queuedAt: now,
      nextRetryAt: now,
      diagnostics: [
        {
          code: 'workflow_semantic_queued',
          severity: 'info',
          message: `Queued workflow-level semantic context evaluation (${reason}).`,
        },
      ],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.jobs.updateOne(
      { executionId, provider: 'deepeval', mode: 'workflow_summary', scope: 'workflow', active: true },
      {
        $set: job,
        $unset: {
          promptPreview: '',
          promptChars: '',
          promptSha256: '',
          evidencePayload: '',
          packedEvidencePayload: '',
          evidenceTruncated: '',
          evidenceStats: '',
          rawJudgeResponse: '',
          judgeProvider: '',
          judgeModel: '',
          judgeDurationMs: '',
          judgeCostUsd: '',
        },
      },
      { upsert: true },
    );
    return job;
  }

  async runPendingWorkflowEvaluations(limit = 3): Promise<number> {
    if (!isWorkflowDeepEvalEnabled()) return 0;
    const now = new Date();
    const rows = await this.jobs.find({
      provider: 'deepeval',
      scope: 'workflow',
      active: true,
      mode: 'workflow_summary',
      $or: [
        { status: 'queued' },
        {
          status: 'running',
          lastAttemptAt: { $lte: staleRunningBefore(now) },
          attempts: { $lt: workflowSemanticMaxAttempts() },
        },
        {
          status: 'failed',
          attempts: { $lt: workflowSemanticMaxAttempts() },
          $or: [
            { nextRetryAt: { $exists: false } },
            { nextRetryAt: { $lte: now } },
          ],
        },
      ],
    }).sort({ lastAttemptAt: 1, queuedAt: 1 }).limit(limit).toArray();
    let count = 0;
    for (const row of rows) {
      const result = await this.runWorkflowEvaluation(row.jobId).catch((err) => {
        logger.warn('workflow semantic evaluation failed', { executionId: row.executionId, error: (err as Error).message });
        return null;
      });
      if (result) count += 1;
    }
    return count;
  }

  async runWorkflowEvaluation(jobId: string): Promise<WorkflowSemanticJob | null> {
    if (!isWorkflowDeepEvalEnabled()) return null;
    const job = await this.jobs.findOne({ jobId, scope: 'workflow', active: true });
    if (!job) return null;
    const attempts = Number(job.attempts ?? 0);
    const maxAttempts = workflowSemanticMaxAttempts();
    if (attempts >= maxAttempts && job.status !== 'queued') return job;
    const nextAttempt = attempts + 1;
    await this.jobs.updateOne(
      { jobId },
      {
        $set: {
          status: 'running',
          attempts: nextAttempt,
          maxAttempts,
          lastAttemptAt: new Date(),
          updatedAt: new Date(),
        },
        $unset: { error: '', completedAt: '' },
      },
    );
    await this.updateExecutionSummary(job.executionId, {
      ...job,
      status: 'running',
      attempts: nextAttempt,
      maxAttempts,
      lastAttemptAt: new Date(),
    });

    try {
      const input = await this.buildEvaluationInput(job.executionId);
      const promptArtifacts = buildWorkflowSemanticEvaluationPromptArtifacts(input);
      const judgeRun = await runDeepEvalWorkflowJudge(promptArtifacts.prompt);
      const result = withMissingNodeFindings(
        judgeRun.result,
        promptArtifacts.packedEvidencePayload,
      );
      const completed: Partial<WorkflowSemanticJob> = {
        ...job,
        status: 'completed',
        attempts: nextAttempt,
        maxAttempts,
        completedAt: new Date(),
        result,
        ...buildWorkflowAuditFields(promptArtifacts, judgeRun.audit),
        diagnostics: normalizeDiagnostics(result.diagnostics),
        updatedAt: new Date(),
      };
      const refreshed = await this.lifecycle.replaceWorkflowEvaluation({
        executionId: job.executionId,
        rootExecutionId: job.rootExecutionId,
        job: { ...completed, error: undefined, nextRetryAt: undefined } as Record<string, unknown>,
        artifacts: {
          evidencePayload: promptArtifacts.evidencePayload,
          packedEvidencePayload: promptArtifacts.packedEvidencePayload,
          prompt: promptArtifacts.prompt,
          rawJudgeResponse: firstString(judgeRun.audit.rawJudgeResponse),
        },
      }) as WorkflowSemanticJob;
      if (refreshed) await this.updateExecutionSummary(refreshed.executionId, refreshed);
      return refreshed;
    } catch (err) {
      const failed: Partial<WorkflowSemanticJob> = {
        ...job,
        status: 'failed',
        attempts: nextAttempt,
        maxAttempts,
        lastAttemptAt: new Date(),
        nextRetryAt: nextAttempt < maxAttempts ? retryAt(nextAttempt) : undefined,
        error: (err as Error).message,
        diagnostics: [{
          code: 'workflow_semantic_eval_failed',
          severity: 'warn',
          message: (err as Error).message,
        }],
        updatedAt: new Date(),
      };
      const refreshed = await this.lifecycle.replaceWorkflowEvaluation({
        executionId: job.executionId,
        rootExecutionId: job.rootExecutionId,
        job: failed as Record<string, unknown>,
      }) as WorkflowSemanticJob;
      if (refreshed) await this.updateExecutionSummary(refreshed.executionId, refreshed);
      return refreshed;
    }
  }

  async getForExecution(executionId: string): Promise<WorkflowSemanticJob | null> {
    return this.jobs.findOne({ executionId, provider: 'deepeval', mode: 'workflow_summary', scope: 'workflow', active: true });
  }

  async getSummaryForExecution(executionId: string): Promise<Record<string, unknown> | null> {
    const job = await this.getForExecution(executionId);
    if (!job) return null;
    return this.summarizeWorkflowJobWithFreshness(job);
  }

  private async buildEvaluationInput(executionId: string) {
    const descendants = await this.executions.find({
      $or: [
        { rootExecutionId: executionId },
        { parentExecutionId: executionId },
      ],
    }).toArray();
    const executionIds = Array.from(new Set([
      executionId,
      ...descendants.map((row) => String(row.id)).filter(Boolean),
    ]));
    const [execution, attemptRows, nodeEvaluations, executionTraces] = await Promise.all([
      this.executions.findOne({ id: executionId }),
      this.packets.find({ executionId: { $in: executionIds } }).sort({ createdAt: 1 }).toArray(),
      this.nodeEvaluations.find({ executionId: { $in: executionIds }, scope: 'node', active: true }).sort({ createdAt: 1 }).toArray(),
      this.traces.find({ executionId: { $in: executionIds }, type: 'agent' }).sort({ startedAt: 1 }).toArray(),
    ]);
    await Promise.all(executionTraces.map((trace) => {
      const contextAttemptId = firstString(trace.contextAttemptId);
      if (!contextAttemptId) return Promise.resolve();
      return this.lifecycle.recordSourceDiscoveryFromTrace({
        contextAttemptId,
        usageTraceId: firstString(trace.contextUsageTraceId),
        executionTraceId: firstString(trace.executionTraceId),
        trace,
      });
    }));
    const [nodeContextPackets, usageTraces] = await Promise.all([
      Promise.all(attemptRows.map((row) => this.lifecycle.getAttemptPacketView(String(row.contextAttemptId))))
        .then((rows) => rows.filter((row): row is Record<string, unknown> => row != null)),
      Promise.all(attemptRows.map((row) => this.lifecycle.getUsageView(String(row.contextAttemptId))))
        .then((rows) => rows.filter((row): row is Record<string, unknown> => row != null)),
    ]);
    return {
      execution,
      descendants,
      nodeContextPackets,
      usageTraces,
      nodeEvaluations,
      executionTraces,
    };
  }

  private async updateExecutionSummary(executionId: string, job: Partial<WorkflowSemanticJob>): Promise<void> {
    void executionId;
    void job;
  }

  private async summarizeWorkflowJobWithFreshness(job: Partial<WorkflowSemanticJob>): Promise<Record<string, unknown>> {
    const summary = summarizeWorkflowJob(job);
    const executionId = firstString(job.executionId);
    if (!executionId) return summary;
    const latestWorkflowChangeAt = await this.latestWorkflowChangeAt(executionId).catch(() => null);
    const evaluatedAt = dateValue(job.completedAt);
    const isTerminalEval = job.status === 'completed' && evaluatedAt != null;
    const packingVersion = numericValue(isRecord(job.evidenceStats) ? job.evidenceStats.packingVersion : undefined);
    const staleForWorkflowChange = Boolean(isTerminalEval && latestWorkflowChangeAt && evaluatedAt.getTime() < latestWorkflowChangeAt.getTime());
    const staleForPackingVersion = Boolean(isTerminalEval && (packingVersion ?? 0) < WORKFLOW_EVIDENCE_PACKING_VERSION);
    const stale = staleForWorkflowChange || staleForPackingVersion;
    return {
      ...summary,
      stale,
      latestWorkflowChangeAt,
      evaluatedAt,
      staleReason: staleForPackingVersion
        ? 'Workflow-level context evaluation used an older evidence packing format.'
        : staleForWorkflowChange
          ? 'Workflow changed after the last workflow-level context evaluation.'
          : undefined,
    };
  }

  private async latestWorkflowChangeAt(executionId: string): Promise<Date | null> {
    const descendants = await this.executions.find({
      $or: [
        { rootExecutionId: executionId },
        { parentExecutionId: executionId },
      ],
    }, { projection: { id: 1, completedAt: 1, updatedAt: 1, startedAt: 1, feedbackEntries: 1 } }).toArray();
    const executionIds = Array.from(new Set([
      executionId,
      ...descendants.map((row) => String(row.id)).filter(Boolean),
    ]));
    const [execution, latestTrace, latestUsage, latestEval, latestIntervention] = await Promise.all([
      this.executions.findOne(
        { id: executionId },
        { projection: { completedAt: 1, updatedAt: 1, startedAt: 1, feedbackEntries: 1 } },
      ),
      this.traces.find(
        { executionId: { $in: executionIds } },
        { projection: { completedAt: 1, startedAt: 1 } },
      ).sort({ completedAt: -1, startedAt: -1 }).limit(1).next(),
      this.usage.find(
        {
          $or: [
            { executionId: { $in: executionIds } },
            { rootExecutionId: executionId },
            { parentExecutionId: executionId },
          ],
        },
        { projection: { createdAt: 1 } },
      ).sort({ createdAt: -1 }).limit(1).next(),
      this.nodeEvaluations.find(
        { executionId: { $in: executionIds } },
        { projection: { updatedAt: 1, createdAt: 1 } },
      ).sort({ updatedAt: -1, createdAt: -1 }).limit(1).next(),
      this.interventions.find(
        { workflow_run_id: executionId },
        { projection: { updated_at: 1, answered_at: 1, created_at: 1 } },
      ).sort({ updated_at: -1, answered_at: -1, created_at: -1 }).limit(1).next(),
    ]);
    const candidates: Date[] = [];
    collectDate(candidates, execution?.completedAt);
    collectDate(candidates, execution?.updatedAt);
    collectDate(candidates, execution?.startedAt);
    for (const entry of normalizeUsageArray(execution?.feedbackEntries)) collectDate(candidates, entry.createdAt);
    for (const row of descendants) {
      collectDate(candidates, row.completedAt);
      collectDate(candidates, row.updatedAt);
      collectDate(candidates, row.startedAt);
      for (const entry of normalizeUsageArray(row.feedbackEntries)) collectDate(candidates, entry.createdAt);
    }
    collectDate(candidates, latestTrace?.completedAt);
    collectDate(candidates, latestTrace?.startedAt);
    collectDate(candidates, latestUsage?.createdAt);
    collectDate(candidates, latestEval?.updatedAt);
    collectDate(candidates, latestEval?.createdAt);
    collectDate(candidates, latestIntervention?.updated_at);
    collectDate(candidates, latestIntervention?.answered_at);
    collectDate(candidates, latestIntervention?.created_at);
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => b.getTime() - a.getTime())[0];
  }
}

type WorkflowJudgeRun = {
  result: Record<string, unknown>;
  audit: Record<string, unknown>;
};

async function runDeepEvalWorkflowJudge(prompt: string): Promise<WorkflowJudgeRun> {
  const script = resolveWorkflowDeepEvalScript();
  const python = resolveAllenPython();
  const llm = resolveContextLlmConfig({ purpose: 'semantic_judge' });
  const payload = {
    prompt,
    judgeUrl: workflowJudgeUrl(),
    judgeSecret: workflowJudgeSecret(),
    provider: llm.provider,
    model: llm.model,
    timeoutMs: Number(process.env.ALLEN_DEEPEVAL_WORKFLOW_JUDGE_TIMEOUT_MS ?? 300_000),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('DeepEval workflow evaluator timed out'));
    }, workflowSidecarTimeoutMs());
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `DeepEval workflow evaluator exited with code ${code}`));
        return;
      }
      try {
        const raw = parseJsonObject(stdout);
        resolve({
          result: normalizeWorkflowResult(raw),
          audit: normalizeWorkflowJudgeAudit(raw),
        });
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function buildWorkflowAuditFields(
  promptArtifacts: {
    prompt: string;
    evidencePayload: Record<string, unknown>;
    packedEvidencePayload: Record<string, unknown>;
    evidenceJson: string;
    evidenceTruncated: boolean;
    evidenceStats: Record<string, unknown>;
  },
  judgeAudit: Record<string, unknown>,
): Partial<WorkflowSemanticJob> {
  return {
    promptPreview: promptArtifacts.prompt.slice(0, workflowEvalPromptPreviewChars()),
    promptChars: promptArtifacts.prompt.length,
    promptSha256: createHash('sha256').update(promptArtifacts.prompt).digest('hex'),
    evidenceTruncated: promptArtifacts.evidenceTruncated,
    evidenceStats: promptArtifacts.evidenceStats,
    judgeProvider: firstString(judgeAudit.judgeProvider),
    judgeModel: firstString(judgeAudit.judgeModel),
    judgeDurationMs: numericValue(judgeAudit.judgeDurationMs),
    judgeCostUsd: numericValue(judgeAudit.judgeCostUsd),
  };
}

function normalizeWorkflowResult(result: Record<string, unknown>): Record<string, unknown> {
  const scores = isRecord(result.scores) ? result.scores : {};
  return {
    provider: 'deepeval',
    mode: 'workflow_summary',
    runner: firstString(result.runner) ?? 'python_deepeval',
    modelProvider: firstString(result.modelProvider) ?? 'allen_codex',
    model: firstString(result.model),
    status: ['passed', 'warning', 'failed'].includes(String(result.status)) ? result.status : 'warning',
    scores: {
      precision: score(scores.precision),
      completeness: score(scores.completeness),
      usefulness: score(scores.usefulness),
      groundedness: score(scores.groundedness),
      correctness: score(scores.correctness),
      bloat: score(scores.bloat),
      overall: score(scores.overall),
    },
    diagnostics: normalizeDiagnostics(result.diagnostics),
    nodeFindings: normalizeNodeFindings(result.nodeFindings).slice(0, 100),
    summary: firstString(result.summary) ?? '',
    rawScores: isRecord(result.rawScores) ? result.rawScores : undefined,
  };
}

function normalizeWorkflowJudgeAudit(result: Record<string, unknown>): Record<string, unknown> {
  return {
    rawJudgeResponse: firstString(result.rawJudgeResponse),
    judgeProvider: firstString(result.judgeProvider, result.modelProvider),
    judgeModel: firstString(result.judgeModel, result.model),
    judgeDurationMs: numericValue(result.judgeDurationMs),
    judgeCostUsd: numericValue(result.judgeCostUsd),
  };
}

function withMissingNodeFindings(
  result: Record<string, unknown>,
  packedEvidencePayload: Record<string, unknown>,
): Record<string, unknown> {
  const existing = normalizeNodeFindings(result.nodeFindings);
  const expected = expectedNodeFindings(packedEvidencePayload);
  const missing = expected.filter((node) => !existing.some((finding) => identitiesMatch(node, finding)));
  const additions = missing.map((node) => ({
    executionId: node.executionId,
    nodeName: node.nodeName,
    attempt: node.attempt,
    status: 'not_assessed',
    source: 'allen_fallback',
    fallbackReason: fallbackReason(node),
    summary: fallbackSummary(node),
  }));
  return {
    ...result,
    nodeFindings: [...existing, ...additions].slice(0, 100),
    evaluationCoverage: {
      expectedNodeFindings: expected.length,
      returnedNodeFindings: existing.length,
      fallbackNodeFindings: additions.length,
      missingNodeFindings: additions.map((row) => ({
        executionId: row.executionId,
        nodeName: row.nodeName,
        attempt: row.attempt,
        reason: row.fallbackReason,
      })),
    },
  };
}

function normalizeNodeFindings(value: unknown): Array<Record<string, unknown>> {
  return normalizeUsageArray(value).map((finding) => {
    const normalized = { ...finding };
    const parsedIdentity = parseNodeFindingIdentity(finding);
    normalized.executionId = parsedIdentity.executionId;
    normalized.nodeName = parsedIdentity.nodeName;
    normalized.attempt = parsedIdentity.attempt;
    normalized.source = firstString(finding.source) ?? 'deepeval';
    if (parsedIdentity.normalizedFromNodeName) normalized.identityNormalized = true;
    const status = firstString(finding.status);
    normalized.status = ['passed', 'warning', 'failed', 'not_assessed'].includes(String(status))
      ? status
      : 'warning';
    return normalized;
  });
}

function parseNodeFindingIdentity(finding: Record<string, unknown>): {
  executionId?: string;
  nodeName: string;
  attempt: number;
  normalizedFromNodeName: boolean;
} {
  const executionId = firstString(finding.executionId);
  let nodeName = firstString(finding.nodeName) ?? 'unknown';
  let attempt = numericValue(finding.attempt);
  let normalizedFromNodeName = false;
  if (attempt == null) {
    const legacy = nodeName.match(/^(.*?)\s+(?:attempt\s*#?|#)(\d+)\s*$/i);
    if (legacy?.[1] && legacy[2]) {
      nodeName = legacy[1].trim();
      attempt = Number(legacy[2]);
      normalizedFromNodeName = true;
    }
  }
  return {
    executionId,
    nodeName,
    attempt: attempt != null && Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1,
    normalizedFromNodeName,
  };
}

function expectedNodeFindings(packedEvidencePayload: Record<string, unknown>): Array<Record<string, unknown>> {
  return normalizeUsageArray(packedEvidencePayload.nodes)
    .map((node) => ({
      ...node,
      executionId: firstString(node.executionId),
      nodeName: firstString(node.nodeName) ?? 'unknown',
      attempt: normalizeAttempt(node.attempt),
    }))
    .filter((node) => node.nodeName !== 'unknown');
}

function identitiesMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  if (firstString(expected.nodeName) !== firstString(actual.nodeName)) return false;
  if (normalizeAttempt(expected.attempt) !== normalizeAttempt(actual.attempt)) return false;
  const expectedExecutionId = firstString(expected.executionId);
  const actualExecutionId = firstString(actual.executionId);
  return !expectedExecutionId || !actualExecutionId || expectedExecutionId === actualExecutionId;
}

function normalizeAttempt(value: unknown): number {
  const attempt = numericValue(value);
  return attempt != null && Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
}

function fallbackReason(node: Record<string, unknown>): string {
  if (!firstString(node.outputExcerpt) && normalizeUsageArray(node.loadedRefs).length === 0 && normalizeUsageArray(node.appliedRefs).length === 0) {
    return 'judge_omitted_node_finding_with_limited_usage_evidence';
  }
  return 'judge_omitted_node_finding';
}

function fallbackSummary(node: Record<string, unknown>): string {
  const counts = [
    `selected=${normalizeUsageArray(node.selectedRefs).length}`,
    `injected=${normalizeUsageArray(node.injectedRefs).length}`,
    `skipped=${normalizeUsageArray(node.skippedRefs).length}`,
    `loaded=${normalizeUsageArray(node.loadedRefs).length}`,
    `applied=${normalizeUsageArray(node.appliedRefs).length}`,
    `diagnostics=${normalizeUsageArray(node.diagnostics).length}`,
    `outputChars=${String(node.outputExcerpt ?? '').length}`,
  ].join(', ');
  return `Workflow-level DeepEval omitted this exact node attempt from nodeFindings. Allen added this fallback from packed evidence (${counts}).`;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (isRecord(parsed)) return parsed;
    }
  }
  throw new Error('DeepEval workflow evaluator returned invalid JSON');
}

function normalizeDiagnostics(value: unknown): Array<Record<string, unknown>> {
  return normalizeUsageArray(value).slice(0, 100).map((item) => ({
    code: firstString(item.code) ?? 'workflow_semantic_finding',
    severity: firstString(item.severity) === 'warn' ? 'warn' : 'info',
    message: firstString(item.message, item.summary) ?? '',
    ...item,
  }));
}

function summarizeWorkflowJob(job: Partial<WorkflowSemanticJob>): Record<string, unknown> {
  return {
    jobId: job.jobId,
    provider: job.provider ?? 'deepeval',
    mode: job.mode ?? 'workflow_summary',
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    queuedAt: job.queuedAt,
    lastAttemptAt: job.lastAttemptAt,
    completedAt: job.completedAt,
    nextRetryAt: job.nextRetryAt,
    error: job.error,
    result: job.result,
    audit: workflowAuditSummary(job),
    diagnostics: normalizeDiagnostics(job.diagnostics),
  };
}

function workflowAuditSummary(job: Partial<WorkflowSemanticJob>): Record<string, unknown> | undefined {
  const audit = {
    promptPreview: job.promptPreview,
    promptChars: job.promptChars,
    promptSha256: job.promptSha256,
    artifactHashes: job.artifactHashes,
    evidenceTruncated: job.evidenceTruncated,
    evidenceStats: job.evidenceStats,
    judgeProvider: job.judgeProvider,
    judgeModel: job.judgeModel,
    judgeDurationMs: job.judgeDurationMs,
    judgeCostUsd: job.judgeCostUsd,
  };
  return Object.values(audit).some((value) => value !== undefined && value !== null) ? audit : undefined;
}

function resolveWorkflowDeepEvalScript(): string {
  if (process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT) return process.env.ALLEN_DEEPEVAL_WORKFLOW_SCRIPT;
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '../scripts/deepeval-workflow-evaluator.py'),
    join(process.cwd(), 'packages/server/src/scripts/deepeval-workflow-evaluator.py'),
    join(process.cwd(), 'src/scripts/deepeval-workflow-evaluator.py'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function workflowJudgeUrl(): string {
  if (process.env.ALLEN_CONTEXT_EVAL_JUDGE_URL) return process.env.ALLEN_CONTEXT_EVAL_JUDGE_URL;
  const base = process.env.ALLEN_INTERNAL_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '4000'}`;
  return `${base.replace(/\/+$/, '')}/api/internal/context-evaluation/judge`;
}

function workflowJudgeSecret(): string {
  const secret = process.env.ALLEN_CONTEXT_LLM_SECRET ?? process.env.ALLEN_CONTEXT_EVAL_JUDGE_SECRET ?? process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('ALLEN_CONTEXT_LLM_SECRET, ALLEN_CONTEXT_EVAL_JUDGE_SECRET, or JWT_ACCESS_SECRET is required for workflow DeepEval judge calls');
  return secret;
}

function isWorkflowDeepEvalEnabled(): boolean {
  return isContextEngineEnabled()
    && (process.env.ALLEN_CONTEXT_SEMANTIC_EVALUATOR ?? '').toLowerCase() === 'deepeval'
    && (process.env.ALLEN_CONTEXT_SEMANTIC_MODE ?? 'workflow_summary').toLowerCase() !== 'per_node';
}

function workflowSemanticMaxAttempts(): number {
  const value = Number(process.env.ALLEN_CONTEXT_SEMANTIC_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_ATTEMPTS;
}

function workflowSidecarTimeoutMs(): number {
  const explicit = Number(process.env.ALLEN_DEEPEVAL_WORKFLOW_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const judge = Number(process.env.ALLEN_DEEPEVAL_WORKFLOW_JUDGE_TIMEOUT_MS ?? 300_000);
  const safeJudge = Number.isFinite(judge) && judge > 0 ? judge : 300_000;
  return safeJudge + 60_000;
}

function workflowEvalPromptPreviewChars(): number {
  const value = Number(process.env.ALLEN_CONTEXT_EVAL_PROMPT_PREVIEW_CHARS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 120_000;
}

function numericValue(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function retryAt(attempt: number): Date {
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delayMs);
}

function staleRunningBefore(now: Date): Date {
  const timeoutMs = Number(process.env.ALLEN_DEEPEVAL_STALE_RUNNING_MS ?? 10 * 60_000);
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10 * 60_000;
  return new Date(now.getTime() - safeTimeoutMs);
}

function score(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(Math.max(0, Math.min(1, numeric)) * 1000) / 1000;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function collectDate(out: Date[], value: unknown): void {
  const date = dateValue(value);
  if (date) out.push(date);
}
