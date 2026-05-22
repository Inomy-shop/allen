import { createHash, randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';
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

  constructor(private db: Db) {
    this.profiles = db.collection<CurationProfile>('repo_context_curation_profiles');
    this.entries = db.collection<CurationEntry>('repo_context_curation_entries');
    this.repos = db.collection('repos');
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
    const input = await this.buildRunInput(repo, scope);
    const executionId = stringValue(body.source_execution_id) ?? stringValue(body.execution_id);
    const profile = executionId
      ? await this.createProfileForExecution(input, executionId, 'Context curation coordinator prepared')
      : await this.createRunningProfile(input, 'Context curation coordinator prepared', { source: 'agent_run', prompt: stringValue(body.prompt) });
    const run = await createRepoContextCurationRun(this.db, {
      executionId: profile.executionId!,
      profileId: profile.profileId,
      repoId: input.repoId,
      repoName: input.repoName,
      expectedFiles: input.newOrChangedFiles,
      scope,
    });
    const stageStatus = await getRepoContextCurationStageStatus(this.db, String(run.runId));
    const filesToCurate = stageStatus.retryFiles.length ? stageStatus.retryFiles : input.newOrChangedFiles;
    const filesPreviewLimit = 50;
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
    const input = await this.buildRunInput(repo, normalizeScope(run.scope));
    const expectedFiles = normalizeCandidateFiles(run.expectedFiles);
    const inputForSave = { ...input, newOrChangedFiles: expectedFiles };
    const newEntries = normalizeCuratorEntries({
      repoId: input.repoId,
      configHash: input.configHash,
      candidates: expectedFiles,
      rawEntries: stage.entries,
    });
    const diagnostics = [...input.diagnostics, ...normalizeDiagnostics(stage.diagnostics)];
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

  private async buildRunInput(repo: Record<string, unknown>, scope: CurationScopeInput = {}): Promise<CurationRunInput> {
    const repoId = String(repo._id);
    const repoName = String(repo.name ?? 'repo');
    const repoPath = String(repo.path ?? '');
    if (!repoPath) throw new Error('Repo path is missing');
    const defaultBranch = resolveDefaultBranchName(repo);
    const [inventory, roleInventoryFull, spawnedRoleInventoryFull] = await Promise.all([
      collectDefaultBranchContextFiles(repoPath, defaultBranch),
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
      .map((entry) => ({ path: entry.path, sourceHash: entry.sourceHash, title: entry.title, reason: 'File is no longer in the tracked context inventory.' }));

    return {
      repoId,
      repoName,
      repoPath,
      branch: inventory.branch,
      gitRef: inventory.ref,
      headSha: inventory.headSha,
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
    const now = new Date();
    for (const entry of input.newEntries) {
      const { createdAt: _createdAt, ...entryForSet } = entry;
      await this.entries.updateOne(
        {
          repoId: entry.repoId,
          path: entry.path,
          sourceHash: entry.sourceHash,
          curationVersion: CURATION_VERSION,
        },
        { $set: { ...entryForSet, updatedAt: now }, $setOnInsert: { createdAt: entry.createdAt ?? now } },
        { upsert: true },
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
    await this.db.collection('executions').updateOne(
      { id: executionId },
      {
        $set: {
          status: 'running',
          currentNodes: ['repo-context-curator'],
          'meta.curationProfile': true,
          'meta.cwd': input.repoPath,
          'input.repo_id': input.repoId,
          'input.repo_path': input.repoPath,
        },
      },
    );
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
    await this.db.collection('executions').insertOne({
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
    });
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
    await this.db.collection('executions').updateOne(
      { id: input.executionId },
      {
        $set: {
          status: 'completed',
          completedNodes: ['repo-context-curator'],
          currentNodes: [],
          cost: { actual: 0, estimated: 0 },
          durationMs: input.durationMs,
          completedAt,
        },
        $unset: { errorMessage: '' },
      },
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
    const chunks = normalizeChunks(rec.chunks);
    const curatedContext = stringValue(rec.curatedContext);
    const retrievalText = stringValue(rec.retrievalText) ?? curatedContext ?? chunks.map((chunk) => chunk.text).join('\n\n').trim();
    const inclusion = normalizeInclusion(rec.inclusion);
    if (inclusion === 'include' && !curatedContext && !retrievalText && chunks.length === 0) continue;
    out.push({
      entryId: stableEntryId(input.repoId, candidate.path),
      repoId: input.repoId,
      path: candidate.path,
      sourceHash: candidate.sourceHash,
      title: stringValue(rec.title) ?? candidate.title,
      category: normalizeCategory(rec.category),
      inclusion,
      authority: normalizeAuthority(rec.authority),
      freshness: rec.freshness === 'stale' || rec.freshness === 'unknown' ? rec.freshness : 'current',
      injectionPolicy: normalizePolicy(rec.injectionPolicy),
      summary: stringValue(rec.summary) ?? previewText(curatedContext ?? retrievalText ?? chunks[0]?.text ?? ''),
      curatedContext,
      retrievalText,
      chunks,
      aliases: stringArray(rec.aliases).slice(0, 20),
      appliesToGlobs: stringArray(rec.appliesToGlobs).slice(0, 20),
      sourceAnchors: stringArray(rec.sourceAnchors).slice(0, 20),
      reasoning: stringValue(rec.reasoning) ?? '',
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
  const explicitSubagentScope = scopeExplicitlyTargetsSubagentFiles(scope);
  return candidates.filter((candidate) => {
    if (!explicitSubagentScope && isSubagentPersonaPath(candidate.path)) return false;
    return pathMatchesScope(candidate.path, scope);
  });
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

function scopeExplicitlyTargetsSubagentFiles(scope: CurationScopeInput): boolean {
  const haystack = `${scope.mode ?? ''} ${scope.pattern ?? ''}`.toLowerCase();
  return Boolean(haystack.match(/(\.claude\/agents|\.agents\/|subagent|sub-agent|agent persona|agent_persona|persona)/));
}

function isSubagentPersonaPath(rawPath: string): boolean {
  const path = rawPath.toLowerCase();
  if (isAgentMemoryOrLearningPath(path)) return false;
  return /^\.claude\/agents\/[^/]+\.md$/.test(path)
    || /^\.claude\/agents\/[^/]+\/[^/]+\.md$/.test(path)
    || /^\.claude\/agents\/[^/]+\/agents\/[^/]+\.md$/.test(path)
    || /^\.agents\/.+\.md$/.test(path);
}

function isAgentMemoryOrLearningPath(path: string): boolean {
  const basename = path.split('/').pop() ?? path;
  return /(^|\/)(memory|memories)(\/|$)/.test(path)
    || /(learning|learnings|memory|memories)/.test(basename);
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
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function isStaleDate(value: unknown): boolean {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return true;
  return Date.now() - date.getTime() > STALE_RUNNING_PROFILE_MS;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
