import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, normalize, relative, isAbsolute } from 'node:path';
import { ObjectId, type Collection, type Db } from 'mongodb';
import {
  cogneeDataDir,
  cogneeDatasetName,
  isCogneeCorruptWalError,
  isCogneeSidecarStoppedError,
  recoverCogneeGraphWalFiles,
  runCogneeSidecar,
  type CogneeSidecarProgress,
} from '../repo-context-cognee-provider.js';
import { normalizeUsageArray } from '../knowledge-graph/repo-knowledge-graph-usage.js';
import { contextProviderDisabledError, isCogneeContextEnabled } from '../context-provider-config.js';

const exec = promisify(execFile);
const DEFAULT_COGNEE_STALE_MS = 10 * 60_000;
const COGNEE_FILE_MANIFEST_VERSION = 1;
const COGNEE_INGEST_FORMAT = 'markdown_file_docmeta_v1';

type CogneeBuildStage = 'pulling' | 'collecting_markdown' | 'ingesting' | 'cognifying' | 'completed' | 'failed';
type CogneeDatasetStatusValue = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'stopped';
type CogneeBuildMode = 'resume' | 'clean_rebuild';
type UncognifiedCogneeDocument = {
  path?: string;
  title?: string;
  fileHash?: string;
  dataId?: string;
  cogneeDataId?: string;
  status?: string;
};

type CogneeDatasetStatus = {
  repoId: string;
  repoName?: string;
  repoPath: string;
  sourcePath?: string;
  source?: string;
  branch: string;
  datasetName: string;
  previousDatasetName?: string;
  buildMode?: CogneeBuildMode;
  headSha?: string;
  status: CogneeDatasetStatusValue;
  stage?: CogneeBuildStage;
  message?: string;
  documentCount?: number;
  candidateCount?: number;
  processedDocumentCount?: number;
  ingestedDocumentCount?: number;
  cognifiedDocumentCount?: number;
  documentsToIngestCount?: number;
  addedDocumentCount?: number;
  changedDocumentCount?: number;
  deletedDocumentCount?: number;
  unchangedDocumentCount?: number;
  uncognifiedRetryCount?: number;
  manifestVersion?: number;
  ingestFormat?: string;
  manifest?: CogneeFileManifest;
  storageRoot?: string;
  systemRoot?: string;
  databasePath?: string;
  storageExisting?: boolean;
  datasetExisting?: boolean;
  workerActive?: boolean;
  fileHashes?: Array<{ path?: string; hash: string; kind?: string }>;
  uncognifiedDocuments?: UncognifiedCogneeDocument[];
  diagnostics?: Array<Record<string, unknown>>;
  error?: string;
  stopRequestedAt?: Date;
  lastStartedAt?: Date;
  lastCompletedAt?: Date;
  updatedAt: Date;
  createdAt: Date;
};

type CogneeFileManifest = {
  version: typeof COGNEE_FILE_MANIFEST_VERSION;
  ingestFormat: typeof COGNEE_INGEST_FORMAT;
  repoId: string;
  repoName?: string;
  branch?: string;
  headSha?: string;
  documentCount: number;
  createdAt: string;
  documents: Array<{ title: string; path?: string; kind?: string; hash: string; dataId: string }>;
};

type CollectedCogneeDocument = { title: string; path?: string; kind?: string; content: string; hash: string };
type CogneePayloadDocument = CollectedCogneeDocument & {
  dataId: string;
  externalMetadata: Record<string, unknown>;
  changeType: 'current';
};

export class CogneeMemoryService {
  private statuses: Collection<CogneeDatasetStatus>;
  private repos: Collection;
  private runningBuilds = new Set<string>();
  private buildControllers = new Map<string, AbortController>();
  private progressQueues = new Map<string, Promise<void>>();

  constructor(private db: Db) {
    this.statuses = db.collection<CogneeDatasetStatus>('repo_cognee_datasets');
    this.repos = db.collection('repos');
  }

  async getStatus(repoId: string): Promise<CogneeDatasetStatus | null> {
    if (!isCogneeContextEnabled()) return null;
    const status = await this.statuses.findOne({ repoId });
    if (status?.status === 'running' && !this.runningBuilds.has(repoId) && isStaleRunningStatus(status)) {
      await this.markStaleFailed(repoId, status);
      return this.decorateStatus(await this.statuses.findOne({ repoId }));
    }
    return this.decorateStatus(status);
  }

  async refreshRepo(repoId: string, options: { pullLatest?: boolean; cleanRebuild?: boolean } = {}): Promise<CogneeDatasetStatus> {
    if (!isCogneeContextEnabled()) throw contextProviderDisabledError('Cognee context provider is disabled.');
    const input = await this.resolveRepoInput(repoId, options);
    const controller = new AbortController();
    this.runningBuilds.add(repoId);
    this.buildControllers.set(repoId, controller);
    try {
      return await this.refreshRepoFromSource(input, [], controller);
    } finally {
      if (this.buildControllers.get(repoId) === controller) this.buildControllers.delete(repoId);
      this.runningBuilds.delete(repoId);
    }
  }

  async scheduleRefreshRepo(repoId: string, options: { pullLatest?: boolean; cleanRebuild?: boolean } = {}): Promise<CogneeDatasetStatus> {
    if (!isCogneeContextEnabled()) throw contextProviderDisabledError('Cognee context provider is disabled.');
    const existing = await this.statuses.findOne({ repoId });
    if (this.runningBuilds.has(repoId)) {
      return this.decorateStatus(existing ?? await this.createInitialRunningStatus(await this.resolveRepoInput(repoId, options)))!;
    }
    const interruptedDiagnostics = existing?.status === 'running'
      ? await this.markInterruptedFailed(repoId, existing)
      : [];
    const input = await this.resolveRepoInput(repoId, options);
    const status = await this.createInitialRunningStatus(input, interruptedDiagnostics);
    const controller = new AbortController();
    this.runningBuilds.add(repoId);
    this.buildControllers.set(repoId, controller);
    void this.refreshRepoFromSource(input, interruptedDiagnostics, controller)
      .catch((err) => this.markFailed(repoId, err))
      .finally(() => {
        if (this.buildControllers.get(repoId) === controller) this.buildControllers.delete(repoId);
        this.runningBuilds.delete(repoId);
      });
    return this.decorateStatus(status)!;
  }

  async stopRefreshRepo(repoId: string): Promise<CogneeDatasetStatus> {
    if (!isCogneeContextEnabled()) throw contextProviderDisabledError('Cognee context provider is disabled.');
    const existing = await this.statuses.findOne({ repoId });
    const controller = this.buildControllers.get(repoId);
    if (controller) {
      controller.abort();
      await this.markStopped(repoId, existing, { noWorker: false });
    } else if (existing?.status === 'running') {
      await this.markStopped(repoId, existing, { noWorker: true });
    } else if (!existing) {
      throw new Error('No Cognee dataset found for repo');
    }
    const status = await this.getStatus(repoId);
    if (!status) throw new Error('No Cognee dataset found for repo');
    return status;
  }

  private decorateStatus(status: CogneeDatasetStatus | null): CogneeDatasetStatus | null {
    if (!status) return null;
    if (status.status !== 'running') return status;
    return {
      ...status,
      workerActive: this.runningBuilds.has(status.repoId),
    };
  }

  private async resolveRepoInput(repoId: string, options: { pullLatest?: boolean; cleanRebuild?: boolean } = {}): Promise<{
    repoId: string;
    repoName: string;
    repoPath: string;
    sourcePath: string;
    defaultBranch: string;
    pullLatest: boolean;
    datasetName: string;
    previousDatasetName?: string;
    buildMode: CogneeBuildMode;
  }> {
    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo?.path || typeof repo.path !== 'string') throw new Error('Repo not found');
    const repoName = String(repo.name ?? '');
    const existing = await this.statuses.findOne({ repoId });
    const defaultBranch = String((repo.detected as { defaultBranch?: unknown } | undefined)?.defaultBranch ?? repo.defaultBranch ?? 'main');
    const cleanRebuild = options.cleanRebuild === true;
    const canonicalDatasetName = cogneeDatasetName(repoId, repoName || 'repo');
    return {
      repoId,
      repoName,
      repoPath: String(repo.path),
      sourcePath: String(repo.path),
      defaultBranch,
      pullLatest: options.pullLatest === true,
      datasetName: cleanRebuild
        ? cogneeRunDatasetName(repoId, repoName || 'repo')
        : existing?.datasetName ?? canonicalDatasetName,
      previousDatasetName: cleanRebuild ? existing?.datasetName : undefined,
      buildMode: cleanRebuild ? 'clean_rebuild' : 'resume',
    };
  }

  private async refreshRepoFromSource(input: {
    repoId: string;
    repoName: string;
    repoPath: string;
    sourcePath: string;
    defaultBranch: string;
    pullLatest: boolean;
    datasetName: string;
    previousDatasetName?: string;
    buildMode: CogneeBuildMode;
  }, initialDiagnostics: Array<Record<string, unknown>> = [], controller?: AbortController): Promise<CogneeDatasetStatus> {
    const { repoId, repoName, repoPath, sourcePath } = input;
    const preflightDiagnostics: Array<Record<string, unknown>> = [...initialDiagnostics];
    await this.createInitialRunningStatus(input, initialDiagnostics);
    if (input.pullLatest) {
      await this.updateProgress(repoId, {
        stage: 'pulling',
        message: `Pulling latest ${input.defaultBranch} before building Cognee context`,
      });
      preflightDiagnostics.push(...await updateDefaultBranch(sourcePath, input.defaultBranch));
    }
    const branch = await gitOutput(sourcePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => input.defaultBranch);
    const headSha = await gitOutput(sourcePath, ['rev-parse', 'HEAD']).catch(() => undefined);
    const datasetName = input.datasetName;
    await this.statuses.updateOne(
      { repoId },
      {
        $set: {
          branch,
          headSha,
          updatedAt: new Date(),
        },
      },
    );

    try {
      await this.updateProgress(repoId, {
        stage: 'collecting_markdown',
        message: 'Collecting tracked Markdown files for Cognee context',
      });
      const { documents, diagnostics: collectionDiagnostics } = await this.collectDocuments(sourcePath);
      const manifest = buildCogneeFileManifest({
        repoId,
        repoName,
        branch,
        headSha,
        documents,
      });
      const payloadDocuments = documents.map((document): CogneePayloadDocument => ({
        ...document,
        dataId: stableUuid(`${repoId}:${document.path ?? document.title}`),
        changeType: 'current',
        externalMetadata: cogneeExternalMetadata({
          repoId,
          repoName,
          repoPath,
          sourcePath,
          branch,
          headSha,
        }, document),
      }));
      const diffDiagnostics = [{
        code: 'cognee_db_diff_pending',
        severity: 'info',
        message: 'Cognee sidecar will compare current Markdown files with Cognee database metadata before adding or deleting documents.',
      }];
      await this.updateProgress(repoId, {
        stage: 'ingesting',
        message: `Checking Cognee database for ${documents.length} Markdown file${documents.length === 1 ? '' : 's'}`,
        candidateCount: Number(collectionDiagnostics[0]?.candidateCount ?? documents.length),
        documentCount: documents.length,
        processedDocumentCount: 0,
        ingestedDocumentCount: 0,
        cognifiedDocumentCount: 0,
        manifestVersion: COGNEE_FILE_MANIFEST_VERSION,
        ingestFormat: COGNEE_INGEST_FORMAT,
        manifest,
        diagnostics: [...preflightDiagnostics, ...collectionDiagnostics, ...diffDiagnostics],
      });
      const sidecarPayload = {
        dataDir: cogneeDataDir(),
        datasetName,
        repo: { repoId, repoName, repoPath, sourcePath, branch, headSha },
        ingestFormat: COGNEE_INGEST_FORMAT,
        chunkSize: cogneeCognifyChunkSize(),
        totalDocumentCount: documents.length,
        documents: payloadDocuments,
      };
      const handleProgress = (progress: CogneeSidecarProgress) => {
        this.queueProgress(repoId, progress);
      };
      let result: Record<string, unknown>;
      try {
        result = await runCogneeSidecar('ingest', sidecarPayload, handleProgress, { signal: controller?.signal });
      } catch (err) {
        if (!isCogneeCorruptWalError(err)) throw err;
        const recoveryDiagnostics = await recoverCogneeGraphWalFiles(cogneeDataDir());
        preflightDiagnostics.push(...recoveryDiagnostics);
        await this.updateProgress(repoId, {
          message: 'Recovered corrupted Cognee graph WAL; retrying context build',
          diagnostics: [...preflightDiagnostics, ...collectionDiagnostics, ...diffDiagnostics],
        });
        result = await runCogneeSidecar('ingest', sidecarPayload, handleProgress, { signal: controller?.signal });
      }
      await this.flushProgress(repoId);
      const ingestedDocumentCount = resultNumber(result.ingestedDocumentCount) ?? documents.length;
      const cognifiedDocumentCount = resultNumber(result.cognifiedDocumentCount) ?? documents.length;
      const uncognifiedDocuments = normalizeUncognifiedDocuments(result.uncognifiedDocuments);
      const partial = cognifiedDocumentCount < ingestedDocumentCount;
      const partialDiagnostics = partial
        ? [{
            code: 'cognee_cognify_partial',
            severity: 'warn',
            message: `Cognee cognified ${cognifiedDocumentCount}/${ingestedDocumentCount} ingested Markdown files.`,
            ingestedDocumentCount,
            cognifiedDocumentCount,
            uncognifiedDocuments,
          }]
        : [];
      const completed: Partial<CogneeDatasetStatus> = {
        status: partial ? 'partial' : 'completed',
        stage: 'completed',
        message: partial
          ? `Context partially built: ${cognifiedDocumentCount}/${ingestedDocumentCount} Markdown files cognified`
          : `Context built from ${documents.length} Markdown file${documents.length === 1 ? '' : 's'}`,
        documentCount: documents.length,
        processedDocumentCount: documents.length,
        ingestedDocumentCount,
        cognifiedDocumentCount,
        documentsToIngestCount: resultNumber(result.documentsToIngestCount) ?? resultNumber(result.addedDocumentCount),
        addedDocumentCount: resultNumber(result.addedDocumentCount),
        changedDocumentCount: resultNumber(result.changedDocumentCount),
        deletedDocumentCount: resultNumber(result.deletedDocumentCount),
        unchangedDocumentCount: resultNumber(result.unchangedDocumentCount),
        uncognifiedRetryCount: resultNumber(result.uncognifiedRetryCount),
        manifestVersion: COGNEE_FILE_MANIFEST_VERSION,
        ingestFormat: COGNEE_INGEST_FORMAT,
        manifest,
        storageRoot: resultString(result.storageRoot),
        systemRoot: resultString(result.systemRoot),
        databasePath: resultString(result.databasePath),
        storageExisting: resultBoolean(result.storageExisting),
        datasetExisting: resultBoolean(result.datasetExisting),
        fileHashes: documents.map((doc) => ({ path: doc.path, kind: doc.kind, hash: doc.hash })),
        uncognifiedDocuments: partial ? uncognifiedDocuments : undefined,
        diagnostics: [...preflightDiagnostics, ...collectionDiagnostics, ...diffDiagnostics, ...normalizeUsageArray(result.diagnostics), ...partialDiagnostics],
        lastCompletedAt: new Date(),
        updatedAt: new Date(),
      };
      await this.statuses.updateOne(
        { repoId, status: 'running' },
        {
          $set: definedValues(completed),
          $unset: {
            error: '',
            stopRequestedAt: '',
            ...(partial ? {} : { uncognifiedDocuments: '' }),
          },
        },
      );
    } catch (err) {
      await this.flushProgress(repoId).catch(() => undefined);
      if (isCogneeSidecarStoppedError(err)) {
        await this.markStopped(repoId, await this.statuses.findOne({ repoId }), { noWorker: false });
      } else {
        await this.markFailed(repoId, err);
      }
    }
    const status = await this.getStatus(repoId);
    if (!status) throw new Error('Failed to load Cognee dataset status after refresh');
    return status;
  }

  private async createInitialRunningStatus(input: {
    repoId: string;
    repoName: string;
    repoPath: string;
    sourcePath: string;
    defaultBranch: string;
    pullLatest: boolean;
    datasetName: string;
    previousDatasetName?: string;
    buildMode: CogneeBuildMode;
  }, diagnostics: Array<Record<string, unknown>> = []): Promise<CogneeDatasetStatus> {
    const now = new Date();
    const status: CogneeDatasetStatus = {
      repoId: input.repoId,
      repoName: input.repoName,
      repoPath: input.repoPath,
      sourcePath: input.sourcePath,
      source: 'markdown_file_filter',
      branch: input.defaultBranch,
      datasetName: input.datasetName,
      previousDatasetName: input.previousDatasetName,
      buildMode: input.buildMode,
      status: 'running',
      stage: input.pullLatest ? 'pulling' : 'collecting_markdown',
      message: input.pullLatest
        ? `Pulling latest ${input.defaultBranch} before building Cognee context`
        : 'Collecting tracked Markdown files for Cognee context',
      diagnostics,
      processedDocumentCount: 0,
      ingestedDocumentCount: 0,
      cognifiedDocumentCount: 0,
      lastStartedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.statuses.updateOne(
      { repoId: input.repoId },
      {
        $set: definedValues({
          repoId: status.repoId,
          repoName: status.repoName,
          repoPath: status.repoPath,
          sourcePath: status.sourcePath,
          source: status.source,
          branch: status.branch,
          datasetName: status.datasetName,
          previousDatasetName: status.previousDatasetName,
          buildMode: status.buildMode,
          status: status.status,
          stage: status.stage,
          message: status.message,
          diagnostics: status.diagnostics,
          processedDocumentCount: status.processedDocumentCount,
          ingestedDocumentCount: status.ingestedDocumentCount,
          cognifiedDocumentCount: status.cognifiedDocumentCount,
          storageRoot: status.storageRoot,
          systemRoot: status.systemRoot,
          databasePath: status.databasePath,
          storageExisting: status.storageExisting,
          datasetExisting: status.datasetExisting,
          uncognifiedDocuments: status.uncognifiedDocuments,
          lastStartedAt: status.lastStartedAt,
          updatedAt: status.updatedAt,
        }),
        $unset: {
          error: '',
          lastCompletedAt: '',
          sourceWorkspaceId: '',
          manifest: '',
          manifestVersion: '',
          ingestFormat: '',
          fileHashes: '',
          stopRequestedAt: '',
          uncognifiedDocuments: '',
          ...(input.previousDatasetName ? {} : { previousDatasetName: '' }),
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    const saved = await this.getStatus(input.repoId);
    if (!saved) throw new Error('Failed to create Cognee dataset status');
    return saved;
  }

  private async updateProgress(repoId: string, updates: Partial<CogneeDatasetStatus>): Promise<void> {
    const current = await this.statuses.findOne({ repoId });
    if (!current || current.status !== 'running' || !isProgressAllowed(current, updates)) return;
    await this.statuses.updateOne(
      { repoId, status: 'running' },
      {
        $set: definedValues({
          ...updates,
          status: 'running',
          updatedAt: new Date(),
        }),
      },
    );
  }

  private async applySidecarProgress(repoId: string, progress: CogneeSidecarProgress): Promise<void> {
    const stage = normalizeStage(progress.stage);
    const current = await this.statuses.findOne({ repoId });
    const progressDiagnostic = cogneeDbDiffDiagnosticFromProgress(progress);
    const diagnostics = progressDiagnostic && !hasDiagnosticCode(current?.diagnostics, 'cognee_db_diff')
      ? [...(current?.diagnostics ?? []), progressDiagnostic]
      : undefined;
    await this.updateProgress(repoId, {
      stage,
      message: progress.message,
      processedDocumentCount: progress.processedDocumentCount,
      ingestedDocumentCount: progress.ingestedDocumentCount,
      cognifiedDocumentCount: progress.cognifiedDocumentCount,
      documentCount: progress.documentCount,
      candidateCount: progress.candidateCount,
      documentsToIngestCount: progress.documentsToIngestCount,
      addedDocumentCount: progress.addedDocumentCount,
      changedDocumentCount: progress.changedDocumentCount,
      deletedDocumentCount: progress.deletedDocumentCount,
      unchangedDocumentCount: progress.unchangedDocumentCount,
      uncognifiedRetryCount: progress.uncognifiedRetryCount,
      storageRoot: progress.storageRoot,
      systemRoot: progress.systemRoot,
      databasePath: progress.databasePath,
      storageExisting: progress.storageExisting,
      datasetExisting: progress.datasetExisting,
      diagnostics,
    });
  }

  private queueProgress(repoId: string, progress: CogneeSidecarProgress): void {
    const previous = this.progressQueues.get(repoId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.applySidecarProgress(repoId, progress));
    this.progressQueues.set(repoId, next);
    void next.catch(() => undefined);
  }

  private async flushProgress(repoId: string): Promise<void> {
    while (true) {
      const pending = this.progressQueues.get(repoId);
      if (!pending) return;
      await pending;
      if (this.progressQueues.get(repoId) === pending) {
        this.progressQueues.delete(repoId);
        return;
      }
    }
  }

  private async markFailed(repoId: string, err: unknown): Promise<void> {
    const current = await this.statuses.findOne({ repoId });
    const uncognifiedDocuments = uncognifiedDocumentsFromStatus(current);
    await this.statuses.updateOne(
      { repoId, status: 'running' },
      {
        $set: definedValues({
          status: 'failed',
          stage: 'failed',
          message: 'Cognee context build failed',
          error: (err as Error).message,
          uncognifiedDocuments,
          diagnostics: [
            ...(current?.diagnostics ?? []),
            { code: 'cognee_ingest_failed', severity: 'warn', message: (err as Error).message },
          ],
          updatedAt: new Date(),
        }),
      },
    );
  }

  private async markStopped(repoId: string, status: CogneeDatasetStatus | null, options: { noWorker: boolean }): Promise<void> {
    const message = options.noWorker
      ? 'Cognee context build stop requested, but no live worker was found'
      : 'Cognee context build stopped by user';
    await this.statuses.updateOne(
      { repoId, status: 'running' },
      {
        $set: {
          status: 'stopped',
          stage: 'failed',
          message,
          error: message,
          stopRequestedAt: new Date(),
          diagnostics: [
            ...(status?.diagnostics ?? []),
            {
              code: options.noWorker ? 'cognee_build_stop_no_worker' : 'cognee_build_stopped',
              severity: 'warn',
              stage: status?.stage,
              message,
            },
          ],
          updatedAt: new Date(),
        },
      },
    );
  }

  private async markInterruptedFailed(repoId: string, status: CogneeDatasetStatus): Promise<Array<Record<string, unknown>>> {
    const message = `Cognee context build was interrupted at ${status.stage ?? 'unknown'} because Allen restarted or the worker was lost`;
    const uncognifiedDocuments = uncognifiedDocumentsFromStatus(status);
    const diagnostics = [
      ...(status.diagnostics ?? []),
      {
        code: 'cognee_build_interrupted',
        severity: 'warn',
        stage: status.stage,
        updatedAt: status.updatedAt,
        message,
      },
    ];
    await this.statuses.updateOne(
      { repoId, status: 'running' },
      {
        $set: definedValues({
          status: 'failed',
          stage: 'failed',
          message,
          error: message,
          uncognifiedDocuments,
          diagnostics,
          updatedAt: new Date(),
        }),
      },
    );
    return diagnostics;
  }

  private async markStaleFailed(repoId: string, status: CogneeDatasetStatus): Promise<void> {
    const message = `Cognee context build became stale at ${status.stage ?? 'unknown'} because Allen restarted or the worker was lost`;
    const uncognifiedDocuments = uncognifiedDocumentsFromStatus(status);
    await this.statuses.updateOne(
      { repoId, status: 'running' },
      {
        $set: definedValues({
          status: 'failed',
          stage: 'failed',
          message,
          error: message,
          uncognifiedDocuments,
          diagnostics: [
            ...(status.diagnostics ?? []),
            {
              code: 'cognee_build_stale',
              severity: 'warn',
              stage: status.stage,
              updatedAt: status.updatedAt,
              message,
            },
          ],
          updatedAt: new Date(),
        }),
      },
    );
  }

  private async collectDocuments(repoPath: string): Promise<{
    documents: CollectedCogneeDocument[];
    diagnostics: Array<Record<string, unknown>>;
  }> {
    const files = await listTrackedMarkdownFiles(repoPath);
    const docs: CollectedCogneeDocument[] = [];
    const diagnostics: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const maxBytes = maxMarkdownFileBytes();
    for (const path of files) {
      const safePath = safeRepoPath(repoPath, path);
      if (!safePath) {
        diagnostics.push({ code: 'cognee_md_skipped_unsafe_path', severity: 'warn', path });
        continue;
      }
      const fileStat = await stat(safePath).catch(() => null);
      if (!fileStat?.isFile()) {
        diagnostics.push({ code: 'cognee_md_skipped_not_file', severity: 'info', path });
        continue;
      }
      if (fileStat.size > maxBytes) {
        diagnostics.push({ code: 'cognee_md_skipped_too_large', severity: 'warn', path, bytes: fileStat.size, maxBytes });
        continue;
      }
      const content = await readFile(safePath, 'utf8').catch((err) => {
        diagnostics.push({ code: 'cognee_md_read_failed', severity: 'warn', path, message: (err as Error).message });
        return '';
      });
      if (!content.trim()) {
        diagnostics.push({ code: 'cognee_md_skipped_empty', severity: 'info', path });
        continue;
      }
      const hash = sha256(content);
      if (seen.has(hash)) {
        diagnostics.push({ code: 'cognee_md_skipped_duplicate_content', severity: 'info', path });
        continue;
      }
      seen.add(hash);
      docs.push({
        title: markdownTitle(content) ?? path,
        path,
        kind: 'doc',
        content,
        hash,
      });
    }
    diagnostics.unshift({ code: 'cognee_md_collection_complete', severity: 'info', documentCount: docs.length, candidateCount: files.length });
    return { documents: docs, diagnostics };
  }
}

function safeRepoPath(repoPath: string, rawPath: string): string | null {
  const normalized = normalize(rawPath.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes('/../')) return null;
  const fullPath = join(repoPath, normalized);
  const rel = relative(repoPath, fullPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? fullPath : null;
}

function normalizeStage(value: unknown): CogneeBuildStage {
  const stage = String(value ?? '');
  return stage === 'pulling'
    || stage === 'collecting_markdown'
    || stage === 'ingesting'
    || stage === 'cognifying'
    || stage === 'completed'
    || stage === 'failed'
    ? stage
    : 'ingesting';
}

function definedValues<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function resultString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function resultBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function resultNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeUncognifiedDocuments(value: unknown): UncognifiedCogneeDocument[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => definedValues({
      path: resultString(item.path),
      title: resultString(item.title),
      fileHash: resultString(item.fileHash) ?? resultString(item.file_hash),
      dataId: resultString(item.dataId) ?? resultString(item.data_id),
      cogneeDataId: resultString(item.cogneeDataId) ?? resultString(item.cognee_data_id) ?? resultString(item.id),
      status: resultString(item.status),
    }) as UncognifiedCogneeDocument)
    .filter((item) => Object.keys(item).length > 0);
}

function hasDiagnosticCode(diagnostics: Array<Record<string, unknown>> | undefined, code: string): boolean {
  return Boolean(diagnostics?.some((diagnostic) => diagnostic.code === code));
}

function cogneeDbDiffDiagnosticFromProgress(progress: CogneeSidecarProgress): Record<string, unknown> | undefined {
  const unchangedDocumentCount = resultNumber(progress.unchangedDocumentCount);
  const documentsToIngestCount = resultNumber(progress.documentsToIngestCount);
  if (unchangedDocumentCount === undefined && documentsToIngestCount === undefined) return undefined;
  return definedValues({
    code: 'cognee_db_diff',
    severity: 'info',
    message: progress.message,
    addedDocumentCount: resultNumber(progress.addedDocumentCount),
    changedDocumentCount: resultNumber(progress.changedDocumentCount),
    deletedDocumentCount: resultNumber(progress.deletedDocumentCount),
    unchangedDocumentCount,
    documentsToIngestCount,
    uncognifiedRetryCount: resultNumber(progress.uncognifiedRetryCount),
  });
}

function isProgressAllowed(current: CogneeDatasetStatus, updates: Partial<CogneeDatasetStatus>): boolean {
  if (!updates.stage) return true;
  const currentStage = current.stage ?? 'collecting_markdown';
  const nextStage = updates.stage;
  if (stageRank(nextStage) > stageRank(currentStage)) return true;
  if (stageRank(nextStage) < stageRank(currentStage)) return false;
  const currentProcessed = progressValueForStage(current, nextStage);
  const nextProcessed = progressValueForStage({ ...current, ...updates }, nextStage);
  return nextProcessed >= currentProcessed;
}

function progressValueForStage(status: Partial<CogneeDatasetStatus>, stage: CogneeBuildStage): number {
  const raw = stage === 'cognifying'
    ? status.cognifiedDocumentCount ?? status.processedDocumentCount
    : stage === 'ingesting'
      ? status.ingestedDocumentCount ?? status.processedDocumentCount
      : status.processedDocumentCount;
  const parsed = Number(raw ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stageRank(stage: CogneeBuildStage): number {
  switch (stage) {
    case 'pulling': return 10;
    case 'collecting_markdown': return 20;
    case 'ingesting': return 30;
    case 'cognifying': return 40;
    case 'completed': return 50;
    case 'failed': return 50;
  }
}

function isStaleRunningStatus(status: CogneeDatasetStatus): boolean {
  const updatedAt = status.updatedAt ?? status.lastStartedAt;
  const updatedAtMs = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) return true;
  const timeoutMs = Number(process.env.ALLEN_COGNEE_STALE_MS ?? DEFAULT_COGNEE_STALE_MS);
  const staleAfterMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_COGNEE_STALE_MS;
  return Date.now() - updatedAtMs > staleAfterMs;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd });
  return result.stdout.trim();
}

async function updateDefaultBranch(repoPath: string, branch: string): Promise<Array<Record<string, unknown>>> {
  const before = await gitOutput(repoPath, ['rev-parse', 'HEAD']).catch(() => undefined);
  await exec('git', ['fetch', 'origin'], { cwd: repoPath, timeout: 60_000 });
  await exec('git', ['checkout', branch], { cwd: repoPath, timeout: 30_000 });
  await exec('git', ['pull', 'origin', branch], { cwd: repoPath, timeout: 60_000 });
  const after = await gitOutput(repoPath, ['rev-parse', 'HEAD']).catch(() => undefined);
  return [{
    code: 'cognee_repo_default_branch_updated',
    severity: 'info',
    branch,
    before,
    after,
    updated: Boolean(before && after && before !== after),
  }];
}

async function listTrackedMarkdownFiles(repoPath: string): Promise<string[]> {
  const result = await exec('git', ['ls-files', '-z'], { cwd: repoPath });
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((path) => path.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

function markdownTitle(content: string): string | undefined {
  for (const line of content.split('\n').slice(0, 80)) {
    const match = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function maxMarkdownFileBytes(): number {
  const parsed = Number(process.env.ALLEN_COGNEE_MAX_MD_FILE_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1024 * 1024;
}

function cogneeCognifyChunkSize(): number {
  const parsed = Number(process.env.ALLEN_COGNEE_COGNIFY_CHUNK_SIZE);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4096;
}

function cogneeRunDatasetName(repoId: string, repoName: string): string {
  return `${cogneeDatasetName(repoId, repoName)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildCogneeFileManifest(input: {
  repoId: string;
  repoName?: string;
  branch?: string;
  headSha?: string;
  documents: Array<{ title: string; path?: string; kind?: string; hash: string }>;
}): CogneeFileManifest {
  return {
    version: COGNEE_FILE_MANIFEST_VERSION,
    ingestFormat: COGNEE_INGEST_FORMAT,
    repoId: input.repoId,
    repoName: input.repoName,
    branch: input.branch,
    headSha: input.headSha,
    documentCount: input.documents.length,
    createdAt: new Date().toISOString(),
    documents: input.documents.map((document) => ({
      title: document.title,
      path: document.path,
      kind: document.kind,
      hash: document.hash,
      dataId: stableUuid(`${input.repoId}:${document.path ?? document.title}`),
    })),
  };
}

function isCompatibleManifest(manifest: CogneeDatasetStatus['manifest']): manifest is CogneeFileManifest {
  return Boolean(
    manifest
      && manifest.version === COGNEE_FILE_MANIFEST_VERSION
      && manifest.ingestFormat === COGNEE_INGEST_FORMAT
      && Array.isArray(manifest.documents),
  );
}

function cogneeExternalMetadata(input: {
  repoId: string;
  repoName: string;
  repoPath: string;
  sourcePath: string;
  branch?: string;
  headSha?: string;
}, document: CollectedCogneeDocument): Record<string, unknown> {
  return {
    repoId: input.repoId,
    repoName: input.repoName,
    branch: input.branch,
    headSha: input.headSha,
    path: document.path,
    title: document.title,
    kind: document.kind,
    fileHash: document.hash,
    source: 'allen_markdown_file_filter',
    ingestFormat: COGNEE_INGEST_FORMAT,
  };
}

function uncognifiedDocumentsFromStatus(status: CogneeDatasetStatus | null | undefined): UncognifiedCogneeDocument[] | undefined {
  if (!status) return undefined;
  if (status.uncognifiedDocuments?.length) return status.uncognifiedDocuments;
  const ingested = resultNumber(status.ingestedDocumentCount) ?? resultNumber(status.documentCount) ?? status.manifest?.documentCount;
  const cognified = resultNumber(status.cognifiedDocumentCount) ?? 0;
  const canRetryCognify = (status.stage === 'cognifying' || status.status === 'partial') && Number.isFinite(ingested) && ingested! > cognified;
  if (!canRetryCognify || !isCompatibleManifest(status.manifest)) return undefined;
  return status.manifest.documents.map((document) => ({
    path: document.path,
    title: document.title,
    fileHash: document.hash,
    dataId: document.dataId,
    status: 'unknown',
  }));
}

function stableUuid(value: string): string {
  const namespaceDns = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const hash = createHash('sha1').update(namespaceDns).update(value).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
