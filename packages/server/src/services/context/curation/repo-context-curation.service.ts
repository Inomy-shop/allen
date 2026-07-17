import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { StateManager } from '@allen/engine';
import { sha256, stringValue } from '../common/context-utils.js';
import {
  REPO_CONTEXT_CURATOR_PROMPT_VERSION,
  REPO_CONTEXT_CURATOR_SCHEMA_VERSION,
} from './repo-context-curator-prompts.js';
import {
  buildSpawnedAgentRoleInventory,
  buildWorkflowRoleInventory,
} from '../common/context-role-inventory.js';
import {
  type CandidateContextFile,
  collectDefaultBranchContextFiles,
  contextInventoryConfig,
  resolveDefaultBranchName,
  resolveRequestedBranch,
  revParse,
} from './repo-context-curation-git.js';
import {
  createRepoContextCurationRun,
  curationBudgets,
  getRepoContextCurationStageStatus,
  markRepoContextCurationRunPromoted,
  normalizeCandidateFiles,
  planRepoContextCurationAssignments,
  registerRepoContextCurationAssignments,
  saveRepoContextCurationStage,
} from './repo-context-curation-runner.js';
import {
  agentAdjacentDiagnosticReason,
  hasProductionLearningSignals,
  shouldBlockAgentAdjacentInjection,
} from './repo-context-agent-adjacent.js';
import { CuratedContextEditorService } from '../judge/curated-context-editor.service.js';

type CurationStatus = 'running' | 'completed' | 'failed' | 'stopped';
type Inclusion = 'include' | 'exclude' | 'stale';
type InjectionPolicy = 'snippet' | 'manifest_only' | 'never_full_auto';
type Authority = 'high' | 'medium' | 'low';

type CurationChunk = {
  chunkId: string;
  heading: string;
  targetGlobs: string[];
  targetRoles: string[];
  text: string;
  sourceAnchors: string[];
};

type CurationRunInput = {
  repoId: string;
  repoName: string;
  repoPath: string;
  branch?: string;
  gitRef?: string;
  headSha?: string;
  /** true when the inventory fetch succeeded AND the resolved ref is origin/<branch> */
  snapshotFresh?: boolean;
  /** mirrors inventory.fetchOk */
  snapshotFetchOk?: boolean;
  configHash: string;
  roleInventory: Array<{ role: string; category: string }>;
  spawnedRoleInventory: Array<{ role: string; category: string }>;
  candidates: CandidateContextFile[];
  reusedEntries: CurationEntry[];
  newOrChangedFiles: CandidateContextFile[];
  deletedOrStaleFiles: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
};

type CurationEntry = {
  entryId: string;
  repoId: string;
  path: string;
  sourceHash: string;
  title: string;
  category: string;
  inclusion: Inclusion;
  authority: Authority;
  freshness: 'current' | 'stale' | 'unknown';
  injectionPolicy: InjectionPolicy;
  summary: string;
  curatedContext?: string;
  retrievalText?: string;
  chunks?: CurationChunk[];
  aliases: string[];
  appliesToGlobs: string[];
  sourceAnchors: string[];
  reasoning: string;
  curationVersion: number;
  promptVersion: number;
  configHash: string;
  reused?: boolean;
  stale?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type CurationProfile = {
  profileId: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  branch?: string;
  gitRef?: string;
  headSha?: string;
  curationVersion: number;
  promptVersion: number;
  configHash: string;
  latest: boolean;
  status: CurationStatus;
  message?: string;
  stats: Record<string, number>;
  diagnostics: Array<Record<string, unknown>>;
  entries: CurationEntry[];
  executionId?: string;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
  updatedAt: Date;
};

type ScheduleRefreshOptions = {
  source?: 'ui' | 'chat_spawn' | 'agent_run';
  prompt?: string;
  chatSessionId?: string;
  parentExecutionId?: string | null;
  parentCaller?: string | null;
  rootExecutionId?: string | null;
  spawnedBy?: string;
  forceExecution?: boolean;
};

type CurationScopeInput = {
  mode?: string;
  pattern?: string;
  force?: boolean;
};

const CURATION_VERSION = REPO_CONTEXT_CURATOR_SCHEMA_VERSION;
const PROMPT_VERSION = REPO_CONTEXT_CURATOR_PROMPT_VERSION;

const VALID_CATEGORIES = new Set([
  'mandatory_guidance',
  'module_rule',
  'prd',
  'spec',
  'runbook',
  'skill',
  'source_doc',
  'agent_persona',
  'architecture',
  'production_note',
  'historical_note',
  'generated_doc',
  'duplicate',
  'stale',
  'excluded_noise',
  'doc',
]);
const VALID_INCLUSIONS = new Set<Inclusion>(['include', 'exclude', 'stale']);
const VALID_POLICIES = new Set<InjectionPolicy>(['snippet', 'manifest_only', 'never_full_auto']);
const VALID_AUTHORITY = new Set<Authority>(['high', 'medium', 'low']);
const STALE_RUNNING_PROFILE_MS = 12 * 60 * 60 * 1000;

export class RepoContextCurationService {
  private profiles: Collection<CurationProfile>;
  private entries: Collection<CurationEntry>;
  private repos: Collection;
  private editor: CuratedContextEditorService;

  constructor(private db: Db) {
    this.profiles = db.collection<CurationProfile>('repo_context_curation_profiles');
    this.entries = db.collection<CurationEntry>('repo_context_curation_entries');
    this.repos = db.collection('repos');
    this.editor = new CuratedContextEditorService(db);
  }

  async getLatest(repoId: string): Promise<CurationProfile | null> {
    const running = await this.findActiveRunningProfile(repoId);
    if (running) return { ...running, message: running.message ?? 'Context curation is running' };
    return this.profiles.findOne({ repoId, latest: true }, { sort: { createdAt: -1 } });
  }

  async saveStageFromAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return saveRepoContextCurationStage(this.db, body);
  }

  private async findActiveRunningProfile(repoId: string): Promise<CurationProfile | null> {
    const runningProfiles = await this.profiles.find({ repoId, status: 'running' }, { sort: { createdAt: -1 } }).toArray();
    for (const profile of runningProfiles) {
      if (await this.isActiveRunningProfile(profile)) return profile;
      await this.markRunningProfileStale(profile);
    }
    return null;
  }

  private async isActiveRunningProfile(profile: CurationProfile): Promise<boolean> {
    if (!profile.executionId) return !isStaleDate(profile.updatedAt ?? profile.createdAt);
    const execution = await this.db.collection('executions').findOne(
      { id: profile.executionId },
      { projection: { status: 1, updatedAt: 1, startedAt: 1, createdAt: 1, completedAt: 1, currentNodes: 1 } },
    );
    if (!execution) return !isStaleDate(profile.updatedAt ?? profile.createdAt);
    if (execution.completedAt) return false;
    const status = String(execution.status ?? '');
    if (!['queued', 'running'].includes(status)) return false;
    return !isStaleDate(execution.updatedAt ?? execution.startedAt ?? execution.createdAt ?? profile.updatedAt ?? profile.createdAt);
  }

  private async markRunningProfileStale(profile: CurationProfile): Promise<void> {
    const now = new Date();
    const message = 'Context curation was interrupted or abandoned; showing the latest completed curation profile.';
    await this.profiles.updateOne(
      { profileId: profile.profileId, status: 'running' },
      { $set: { status: 'stopped', message, updatedAt: now, completedAt: now } },
    );
    if (profile.executionId) {
      await this.db.collection('repo_context_curation_runs').updateMany(
        { executionId: profile.executionId, status: 'running' },
        { $set: { status: 'stopped', message, updatedAt: now, completedAt: now } },
      );
    }
  }

  async prepareForCoordinator(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const repo = await this.resolveRepo(body);
    const scope = normalizeScope(body.scope ?? body);
    const requestedBranch = stringValue(body.branch) ?? stringValue(body.git_ref) ?? stringValue(body.gitRef);
    const input = await this.buildRunInput(repo, scope, { branch: requestedBranch });

    // Fix L: if the caller supplies an existing run_id, try to reuse the live curation run
    // instead of creating a new profile + run. This lets Resume pick up where staged
    // worker progress left off rather than starting a full re-curation from zero.
    const requestedRunId = stringValue(body.run_id);
    if (requestedRunId) {
      try {
        const existingRunDoc = await this.db.collection('repo_context_curation_runs').findOne({ runId: requestedRunId });
        const existingRunStatus = String(existingRunDoc?.status ?? '');
        // 'running' runs are reused as-is. 'stopped' runs (stall watchdog cancelled a stalled
        // curator) are reactivated so staged worker progress survives the interruption.
        const runReusable =
          existingRunDoc &&
          String(existingRunDoc.repoId) === String(input.repoId) &&
          ['running', 'stopped'].includes(existingRunStatus);

        if (runReusable && existingRunDoc) {
          const profileId = stringValue(existingRunDoc.profileId as unknown) ?? '';
          const stageStatus = await getRepoContextCurationStageStatus(this.db, requestedRunId);
          const filesToCurate = stageStatus.retryFiles.length
            ? stageStatus.retryFiles
            : normalizeCandidateFiles(existingRunDoc.expectedFiles);
          const filesPreviewLimit = 50;

          // Reactivate a stopped run before reusing it: flip the run + profile back to
          // 'running' and clear the watchdog's completedAt/"interrupted or abandoned" message.
          // Deliberately no head-SHA staleness refusal here — snapshotFresh diagnostics and
          // the stale-at-promote guard already cover staleness; a stale snapshot must not
          // force a fresh run.
          const reactivated = existingRunStatus === 'stopped';
          if (reactivated) {
            const now = new Date();
            await this.db.collection('repo_context_curation_runs').updateOne(
              { runId: requestedRunId },
              { $set: { status: 'running', updatedAt: now }, $unset: { completedAt: '', message: '' } },
            );
            if (profileId) {
              await this.profiles.updateOne(
                { profileId },
                { $set: { status: 'running', updatedAt: now }, $unset: { completedAt: '' } },
              );
            }
          }

          // Update the existing profile's message so the UI shows the right state
          if (profileId) {
            await this.profiles.updateOne(
              { profileId },
              {
                $set: {
                  message: filesToCurate.length
                    ? `Context curation resuming: ${filesToCurate.length} file${filesToCurate.length === 1 ? '' : 's'} pending`
                    : 'No pending files; ready to promote',
                  stats: baseStats(input),
                  updatedAt: new Date(),
                },
              },
            );
          }

          const diagnostics: Array<Record<string, unknown>> = [
            ...input.diagnostics,
            {
              code: 'curation_run_reused',
              severity: 'info',
              message: `Reusing existing curation run ${requestedRunId} with ${filesToCurate.length} pending file(s)`,
            },
          ];
          if (reactivated) {
            diagnostics.push({
              code: 'curation_run_reactivated',
              severity: 'info',
              message: `Reactivated stopped curation run ${requestedRunId} after interruption; ${filesToCurate.length} file(s) still pending`,
            });
          }
          if (!input.snapshotFresh) {
            diagnostics.push({
              code: 'inventory_snapshot_stale',
              severity: 'warning',
              message: `Inventory snapshot may be stale (fetchOk=${String(input.snapshotFetchOk)}, ref=${String(input.gitRef)}). Commits pushed after the inventory snapshot will not be curated in this run.`,
            });
          }

          return {
            run_id: requestedRunId,
            profile_id: profileId || existingRunDoc.profileId,
            execution_id: existingRunDoc.executionId,
            repo: { id: input.repoId, name: input.repoName, path: input.repoPath, branch: input.branch, git_ref: input.gitRef, head_sha: input.headSha },
            snapshot: { fresh: input.snapshotFresh ?? false, ref: input.gitRef ?? null, head_sha: input.headSha ?? null, fetch_ok: input.snapshotFetchOk ?? false },
            scope,
            budgets: curationBudgets(),
            role_inventory: input.roleInventory,
            spawned_role_inventory: input.spawnedRoleInventory,
            unchanged_reused_entries: input.reusedEntries.map(compactEntryForPrompt),
            files_to_curate_count: filesToCurate.length,
            files_to_curate_preview: filesToCurate.slice(0, filesPreviewLimit),
            files_to_curate_truncated: filesToCurate.length > filesPreviewLimit,
            deleted_or_stale_files: input.deletedOrStaleFiles,
            diagnostics,
            stage_status: compactStageStatusForPrompt(stageStatus),
            instructions: [
              'Call plan_repo_context_curation_assignments for assignment-ready batches; do not reconstruct inventory from the filesystem.',
              'For large runs, spawn visible repo-context-curation-worker agents up to the returned concurrency limit immediately. The planner hard-caps concurrency at 4. Do not run a pilot unless explicitly requested.',
              'After workers finish, call get_repo_context_curation_stage_status and retry missing/invalid files.',
              'Call promote_repo_context_curation_stage only when promotable is true.',
            ],
          };
        }

        // Run not reusable (wrong repo, not active, or lookup failed) — add diagnostic and create new
        input.diagnostics.push({
          code: 'run_id_not_reusable',
          severity: 'info',
          message: existingRunDoc
            ? `Requested run_id ${requestedRunId} is not reusable (status: ${existingRunDoc.status ?? 'unknown'}).`
            : `Requested run_id ${requestedRunId} was not found; starting a new curation run.`,
          requestedRunId,
        });
      } catch (_err) {
        // Any error in the reuse path (e.g., stage run not found) — fall through to new run
        input.diagnostics.push({
          code: 'run_id_not_reusable',
          severity: 'info',
          message: `Requested run_id ${requestedRunId} could not be reused; starting a new curation run.`,
          requestedRunId,
        });
      }
    }

    const executionId = stringValue(body.source_execution_id) ?? stringValue(body.execution_id);
    // Fix H: when skip_execution_record=true and no source executionId, create the profile
    // WITHOUT inserting a synthetic executions row — the caller will attach the real
    // spawned execution id via attachExecutionToProfile().
    const skipExecutionRecord = body.skip_execution_record === true && !executionId;
    const profile = executionId
      ? await this.createProfileForExecution(input, executionId, 'Context curation coordinator prepared')
      : skipExecutionRecord
        ? await this.createProfileOnly(input, 'Context curation coordinator prepared')
        : await this.createRunningProfile(input, 'Context curation coordinator prepared', { source: 'agent_run', prompt: stringValue(body.prompt) });
    const run = await createRepoContextCurationRun(this.db, {
      executionId: profile.executionId!,
      profileId: profile.profileId,
      repoId: input.repoId,
      repoName: input.repoName,
      expectedFiles: input.newOrChangedFiles,
      branch: input.branch,
      scope,
    });
    const stageStatus = await getRepoContextCurationStageStatus(this.db, String(run.runId));
    const filesToCurate = stageStatus.retryFiles.length ? stageStatus.retryFiles : input.newOrChangedFiles;
    const filesPreviewLimit = 50;

    // G1: surface snapshot freshness — add diagnostic when fetch failed or ref is not origin/<branch>
    if (!input.snapshotFresh) {
      input.diagnostics.push({
        code: 'inventory_snapshot_stale',
        severity: 'warning',
        message: `Inventory snapshot may be stale (fetchOk=${String(input.snapshotFetchOk)}, ref=${String(input.gitRef)}). Commits pushed after the inventory snapshot will not be curated in this run.`,
      });
    }

    // G1: persist snapshot info on the run doc so promoteStageFromAgent can compare at promote time
    await this.db.collection('repo_context_curation_runs').updateOne(
      { runId: String(run.runId) },
      {
        $set: {
          snapshotFresh: input.snapshotFresh ?? false,
          snapshotFetchOk: input.snapshotFetchOk ?? false,
          snapshotHeadSha: input.headSha ?? null,
          snapshotRef: input.gitRef ?? null,
          updatedAt: new Date(),
        },
      },
    );

    await this.profiles.updateOne(
      { profileId: profile.profileId },
      {
        $set: {
          message: filesToCurate.length
            ? `Context curation prepared ${filesToCurate.length} file${filesToCurate.length === 1 ? '' : 's'} for worker agents`
            : 'No context files changed; ready to promote reused curation',
          stats: baseStats(input),
          updatedAt: new Date(),
        },
      },
    );
    return {
      run_id: run.runId,
      profile_id: profile.profileId,
      execution_id: profile.executionId,
      repo: {
        id: input.repoId,
        name: input.repoName,
        path: input.repoPath,
        branch: input.branch,
        git_ref: input.gitRef,
        head_sha: input.headSha,
      },
      // G1: snapshot freshness block for the coordinator and the setup-service caller
      snapshot: {
        fresh: input.snapshotFresh ?? false,
        ref: input.gitRef ?? null,
        head_sha: input.headSha ?? null,
        fetch_ok: input.snapshotFetchOk ?? false,
      },
      scope,
      budgets: curationBudgets(),
      role_inventory: input.roleInventory,
      spawned_role_inventory: input.spawnedRoleInventory,
      unchanged_reused_entries: input.reusedEntries.map(compactEntryForPrompt),
      files_to_curate_count: filesToCurate.length,
      files_to_curate_preview: filesToCurate.slice(0, filesPreviewLimit),
      files_to_curate_truncated: filesToCurate.length > filesPreviewLimit,
      deleted_or_stale_files: input.deletedOrStaleFiles,
      diagnostics: input.diagnostics,
      stage_status: compactStageStatusForPrompt(stageStatus),
      instructions: [
        'Call plan_repo_context_curation_assignments for assignment-ready batches; do not reconstruct inventory from the filesystem.',
        'For large runs, spawn visible repo-context-curation-worker agents up to the returned concurrency limit immediately. The planner hard-caps concurrency at 4. Do not run a pilot unless explicitly requested.',
        'After workers finish, call get_repo_context_curation_stage_status and retry missing/invalid files.',
        'Call promote_repo_context_curation_stage only when promotable is true.',
      ],
    };
  }

  async planAssignmentsFromAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return planRepoContextCurationAssignments(this.db, body);
  }

  async registerAssignmentsFromAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return registerRepoContextCurationAssignments(this.db, body);
  }

  async getStageStatusFromAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const runId = stringValue(body.run_id) ?? stringValue(body.runId);
    if (!runId) throw new Error('run_id is required');
    return getRepoContextCurationStageStatus(this.db, runId);
  }

  async promoteStageFromAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const runId = stringValue(body.run_id) ?? stringValue(body.runId);
    if (!runId) throw new Error('run_id is required');
    const run = await this.db.collection('repo_context_curation_runs').findOne({ runId });
    if (!run) throw new Error('Curation staging run not found');
    const runStatus = String(run.status ?? '');
    if (!['running', 'validated'].includes(runStatus)) {
      throw new Error(`Curation staging run is not active (${runStatus || 'unknown'}).`);
    }
    const stage = await getRepoContextCurationStageStatus(this.db, runId);
    if (!stage.promotable) {
      throw new Error(`Curation staging run is not promotable; retry ${stage.retryFiles.length} file(s) first.`);
    }
    const repo = await this.repoById(String(run.repoId));
    const runBranch = stringValue(run.branch as unknown);
    const repoPath = String(repo.path ?? '');
    const input = await this.buildRunInput(repo, normalizeScope(run.scope), { branch: runBranch });
    const expectedFiles = normalizeCandidateFiles(run.expectedFiles);
    const inputForSave = { ...input, newOrChangedFiles: expectedFiles };
    const newEntries = normalizeCuratorEntries({
      repoId: input.repoId,
      configHash: input.configHash,
      candidates: expectedFiles,
      rawEntries: stage.entries,
    });
    const diagnostics = [...input.diagnostics, ...normalizeDiagnostics(stage.diagnostics)];

    // G1: best-effort stale-at-promote check — NON-FATAL
    const snapshotHeadSha = stringValue(run.snapshotHeadSha as unknown);
    if (snapshotHeadSha && repoPath && runBranch) {
      const currentSha = await revParse(repoPath, `origin/${runBranch}`).catch(() => undefined);
      if (currentSha && currentSha !== snapshotHeadSha) {
        diagnostics.push({
          code: 'snapshot_stale_at_promote',
          severity: 'warning',
          message: `New commits appeared on origin/${runBranch} since the inventory snapshot. The promoted curation may be missing recently committed files.`,
          snapshotHeadSha,
          currentHeadSha: currentSha,
        });
      }
    }
    await this.saveCompletedCuration({
      input: inputForSave,
      profileId: String(run.profileId),
      executionId: String(run.executionId),
      newEntries,
      diagnostics,
      costUsd: 0,
      startedAt: run.createdAt ? new Date(run.createdAt as Date).getTime() : Date.now(),
      message: expectedFiles.length ? 'Context curation completed' : 'Context curation reused existing entries',
    });
    await markRepoContextCurationRunPromoted(this.db, runId, stage);
    return {
      run_id: runId,
      profile_id: run.profileId,
      execution_id: run.executionId,
      promoted_entries: newEntries.length,
      stats: countStats(inputForSave, newEntries, input.deletedOrStaleFiles.map((item) => staleEntry(input.repoId, input.configHash, item))),
      diagnostics,
    };
  }

  private async buildRunInput(repo: Record<string, unknown>, scope: CurationScopeInput = {}, options: { branch?: string } = {}): Promise<CurationRunInput> {
    const repoId = String(repo._id);
    const repoName = String(repo.name ?? 'repo');
    const repoPath = String(repo.path ?? '');
    if (!repoPath) throw new Error('Repo path is missing');
    const defaultBranch = resolveDefaultBranchName(repo);
    const effectiveBranch = resolveRequestedBranch(options.branch, defaultBranch);
    const [inventory, roleInventoryFull, spawnedRoleInventoryFull] = await Promise.all([
      collectDefaultBranchContextFiles(repoPath, effectiveBranch),
      buildWorkflowRoleInventory(this.db),
      buildSpawnedAgentRoleInventory(this.db),
    ]);
    const candidates = filterCandidatesByScope(inventory.candidates, scope);
    const roleInventory = roleInventoryFull.map((entry) => ({ role: entry.role, category: entry.category }));
    const spawnedRoleInventory = spawnedRoleInventoryFull.map((entry) => ({ role: entry.role, category: entry.category }));
    const baseConfigHash = sha256(JSON.stringify({
      curationVersion: CURATION_VERSION,
      inventory: contextInventoryConfig(),
      roleInventory,
      spawnedRoleInventory,
    }));
    const configHash = sha256(JSON.stringify({ baseConfigHash, scope: { mode: scope.mode, pattern: scope.pattern } }));

    const priorEntries = await this.entries.find({
      repoId,
      curationVersion: CURATION_VERSION,
      active: { $ne: false },
    }, { sort: { updatedAt: -1, createdAt: -1 } }).toArray();
    const priorInScope = priorEntries.filter((entry) => pathMatchesScope(entry.path, scope));
    const priorByPathHash = new Map<string, CurationEntry>();
    for (const entry of priorInScope) {
      const key = `${entry.path}:${entry.sourceHash}`;
      if (!priorByPathHash.has(key)) priorByPathHash.set(key, entry);
    }
    const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
    const reusedEntries: CurationEntry[] = [];
    const newOrChangedFiles: CandidateContextFile[] = [];
    for (const candidate of candidates) {
      const reused = priorByPathHash.get(`${candidate.path}:${candidate.sourceHash}`);
      if (reused) reusedEntries.push({ ...reused, reused: true, updatedAt: new Date() });
      else newOrChangedFiles.push(candidate);
    }
    if (scope.force) {
      reusedEntries.length = 0;
      newOrChangedFiles.splice(0, newOrChangedFiles.length, ...candidates);
    }
    const deletedOrStaleFiles = priorInScope
      .filter((entry) => !candidatePaths.has(entry.path))
      .map((entry) => ({
        entryId: entry.entryId,
        path: entry.path,
        sourceHash: entry.sourceHash,
        title: entry.title,
        reason: 'File is no longer in the tracked context inventory.',
      }));

    const snapshotFetchOk = inventory.fetchOk === true;
    const snapshotFresh = snapshotFetchOk && inventory.ref === `origin/${effectiveBranch}`;

    return {
      repoId,
      repoName,
      repoPath,
      branch: inventory.branch,
      gitRef: inventory.ref,
      headSha: inventory.headSha,
      snapshotFresh,
      snapshotFetchOk,
      configHash,
      roleInventory,
      spawnedRoleInventory,
      candidates,
      reusedEntries,
      newOrChangedFiles,
      deletedOrStaleFiles,
      diagnostics: inventory.diagnostics,
    };
  }

  private async saveCompletedCuration(input: {
    input: CurationRunInput;
    profileId: string;
    executionId: string;
    newEntries: CurationEntry[];
    diagnostics: Array<Record<string, unknown>>;
    costUsd: number;
    startedAt: number;
    message: string;
  }): Promise<void> {
    for (const entry of input.newEntries) {
      await this.editor.replaceFromCurator(
        entry.repoId,
        entry.entryId,
        entry as unknown as Record<string, unknown>,
        { actor: 'repo-context-curator', source: 'repo_context_curator' },
      );
    }

    for (const item of input.input.deletedOrStaleFiles) {
      const path = stringValue(item.path) ?? 'unknown';
      const entryId = stringValue(item.entryId) ?? stableEntryId(input.input.repoId, path);
      const existing = await this.editor.getEntry(input.input.repoId, entryId);
      if (!existing) continue;
      await this.editor.applyEdit(
        input.input.repoId,
        entryId,
        {},
        { actor: 'repo-context-curator', source: 'repo_context_curator', action: 'archive' },
      );
    }

    const staleEntries = input.input.deletedOrStaleFiles.map((item) => staleEntry(input.input.repoId, input.input.configHash, item));
    const mergedEntries = [
      ...input.input.reusedEntries.map((entry) => ({ ...entry, reused: true })),
      ...input.newEntries,
      ...staleEntries,
    ];
    const stats = countStats(input.input, input.newEntries, staleEntries);
    await this.profiles.updateMany({ repoId: input.input.repoId, latest: true }, { $set: { latest: false } });
    await this.profiles.updateOne(
      { profileId: input.profileId },
      {
        $set: {
          latest: true,
          status: 'completed',
          message: input.message,
          stats,
          diagnostics: input.diagnostics,
          entries: mergedEntries,
          executionId: input.executionId,
          costUsd: input.costUsd,
          durationMs: Date.now() - input.startedAt,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
        $unset: { error: '' },
      },
    );
    await this.repos.updateOne(
      { _id: new ObjectId(input.input.repoId) },
      {
        $set: {
          contextCuration: {
            status: 'ready',
            profileId: input.profileId,
            executionId: input.executionId,
            headSha: input.input.headSha,
            curatedAt: new Date(),
          },
        },
      },
    );
    await this.markExecutionCompleted({
      executionId: input.executionId,
      input: input.input,
      stats,
      diagnostics: input.diagnostics,
      durationMs: Date.now() - input.startedAt,
      codexRan: input.input.newOrChangedFiles.length > 0,
    });
  }

  private async createRunningProfile(input: CurationRunInput, message: string, options: ScheduleRefreshOptions = {}): Promise<CurationProfile> {
    const now = new Date();
    const executionId = await this.createCurationExecution(input, options, now);
    const profile: CurationProfile = {
      profileId: randomUUID(),
      repoId: input.repoId,
      repoName: input.repoName,
      repoPath: input.repoPath,
      branch: input.branch,
      gitRef: input.gitRef,
      headSha: input.headSha,
      curationVersion: CURATION_VERSION,
      promptVersion: PROMPT_VERSION,
      configHash: input.configHash,
      latest: false,
      status: 'running',
      message,
      stats: baseStats(input),
      diagnostics: input.diagnostics,
      entries: [],
      executionId,
      createdAt: now,
      updatedAt: now,
    };
    await this.profiles.insertOne(profile);
    await this.repos.updateOne(
      { _id: new ObjectId(input.repoId) },
      { $set: { contextCuration: { status: 'running', profileId: profile.profileId, executionId, startedAt: now } } },
    );
    return profile;
  }

  /**
   * Fix H: creates a curation profile WITHOUT inserting a synthetic executions row.
   * The caller (RepoContextSetupService.runCurationPhase) is responsible for spawning
   * the real agent and calling attachExecutionToProfile() with the resulting execId.
   */
  private async createProfileOnly(input: CurationRunInput, message: string): Promise<CurationProfile> {
    const now = new Date();
    const profile: CurationProfile = {
      profileId: randomUUID(),
      repoId: input.repoId,
      repoName: input.repoName,
      repoPath: input.repoPath,
      branch: input.branch,
      gitRef: input.gitRef,
      headSha: input.headSha,
      curationVersion: CURATION_VERSION,
      promptVersion: PROMPT_VERSION,
      configHash: input.configHash,
      latest: false,
      status: 'running',
      message,
      stats: baseStats(input),
      diagnostics: input.diagnostics,
      entries: [],
      // executionId intentionally omitted — will be backfilled by attachExecutionToProfile
      createdAt: now,
      updatedAt: now,
    };
    await this.profiles.insertOne(profile);
    // Update repo contextCuration without executionId — will be backfilled
    await this.repos.updateOne(
      { _id: new ObjectId(input.repoId) },
      { $set: { contextCuration: { status: 'running', profileId: profile.profileId, startedAt: now } } },
    );
    return profile;
  }

  /**
   * Fix H: backfills the real spawned execution id onto the profile, the
   * repo_context_curation_runs row, and the repo.contextCuration summary.
   * Called by RepoContextSetupService immediately after spawnAgentFn resolves.
   */
  async attachExecutionToProfile(profileId: string, runId: string, executionId: string): Promise<void> {
    await this.profiles.updateOne(
      { profileId },
      { $set: { executionId, updatedAt: new Date() } },
    );
    await this.db.collection('repo_context_curation_runs').updateOne(
      { runId },
      { $set: { executionId, updatedAt: new Date() } },
    );
    // Best-effort repo contextCuration.executionId backfill
    const profile = await this.profiles.findOne({ profileId });
    if (profile?.repoId) {
      await this.repos.updateOne(
        { _id: new ObjectId(String(profile.repoId)), 'contextCuration.profileId': profileId },
        { $set: { 'contextCuration.executionId': executionId } },
      );
    }
  }

  private async createProfileForExecution(input: CurationRunInput, executionId: string, message: string): Promise<CurationProfile> {
    const existing = await this.profiles.findOne({ executionId });
    if (existing) return existing;
    const now = new Date();
    const profile: CurationProfile = {
      profileId: randomUUID(),
      repoId: input.repoId,
      repoName: input.repoName,
      repoPath: input.repoPath,
      branch: input.branch,
      gitRef: input.gitRef,
      headSha: input.headSha,
      curationVersion: CURATION_VERSION,
      promptVersion: PROMPT_VERSION,
      configHash: input.configHash,
      latest: false,
      status: 'running',
      message,
      stats: baseStats(input),
      diagnostics: input.diagnostics,
      entries: [],
      executionId,
      createdAt: now,
      updatedAt: now,
    };
    await this.profiles.insertOne(profile);
    await new StateManager(this.db).updateExecution(executionId, {
          status: 'running',
          currentNodes: ['repo-context-curator'],
          'meta.curationProfile': true,
          'meta.cwd': input.repoPath,
          'input.repo_id': input.repoId,
          'input.repo_path': input.repoPath,
    } as any);
    await this.repos.updateOne(
      { _id: new ObjectId(input.repoId) },
      { $set: { contextCuration: { status: 'running', profileId: profile.profileId, executionId, startedAt: now } } },
    );
    return profile;
  }

  private async repoById(repoId: string): Promise<Record<string, unknown>> {
    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo) throw new Error('Repo not found');
    return repo;
  }

  private async resolveRepo(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const repoId = stringValue(body.repo_id) ?? stringValue(body.repoId);
    if (repoId) return this.repoById(repoId);
    const repoPath = stringValue(body.repo_path) ?? stringValue(body.repoPath);
    if (!repoPath) throw new Error('repo_id or repo_path is required');
    const repo = await this.repos.findOne({ path: repoPath });
    if (!repo) throw new Error('Repo not found for repo_path');
    return repo;
  }

  private async createCurationExecution(input: CurationRunInput, options: ScheduleRefreshOptions, now: Date): Promise<string> {
    const executionId = randomUUID();
    await new StateManager(this.db).createExecution({
      id: executionId,
      workflowName: `${options.parentCaller ?? 'chat'}:spawn_agent/repo-context-curator`,
      workflowId: null,
      workflowVersion: 0,
      status: 'running',
      source: options.source === 'ui' ? 'repo_context_curation' : options.parentCaller ? 'spawn' : 'chat',
      input: {
        prompt: options.prompt ?? `context-curation: ${input.repoName}`,
        agent_name: 'repo-context-curator',
        repo_path: input.repoPath,
        repo_id: input.repoId,
      },
      meta: {
        cwd: input.repoPath,
        provider: 'codex',
        model: 'gpt-5.5',
        spawnedBy: options.spawnedBy ?? 'repo-context-curation',
        chatSessionId: options.chatSessionId,
        curationProfile: true,
      },
      parentExecutionId: options.parentExecutionId ?? null,
      parentCaller: options.parentCaller ?? null,
      rootExecutionId: options.rootExecutionId ?? executionId,
      spawnDepth: options.parentExecutionId ? 1 : 0,
      state: {},
      sessions: {},
      retryCounts: {},
      currentNodes: ['repo-context-curator'],
      completedNodes: [],
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: now,
      nodeAttempts: {},
    } as any);
    return executionId;
  }

  private async markExecutionCompleted(input: {
    executionId: string;
    input: CurationRunInput;
    stats: Record<string, number>;
    diagnostics: Array<Record<string, unknown>>;
    durationMs: number;
    codexRan: boolean;
  }): Promise<void> {
    const completedAt = new Date();
    await new StateManager(this.db).updateExecutionWithUnset(
      input.executionId,
      {
          status: 'completed',
          completedNodes: ['repo-context-curator'],
          currentNodes: [],
          durationMs: input.durationMs,
          completedAt,
      },
      ['errorMessage'],
    );
    if (!input.codexRan) {
      await this.db.collection('execution_traces').insertOne({
        executionId: input.executionId,
        node: 'repo-context-curator',
        attempt: 1,
        status: 'completed',
        type: 'agent',
        agent: 'repo-context-curator',
        inputState: {
          prompt: `context-curation: ${input.input.repoName}`,
          repoId: input.input.repoId,
          repoPath: input.input.repoPath,
          gitRef: input.input.gitRef,
        },
        renderedPrompt: '',
        rawResponse: '',
        output: {
          reused: true,
          stats: input.stats,
          diagnostics: input.diagnostics,
        },
        cost: { actual: 0, estimated: 0, model: 'gpt-5.5', method: 'sdk_reported' as const },
        durationMs: input.durationMs,
        startedAt: new Date(completedAt.getTime() - input.durationMs),
        completedAt,
      });
    }
  }
}

function normalizeCuratorEntries(input: {
  repoId: string;
  configHash: string;
  candidates: CandidateContextFile[];
  rawEntries: unknown[];
}): CurationEntry[] {
  const byPath = new Map(input.candidates.map((candidate) => [candidate.path, candidate]));
  const out: CurationEntry[] = [];
  for (const raw of input.rawEntries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const path = stringValue(rec.path);
    const candidate = path ? byPath.get(path) : undefined;
    if (!candidate) continue;
    let chunks = normalizeChunks(rec.chunks);
    let curatedContext = stringValue(rec.curatedContext);
    let retrievalText: string | undefined = stringValue(rec.retrievalText) ?? curatedContext ?? chunks.map((chunk) => chunk.text).join('\n\n').trim();
    let category = normalizeCategory(rec.category);
    let inclusion = normalizeInclusion(rec.inclusion);
    let injectionPolicy = normalizePolicy(rec.injectionPolicy);
    let summary = stringValue(rec.summary) ?? previewText(curatedContext ?? retrievalText ?? chunks[0]?.text ?? '');
    let reasoning = stringValue(rec.reasoning) ?? '';
    const classificationText = [
      rec.title,
      summary,
      curatedContext,
      retrievalText,
      ...chunks.map((chunk) => chunk.text),
      reasoning,
    ].map((value) => String(value ?? '')).join('\n');
    if (category === 'agent_persona' && hasProductionLearningSignals(classificationText)) {
      category = 'production_note';
      reasoning = appendReason(reasoning, 'agent_persona category normalized to production_note because the staged context contains source-grounded production learnings.');
    }
    const block = shouldBlockAgentAdjacentInjection({
      path: candidate.path,
      category,
      inclusion,
      injectionPolicy,
      text: classificationText,
    });
    if (block) {
      inclusion = 'exclude';
      injectionPolicy = 'never_full_auto';
      category = category === 'agent_persona' ? 'agent_persona' : 'excluded_noise';
      curatedContext = undefined;
      retrievalText = undefined;
      chunks = [];
      summary = block.message;
      reasoning = appendReason(reasoning, agentAdjacentDiagnosticReason(block.code));
    }
    if (inclusion === 'include' && !curatedContext && !retrievalText && chunks.length === 0) continue;
    out.push({
      entryId: stableEntryId(input.repoId, candidate.path),
      repoId: input.repoId,
      path: candidate.path,
      sourceHash: candidate.sourceHash,
      title: stringValue(rec.title) ?? candidate.title,
      category,
      inclusion,
      authority: normalizeAuthority(rec.authority),
      freshness: rec.freshness === 'stale' || rec.freshness === 'unknown' ? rec.freshness : 'current',
      injectionPolicy,
      summary,
      curatedContext,
      retrievalText,
      chunks,
      aliases: stringArray(rec.aliases).slice(0, 20),
      appliesToGlobs: stringArray(rec.appliesToGlobs).slice(0, 20),
      sourceAnchors: stringArray(rec.sourceAnchors).slice(0, 20),
      reasoning,
      curationVersion: CURATION_VERSION,
      promptVersion: PROMPT_VERSION,
      configHash: input.configHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return out;
}

function staleEntry(repoId: string, configHash: string, raw: Record<string, unknown>): CurationEntry {
  const path = stringValue(raw.path) ?? 'unknown';
  const sourceHash = stringValue(raw.sourceHash) ?? sha256(path);
  return {
    entryId: stableEntryId(repoId, path),
    repoId,
    path,
    sourceHash,
    title: stringValue(raw.title) ?? path,
    category: 'stale',
    inclusion: 'stale',
    authority: 'low',
    freshness: 'stale',
    injectionPolicy: 'never_full_auto',
    summary: 'Previously curated context file is no longer present in the tracked context inventory.',
    aliases: [],
    appliesToGlobs: [],
    sourceAnchors: [],
    reasoning: stringValue(raw.reason) ?? 'Deleted or excluded by current inventory.',
    stale: true,
    curationVersion: CURATION_VERSION,
    promptVersion: PROMPT_VERSION,
    configHash,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function baseStats(input: { candidates: CandidateContextFile[]; reusedEntries: CurationEntry[]; newOrChangedFiles: CandidateContextFile[]; deletedOrStaleFiles: Array<Record<string, unknown>> }): Record<string, number> {
  return {
    candidateFiles: input.candidates.length,
    reusedFiles: input.reusedEntries.length,
    newOrChangedFiles: input.newOrChangedFiles.length,
    deletedOrStaleFiles: input.deletedOrStaleFiles.length,
  };
}

function countStats(input: CurationRunInput, newEntries: CurationEntry[], staleEntries: CurationEntry[]): Record<string, number> {
  const all = [...input.reusedEntries, ...newEntries, ...staleEntries];
  return {
    ...baseStats(input),
    totalEntries: all.length,
    includedEntries: all.filter((entry) => entry.inclusion === 'include').length,
    excludedEntries: all.filter((entry) => entry.inclusion === 'exclude').length,
    staleEntries: all.filter((entry) => entry.inclusion === 'stale').length,
    mandatoryCandidates: 0,
    generatedContextEntries: all.filter((entry) => Boolean(entry.curatedContext || entry.retrievalText || entry.chunks?.length)).length,
    generatedChunks: all.reduce((sum, entry) => sum + (entry.chunks?.length ?? 0), 0),
  };
}

function compactEntryForPrompt(entry: CurationEntry): Record<string, unknown> {
  return {
    path: entry.path,
    sourceHash: entry.sourceHash,
    title: entry.title,
    category: entry.category,
    inclusion: entry.inclusion,
    injectionPolicy: entry.injectionPolicy,
    summary: entry.summary,
    curatedContextPreview: entry.curatedContext?.slice(0, 500),
  };
}

function compactStageStatusForPrompt(status: {
  runId: string;
  status: string;
  expectedFiles: number;
  stagedEntries: number;
  validEntries: number;
  stagedStatuses: number;
  completedFiles: number;
  missingFiles: CandidateContextFile[];
  invalidFiles: CandidateContextFile[];
  duplicateStatusFiles: CandidateContextFile[];
  retryFiles: CandidateContextFile[];
  promotable: boolean;
  diagnostics: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    runId: status.runId,
    status: status.status,
    expectedFiles: status.expectedFiles,
    stagedEntries: status.stagedEntries,
    validEntries: status.validEntries,
    stagedStatuses: status.stagedStatuses,
    completedFiles: status.completedFiles,
    missingFilesCount: status.missingFiles.length,
    invalidFilesCount: status.invalidFiles.length,
    duplicateStatusFilesCount: status.duplicateStatusFiles.length,
    retryFilesCount: status.retryFiles.length,
    retryFilesPreview: status.retryFiles.slice(0, 25),
    retryFilesTruncated: status.retryFiles.length > 25,
    promotable: status.promotable,
    diagnostics: status.diagnostics.slice(-10),
  };
}

function normalizeDiagnostics(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      code: stringValue(item.code) ?? 'curator_diagnostic',
      severity: ['info', 'warn', 'error'].includes(String(item.severity)) ? String(item.severity) : 'info',
      message: stringValue(item.message) ?? '',
      ...item,
    }));
}

function normalizeScope(value: unknown): CurationScopeInput {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    mode: stringValue(input.mode) ?? stringValue(input.scope),
    pattern: stringValue(input.pattern) ?? stringValue(input.path) ?? stringValue(input.glob),
    force: input.force === true || input.force === 'true',
  };
}

function filterCandidatesByScope(candidates: CandidateContextFile[], scope: CurationScopeInput): CandidateContextFile[] {
  return candidates.filter((candidate) => pathMatchesScope(candidate.path, scope));
}

function pathMatchesScope(rawPath: string, scope: CurationScopeInput): boolean {
  const mode = scope.mode?.toLowerCase();
  const pattern = scope.pattern?.toLowerCase();
  const path = rawPath.toLowerCase();
  if (pattern && !path.includes(pattern.replace(/\*/g, '').replace(/\/+$/, ''))) return false;
  if (!mode || mode === 'all' || mode === 'default') return true;
  if (mode === 'documents' || mode === 'docs') {
    return path.endsWith('.md') || path.endsWith('.mdx') || path.startsWith('docs/') || path.includes('/docs/') || path.includes('readme');
  }
  return path.includes(mode);
}

function normalizeCategory(value: unknown): string {
  const category = stringValue(value) ?? 'doc';
  return VALID_CATEGORIES.has(category) ? category : 'doc';
}

function normalizeInclusion(value: unknown): Inclusion {
  return VALID_INCLUSIONS.has(value as Inclusion) ? value as Inclusion : 'include';
}
function normalizePolicy(value: unknown): InjectionPolicy {
  if (value === 'mandatory_full') return 'snippet';
  return VALID_POLICIES.has(value as InjectionPolicy) ? value as InjectionPolicy : 'manifest_only';
}
function normalizeAuthority(value: unknown): Authority { return VALID_AUTHORITY.has(value as Authority) ? value as Authority : 'medium'; }

function stableEntryId(repoId: string, path: string): string {
  return `curation:${repoId}:${path.toLowerCase().replace(/[^a-z0-9._/-]+/g, '-')}`;
}
function normalizeChunks(value: unknown): CurationChunk[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => ({
      chunkId: stringValue(item.chunkId) ?? `chunk-${index + 1}`,
      heading: stringValue(item.heading) ?? `Chunk ${index + 1}`,
      targetGlobs: stringArray(item.targetGlobs).slice(0, 20),
      targetRoles: stringArray(item.targetRoles).slice(0, 20),
      text: stringValue(item.text) ?? '',
      sourceAnchors: stringArray(item.sourceAnchors).slice(0, 20),
    }))
    .filter((chunk) => chunk.text);
}
function previewText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}
function appendReason(reasoning: string, addition: string): string {
  return [reasoning, addition].filter(Boolean).join(' ');
}
function isStaleDate(value: unknown): boolean {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return true;
  return Date.now() - date.getTime() > STALE_RUNNING_PROFILE_MS;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}
