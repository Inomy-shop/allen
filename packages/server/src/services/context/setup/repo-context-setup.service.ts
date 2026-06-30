import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ObjectId, type Db } from 'mongodb';
import { isActiveSetupStatus, type RepoContextSetupRun, type SetupPhase, type SetupPhaseSnapshot, type SetupStatus, type CurationFileFailure, type MandatoryMappingRow, type MandatoryMappingRowStatus, type MandatoryProposalDetail, type SetupDetailResponse } from './repo-context-setup.types.js';
import type { RepoContextCurationService } from '../curation/repo-context-curation.service.js';
import type { RepoMandatoryContextService } from '../mandatory/repo-mandatory-context.service.js';
import type { CogneeMemoryService } from '../cognee/cognee-memory.service.js';
import { ExecutionService } from '../../execution.service.js';
import { isContextEngineEnabled, isCogneeContextEnabled } from '../config/context-provider-config.js';
import { resolveDefaultBranchName, fetchBranch, revParse } from '../curation/repo-context-curation-git.js';
import { getRepoContextCurationStageStatus, type CurationStageStatus } from '../curation/repo-context-curation-runner.js';
import { logger } from '../../../logger.js';
import { AlertService } from '../../alert.service.js';
import { notDeletedFilter } from '../../soft-delete.js';

/** G2: throttle git fetches within hasCommittedChangesSinceLastRun to at most once per repo per 5 min. */
const FETCH_THROTTLE_MS = 5 * 60 * 1_000;
const lastFetchByRepo = new Map<string, number>();
/** Test-only: clears the per-repo git-fetch throttle cache. */
export function resetFetchThrottleForTests(): void {
  lastFetchByRepo.clear();
}

export const SETUP_RUNS_COLLECTION = 'repo_context_setup_runs';
const PROPOSALS_COLLECTION = 'mandatory_context_proposals';

/** Fix K: hard cap raised to 4 hours (backstop only — stall detection is the primary guard). */
const SETUP_TIMEOUT_MS = Number(process.env.REPO_CONTEXT_SETUP_TIMEOUT_MS ?? '') || 4 * 3_600_000;
/** Fix K: stall threshold — fails a child exec that shows no staging progress for this long. */
const SETUP_STALL_MS = Number(process.env.REPO_CONTEXT_SETUP_STALL_MS ?? '') || 20 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_BACKOFF_MAX_MS = 5_000;

type SpawnArgs = {
  agent_name: string;
  prompt: string;
  repo_path?: string;
  root_execution_id?: string;
  parent_caller?: string;
};

/** Priority weight for deduplication: higher = wins. */
const STATUS_PRIORITY: Record<string, number> = {
  missing: 0,
  staged: 1,
  consumed_into_proposal: 2,
  deactivated: 3,
  saved: 4,
};

/**
 * Pure function — no DB access. Merges proposal rows + mapping rows into
 * a deduped list keyed by (agentName, title, sourcePath?).
 * Priority: saved > deactivated > consumed_into_proposal > staged > missing.
 * Returns null when all sources are empty.
 * Caps output at 200 rows.
 */
function buildMandatoryProposalDetail(
  proposalDocs: Record<string, unknown>[],
  savedDocs: Record<string, unknown>[],
  deactivatedDocs: Record<string, unknown>[],
  affectedAgentNames: string[],
): MandatoryProposalDetail | null {
  if (proposalDocs.length === 0 && savedDocs.length === 0 && deactivatedDocs.length === 0) {
    return null;
  }

  let stagedCount = 0;
  let consumedIntoProposalCount = 0;
  let activeProposalCount = 0;

  const rowMap = new Map<string, MandatoryMappingRow>();

  function rowKey(agentName: string, title: string, sourcePath?: string): string {
    return `${agentName}::${title}::${sourcePath ?? ''}`;
  }

  function addRow(row: MandatoryMappingRow): void {
    const key = rowKey(row.agentName, row.title, row.sourcePath);
    const existing = rowMap.get(key);
    if (!existing || (STATUS_PRIORITY[row.status] ?? 0) > (STATUS_PRIORITY[existing.status] ?? 0)) {
      rowMap.set(key, row);
    }
  }

  // Process proposal docs (staged rows, consumed_into_proposal rows, or assembled proposals)
  for (const doc of proposalDocs) {
    const status = String(doc.status ?? '');
    if (status === 'staged') {
      stagedCount++;
      addRow({
        agentName: String(doc.agentName ?? ''),
        title: String(doc.title ?? ''),
        ...(doc.sourcePath != null ? { sourcePath: String(doc.sourcePath) } : {}),
        status: 'staged',
        ...(doc.updatedAt != null ? { updatedAt: doc.updatedAt as Date } : {}),
      });
    } else if (status === 'consumed_into_proposal') {
      consumedIntoProposalCount++;
      addRow({
        agentName: String(doc.agentName ?? ''),
        title: String(doc.title ?? ''),
        ...(doc.sourcePath != null ? { sourcePath: String(doc.sourcePath) } : {}),
        status: 'consumed_into_proposal',
        ...(doc.updatedAt != null ? { updatedAt: doc.updatedAt as Date } : {}),
      });
    } else if (status === 'proposed' || status === 'consumed') {
      // Assembled proposal doc — unpack mappings[]
      if (status === 'proposed') activeProposalCount++;
      if (Array.isArray(doc.mappings)) {
        for (const mapping of doc.mappings as Record<string, unknown>[]) {
          const rowStatus: MandatoryMappingRowStatus =
            status === 'consumed' ? 'consumed_into_proposal' : 'staged';
          addRow({
            agentName: String(mapping.agentName ?? ''),
            title: String(mapping.title ?? ''),
            ...(mapping.sourcePath != null ? { sourcePath: String(mapping.sourcePath) } : {}),
            status: rowStatus,
            ...(doc.updatedAt != null ? { updatedAt: doc.updatedAt as Date } : {}),
          });
        }
      }
    }
  }

  // Process saved mapping docs (enabled=true, stagedBySetupRunId matches)
  for (const doc of savedDocs) {
    addRow({
      agentName: String(doc.agentName ?? ''),
      title: String(doc.title ?? ''),
      ...(doc.sourcePath != null ? { sourcePath: String(doc.sourcePath) } : {}),
      status: 'saved',
      ...(doc.updatedAt != null ? { updatedAt: doc.updatedAt as Date } : {}),
    });
  }

  // Process deactivated mapping docs (enabled=false, deactivatedByRunId matches)
  for (const doc of deactivatedDocs) {
    addRow({
      agentName: String(doc.agentName ?? ''),
      title: String(doc.title ?? ''),
      ...(doc.sourcePath != null ? { sourcePath: String(doc.sourcePath) } : {}),
      status: 'deactivated',
      ...(doc.deactivationReason != null ? { reason: String(doc.deactivationReason) } : {}),
      ...(doc.updatedAt != null ? { updatedAt: doc.updatedAt as Date } : {}),
    });
  }

  // Add synthetic 'missing' rows for agents in affectedAgentNames with no existing rows
  const agentsWithRows = new Set<string>();
  for (const row of rowMap.values()) {
    agentsWithRows.add(row.agentName);
  }
  for (const agentName of affectedAgentNames) {
    if (!agentsWithRows.has(agentName)) {
      const key = `${agentName}::__missing__::`;
      rowMap.set(key, {
        agentName,
        title: '',
        status: 'missing',
        reason: `No mandatory mapping row found for agent '${agentName}' in this setup run`,
      });
    }
  }

  const rows = Array.from(rowMap.values())
    .sort((a, b) => {
      const nameCmp = a.agentName.localeCompare(b.agentName);
      if (nameCmp !== 0) return nameCmp;
      return (STATUS_PRIORITY[b.status] ?? 0) - (STATUS_PRIORITY[a.status] ?? 0);
    })
    .slice(0, 200);

  return { stagedCount, consumedIntoProposalCount, activeProposalCount, rows };
}

export class RepoContextSetupService {
  private setupRuns;
  private proposals;
  private repos;
  private agents;
  private mcpServers;
  private executions;
  // C9: lazily constructed singletons — lazy (not eager) so test suites that
  // mock these classes per-test still observe construction at first use.
  private _alerts?: AlertService;
  private _executionService?: ExecutionService;

  constructor(
    private db: Db,
    private curation: RepoContextCurationService,
    private mandatory: RepoMandatoryContextService,
    private cognee: CogneeMemoryService,
    private spawnAgentFn: (args: SpawnArgs, db: Db) => Promise<{ execution_id: string }>,
  ) {
    this.setupRuns = db.collection<RepoContextSetupRun>(SETUP_RUNS_COLLECTION);
    this.proposals = db.collection(PROPOSALS_COLLECTION);
    this.repos = db.collection('repos');
    this.agents = db.collection('agents');
    this.mcpServers = db.collection('mcp_servers');
    this.executions = db.collection('executions');
  }

  private get alerts(): AlertService {
    this._alerts ??= new AlertService(this.db);
    return this._alerts;
  }

  private get executionService(): ExecutionService {
    this._executionService ??= new ExecutionService(this.db);
    return this._executionService;
  }

  /** Factory for boot reconciliation — uses minimal deps. */
  static async createForBoot(db: Db): Promise<RepoContextSetupService> {
    const { RepoContextCurationService } = await import('../curation/repo-context-curation.service.js');
    const { RepoMandatoryContextService } = await import('../mandatory/repo-mandatory-context.service.js');
    const { CogneeMemoryService } = await import('../cognee/cognee-memory.service.js');
    const { executeChatTool } = await import('../../chat-tools.js');
    const spawnFn = (args: SpawnArgs, innerDb: Db) =>
      executeChatTool('spawn_agent', args as Record<string, unknown>, innerDb).then((r) => ({ execution_id: String(r.execution_id ?? '') }));
    return new RepoContextSetupService(
      db,
      new RepoContextCurationService(db),
      new RepoMandatoryContextService(db),
      new CogneeMemoryService(db),
      spawnFn,
    );
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async startOrReturn(
    repoId: string,
    options: RepoContextSetupRun['options'] = {},
    requestedBy?: string,
    source: RepoContextSetupRun['source'] = 'api',
  ): Promise<{ setupRun: RepoContextSetupRun; deduped: boolean }> {
    // Check for active run first (soft dedup check — DB also has partial unique index)
    const activeRun = await this.setupRuns.findOne({
      repoId,
      status: { $in: ['running', 'partial'] },
    });
    if (activeRun) {
      logger.info('repo-context-setup:dedupe', { setupRunId: activeRun.setupRunId, repoId });
      return { setupRun: activeRun, deduped: true };
    }

    // Validate cleanRebuildCognee + skipCognee contradiction
    if (options.cleanRebuildCognee && options.skipCognee) {
      throw Object.assign(new Error('cleanRebuildCognee and skipCognee are contradictory'), { code: 'INVALID_OPTIONS', statusCode: 400 });
    }

    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo) throw Object.assign(new Error('Repo not found'), { code: 'REPO_NOT_FOUND', statusCode: 404 });

    // Preflight
    const preflight = await this.preflight(repo, options);
    if (!preflight.ok) {
      const firstHard = preflight.failed.find((f) => f.hard);
      if (firstHard) {
        throw Object.assign(new Error(firstHard.message), { code: firstHard.code, statusCode: firstHard.code === 'INVALID_REPO_PATH' ? 400 : 409 });
      }
    }

    const now = new Date();
    const branch = resolveDefaultBranchName(repo as Record<string, unknown>);
    const setupRunId = randomUUID();
    const initialPhases: RepoContextSetupRun['phases'] = {
      preflight: {
        status: 'completed',
        startedAt: now,
        completedAt: now,
        diagnostics: preflight.diagnostics,
      },
      curation: { status: 'pending' },
      mandatoryMapping: { status: 'pending' },
      contextRefresh: preflight.skipRefresh
        ? { status: 'skipped', message: 'Cognee is disabled', diagnostics: [{ code: 'cognee_disabled', severity: 'info' }] }
        : options.skipCognee
          ? { status: 'skipped', message: 'Skipped by user request', diagnostics: [{ code: 'cognee_skipped_by_user', severity: 'info' }] }
          : { status: 'pending' },
    };

    const run: RepoContextSetupRun = {
      setupRunId,
      repoId,
      repoName: String(repo.name ?? ''),
      repoPath: String(repo.path ?? ''),
      branch,
      status: 'running',
      isActive: true,
      currentPhase: 'curation',
      requestedBy,
      requestedAt: now,
      source,
      options,
      phases: initialPhases,
      diagnostics: [],
      resumeCount: 0,
      childExecutionIds: [],
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.setupRuns.insertOne(run as never);
    } catch (err: unknown) {
      // Partial unique index race — another request won
      if ((err as { code?: number }).code === 11000) {
        const existing = await this.setupRuns.findOne({ repoId, status: { $in: ['running', 'partial'] } });
        if (existing) return { setupRun: existing, deduped: true };
      }
      throw err;
    }

    logger.info('repo-context-setup:start', { setupRunId, repoId, source, options });

    // Fire runPhases in background — do NOT await
    this.runPhases(run).catch((err: unknown) => {
      logger.error('[repo-context-setup] runPhases crashed', { setupRunId, error: (err as Error).message });
    });

    return { setupRun: run, deduped: false };
  }

  async getActiveOrLatest(repoId: string): Promise<{ active: boolean; setupRun: RepoContextSetupRun | null; label: string }> {
    const active = await this.setupRuns.findOne(
      { repoId, status: { $in: ['running', 'partial'] } },
      { sort: { createdAt: -1 } },
    );
    if (active) {
      const cogneeStatus = await this.cognee.getStatus(repoId).catch(() => null);
      const enriched = cogneeStatus
        ? { ...active, phases: { ...active.phases, contextRefresh: { ...active.phases.contextRefresh, cogneeStatus: cogneeStatus.status, cogneeStage: cogneeStatus.stage, cogneeMessage: cogneeStatus.message } } }
        : active;
      const label = await this.computeLabel(repoId);
      return { active: true, setupRun: enriched as RepoContextSetupRun, label };
    }
    const latest = await this.setupRuns.findOne({ repoId }, { sort: { createdAt: -1 } });
    const label = await this.computeLabel(repoId);
    return { active: false, setupRun: latest ?? null, label };
  }

  async get(setupRunId: string): Promise<SetupDetailResponse> {
    const run = await this.setupRuns.findOne({ setupRunId });
    if (!run) throw Object.assign(new Error('Setup run not found'), { code: 'RUN_NOT_FOUND', statusCode: 404 });

    const curationRunId = run.phases.curation.curationRunId;
    const repoId = run.repoId;

    const [
      curationProfile,
      cogneeStatus,
      allMappings,
      curationStageStatus,
      curationFileFailuresRaw,
      proposalDocs,
      savedMappingDocs,
      deactivatedMappingDocs,
    ] = await Promise.all([
      // Existing queries
      this.curation.getLatest(repoId).catch(() => null),
      this.cognee.getStatus(repoId).catch(() => null),
      this.mandatory.list(repoId, { enabled: 'all' as const }).catch(() => []),
      // Bug fix: use getRepoContextCurationStageStatus instead of raw findOne on repo_context_curation_runs
      curationRunId
        ? getRepoContextCurationStageStatus(this.db, curationRunId).catch((err) => {
            logger.warn('repo-context-setup:get:curation-stage-status-warn', { setupRunId, error: (err as Error).message });
            return null as CurationStageStatus | null;
          })
        : Promise.resolve(null as CurationStageStatus | null),
      // New: curation file failures (capped at 20 by DB + app-level slice)
      curationRunId
        ? (this.db.collection('repo_context_curation_stage_file_statuses')
            .find({ runId: curationRunId, status: 'failed' })
            .sort({ updatedAt: -1 })
            .limit(20)
            .toArray() as Promise<Record<string, unknown>[]>)
            .catch((): Record<string, unknown>[] => [])
        : Promise.resolve([] as Record<string, unknown>[]),
      // New: mandatory proposals for this setup run
      (this.proposals
        .find({ setupRunId })
        .toArray() as Promise<Record<string, unknown>[]>)
        .catch((err): Record<string, unknown>[] => {
          logger.warn('repo-context-setup:get:mandatory-detail-warn', { setupRunId, error: (err as Error).message });
          return [];
        }),
      // New: saved mandatory mappings (enabled=true, stagedBySetupRunId=setupRunId)
      (this.db.collection('repo_mandatory_context_mappings')
        .find({ repoId, stagedBySetupRunId: setupRunId, enabled: true })
        .toArray() as Promise<Record<string, unknown>[]>)
        .catch((): Record<string, unknown>[] => []),
      // New: deactivated mandatory mappings (enabled=false, deactivatedByRunId=setupRunId)
      (this.db.collection('repo_mandatory_context_mappings')
        .find({ repoId, deactivatedByRunId: setupRunId, enabled: false })
        .toArray() as Promise<Record<string, unknown>[]>)
        .catch((): Record<string, unknown>[] => []),
    ]);

    const curationFileFailures: CurationFileFailure[] = (curationFileFailuresRaw ?? [])
      .slice(0, 20)
      .map((r) => ({
        path: String(r.path ?? ''),
        ...(r.sourceHash != null ? { sourceHash: String(r.sourceHash) } : {}),
        status: String(r.status ?? 'failed'),
        ...(r.reason != null ? { reason: String(r.reason) } : {}),
        ...(r.updatedAt != null ? { updatedAt: r.updatedAt as Date } : {}),
      }));

    const affectedAgentNames = Array.isArray(run.phases.mandatoryMapping?.affectedAgentNames)
      ? (run.phases.mandatoryMapping.affectedAgentNames as string[])
      : [];

    const mandatoryProposalDetail = buildMandatoryProposalDetail(
      proposalDocs ?? [],
      savedMappingDocs ?? [],
      deactivatedMappingDocs ?? [],
      affectedAgentNames,
    );

    logger.info('repo-context-setup:get:detail-enriched', {
      setupRunId,
      curationFileFailureCount: curationFileFailures.length,
      mandatoryProposalRowCount: mandatoryProposalDetail?.rows.length ?? 0,
    });

    return {
      setupRun: run,
      curationProfile: curationProfile as Record<string, unknown> | null,
      curationStageStatus,
      curationFileFailures,
      mandatoryMappings: {
        activeCount: (allMappings ?? []).filter((m) => m.enabled).length,
        inactiveCount: (allMappings ?? []).filter((m) => !m.enabled).length,
      },
      mandatoryProposalDetail,
      cogneeStatus: cogneeStatus as Record<string, unknown> | null,
    };
  }

  async listHistory(repoId: string, limit = 10): Promise<RepoContextSetupRun[]> {
    return this.setupRuns
      .find({ repoId }, { sort: { createdAt: -1 }, limit })
      .toArray();
  }

  async cancel(setupRunId: string): Promise<RepoContextSetupRun> {
    const run = await this.setupRuns.findOne({ setupRunId });
    if (!run) throw Object.assign(new Error('Setup run not found'), { code: 'RUN_NOT_FOUND', statusCode: 404 });
    if (!['running', 'partial'].includes(run.status)) {
      throw Object.assign(new Error('Run is not cancellable'), { code: 'RUN_NOT_CANCELLABLE', statusCode: 409 });
    }

    // Cancel child executions (best effort)
    const cancelledIds: string[] = [];
    for (const execId of run.childExecutionIds ?? []) {
      await this.executionService.cancel(execId).catch(() => undefined);
      cancelledIds.push(execId);
    }

    // Stop cognee refresh if running
    if (run.phases.contextRefresh?.status === 'running') {
      await this.cognee.stopRefreshRepo(run.repoId).catch(() => undefined);
    }

    logger.info('repo-context-setup:cancel', { setupRunId, atPhase: run.currentPhase, cancelledExecutions: cancelledIds });

    return this.patch(setupRunId, {
      status: 'cancelled',
      completedAt: new Date(),
    });
  }

  async resume(setupRunId: string): Promise<RepoContextSetupRun> {
    const run = await this.setupRuns.findOne({ setupRunId });
    if (!run) throw Object.assign(new Error('Setup run not found'), { code: 'RUN_NOT_FOUND', statusCode: 404 });
    if (['running', 'completed'].includes(run.status)) {
      throw Object.assign(new Error('Run is not resumable'), { code: 'RUN_NOT_RESUMABLE', statusCode: 409 });
    }

    // Fix J: detect whether the current phase already has a live child execution.
    // If so, reattach instead of spawning a brand-new agent — the original child
    // may still be running (e.g. the orchestrator timed out but the curator was
    // still curating files as a "zombie" and will eventually finish).
    let expectChildExecution: string | undefined;
    const { currentPhase } = run;
    const reattachCandidates: Array<{ phase: SetupPhase; execId?: string }> = [
      { phase: 'curation', execId: run.phases.curation.curationExecutionId },
      { phase: 'mandatory_mapping', execId: run.phases.mandatoryMapping.mandatoryExecutionId },
    ];
    for (const { phase, execId } of reattachCandidates) {
      if (currentPhase !== phase || !execId) continue;
      const exec = await this.executions.findOne({ id: execId }, { projection: { status: 1 } });
      if (exec && isLiveExecutionStatus(String(exec.status ?? ''))) {
        expectChildExecution = execId;
      }
    }

    // When reattaching, reset the phase status from 'failed' back to 'running'
    // so the run record is truthful while we wait for the child to finish.
    if (expectChildExecution) {
      const phaseStatusField = `phases.${phaseField(currentPhase)}.status`;
      await this.setupRuns.updateOne(
        { setupRunId },
        { $set: { [phaseStatusField]: 'running', updatedAt: new Date() } },
      );
    }

    // M4: clear any stale failure message so the card doesn't show old error text
    // while a fresh resume is running.
    const updated = await this.patch(setupRunId, {
      status: 'running',
      resumeCount: (run.resumeCount ?? 0) + 1,
      message: 'Resuming setup…',
    });

    logger.info('repo-context-setup:resume', { setupRunId, fromPhase: run.currentPhase, resumeCount: updated.resumeCount, reattachExecId: expectChildExecution });

    // Fire continuation in background
    this.runPhases(updated, { resume: true, ...(expectChildExecution ? { expectChildExecution } : {}) }).catch((err: unknown) => {
      logger.error('[repo-context-setup] resume runPhases crashed', { setupRunId, error: (err as Error).message });
    });

    return updated;
  }

  async reconcileSetupRuns(): Promise<void> {
    const runs = await this.setupRuns.find({ status: { $in: ['running', 'partial'] } }).toArray();
    logger.info('[repo-context-setup] Boot reconciliation', { count: runs.length, component: 'repo-context-setup' });

    for (const run of runs) {
      try {
        await this.reconcileRun(run);
      } catch (err) {
        logger.error('[repo-context-setup] reconcile error for run', { setupRunId: run.setupRunId, error: (err as Error).message, component: 'repo-context-setup' });
      }
    }
  }

  // ─── Private: Reconciliation ───────────────────────────────────────────────

  private async reconcileRun(run: RepoContextSetupRun): Promise<void> {
    const { setupRunId, repoId, currentPhase, childExecutionIds = [] } = run;

    // Rule 7: idempotent — use findOneAndUpdate with phase-status guards

    // Check timeout (rule 5 supplement — orphan detection)
    const age = Date.now() - new Date(run.updatedAt).getTime();
    if (age > SETUP_TIMEOUT_MS) {
      logger.warn('repo-context-setup:reconcile', { setupRunId, decision: 'timeout_stopped' });
      await this.setupRuns.findOneAndUpdate(
        { setupRunId, status: { $in: ['running', 'partial'] } },
        { $set: { status: 'stopped', isActive: false, updatedAt: new Date(), message: 'Timed out during server restart', diagnostics: [...(run.diagnostics ?? []), { code: 'server_restart', severity: 'warning', message: 'Run timed out' }] } },
      );
      await this.alerts.create({ title: 'Repo context setup timed out', message: `Setup run ${setupRunId} exceeded the ${SETUP_TIMEOUT_MS}ms timeout and was stopped. Resume from the context management page.`, severity: 'warning', category: 'system', link: `/repos/${repoId}/context-management` }).catch(() => {});
      return;
    }

    // Get the most recent child execution status
    const lastChildExecId = childExecutionIds[childExecutionIds.length - 1];
    const lastChildExec = lastChildExecId
      ? await this.executions.findOne({ id: lastChildExecId }, { projection: { status: 1 } })
      : null;
    const lastChildStatus = lastChildExec ? String(lastChildExec.status ?? '') : null;

    // Cognee status
    const cogneeStatus = await this.cognee.getStatus(repoId).catch(() => null);

    // Rule 3: child exec still running/queued → ReattachLoop
    if (lastChildStatus && isLiveExecutionStatus(lastChildStatus)) {
      logger.info('repo-context-setup:reconcile', { setupRunId, decision: 'reattach', phase: currentPhase });
      this.runPhases(run, { resume: true, expectChildExecution: lastChildExecId }).catch(() => {});
      return;
    }

    // Rule 5: cognee refresh still in flight
    if ((currentPhase === 'context_refresh' || run.phases.contextRefresh.status === 'running') && cogneeStatus?.workerActive) {
      logger.info('repo-context-setup:reconcile', { setupRunId, decision: 'watch_cognee' });
      this.watchCogneeLoop(run).catch(() => {});
      return;
    }

    // Rule 5b: cognee refresh terminal but setupRun still 'running'
    if (currentPhase === 'context_refresh' && !cogneeStatus?.workerActive && cogneeStatus?.status && !['pending', 'running'].includes(cogneeStatus.status)) {
      logger.info('repo-context-setup:reconcile', { setupRunId, decision: 'collapse_cognee', cogneeStatus: cogneeStatus.status, finalStatus: cogneeStatus.status === 'completed' ? 'completed' : 'partial' });
      await this.finalizeRunFromCogneeStatus(setupRunId, cogneeStatus.status);
      return;
    }

    // Rule 4: child exec terminal — ContinueLoop
    if (lastChildStatus && ['completed', 'failed', 'cancelled'].includes(lastChildStatus)) {
      logger.info('repo-context-setup:reconcile', { setupRunId, decision: 'continue', phase: currentPhase });
      this.runPhases(run, { resume: true }).catch(() => {});
      return;
    }

    // Rule 6: true orphan — no live signals
    logger.info('repo-context-setup:reconcile', { setupRunId, decision: 'stopped_orphan' });
    await this.setupRuns.findOneAndUpdate(
      { setupRunId, status: { $in: ['running', 'partial'] } },
      { $set: { status: 'stopped', isActive: false, updatedAt: new Date(), diagnostics: [...(run.diagnostics ?? []), { code: 'server_restart', severity: 'warning', message: 'Run orphaned by server restart' }] } },
    );
  }

  private async watchCogneeLoop(run: RepoContextSetupRun): Promise<void> {
    const { setupRunId, repoId } = run;
    const deadline = Date.now() + SETUP_TIMEOUT_MS;
    let delay = POLL_INTERVAL_MS;
    while (Date.now() < deadline) {
      delay = await sleepWithBackoff(delay);
      const status = await this.cognee.getStatus(repoId).catch(() => null);
      if (!status || status.workerActive) continue;
      if (['completed', 'failed', 'partial', 'stopped'].includes(status.status)) {
        await this.finalizeRunFromCogneeStatus(setupRunId, status.status);
        return;
      }
    }
    await this.setupRuns.findOneAndUpdate(
      { setupRunId, status: { $in: ['running', 'partial'] } },
      { $set: { status: 'stopped', isActive: false, updatedAt: new Date() } },
    );
  }

  /**
   * C1: single "terminal Cognee status → run finalization" rule, shared by
   * reconcileRun (rule 5b), watchCogneeLoop, and the runPhases context_refresh
   * failure path. Maps the terminal cognee status to a final run status
   * ('completed'/'partial') and persists a consistent field set including
   * phases.contextRefresh.cogneeStatus. With `resumable: true` the run is
   * forced to 'partial' and kept on context_refresh (no run completedAt) so
   * it stays resumable.
   */
  private async finalizeRunFromCogneeStatus(
    setupRunId: string,
    cogneeStatus: string | undefined,
    opts: { resumable?: boolean; message?: string; phaseMessage?: string } = {},
  ): Promise<void> {
    const now = new Date();
    const finalStatus: SetupStatus = !opts.resumable && cogneeStatus === 'completed' ? 'completed' : 'partial';
    const $set: Record<string, unknown> = {
      status: finalStatus,
      isActive: isActiveSetupStatus(finalStatus),
      currentPhase: opts.resumable ? 'context_refresh' : 'completed',
      updatedAt: now,
      'phases.contextRefresh.status': finalStatus === 'completed' ? 'completed' : 'failed',
      'phases.contextRefresh.completedAt': now,
    };
    if (!opts.resumable) $set.completedAt = now;
    if (cogneeStatus) $set['phases.contextRefresh.cogneeStatus'] = cogneeStatus;
    if (opts.message) $set.message = opts.message;
    if (opts.phaseMessage) $set['phases.contextRefresh.message'] = opts.phaseMessage;
    await this.setupRuns.findOneAndUpdate(
      { setupRunId, status: { $in: ['running', 'partial'] } },
      { $set },
    );
  }

  // ─── Private: Phase execution ──────────────────────────────────────────────

  private async runPhases(
    run: RepoContextSetupRun,
    opts: { resume?: boolean; expectChildExecution?: string } = {},
  ): Promise<void> {
    const { setupRunId } = run;
    const startTime = Date.now();
    try {
      let current = await this.setupRuns.findOne({ setupRunId }) ?? run;

      // Execute phases in order, skipping already-completed ones
      const phaseOrder: Array<SetupPhase> = ['curation', 'mandatory_mapping', 'context_refresh'];
      for (const phase of phaseOrder) {
        current = await this.setupRuns.findOne({ setupRunId }) ?? current;
        if (current.status === 'cancelled') return;
        const phaseStatus = this.getPhaseStatus(current, phase);
        if (phaseStatus === 'completed' || phaseStatus === 'skipped') continue;

        await this.setPhaseRunning(setupRunId, phase);
        current = await this.setupRuns.findOne({ setupRunId }) ?? current;

        try {
          if (phase === 'curation') await this.runCurationPhase(current, opts);
          else if (phase === 'mandatory_mapping') await this.runMandatoryPhase(current, opts);
          else if (phase === 'context_refresh') await this.runRefreshPhase(current);

          await this.setPhaseCompleted(setupRunId, phase);
          current = await this.setupRuns.findOne({ setupRunId }) ?? current;
        } catch (err: unknown) {
          const msg = (err as Error).message;
          logger.error(`repo-context-setup:phase`, { setupRunId, phase, status: 'failed', durationMs: Date.now() - startTime, error: msg });

          // Fix A: partial Cognee refresh → run status 'partial', not 'failed'
          if (phase === 'context_refresh') {
            const cogneeStatus = await this.cognee.getStatus(current.repoId).catch(() => null);
            await this.finalizeRunFromCogneeStatus(setupRunId, cogneeStatus?.status, {
              resumable: true,
              message: 'Graph refresh partial/failed — resumable',
              phaseMessage: msg,
            });
            await this.alerts.create({
              title: 'Repo context graph refresh partial',
              message: msg,
              severity: 'warning',
              category: 'system',
              link: `/repos/${current.repoId}/context-management`,
            }).catch(() => {});
            return;
          }

          // Other phases: fail the run
          await this.setPhaseStatus(setupRunId, phase, 'failed', msg);
          await this.patch(setupRunId, {
            status: 'failed',
            message: `Phase ${phase} failed: ${msg}`,
          });
          await this.alerts.create({ title: `Repo context setup failed in ${phase}`, message: msg, severity: 'error', category: 'system', link: `/repos/${current.repoId}/context-management` }).catch(() => {});
          return;
        }
      }

      // All phases done (or skipped) — a context_refresh failure returns early
      // in the catch above, so reaching this point always means a completed run.
      const durationMs = Date.now() - startTime;
      logger.info('repo-context-setup:complete', { setupRunId, status: 'completed', durationMs });
      await this.patch(setupRunId, {
        status: 'completed',
        currentPhase: 'completed',
        completedAt: new Date(),
        message: 'Context setup completed successfully',
      });
    } catch (err: unknown) {
      logger.error('[repo-context-setup] runPhases unexpected error', { setupRunId, error: (err as Error).message });
      await this.patch(setupRunId, { status: 'failed', message: (err as Error).message }).catch(() => {});
    }
  }

  private async runCurationPhase(run: RepoContextSetupRun, opts: { expectChildExecution?: string } = {}): Promise<void> {
    const { setupRunId, repoId } = run;
    const phaseStart = Date.now();

    // Reattach path: existing child exec is (or was) running — poll to terminal then consume output
    if (opts.expectChildExecution) {
      const runId = run.phases.curation.curationRunId ?? '';
      await this.pollCurator(opts.expectChildExecution, runId);
      if (runId) {
        await this.consumeCurationOutput(setupRunId, runId, phaseStart);
      } else {
        // No runId stored — cannot consume stage, mark phase completed without promotion
        const durationMs = Date.now() - phaseStart;
        logger.warn('repo-context-setup:phase', { setupRunId, phase: 'curation', status: 'completed_no_runId', durationMs });
        await this.setPhaseCompleted(setupRunId, 'curation');
      }
      return;
    }

    // Normal path: prepare, spawn, poll, consume
    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });

    // G2: best-effort fetch before prepare so the inventory snapshot is as fresh as possible
    const repoPathForFetch = String(repo?.path ?? run.repoPath ?? '');
    if (repoPathForFetch) {
      const defaultBranch = resolveDefaultBranchName((repo ?? {}) as Record<string, unknown>);
      const effectiveBranch = run.branch ?? defaultBranch;
      await fetchBranch(repoPathForFetch, effectiveBranch);
    }

    const prepareBody: Record<string, unknown> = {
      repoId,
      // Fix H: suppress the phantom executions row that createRunningProfile would insert;
      // the real spawned-agent execution is attached below via attachExecutionToProfile.
      skip_execution_record: true,
      ...(run.options.scope ? { scope: run.options.scope } : {}),
      ...(run.options.forceCuration ? { force: true } : {}),
    };
    if (run.phases.curation.curationRunId) {
      prepareBody.run_id = run.phases.curation.curationRunId;
    }

    const prepareResult = await this.curation.prepareForCoordinator(prepareBody) as Record<string, unknown>;
    const runId = String(prepareResult.run_id ?? '');
    const profileId = String(prepareResult.profile_id ?? '');

    // M4: persist unchanged/changed counts from prepare response immediately so
    // the card shows honest "reused N · promoted M" numbers even for hash-stable runs.
    const unchangedReused = prepareResult.unchanged_reused_entries;
    const unchangedCount = Array.isArray(unchangedReused) ? unchangedReused.length : 0;
    const changedCount = typeof prepareResult.files_to_curate_count === 'number' ? prepareResult.files_to_curate_count : 0;

    // G1: propagate snapshot stale signal to curation phase diagnostics — NON-FATAL
    const prepareSnapshot = prepareResult.snapshot as Record<string, unknown> | undefined;
    if (prepareSnapshot && prepareSnapshot.fresh === false) {
      await this.setupRuns.updateOne(
        { setupRunId },
        {
          $push: {
            'phases.curation.diagnostics': {
              code: 'inventory_snapshot_stale',
              severity: 'warning',
              message: `Inventory snapshot may be stale (ref=${String(prepareSnapshot.ref ?? 'unknown')}). Some recently committed files may be missed.`,
            },
          } as never,
          $set: { updatedAt: new Date() },
        },
      );
    }

    await this.setupRuns.updateOne(
      { setupRunId },
      {
        $set: {
          'phases.curation.curationRunId': runId,
          'phases.curation.curationProfileId': profileId,
          'phases.curation.unchangedCount': unchangedCount,
          'phases.curation.changedCount': changedCount,
          updatedAt: new Date(),
        },
      },
    );

    const prompt = buildCuratorPrompt({ setupRunId, repoId, repoPath: String(repo?.path ?? run.repoPath), runId, profileId, branch: run.branch });
    const spawnResult = await this.spawnAgentFn({
      agent_name: 'repo-context-curator',
      prompt,
      repo_path: run.repoPath,
      root_execution_id: setupRunId,
      parent_caller: `repo-context-setup:${setupRunId}`,
    }, this.db);
    const execId = spawnResult.execution_id;
    await this.appendChildExecutionId(setupRunId, execId);
    await this.setupRuns.updateOne(
      { setupRunId },
      { $set: { 'phases.curation.curationExecutionId': execId, updatedAt: new Date() } },
    );

    // Fix H: attach the real spawned execution id to the profile and stage-run row
    // so that profile→execution UI links, isActiveRunningProfile, and promoteStageFromAgent
    // all see the correct execution id instead of a phantom row.
    await this.curation.attachExecutionToProfile(profileId, runId, execId);

    await this.pollCurator(execId, runId);
    await this.consumeCurationOutput(setupRunId, runId, phaseStart);
  }

  /**
   * C5: polls a curator child execution to terminal status — with stall
   * detection via staging progress (Fix B+K) — and throws PHASE_FAILED_CURATION
   * when the execution failed or was cancelled. Shared by the reattach and
   * normal paths of runCurationPhase.
   */
  private async pollCurator(executionId: string, runId: string): Promise<void> {
    // Fix K: use curation stage file status count+timestamp as the progress fingerprint
    const curationProbe = runId ? this.makeCurationProbe(runId) : undefined;
    const terminalStatus = await this.pollExecution(executionId, curationProbe ? { progressProbe: curationProbe } : undefined);
    if (terminalStatus === 'failed' || terminalStatus === 'cancelled') {
      throw new Error(`PHASE_FAILED_CURATION: curator execution ${executionId} ${terminalStatus}`);
    }
  }

  private async consumeCurationOutput(setupRunId: string, runId: string, phaseStartMs: number): Promise<void> {
    // Fix F: check if curator agent already promoted the stage-run
    const stageRunDoc = await this.db.collection('repo_context_curation_runs').findOne({ runId }).catch(() => null);
    if (stageRunDoc && String(stageRunDoc.status ?? '') === 'promoted') {
      // Agent already promoted — harvest counts from stage status
      let stageStatus: { validEntries?: number } = {};
      try {
        const s = await getRepoContextCurationStageStatus(this.db, runId);
        stageStatus = { validEntries: s.validEntries };
      } catch (_err) { /* stage may not have full data, use stageRunDoc */ }

      const promotedCount = stageStatus.validEntries ?? 0;
      const durationMs = Date.now() - phaseStartMs;
      logger.info('repo-context-setup:phase', { setupRunId, phase: 'curation', status: 'already_promoted', durationMs, promotedCount });

      await this.setCurationPromoted(setupRunId, promotedCount);
      return;
    }

    // Stage-run not yet promoted — compute stage status
    let stageStatus: { promotable?: boolean; retryFiles?: unknown[]; expectedFiles?: number; validEntries?: number } = {};
    try {
      const s = await getRepoContextCurationStageStatus(this.db, runId);
      stageStatus = {
        promotable: s.promotable,
        retryFiles: s.retryFiles,
        expectedFiles: s.expectedFiles,
        validEntries: s.validEntries,
      };
    } catch (_err) { /* may not have staged */ }

    const promotable = stageStatus.promotable === true;
    const retryFiles = Array.isArray(stageStatus.retryFiles) ? stageStatus.retryFiles : [];
    const expectedFileCount = typeof stageStatus.expectedFiles === 'number' ? stageStatus.expectedFiles : 0;

    if (promotable) {
      // Fix F: call promoteStageFromAgent (full promotion incl. entry writes) instead of markRepoContextCurationRunPromoted
      const result = await this.curation.promoteStageFromAgent({ run_id: runId }) as Record<string, unknown>;
      const promotedCount = (result.promoted_entries as number | undefined) ?? 0;
      const durationMs = Date.now() - phaseStartMs;
      logger.info('repo-context-setup:phase', { setupRunId, phase: 'curation', status: 'completed', durationMs, promotedCount });

      await this.setCurationPromoted(setupRunId, promotedCount);
    } else if (expectedFileCount === 0) {
      // Fix B (REQ-018): genuinely empty inventory — complete with warning, promotedCount 0
      const durationMs = Date.now() - phaseStartMs;
      logger.info('repo-context-setup:phase', { setupRunId, phase: 'curation', status: 'completed_empty', durationMs });
      await this.setupRuns.updateOne(
        { setupRunId },
        {
          $set: {
            'phases.curation.promotable': false,
            'phases.curation.promotedCount': 0,
            'phases.curation.retryCount': 0,
            updatedAt: new Date(),
          },
          // Q1: $push (not $set) so earlier diagnostics on the same phase —
          // e.g. inventory_snapshot_stale from prepare — are preserved.
          $push: {
            'phases.curation.diagnostics': { code: 'no_context_files', severity: 'warning', message: 'No context files found in repository' },
          } as never,
        },
      );
    } else {
      // Fix B (AC-005): retry files remain — fail so run is resumable
      const retryCount = retryFiles.length;
      throw new Error(`PHASE_FAILED_CURATION: ${retryCount} file(s) could not be staged (retryFiles: ${retryCount})`);
    }
  }

  /** C7: shared "curation stage promoted" phase update for consumeCurationOutput. */
  private async setCurationPromoted(setupRunId: string, promotedCount: number): Promise<void> {
    await this.setupRuns.updateOne(
      { setupRunId },
      {
        $set: {
          'phases.curation.promotable': true,
          'phases.curation.promotedCount': promotedCount,
          'phases.curation.retryCount': 0,
          updatedAt: new Date(),
        },
      },
    );
  }

  private async runMandatoryPhase(run: RepoContextSetupRun, opts: { expectChildExecution?: string } = {}): Promise<void> {
    const { setupRunId, repoId } = run;
    const phaseStart = Date.now();

    let execId: string;

    if (opts.expectChildExecution) {
      // Fix J: reattach to an existing live mapper execution — skip spawn.
      execId = opts.expectChildExecution;
      logger.info('repo-context-setup:phase', { setupRunId, phase: 'mandatory_mapping', decision: 'reattach', execId });
    } else {
      // Normal path: spawn mapper agent.
      // Continue-from-last-run: staged rows from a previous attempt are kept (NOT
      // deleted) and summarized into the prompt so the mapper only stages what is
      // missing or needs correction — upsert by key makes re-staging safe.
      const stagedRows = await this.proposals
        .find({ setupRunId, status: 'staged' })
        .toArray() as Array<{ agentName?: string; title?: string }>;
      let stagedSummary: string | undefined;
      if (stagedRows.length > 0) {
        stagedSummary = buildStagedSummary(stagedRows);
        logger.info('repo-context-setup:phase', { setupRunId, phase: 'mandatory_mapping', decision: 'resume_with_staged', stagedCount: stagedRows.length });
      }

      const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
      const prompt = buildMapperPrompt({ setupRunId, repoId, repoPath: String(repo?.path ?? run.repoPath), branch: run.branch, stagedSummary });
      const spawnResult = await this.spawnAgentFn({
        agent_name: 'repo-mandatory-context-mapper',
        prompt,
        repo_path: run.repoPath,
        root_execution_id: setupRunId,
        parent_caller: `repo-context-setup:${setupRunId}`,
      }, this.db);
      execId = spawnResult.execution_id;
      await this.appendChildExecutionId(setupRunId, execId);
      await this.setupRuns.updateOne(
        { setupRunId },
        { $set: { 'phases.mandatoryMapping.mandatoryExecutionId': execId, updatedAt: new Date() } },
      );
    }

    // Fix B+K: check terminal status of mapper exec with stall detection via proposal-collection
    // progress. countDocuments({setupRunId}) covers staged + proposed docs (both carry setupRunId);
    // the latest staged updatedAt is added so re-staging existing keys (count-stable upserts on the
    // resume path) still registers as progress.
    const mandatoryProbe = async (): Promise<string | number> => {
      const count = await this.proposals.countDocuments({ setupRunId });
      const latestStaged = await this.proposals.findOne(
        { setupRunId, status: 'staged' },
        { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
      );
      const ts = latestStaged?.updatedAt instanceof Date ? latestStaged.updatedAt.getTime() : 0;
      return `${count}:${ts}`;
    };
    const terminalStatus = await this.pollExecution(execId, { progressProbe: mandatoryProbe });
    if (terminalStatus === 'failed' || terminalStatus === 'cancelled') {
      throw new Error(`PHASE_FAILED_MANDATORY: mapper execution ${execId} ${terminalStatus}`);
    }

    // Look for proposal (same for both reattach and normal path)
    const proposal = await this.proposals.findOne({ setupRunId, status: 'proposed' }) as Record<string, unknown> | null;
    if (!proposal) {
      throw new Error('PHASE_FAILED_MANDATORY: no proposal found after mapper agent completed');
    }

    // replaceForRun
    const result = await this.mandatory.replaceForRun(repoId, {
      setupRunId,
      affectedAgentNames: Array.isArray(proposal.affectedAgentNames) ? (proposal.affectedAgentNames as string[]) : [],
      mappings: Array.isArray(proposal.mappings) ? (proposal.mappings as Array<{ agentName: string; sourcePath?: string; sourceHash?: string; title: string; content: string; reasoning?: string }>) : [],
    });

    // Mark proposal consumed — use status:'proposed' in the filter so this update
    // targets only the final assembled proposal doc and never touches staged rows
    // (staged rows have no proposalId; narrowing the filter is defense-in-depth).
    await this.proposals.updateOne(
      { proposalId: proposal.proposalId, status: 'proposed' },
      { $set: { status: 'consumed', consumedAt: new Date() } },
    );

    const durationMs = Date.now() - phaseStart;
    logger.info('repo-context-setup:phase', { setupRunId, phase: 'mandatory_mapping', status: 'completed', durationMs, savedMappingCount: result.saved, deactivatedMappingCount: result.deactivated });
    logger.info('repo-context-setup:mandatory-deactivate', { setupRunId, repoId, count: result.deactivated });

    await this.setupRuns.updateOne(
      { setupRunId },
      {
        $set: {
          'phases.mandatoryMapping.affectedAgentNames': Array.isArray(proposal.affectedAgentNames) ? proposal.affectedAgentNames : [],
          'phases.mandatoryMapping.savedMappingCount': result.saved,
          'phases.mandatoryMapping.deactivatedMappingCount': result.deactivated,
          updatedAt: new Date(),
        },
      },
    );
  }

  private async runRefreshPhase(run: RepoContextSetupRun): Promise<void> {
    const { setupRunId, repoId } = run;
    const phaseStart = Date.now();

    // Check if context refresh should be skipped (already set in phases by preflight)
    const currentRun = await this.setupRuns.findOne({ setupRunId }) ?? run;
    if (currentRun.phases.contextRefresh.status === 'skipped') {
      // Already marked skipped in initialPhases
      return;
    }

    // Check if skipCognee option set
    if (currentRun.options.skipCognee) {
      await this.setupRuns.updateOne(
        { setupRunId },
        { $set: { 'phases.contextRefresh.status': 'skipped', 'phases.contextRefresh.message': 'Skipped by user request', updatedAt: new Date() } },
      );
      return;
    }

    // Check if cognee is disabled (soft skip)
    if (!isCogneeContextEnabled()) {
      await this.setupRuns.updateOne(
        { setupRunId },
        { $set: { 'phases.contextRefresh.status': 'skipped', 'phases.contextRefresh.message': 'Cognee is disabled', updatedAt: new Date() } },
      );
      return;
    }

    const cleanRebuild = currentRun.options.cleanRebuildCognee === true;
    await this.cognee.scheduleRefreshRepo(repoId, { cleanRebuild });
    await this.setupRuns.updateOne(
      { setupRunId },
      { $set: { 'phases.contextRefresh.cogneeBuildMode': cleanRebuild ? 'clean_rebuild' : 'resume', 'phases.contextRefresh.startedAt': new Date(), updatedAt: new Date() } },
    );

    // Poll cognee until terminal
    const deadline = Date.now() + SETUP_TIMEOUT_MS;
    let delay = POLL_INTERVAL_MS;
    let lastStatus = '';
    while (Date.now() < deadline) {
      delay = await sleepWithBackoff(delay);
      const status = await this.cognee.getStatus(repoId).catch(() => null);
      if (!status) continue;
      lastStatus = status.status;
      if (['completed', 'failed', 'partial', 'stopped'].includes(status.status)) {
        const durationMs = Date.now() - phaseStart;
        logger.info('repo-context-setup:phase', { setupRunId, phase: 'context_refresh', status: status.status, durationMs });
        await this.setupRuns.updateOne(
          { setupRunId },
          { $set: { 'phases.contextRefresh.cogneeStatus': status.status, 'phases.contextRefresh.cogneeMessage': status.message, 'phases.contextRefresh.completedAt': new Date(), updatedAt: new Date() } },
        );
        if (status.status !== 'completed') {
          // Fix A: throw to let runPhases handle context_refresh specially → run becomes 'partial'
          throw new Error(`Cognee refresh ${status.status}: ${status.message ?? ''}`);
        }
        return;
      }
    }

    throw new Error(`Cognee refresh timed out (last status: ${lastStatus})`);
  }

  // ─── Private: Preflight ────────────────────────────────────────────────────

  private async preflight(repo: Record<string, unknown>, options: RepoContextSetupRun['options']): Promise<{
    ok: boolean;
    failed: Array<{ code: string; message: string; hard: boolean }>;
    diagnostics: Array<Record<string, unknown>>;
    skipRefresh: boolean;
  }> {
    const failed: Array<{ code: string; message: string; hard: boolean }> = [];
    const diagnostics: Array<Record<string, unknown>> = [];
    let skipRefresh = false;

    // 1. hard — repo path exists on disk
    const repoPath = typeof repo.path === 'string' ? repo.path : '';
    if (!repoPath || !existsSync(repoPath)) {
      failed.push({ code: 'INVALID_REPO_PATH', message: 'Repo path is missing or does not exist on disk', hard: true });
    }

    // 2. hard — context engine enabled
    if (!isContextEngineEnabled()) {
      failed.push({ code: 'CONTEXT_PROVIDER_DISABLED', message: 'Context provider is disabled. Set ALLEN_CONTEXT_PROVIDER to enable context engine flows.', hard: true });
    }

    // 3. conditional — Cognee availability
    if (options.cleanRebuildCognee && !isCogneeContextEnabled()) {
      failed.push({ code: 'COGNEE_DISABLED_BUT_REQUIRED', message: 'cleanRebuildCognee requires Cognee to be enabled, but Cognee is currently disabled', hard: true });
    } else if (!isCogneeContextEnabled()) {
      // soft skip
      skipRefresh = true;
      diagnostics.push({ code: 'cognee_disabled', severity: 'info', message: 'Cognee is disabled; context refresh phase will be skipped' });
    }

    // 4. hard — required agents exist (dev adaptation: exclude soft-deleted agents)
    const curator = await this.agents.findOne({ name: 'repo-context-curator', ...notDeletedFilter });
    const mapper = await this.agents.findOne({ name: 'repo-mandatory-context-mapper', ...notDeletedFilter });
    if (!curator || !mapper) {
      failed.push({ code: 'AGENT_MISSING', message: 'Required agents (repo-context-curator, repo-mandatory-context-mapper) are not registered', hard: true });
    }

    // 5. soft — required MCP tools available (informational only: emits an
    //    info diagnostic when tools cannot be verified; never hard-fails)
    if (failed.length === 0) {
      const requiredTools = [
        'save_repo_context_curation_stage',
        'prepare_repo_context_curation',
        'plan_repo_context_curation_assignments',
        'get_repo_context_curation_stage_status',
        'promote_repo_context_curation_stage',
        'save_repo_mandatory_context_mapping_proposal',
      ];
      const mcpServers = await this.mcpServers.find({ enabled: true, ownerId: null }).toArray();
      const toolNames = new Set<string>();
      for (const server of mcpServers) {
        if (Array.isArray(server.tools)) {
          for (const t of server.tools as string[]) toolNames.add(t);
        }
        if (Array.isArray(server.toolNames)) {
          for (const t of server.toolNames as string[]) toolNames.add(t);
        }
      }
      const missingTools = requiredTools.filter((t) => !toolNames.has(t));
      if (missingTools.length > 0) {
        // Warn but do NOT hard fail — tools may be registered differently
        diagnostics.push({ code: 'mcp_tool_check', severity: 'info', missingTools, message: 'Some MCP tools could not be verified in mcp_servers; continuing' });
      }
    }

    // 6. soft — check for active run (handled in startOrReturn before preflight)
    // This is the dedup check; already done above

    return {
      ok: failed.length === 0,
      failed,
      diagnostics,
      skipRefresh,
    };
  }

  // ─── Private: computeLabel ─────────────────────────────────────────────────

  async computeLabel(repoId: string): Promise<string> {
    const [active, lastRun, cogneeStatus, latestProfile] = await Promise.all([
      this.setupRuns.findOne({ repoId, status: { $in: ['running', 'partial'] } }),
      this.setupRuns.findOne({ repoId }, { sort: { createdAt: -1 } }),
      this.cognee.getStatus(repoId).catch(() => null),
      this.curation.getLatest(repoId).catch(() => null),
    ]);

    // Rule 1
    if (active && active.status === 'running') return 'view_progress';
    // Rule 2
    if (active && active.status === 'partial') return 'resume_setup';
    // Rule 3
    if (lastRun && (lastRun.status === 'failed' || lastRun.status === 'stopped')) return 'resume_setup';
    // Rule 4
    if (lastRun && lastRun.status === 'cancelled') return 'resume_setup';
    // Rule 5
    if (!lastRun || !lastRun.status) return 'prepare';
    // Rule 6
    if (cogneeStatus && (cogneeStatus as Record<string, unknown>).curatedContextStale === true) return 'refresh_stale_graph';
    // Rule 7 — check if committed changes since last run
    if (latestProfile) {
      const hasChanges = await this.hasCommittedChangesSinceLastRun(repoId, latestProfile as Record<string, unknown>).catch(() => false);
      if (hasChanges) return 'check_for_updates';
    }
    // Rule 8
    return 'check_for_updates';
  }

  private async hasCommittedChangesSinceLastRun(repoId: string, profile: Record<string, unknown>): Promise<boolean> {
    const lastHeadSha = typeof profile.headSha === 'string' ? profile.headSha : null;
    if (!lastHeadSha) return false;

    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo?.path) return false;

    const repoPath = String(repo.path);
    const branch = resolveDefaultBranchName(repo as Record<string, unknown>);

    // G2: throttled fetch — at most one fetch per repo per 5 min to avoid hammering git on UI polls
    const lastFetch = lastFetchByRepo.get(repoId) ?? 0;
    if (Date.now() - lastFetch >= FETCH_THROTTLE_MS) {
      await fetchBranch(repoPath, branch);
      lastFetchByRepo.set(repoId, Date.now());
    }

    // G2: use origin/<branch> so we see commits pushed since the last fetch
    const currentSha = await revParse(repoPath, `origin/${branch}`);
    return Boolean(currentSha) && currentSha !== lastHeadSha;
  }

  // ─── Private: helpers ──────────────────────────────────────────────────────

  private getPhaseStatus(run: RepoContextSetupRun, phase: SetupPhase): string {
    const field = PHASE_FIELDS[phase];
    return field ? run.phases[field].status : 'pending';
  }

  private async setPhaseRunning(setupRunId: string, phase: SetupPhase): Promise<void> {
    const field = phaseField(phase);
    await this.setupRuns.updateOne(
      { setupRunId },
      { $set: { currentPhase: phase, [`phases.${field}.status`]: 'running', [`phases.${field}.startedAt`]: new Date(), updatedAt: new Date() } },
    );
  }

  private async setPhaseCompleted(setupRunId: string, phase: SetupPhase): Promise<void> {
    const field = phaseField(phase);
    await this.setupRuns.updateOne(
      { setupRunId },
      { $set: { [`phases.${field}.status`]: 'completed', [`phases.${field}.completedAt`]: new Date(), updatedAt: new Date() } },
    );
  }

  private async setPhaseStatus(setupRunId: string, phase: SetupPhase, status: string, message?: string): Promise<void> {
    const field = phaseField(phase);
    const updates: Record<string, unknown> = { [`phases.${field}.status`]: status, [`phases.${field}.completedAt`]: new Date(), updatedAt: new Date() };
    if (message) updates[`phases.${field}.message`] = message;
    await this.setupRuns.updateOne({ setupRunId }, { $set: updates });
  }

  private async appendChildExecutionId(setupRunId: string, execId: string): Promise<void> {
    await this.setupRuns.updateOne(
      { setupRunId },
      { $push: { childExecutionIds: execId } as never, $set: { updatedAt: new Date() } },
    );
  }

  private async patch(setupRunId: string, patch: Partial<RepoContextSetupRun>): Promise<RepoContextSetupRun> {
    const updated = { ...patch, updatedAt: new Date() };
    // Keep the isActive mirror in lockstep with any status transition flowing
    // through patch() (cancel/resume/fail/complete), so the partial unique
    // index stays accurate. See isActiveSetupStatus / repo-context-setup.types.
    if (patch.status !== undefined) updated.isActive = isActiveSetupStatus(patch.status);
    await this.setupRuns.updateOne({ setupRunId }, { $set: updated as never });
    return (await this.setupRuns.findOne({ setupRunId }))!;
  }

  /**
   * Fix B: returns the terminal status string.
   * Fix K: progress-aware — stalls when the progress fingerprint is frozen for
   * SETUP_STALL_MS and a progressProbe is provided. Hard cap SETUP_TIMEOUT_MS
   * (4 h default) is an absolute backstop. On any giveup the child exec is
   * best-effort cancelled so it doesn't run as a zombie.
   */
  private async pollExecution(
    execId: string,
    opts?: { progressProbe?: () => Promise<string | number> },
  ): Promise<string> {
    const hardDeadline = Date.now() + SETUP_TIMEOUT_MS;
    let delay = POLL_INTERVAL_MS;
    let lastProgressAt = Date.now();
    let lastFingerprint: string | number | undefined;

    while (true) {
      const exec = await this.executions.findOne({ id: execId }, { projection: { status: 1 } });
      const status = String(exec?.status ?? '');
      if (exec && ['completed', 'failed', 'cancelled'].includes(status)) return status;

      // Hard cap (backstop — stall detection should fire first for normal cases)
      if (Date.now() >= hardDeadline) {
        this.executionService.cancel(execId).catch(() => {});
        const capMin = Math.round(SETUP_TIMEOUT_MS / 60_000);
        throw new Error(`Execution ${execId} exceeded hard timeout (${capMin}m)`);
      }

      // Stall detection via caller-supplied progress probe
      if (opts?.progressProbe) {
        try {
          const fp = await opts.progressProbe();
          if (fp !== lastFingerprint) {
            lastFingerprint = fp;
            lastProgressAt = Date.now();
          }
        } catch (_err) { /* probe failure is non-fatal */ }

        if (Date.now() - lastProgressAt > SETUP_STALL_MS) {
          this.executionService.cancel(execId).catch(() => {});
          const stallMin = Math.round(SETUP_STALL_MS / 60_000);
          throw new Error(`Execution ${execId} stalled (no progress for ${stallMin}m)`);
        }
      }

      delay = await sleepWithBackoff(delay);
    }
  }

  /** Fix K: builds a curation progress probe that fingerprints staged file count + latest updatedAt. */
  private makeCurationProbe(runId: string): () => Promise<string | number> {
    return async (): Promise<string | number> => {
      const col = this.db.collection('repo_context_curation_stage_file_statuses');
      const count = await col.countDocuments({ runId });
      const latest = await col.findOne({ runId }, { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } });
      const ts = latest?.updatedAt instanceof Date ? latest.updatedAt.getTime() : 0;
      return `${count}:${ts}`;
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** C3: single source of truth for the SetupPhase → phases.<field> mapping. */
const PHASE_FIELDS: Partial<Record<SetupPhase, keyof RepoContextSetupRun['phases']>> = {
  preflight: 'preflight',
  curation: 'curation',
  mandatory_mapping: 'mandatoryMapping',
  context_refresh: 'contextRefresh',
};

function phaseField(phase: SetupPhase): string {
  return PHASE_FIELDS[phase] ?? 'preflight';
}

/** C3: a child execution counts as live while it is queued or still running. */
function isLiveExecutionStatus(status: string): boolean {
  return ['running', 'queued'].includes(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** C4: shared poll backoff — sleeps for `delay` ms, then returns the next delay (×1.5, capped). */
async function sleepWithBackoff(delay: number, maxDelay = POLL_BACKOFF_MAX_MS): Promise<number> {
  await sleep(delay);
  return Math.min(delay * 1.5, maxDelay);
}

function buildCuratorPrompt(args: { setupRunId: string; repoId: string; repoPath: string; runId: string; profileId: string; branch?: string }): string {
  return [
    `You are running as part of a repo context setup run.`,
    `setup_run_id: ${args.setupRunId}`,
    `repo_id: ${args.repoId}`,
    `repo_path: ${args.repoPath}`,
    `curation_run_id: ${args.runId}`,
    `profile_id: ${args.profileId}`,
    ...(args.branch ? [`branch: ${args.branch}`] : []),
    '',
    'Run the full context curation workflow using the provided curation run id.',
    'Assign work batches using plan_repo_context_curation_assignments, spawn repo-context-curation-worker agents, wait for them, check stage status, and call promote_repo_context_curation_stage when promotable.',
  ].join('\n');
}

function buildMapperPrompt(args: { setupRunId: string; repoId: string; repoPath: string; branch?: string; stagedSummary?: string }): string {
  return [
    `You are running as part of a repo context setup run.`,
    `setup_run_id: ${args.setupRunId}`,
    `repo_id: ${args.repoId}`,
    `repo_path: ${args.repoPath}`,
    ...(args.branch ? [`branch: ${args.branch}`] : []),
    '',
    'Review this repository and determine which curated context files should be injected as mandatory (always-loaded) context for specific Allen agents.',
    'Use the save_repo_mandatory_context_mapping_proposal tool to submit your mappings as a proposal.',
    'IMPORTANT: You MUST use save_repo_mandatory_context_mapping_proposal — do NOT use save_repo_mandatory_context_mappings.',
    `IMPORTANT: Always pass setup_run_id: ${args.setupRunId} when calling save_repo_mandatory_context_mapping_proposal.`,
    '',
    'Two-step save protocol (REQUIRED — large single payloads can fail and kill the session):',
    '1. As you draft mappings, stage them incrementally by calling save_repo_mandatory_context_mapping_proposal with mode: "stage" and batches of AT MOST 10 mappings. Staged rows persist server-side, so nothing is lost if the session dies; staging is an upsert by (agentName, title, sourcePath), so re-staging a corrected mapping is safe.',
    '2. After EVERY mapping has been staged, make one final small call with mode: "finalize", affected_agent_names, and expected_mapping_count (the total number of staged mappings). Do NOT include mappings in the finalize call.',
    'Every mapping must be staged before you finalize — the finalize call assembles the proposal from the staged rows only.',
    ...(args.stagedSummary ? ['', args.stagedSummary] : []),
  ].join('\n');
}

/** Cap on individually listed (agentName, title) staged entries in the resume summary. */
const STAGED_SUMMARY_LIST_CAP = 50;

/**
 * Continue-from-last-run: summarizes staged rows left by a previous mapper
 * attempt so a respawned mapper can verify coverage instead of starting over.
 */
function buildStagedSummary(rows: Array<{ agentName?: string; title?: string }>): string {
  const perAgent = new Map<string, number>();
  for (const row of rows) {
    const name = String(row.agentName ?? '');
    perAgent.set(name, (perAgent.get(name) ?? 0) + 1);
  }
  const listed = rows.slice(0, STAGED_SUMMARY_LIST_CAP);
  const remaining = rows.length - listed.length;
  return [
    `RESUME NOTE: A previous attempt of this setup run already staged ${rows.length} mapping(s). They are still saved server-side — do NOT re-stage everything from scratch.`,
    `Staged mappings per agent: ${[...perAgent.entries()].map(([name, count]) => `${name}=${count}`).join(', ')}`,
    'Already-staged (agentName, title) entries:',
    ...listed.map((row) => `- (${String(row.agentName ?? '')}, ${String(row.title ?? '')})`),
    ...(remaining > 0 ? [`…and ${remaining} more staged entries not listed here.`] : []),
    'Verify this staged coverage against your own review, stage only missing or corrected mappings (re-staging an existing (agentName, title, sourcePath) key safely overwrites it), then finalize with the full expected_mapping_count covering ALL staged mappings.',
  ].join('\n');
}
