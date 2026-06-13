import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ObjectId, type Collection, type Db } from 'mongodb';
import {
  cogneeDataDir,
  cogneeDatasetName,
  isCogneeCorruptWalError,
  isCogneeSidecarStoppedError,
  recoverCogneeGraphWalFiles,
  runCogneeSidecar,
  type CogneeSidecarProgress,
} from './repo-context-cognee-provider.js';
import { normalizeUsageArray } from '../common/context-usage-utils.js';
import { contextProviderDisabledError, isCogneeContextEnabled } from '../config/context-provider-config.js';

const exec = promisify(execFile);
const DEFAULT_COGNEE_STALE_MS = 10 * 60_000;
const COGNEE_CHUNK_MAPPING_TIMEOUT_MS = 5 * 60_000;
const COGNEE_FILE_MANIFEST_VERSION = 1;
const COGNEE_INGEST_FORMAT = 'curated_context_entry_v1';
const SERVICE_STARTED_AT_MS = Date.now();

type CogneeBuildStage = 'collecting_curated_context' | 'ingesting' | 'cognifying' | 'completed' | 'failed';
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
  curatedContextStale?: boolean;
  staleReason?: string;
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

type CogneeSourceMapping = {
  repoId: string;
  datasetName: string;
  ingestFormat: typeof COGNEE_INGEST_FORMAT;
  entryId?: string;
  label?: string;
  path?: string;
  title?: string;
  kind?: string;
  fileHash?: string;
  dataId?: string;
  cogneeDataId?: string;
  chunkId?: string;
  mappingType: 'document' | 'chunk';
  source: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type CogneeChunkSourceMappingRow = {
  chunkId?: string;
  entryId?: string;
  path?: string;
  label?: string;
  title?: string;
  kind?: string;
  fileHash?: string;
  sourceMetadataKeys?: string[];
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
  documents: Array<{ title: string; path?: string; kind?: string; hash: string; dataId: string; entryId?: string; label?: string }>;
};

type CollectedCogneeDocument = { title: string; path?: string; kind?: string; content: string; hash: string; entryId?: string; entryVersionId?: string; entryVersion?: number; label?: string; source?: string };
type CogneePayloadDocument = CollectedCogneeDocument & {
  dataId: string;
  externalMetadata: Record<string, unknown>;
  changeType: 'current';
};

export type CogneeGraphPayload = {
  source: string;
  provider?: string;
  accessMode?: string;
  datasetName?: string;
  datasetId?: string;
  databasePath?: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  nodeTypeCounts: Array<Record<string, unknown>>;
  relationshipCounts: Array<Record<string, unknown>>;
  previewNodeCount: number;
  previewEdgeCount: number;
  limited: boolean;
  filters?: Record<string, unknown>;
  selection?: Record<string, unknown>;
  apiError?: string;
  error?: string;
};

export type CogneeGraphNodeDetailPayload = {
  source: string;
  provider?: string;
  accessMode?: string;
  datasetName?: string;
  datasetId?: string;
  databasePath?: string;
  node?: Record<string, unknown> | null;
  relatedNodes: Array<Record<string, unknown>>;
  relatedEdges: Array<Record<string, unknown>>;
  relatedNodeCount?: number;
  relatedEdgeCount?: number;
  limited?: boolean;
  limits?: Record<string, unknown>;
  documentPreview?: string;
  documentChunks: Array<Record<string, unknown>>;
  error?: string;
};

export class CogneeMemoryService {
  private statuses: Collection<CogneeDatasetStatus>;
  private sourceMappings: Collection<CogneeSourceMapping>;
  private repos: Collection;
  private runningBuilds = new Set<string>();
  private buildControllers = new Map<string, AbortController>();
  private progressQueues = new Map<string, Promise<void>>();

  constructor(private db: Db) {
    this.statuses = db.collection<CogneeDatasetStatus>('repo_cognee_datasets');
    this.sourceMappings = db.collection<CogneeSourceMapping>('repo_cognee_source_mappings');
    this.repos = db.collection('repos');
  }

  async getStatus(repoId: string): Promise<CogneeDatasetStatus | null> {
    if (!isCogneeContextEnabled()) return null;
    const status = await this.findCuratedStatus(repoId);
    if (status?.status === 'running' && !this.runningBuilds.has(repoId)) {
      if (isPreviousProcessRunningStatus(status)) {
        await this.markInterruptedFailed(repoId, status);
        return this.decorateStatus(await this.findCuratedStatus(repoId));
      }
      if (isStaleRunningStatus(status)) {
        await this.markStaleFailed(repoId, status);
        return this.decorateStatus(await this.findCuratedStatus(repoId));
      }
    }
    return this.decorateStatus(status);
  }

  async getGraph(repoId: string, options: {
    maxNodes?: number;
    maxEdges?: number;
    query?: string;
    nodeType?: string;
    relationship?: string;
    expandNodeId?: string;
  } = {}): Promise<CogneeGraphPayload> {
    if (!isCogneeContextEnabled()) return emptyCogneeGraph('cognee_disabled');
    const status = await this.findCuratedStatus(repoId);
    const datasetName = status?.datasetName;
    if (!datasetName) return emptyCogneeGraph('cognee_dataset_missing');
    const output = await runCogneeSidecar('graph', {
      dataDir: cogneeDataDir(),
      datasetName,
      maxNodes: options.maxNodes ?? 120,
      maxEdges: options.maxEdges ?? 240,
      query: options.query,
      nodeType: options.nodeType,
      relationship: options.relationship,
      expandNodeId: options.expandNodeId,
    }, undefined, { timeoutMs: 30_000 }).catch((err) => ({
      ...emptyCogneeGraph('cognee_graph_failed'),
      datasetName,
      error: (err as Error).message,
    }));
    return normalizeCogneeGraphPayload(output);
  }

  async getGraphNodeDetail(repoId: string, nodeId: string, options: {
    maxRelatedNodes?: number;
    maxRelatedEdges?: number;
    includeDocuments?: boolean;
  } = {}): Promise<CogneeGraphNodeDetailPayload> {
    if (!isCogneeContextEnabled()) return emptyCogneeGraphNodeDetail('cognee_disabled');
    const status = await this.findCuratedStatus(repoId);
    const datasetName = status?.datasetName;
    if (!datasetName) return emptyCogneeGraphNodeDetail('cognee_dataset_missing');
    const output = await runCogneeSidecar('graph_node_detail', {
      dataDir: cogneeDataDir(),
      datasetName,
      nodeId,
      maxRelatedNodes: options.maxRelatedNodes ?? 500,
      maxRelatedEdges: options.maxRelatedEdges ?? 1000,
      includeDocuments: options.includeDocuments !== false,
    }, undefined, { timeoutMs: 30_000 }).catch((err) => ({
      ...emptyCogneeGraphNodeDetail('cognee_graph_failed'),
      datasetName,
      error: (err as Error).message,
    }));
    return normalizeCogneeGraphNodeDetailPayload(output);
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
    const existing = await this.findCuratedStatus(repoId);
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
    const existing = await this.findCuratedStatus(repoId);
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

  private async findCuratedStatus(repoId: string): Promise<CogneeDatasetStatus | null> {
    return this.statuses.findOne({ repoId, ingestFormat: COGNEE_INGEST_FORMAT });
  }

  private async resolveRepoInput(repoId: string, options: { pullLatest?: boolean; cleanRebuild?: boolean } = {}): Promise<{
    repoId: string;
    repoName: string;
    repoPath: string;
    sourcePath: string;
    defaultBranch: string;
    datasetName: string;
    previousDatasetName?: string;
    buildMode: CogneeBuildMode;
  }> {
    const repo = await this.repos.findOne({ _id: new ObjectId(repoId) });
    if (!repo?.path || typeof repo.path !== 'string') throw new Error('Repo not found');
    const repoName = String(repo.name ?? '');
    const existing = await this.findCuratedStatus(repoId);
    const defaultBranch = String((repo.detected as { defaultBranch?: unknown } | undefined)?.defaultBranch ?? repo.defaultBranch ?? 'main');
    const cleanRebuild = options.cleanRebuild === true;
    const canonicalDatasetName = cogneeDatasetName(repoId, repoName || 'repo');
    return {
      repoId,
      repoName,
      repoPath: String(repo.path),
      sourcePath: String(repo.path),
      defaultBranch,
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
    datasetName: string;
    previousDatasetName?: string;
    buildMode: CogneeBuildMode;
  }, initialDiagnostics: Array<Record<string, unknown>> = [], controller?: AbortController): Promise<CogneeDatasetStatus> {
    const { repoId, repoName, repoPath, sourcePath } = input;
    const preflightDiagnostics: Array<Record<string, unknown>> = [...initialDiagnostics];
    await this.createInitialRunningStatus(input, initialDiagnostics);
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
        stage: 'collecting_curated_context',
        message: 'Collecting curated context entries for Cognee context',
      });
      const { documents, diagnostics: collectionDiagnostics } = await this.collectDocuments(repoId);
      const manifest = buildCogneeFileManifest({
        repoId,
        repoName,
        branch,
        headSha,
        documents,
      });
      const payloadDocuments = documents.map((document): CogneePayloadDocument => ({
        ...document,
        label: document.label ?? (document.entryId ? curatedEntryLabel(document.entryId) : undefined),
        dataId: stableUuid(document.entryId ? `${repoId}:curated:${document.entryId}` : `${repoId}:${document.path ?? document.title}`),
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
        message: 'Cognee sidecar will compare current curated context entries with Cognee database metadata before adding or deleting documents.',
      }];
      await this.updateProgress(repoId, {
        stage: 'ingesting',
        message: `Checking Cognee database for ${documents.length} curated context document${documents.length === 1 ? '' : 's'}`,
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
      await this.persistSourceMappings({
        repoId,
        datasetName,
        payloadDocuments,
        ingestedDocuments: normalizeIngestedDocuments(result.documents),
      });
      const uncognifiedDocuments = normalizeUncognifiedDocuments(result.uncognifiedDocuments);
      const partial = cognifiedDocumentCount < ingestedDocumentCount;
      const chunkMappingDiagnostics = partial
        ? [{
            code: 'cognee_chunk_source_mapping_skipped_partial',
            severity: 'warn',
            message: 'Allen skipped post-cognify chunk mapping because Cognee did not finish cognifying all ingested curated context documents.',
            ingestedDocumentCount,
            cognifiedDocumentCount,
          }]
        : await this.ensureChunkSourceMappings({
            repoId,
            datasetName,
            documentCount: documents.length,
          });
      const partialDiagnostics = partial
        ? [{
            code: 'cognee_cognify_partial',
            severity: 'warn',
            message: `Cognee cognified ${cognifiedDocumentCount}/${ingestedDocumentCount} ingested curated context documents.`,
            ingestedDocumentCount,
            cognifiedDocumentCount,
            uncognifiedDocuments,
          }]
        : [];
      const completed: Partial<CogneeDatasetStatus> = {
        status: partial ? 'partial' : 'completed',
        stage: 'completed',
        message: partial
          ? `Context partially built: ${cognifiedDocumentCount}/${ingestedDocumentCount} curated context documents cognified`
          : `Context built from ${documents.length} curated context document${documents.length === 1 ? '' : 's'}`,
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
        curatedContextStale: partial ? undefined : false,
        uncognifiedDocuments: partial ? uncognifiedDocuments : undefined,
        diagnostics: [...preflightDiagnostics, ...collectionDiagnostics, ...diffDiagnostics, ...normalizeUsageArray(result.diagnostics), ...chunkMappingDiagnostics, ...partialDiagnostics],
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
            ...(partial ? {} : { staleReason: '' }),
            ...(partial ? {} : { uncognifiedDocuments: '' }),
          },
        },
      );
    } catch (err) {
      await this.flushProgress(repoId).catch(() => undefined);
      if (isCogneeSidecarStoppedError(err)) {
        await this.markStopped(repoId, await this.findCuratedStatus(repoId), { noWorker: false });
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
      source: 'allen_curated_context_entries',
      branch: input.defaultBranch,
      datasetName: input.datasetName,
      previousDatasetName: input.previousDatasetName,
      buildMode: input.buildMode,
      status: 'running',
      stage: 'collecting_curated_context',
      ingestFormat: COGNEE_INGEST_FORMAT,
      message: 'Collecting curated context entries for Cognee context',
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
          ingestFormat: status.ingestFormat,
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
    const current = await this.findCuratedStatus(repoId);
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
    const current = await this.findCuratedStatus(repoId);
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

  private async persistSourceMappings(input: {
    repoId: string;
    datasetName: string;
    payloadDocuments: CogneePayloadDocument[];
    ingestedDocuments: Array<Record<string, unknown>>;
  }): Promise<void> {
    const now = new Date();
    const ingestedByDataId = new Map<string, Record<string, unknown>>();
    const ingestedByPath = new Map<string, Record<string, unknown>>();
    for (const item of input.ingestedDocuments) {
      const dataId = resultString(item.dataId) ?? resultString(item.data_id);
      const path = resultString(item.path);
      if (dataId) ingestedByDataId.set(dataId, item);
      if (path) ingestedByPath.set(path, item);
    }
    await this.sourceMappings.updateMany(
      {
        repoId: input.repoId,
        datasetName: input.datasetName,
        ingestFormat: COGNEE_INGEST_FORMAT,
        mappingType: 'document',
      },
      { $set: { active: false, updatedAt: now } },
    ).catch(() => {});
    await Promise.all(input.payloadDocuments.map(async (document) => {
      const metadata = document.externalMetadata ?? {};
      const path = resultString(document.path) ?? resultString(metadata.path);
      const dataId = resultString(document.dataId) ?? resultString(metadata.dataId) ?? resultString(metadata.data_id);
      const label = resultString(document.label) ?? resultString(metadata.label);
      const ingested = (dataId ? ingestedByDataId.get(dataId) : undefined) ?? (path ? ingestedByPath.get(path) : undefined);
      const mapping = definedValues({
        repoId: input.repoId,
        datasetName: input.datasetName,
        ingestFormat: COGNEE_INGEST_FORMAT,
        entryId: resultString(document.entryId) ?? resultString(metadata.entryId) ?? resultString(metadata.entry_id),
        entryVersionId: resultString(document.entryVersionId) ?? resultString(metadata.entryVersionId),
        entryVersion: resultNumber(document.entryVersion) ?? resultNumber(metadata.entryVersion),
        path,
        title: resultString(document.title) ?? resultString(metadata.title),
        kind: resultString(document.kind) ?? resultString(metadata.kind),
        label,
        fileHash: resultString(document.hash) ?? resultString(metadata.fileHash) ?? resultString(metadata.file_hash),
        dataId,
        cogneeDataId: resultString(ingested?.cogneeDataId) ?? resultString(ingested?.cognee_data_id),
        mappingType: 'document',
        source: 'cognee_curated_ingest',
        active: true,
        updatedAt: now,
      }) as Partial<CogneeSourceMapping>;
      const key: Record<string, unknown> = dataId
        ? { repoId: input.repoId, datasetName: input.datasetName, ingestFormat: COGNEE_INGEST_FORMAT, dataId, mappingType: 'document' as const }
        : { repoId: input.repoId, datasetName: input.datasetName, ingestFormat: COGNEE_INGEST_FORMAT, label: label ?? path, mappingType: 'document' as const };
      await this.sourceMappings.updateOne(
        key as never,
        { $set: mapping, $setOnInsert: { createdAt: now } },
        { upsert: true },
      ).catch(() => {});
    }));
  }

  private async ensureChunkSourceMappings(input: {
    repoId: string;
    datasetName: string;
    documentCount: number;
  }): Promise<Array<Record<string, unknown>>> {
    const existingCount = await this.sourceMappings.countDocuments({
      repoId: input.repoId,
      datasetName: input.datasetName,
      ingestFormat: COGNEE_INGEST_FORMAT,
      mappingType: 'chunk',
      active: true,
    }).catch(() => 0);

    await this.updateProgress(input.repoId, {
      stage: 'cognifying',
      message: 'Creating Cognee chunk source mappings',
    });

    let output: Record<string, unknown>;
    try {
      output = await runCogneeSidecar('chunk_source_mappings', {
        dataDir: cogneeDataDir(),
        datasetName: input.datasetName,
      }, undefined, { timeoutMs: COGNEE_CHUNK_MAPPING_TIMEOUT_MS });
    } catch (err) {
      return [{
        code: 'cognee_chunk_source_mapping_failed',
        severity: 'warn',
        datasetName: input.datasetName,
        message: `Allen could not create Cognee chunk source mappings: ${(err as Error).message}`,
      }];
    }

    const rows = normalizeChunkSourceMappingRows(output.rows);
    if (rows.length === 0) {
      if (input.documentCount === 0) {
        await this.sourceMappings.updateMany(
          {
            repoId: input.repoId,
            datasetName: input.datasetName,
            ingestFormat: COGNEE_INGEST_FORMAT,
            mappingType: 'chunk',
            active: true,
          },
          { $set: { active: false, updatedAt: new Date() } },
        ).catch(() => {});
        return [
          ...normalizeUsageArray(output.diagnostics),
          {
            code: 'cognee_chunk_source_mapping_deactivated_empty_dataset',
            severity: 'info',
            datasetName: input.datasetName,
            existingChunkMappingCount: existingCount,
            message: 'Allen deactivated chunk mappings because the refreshed Cognee dataset has no curated context documents.',
          },
        ];
      }
      return [
        ...normalizeUsageArray(output.diagnostics),
        {
          code: 'cognee_chunk_source_mapping_empty_scan',
          severity: 'warn',
          datasetName: input.datasetName,
          documentCount: input.documentCount,
          existingChunkMappingCount: existingCount,
          message: 'Allen preserved existing chunk mappings because Cognee returned no graph chunks for a non-empty curated context dataset.',
        },
      ];
    }
    const resolved = await this.resolveChunkSourceMappingEntries(input.repoId, rows);
    const now = new Date();
    let persistedCount = 0;
    const resolvedChunkIds = resolved.map(({ row }) => row.chunkId).filter((chunkId): chunkId is string => Boolean(chunkId));
    await Promise.all(resolved.map(async ({ row, entry }) => {
      const entryId = resultString(entry.entryId) ?? row.entryId;
      if (!row.chunkId || !entryId) return;
      const path = resultString(entry.path) ?? row.path;
      const label = row.label ?? curatedEntryLabel(entryId);
      const mapping = definedValues({
        repoId: input.repoId,
        datasetName: input.datasetName,
        ingestFormat: COGNEE_INGEST_FORMAT,
        chunkId: row.chunkId,
        entryId,
        path,
        title: resultString(entry.title) ?? row.title ?? path,
        kind: resultString(entry.kind) ?? row.kind,
        label,
        fileHash: row.fileHash ?? resultString(entry.sourceHash),
        mappingType: 'chunk',
        source: 'cognee_graph_post_cognify',
        active: true,
        updatedAt: now,
      }) as Partial<CogneeSourceMapping>;
      await this.sourceMappings.updateOne(
        {
          repoId: input.repoId,
          datasetName: input.datasetName,
          ingestFormat: COGNEE_INGEST_FORMAT,
          chunkId: row.chunkId,
          mappingType: 'chunk' as const,
        },
        { $set: mapping, $setOnInsert: { createdAt: now } },
        { upsert: true },
      ).then(() => {
        persistedCount += 1;
      }).catch(() => {});
    }));
    const staleResult = await this.sourceMappings.updateMany(
      {
        repoId: input.repoId,
        datasetName: input.datasetName,
        ingestFormat: COGNEE_INGEST_FORMAT,
        mappingType: 'chunk',
        active: true,
        chunkId: { $nin: resolvedChunkIds },
      },
      { $set: { active: false, updatedAt: now } },
    ).catch(() => ({ modifiedCount: 0 }));

    const unresolvedCount = rows.length - resolved.length;
    return [
      ...normalizeUsageArray(output.diagnostics),
      {
        code: unresolvedCount > 0 ? 'cognee_chunk_source_mapping_partial' : 'cognee_chunk_source_mapping_complete',
        severity: unresolvedCount > 0 ? 'warn' : 'info',
        datasetName: input.datasetName,
        chunkCount: rows.length,
        resolvedChunkMappingCount: resolved.length,
        unresolvedChunkMappingCount: unresolvedCount,
        persistedChunkMappingCount: persistedCount,
        deactivatedStaleOrUnresolvedChunkMappingCount: staleResult.modifiedCount,
        sidecarChunkCount: resultNumber(output.chunkCount),
        sidecarResolvedCount: resultNumber(output.resolvedCount),
        sidecarUnresolvedCount: resultNumber(output.unresolvedCount),
        existingChunkMappingCount: existingCount,
        message: `Allen persisted ${persistedCount}/${rows.length} Cognee chunk source mappings and deactivated ${staleResult.modifiedCount} stale or unresolved mappings.`,
      },
    ];
  }

  private async resolveChunkSourceMappingEntries(
    repoId: string,
    rows: CogneeChunkSourceMappingRow[],
  ): Promise<Array<{ row: CogneeChunkSourceMappingRow; entry: Record<string, unknown> }>> {
    const entryIds = Array.from(new Set(rows.map((row) => row.entryId).filter(Boolean))) as string[];
    const paths = Array.from(new Set(rows.map((row) => row.path).filter(Boolean))) as string[];
    if (!entryIds.length && !paths.length) return [];
    const clauses: Array<Record<string, unknown>> = [];
    if (entryIds.length) clauses.push({ entryId: { $in: entryIds } });
    if (paths.length) clauses.push({ path: { $in: paths } });
    const entries = await this.db.collection('repo_context_curation_entries')
      .find({ repoId, active: { $ne: false }, $or: clauses })
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray()
      .catch(() => []);
    const byEntryId = new Map<string, Record<string, unknown>>();
    const byPath = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      const entryId = resultString(entry.entryId);
      const path = resultString(entry.path);
      if (entryId && !byEntryId.has(entryId)) byEntryId.set(entryId, entry);
      if (path && !byPath.has(path)) byPath.set(path, entry);
    }
    const resolved: Array<{ row: CogneeChunkSourceMappingRow; entry: Record<string, unknown> }> = [];
    for (const row of rows) {
      const entry = (row.entryId ? byEntryId.get(row.entryId) : undefined)
        ?? (row.path ? byPath.get(row.path) : undefined);
      if (entry) resolved.push({ row, entry });
    }
    return resolved;
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
    const current = await this.findCuratedStatus(repoId);
    const uncognifiedDocuments = uncognifiedDocumentsFromStatus(current);
    const stalled = isCogneeCognifyStallError(err);
    const releaseDiagnostics = stalled && current?.datasetName
      ? await this.releaseCogneeCognifyLock(current.datasetName, (err as Error).message).catch((releaseErr) => [{
          code: 'cognee_cognify_lock_release_failed',
          severity: 'warn',
          message: (releaseErr as Error).message,
        }])
      : [];
    await this.statuses.updateOne(
      { repoId, status: 'running' },
      {
        $set: definedValues({
          status: 'failed',
          stage: 'failed',
          message: stalled ? 'Cognee context build stalled' : 'Cognee context build failed',
          error: (err as Error).message,
          uncognifiedDocuments,
          diagnostics: [
            ...(current?.diagnostics ?? []),
            {
              code: stalled ? 'cognee_cognify_stalled' : 'cognee_ingest_failed',
              severity: 'warn',
              message: (err as Error).message,
            },
            ...releaseDiagnostics,
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
    const releaseDiagnostics = status?.datasetName
      ? await this.releaseCogneeCognifyLock(status.datasetName, message).catch((err) => [{
          code: 'cognee_cognify_lock_release_failed',
          severity: 'warn',
          message: (err as Error).message,
        }])
      : [];
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
            ...releaseDiagnostics,
          ],
          updatedAt: new Date(),
        },
      },
    );
  }

  private async releaseCogneeCognifyLock(datasetName: string, reason: string): Promise<Array<Record<string, unknown>>> {
    const result = await runCogneeSidecar('release_cognify_lock', {
      dataDir: cogneeDataDir(),
      datasetName,
      reason,
    }, undefined, { timeoutMs: 30_000 });
    return [{
      code: resultBoolean(result.released) ? 'cognee_cognify_lock_released' : 'cognee_cognify_lock_release_skipped',
      severity: resultBoolean(result.released) ? 'info' : 'debug',
      message: resultBoolean(result.released)
        ? 'Released Cognee cognify pipeline lock by appending an errored pipeline run.'
        : 'No active Cognee cognify pipeline lock needed release.',
      datasetName,
      latestStatus: resultString(result.latestStatus),
      releaseStatus: resultString(result.releaseStatus),
      reason: resultString(result.reason),
    }];
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

  private async collectDocuments(repoId: string): Promise<{
    documents: CollectedCogneeDocument[];
    diagnostics: Array<Record<string, unknown>>;
  }> {
    return this.collectCuratedDocuments(repoId);
  }

  private async collectCuratedDocuments(repoId: string): Promise<{
    documents: CollectedCogneeDocument[];
    diagnostics: Array<Record<string, unknown>>;
  }> {
    const rows = await this.db.collection('repo_context_curation_entries')
      .find({ repoId, active: { $ne: false }, inclusion: 'include' }, { sort: { path: 1, updatedAt: -1 } })
      .toArray();
    const docs: CollectedCogneeDocument[] = [];
    const diagnostics: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const policy = String(row.injectionPolicy ?? '');
      if (policy === 'manifest_only' || policy === 'never_full_auto') continue;
      const entryId = resultString(row.entryId);
      const retrievalText = resultString(row.retrievalText);
      const curatedContext = resultString(row.curatedContext);
      const chunkText = Array.isArray(row.chunks)
        ? row.chunks
          .filter((chunk): chunk is Record<string, unknown> => Boolean(chunk) && typeof chunk === 'object' && !Array.isArray(chunk))
          .map((chunk) => resultString(chunk.text))
          .filter((text): text is string => Boolean(text))
          .join('\n\n')
        : '';
      const content = retrievalText ?? (chunkText || curatedContext);
      if (!entryId || !content?.trim()) continue;
      if (seen.has(entryId)) continue;
      seen.add(entryId);
      docs.push({
        entryId,
        entryVersionId: resultString(row.entryVersionId),
        entryVersion: resultNumber(row.version) ?? resultNumber(row.editVersion),
        label: curatedEntryLabel(entryId),
        title: resultString(row.title) ?? resultString(row.path) ?? entryId,
        path: resultString(row.path),
        kind: resultString(row.category) ?? 'doc',
        content,
        hash: sha256(content),
        source: 'allen_curated_context_entry',
      });
    }
    diagnostics.push({
      code: docs.length ? 'cognee_curated_collection_complete' : 'cognee_curated_collection_empty',
      severity: docs.length ? 'info' : 'warn',
      documentCount: docs.length,
      candidateCount: rows.length,
      message: docs.length
        ? 'Collected curated context entries for Cognee ingestion.'
        : 'No ingestable curated context entries found. No repo file contents will be sent to Cognee.',
    });
    return { documents: docs, diagnostics };
  }
}

function emptyCogneeGraph(source: string): CogneeGraphPayload {
  return {
    source,
    provider: 'cognee',
    nodeCount: 0,
    edgeCount: 0,
    nodes: [],
    edges: [],
    nodeTypeCounts: [],
    relationshipCounts: [],
    previewNodeCount: 0,
    previewEdgeCount: 0,
    limited: false,
  };
}

function emptyCogneeGraphNodeDetail(source: string): CogneeGraphNodeDetailPayload {
  return {
    source,
    provider: 'cognee',
    node: null,
    relatedNodes: [],
    relatedEdges: [],
    relatedNodeCount: 0,
    relatedEdgeCount: 0,
    limited: false,
    documentChunks: [],
  };
}

function normalizeCogneeGraphPayload(value: Record<string, unknown>): CogneeGraphPayload {
  return {
    source: resultString(value.source) ?? 'cognee_graph',
    provider: resultString(value.provider),
    accessMode: resultString(value.accessMode),
    datasetName: resultString(value.datasetName),
    datasetId: resultString(value.datasetId),
    databasePath: resultString(value.databasePath),
    nodeCount: resultNumber(value.nodeCount) ?? 0,
    edgeCount: resultNumber(value.edgeCount) ?? 0,
    nodes: Array.isArray(value.nodes) ? value.nodes.filter(isPlainRecord) : [],
    edges: Array.isArray(value.edges) ? value.edges.filter(isPlainRecord) : [],
    nodeTypeCounts: Array.isArray(value.nodeTypeCounts) ? value.nodeTypeCounts.filter(isPlainRecord) : [],
    relationshipCounts: Array.isArray(value.relationshipCounts) ? value.relationshipCounts.filter(isPlainRecord) : [],
    previewNodeCount: resultNumber(value.previewNodeCount) ?? (Array.isArray(value.nodes) ? value.nodes.length : 0),
    previewEdgeCount: resultNumber(value.previewEdgeCount) ?? (Array.isArray(value.edges) ? value.edges.length : 0),
    limited: resultBoolean(value.limited) ?? false,
    filters: isPlainRecord(value.filters) ? value.filters : undefined,
    selection: isPlainRecord(value.selection) ? value.selection : undefined,
    apiError: resultString(value.apiError),
    error: resultString(value.error),
  };
}

function normalizeCogneeGraphNodeDetailPayload(value: Record<string, unknown>): CogneeGraphNodeDetailPayload {
  return {
    source: resultString(value.source) ?? 'cognee_graph',
    provider: resultString(value.provider),
    accessMode: resultString(value.accessMode),
    datasetName: resultString(value.datasetName),
    datasetId: resultString(value.datasetId),
    databasePath: resultString(value.databasePath),
    node: isPlainRecord(value.node) ? value.node : null,
    relatedNodes: Array.isArray(value.relatedNodes) ? value.relatedNodes.filter(isPlainRecord) : [],
    relatedEdges: Array.isArray(value.relatedEdges) ? value.relatedEdges.filter(isPlainRecord) : [],
    relatedNodeCount: resultNumber(value.relatedNodeCount),
    relatedEdgeCount: resultNumber(value.relatedEdgeCount),
    limited: resultBoolean(value.limited),
    limits: isPlainRecord(value.limits) ? value.limits : undefined,
    documentPreview: resultString(value.documentPreview),
    documentChunks: Array.isArray(value.documentChunks) ? value.documentChunks.filter(isPlainRecord) : [],
    error: resultString(value.error),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStage(value: unknown): CogneeBuildStage {
  const stage = String(value ?? '');
  return stage === 'collecting_curated_context'
    || stage === 'ingesting'
    || stage === 'cognifying'
    || stage === 'completed'
    || stage === 'failed'
    ? stage
    : stage === 'collecting_markdown'
      ? 'collecting_curated_context'
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

function normalizeIngestedDocuments(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function normalizeChunkSourceMappingRows(value: unknown): CogneeChunkSourceMappingRow[] {
  if (!Array.isArray(value)) return [];
  const rows: CogneeChunkSourceMappingRow[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isPlainRecord(item)) continue;
    const chunkId = resultString(item.chunkId) ?? resultString(item.chunk_id);
    if (!chunkId || seen.has(chunkId)) continue;
    seen.add(chunkId);
    rows.push(definedValues({
      chunkId,
      entryId: resultString(item.entryId) ?? resultString(item.entry_id),
      path: resultString(item.path),
      label: resultString(item.label),
      title: resultString(item.title),
      kind: resultString(item.kind),
      fileHash: resultString(item.fileHash) ?? resultString(item.file_hash),
      sourceMetadataKeys: Array.isArray(item.sourceMetadataKeys) ? item.sourceMetadataKeys.map(String) : undefined,
    }) as CogneeChunkSourceMappingRow);
  }
  return rows;
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
  const currentStage = current.stage ?? 'collecting_curated_context';
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
    case 'collecting_curated_context': return 10;
    case 'ingesting': return 20;
    case 'cognifying': return 30;
    case 'completed': return 40;
    case 'failed': return 40;
  }
}

function isCogneeCognifyStallError(error: unknown): boolean {
  return error instanceof Error && /Cognee cognify stalled/i.test(error.message);
}

function isStaleRunningStatus(status: CogneeDatasetStatus): boolean {
  const updatedAtMs = runningStatusTimestampMs(status);
  if (!Number.isFinite(updatedAtMs)) return true;
  const timeoutMs = Number(process.env.ALLEN_COGNEE_STALE_MS ?? DEFAULT_COGNEE_STALE_MS);
  const staleAfterMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_COGNEE_STALE_MS;
  return Date.now() - updatedAtMs > staleAfterMs;
}

function isPreviousProcessRunningStatus(status: CogneeDatasetStatus): boolean {
  const updatedAtMs = runningStatusTimestampMs(status);
  if (!Number.isFinite(updatedAtMs)) return true;
  return updatedAtMs < SERVICE_STARTED_AT_MS - 1000;
}

function runningStatusTimestampMs(status: CogneeDatasetStatus): number {
  const updatedAt = status.updatedAt ?? status.lastStartedAt;
  return updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd });
  return result.stdout.trim();
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
  documents: Array<{ title: string; path?: string; kind?: string; hash: string; entryId?: string; label?: string }>;
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
      dataId: stableUuid(document.entryId ? `${input.repoId}:curated:${document.entryId}` : `${input.repoId}:${document.path ?? document.title}`),
      entryId: document.entryId,
      label: document.label,
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
    entryId: document.entryId,
    entryVersionId: document.entryVersionId,
    entryVersion: document.entryVersion,
    label: document.label,
    source: document.source ?? 'allen_curated_context_entry',
    ingestFormat: COGNEE_INGEST_FORMAT,
  };
}

function curatedEntryLabel(entryId: string): string {
  return `allen-curated-entry:${entryId}`;
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
