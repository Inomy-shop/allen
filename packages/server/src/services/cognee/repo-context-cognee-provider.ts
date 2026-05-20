import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { opendir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import type {
  KnowledgeCandidateRef,
  KnowledgeNodeKind,
  KnowledgeRetrievalInput,
  KnowledgeRetrievalProvider,
  KnowledgeRetrievalResult,
} from '../repo-context-engine.js';
import { isRecord } from '../knowledge-graph/repo-knowledge-graph-utils.js';
import { normalizeUsageArray } from '../knowledge-graph/repo-knowledge-graph-usage.js';
import { resolveAllenPython } from '../python-runtime.js';
import { contextProviderDisabledError, isCogneeContextEnabled } from '../context-provider-config.js';
import { resolveContextLlmConfig } from '../context-llm-config.js';
import {
  buildCogneeQuery,
  buildGraphExpansionQuery,
  buildRetrievalIntentEnvelope,
  DEFAULT_COGNEE_CANDIDATE_LIMIT,
  positiveIntegerEnv,
  renderedQueryHash,
  retrievalEnvelopeHash,
  selectCogneeRefs,
  type RetrievalIntentEnvelope,
  uniqueCogneeRefs,
} from './cognee-retrieval-policy.js';
import { enrichCogneeCandidates } from './cognee-metadata-enrichment.js';

const COGNEE_INGEST_FORMAT = 'markdown_file_docmeta_v1';

export class CogneeMemoryProvider implements KnowledgeRetrievalProvider {
  readonly providerId = 'cognee_memory';

  constructor(private db?: Db) {}

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    if (!isCogneeContextEnabled()) {
      return {
        providerId: this.providerId,
        candidates: [],
        selectedRefs: [],
        rejectedRefs: [],
        diagnostics: [{ code: 'cognee_context_provider_disabled', severity: 'info', message: 'Cognee context provider is disabled.' }],
        trace: [],
      };
    }
    const status = await this.loadStatus(input.repoId);
    const envelope = buildRetrievalIntentEnvelope(input);
    const query = buildCogneeQuery(input);
    const output = await runCogneeSidecar('search', {
      datasetName: firstString(status?.datasetName) ?? cogneeDatasetName(input.repoId, input.repoName),
      dataDir: cogneeDataDir(),
      query,
      retrievalEnvelope: envelope,
      repo: {
        repoId: input.repoId,
        repoName: input.repoName,
        repoPath: input.repoPath,
        branch: input.state.branch ?? input.state.defaultBranch,
        headSha: input.state.headSha ?? input.state.head_sha,
      },
      node: {
        workflowName: input.workflowName,
        nodeName: input.nodeName,
        nodeRole: input.nodeRole,
        attempt: input.attempt,
        currentFiles: input.currentFiles,
      },
      limits: {
        maxResults: positiveIntegerEnv('ALLEN_COGNEE_CANDIDATE_LIMIT', positiveIntegerEnv('ALLEN_COGNEE_MAX_RESULTS', DEFAULT_COGNEE_CANDIDATE_LIMIT)),
      },
    });
    const rawCandidates = normalizeCogneeRefs(output.results, this.providerId);
    const enriched = await enrichCogneeCandidates({ db: this.db, repoId: input.repoId, candidates: rawCandidates });
    const primary = selectCogneeRefs(enriched.candidates, input, envelope, 'primary');
    const graphExpansion = await this.retrieveGraphExpansion(input, envelope, status?.datasetName, primary.selectedRefs);
    const candidates = [...primary.candidates, ...graphExpansion.candidates];
    const selectedRefs = graphExpansion.active
      ? uniqueCogneeRefs([...primary.selectedRefs, ...graphExpansion.selectedRefs])
      : primary.selectedRefs;
    const injectableRefs = selectedRefs.filter((ref) => ref.providerMetadata?.injectionDecision === 'mandatory_full' || ref.providerMetadata?.injectionDecision === 'snippet' || ref.providerMetadata?.injectionPolicy === 'injectable');
    const rejectedRefs = [...primary.rejectedRefs, ...graphExpansion.rejectedRefs];
    return {
      providerId: this.providerId,
      candidates,
      selectedRefs,
      injectableRefs,
      rejectedRefs,
      diagnostics: [
        {
          code: 'cognee_retrieval_envelope_built',
          severity: 'info',
          retrievalEnvelopeHash: retrievalEnvelopeHash(envelope),
          renderedQueryHash: renderedQueryHash(query),
          role: envelope.role,
          roleFamily: envelope.roleFamily,
          rawRole: envelope.rawRole,
          requiredCategories: envelope.requiredCategories,
          preferredCategories: envelope.preferredCategories,
          exclusionCategories: envelope.exclusionCategories,
          querySignalSources: envelope.querySignalSources,
          querySignalSections: envelope.querySignalSections,
          querySignalLength: envelope.querySignalLength,
          renderedQueryLength: query.length,
          message: 'Allen built a deterministic Cognee retrieval envelope before semantic search.',
        },
        ...normalizeUsageArray(output.diagnostics),
        ...enriched.diagnostics,
        ...primary.diagnostics,
        ...graphExpansion.diagnostics,
      ],
      trace: selectedRefs.map((ref) => ({
        providerId: this.providerId,
        refId: ref.refId,
        kind: ref.kind,
        title: ref.title,
        path: ref.path,
        itemType: ref.itemType,
        grounding: ref.grounding,
        score: ref.score,
        decision: 'selected',
        reason: ref.reason,
        providerMetadata: ref.providerMetadata,
      })),
    };
  }

  private async retrieveGraphExpansion(
    input: KnowledgeRetrievalInput,
    envelope: RetrievalIntentEnvelope,
    datasetName: string | undefined,
    seedRefs: KnowledgeCandidateRef[],
  ): Promise<{
    active: boolean;
    candidates: KnowledgeCandidateRef[];
    selectedRefs: KnowledgeCandidateRef[];
    rejectedRefs: KnowledgeCandidateRef[];
    diagnostics: Array<Record<string, unknown>>;
  }> {
    const mode = (process.env.ALLEN_COGNEE_GRAPH_EXPANSION ?? 'off').toLowerCase();
    if (!['active', 'shadow'].includes(mode)) {
      return {
        active: false,
        candidates: [],
        selectedRefs: [],
        rejectedRefs: [],
        diagnostics: [{
          code: 'cognee_graph_expansion_disabled',
          severity: 'info',
          mode,
          message: 'Cognee graph expansion is disabled; Allen will use only primary Cognee semantic retrieval plus any Allen mandatory context.',
        }],
      };
    }
    const seeds = seedRefs
      .filter((ref) => ref.path || ref.providerMetadata?.cogneeChunkId)
      .slice(0, positiveIntegerEnv('ALLEN_COGNEE_GRAPH_EXPANSION_SEEDS', 3));
    if (!seeds.length) {
      return {
        active: false,
        candidates: [],
        selectedRefs: [],
        rejectedRefs: [],
        diagnostics: [{ code: 'cognee_graph_expansion_no_seeds', severity: 'info', message: 'Cognee graph expansion had no selected seed refs.' }],
      };
    }
    const timeoutMs = positiveIntegerEnv('ALLEN_COGNEE_GRAPH_EXPANSION_TIMEOUT_MS', DEFAULT_COGNEE_GRAPH_EXPANSION_TIMEOUT_MS);
    try {
      const output = await runCogneeSidecar('search', {
        datasetName: datasetName ?? cogneeDatasetName(input.repoId, input.repoName),
        dataDir: cogneeDataDir(),
        query: buildGraphExpansionQuery(input, seeds),
        searchMode: 'GRAPH_COMPLETION_CONTEXT_EXTENSION',
        retrievalEnvelope: envelope,
        repo: {
          repoId: input.repoId,
          repoName: input.repoName,
          repoPath: input.repoPath,
          branch: input.state.branch ?? input.state.defaultBranch,
          headSha: input.state.headSha ?? input.state.head_sha,
        },
        limits: {
          maxResults: positiveIntegerEnv('ALLEN_COGNEE_GRAPH_EXPANSION_MAX_RESULTS', 10),
        },
      }, undefined, {
        timeoutMs,
      });
      const rawRefs = normalizeCogneeRefs(output.results, this.providerId).map((ref) => ({
        ...ref,
        source: 'cognee_graph_expansion',
        providerMetadata: {
          ...ref.providerMetadata,
          graphExpansion: true,
          graphExpansionMode: mode,
          seedRefIds: seeds.map((seed) => seed.refId),
        },
      }));
      const enriched = await enrichCogneeCandidates({ db: this.db, repoId: input.repoId, candidates: rawRefs });
      const selected = selectCogneeRefs(enriched.candidates, input, envelope, 'graph_expansion');
      return {
        active: mode === 'active',
        candidates: enriched.candidates,
        selectedRefs: mode === 'active' ? selected.selectedRefs : [],
        rejectedRefs: mode === 'active' ? selected.rejectedRefs : enriched.candidates.map((ref) => ({
          ...ref,
          reason: `Shadow graph expansion candidate not selected for injection: ${ref.reason}`,
          providerMetadata: { ...ref.providerMetadata, injectionDecision: 'manifest_only', injectionPolicy: 'manifest_only' },
        })),
        diagnostics: [
          ...normalizeUsageArray(output.diagnostics),
          ...enriched.diagnostics,
          ...selected.diagnostics,
          {
            code: mode === 'active' ? 'cognee_graph_expansion_active' : 'cognee_graph_expansion_shadow',
            severity: 'info',
            seedCount: seeds.length,
            candidateCount: enriched.candidates.length,
            selectedCount: mode === 'active' ? selected.selectedRefs.length : 0,
            timeoutMs,
            searchMode: 'GRAPH_COMPLETION_CONTEXT_EXTENSION',
            llmBacked: true,
            message: mode === 'active'
              ? 'Cognee graph expansion candidates were allowed into selected context.'
              : 'Cognee graph expansion ran in shadow mode and did not affect selected context.',
          },
        ],
      };
    } catch (err) {
      return {
        active: false,
        candidates: [],
        selectedRefs: [],
        rejectedRefs: [],
        diagnostics: [{
          code: 'cognee_graph_expansion_failed',
          severity: 'warn',
          message: (err as Error).message,
        }],
      };
    }
  }

  private async loadStatus(repoId: string): Promise<{ datasetName?: string } | null> {
    if (!this.db) return null;
    const status = await this.db.collection('repo_cognee_datasets').findOne(
      { repoId },
      { projection: { datasetName: 1, ingestFormat: 1 } },
    );
    if (!isRecord(status)) return null;
    if (status.ingestFormat !== COGNEE_INGEST_FORMAT) return null;
    return {
      datasetName: firstString(status.datasetName),
    };
  }
}

export function cogneeDatasetName(repoId: string, repoName?: string): string {
  const safeName = String(repoName ?? 'repo').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `allen-${safeName}-${repoId}-docmeta-v1`;
}

export function cogneeDataDir(): string {
  return process.env.ALLEN_COGNEE_DATA_DIR ?? join(process.cwd(), '.allen', 'cognee');
}

export function isCogneeCorruptWalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /corrupted wal file|invalid wal record type/i.test(message);
}

export async function recoverCogneeGraphWalFiles(dataDir = cogneeDataDir()): Promise<Array<Record<string, unknown>>> {
  const databasePath = join(dataDir, 'system', 'databases');
  const files = await findCogneeGraphWalFiles(databasePath);
  const suffix = `.corrupt-${timestampSuffix()}`;
  const moved: Array<{ path: string; movedTo: string }> = [];
  for (const path of files) {
    const movedTo = `${path}${suffix}`;
    await rename(path, movedTo);
    moved.push({ path, movedTo });
  }
  return [{
    code: moved.length > 0 ? 'cognee_graph_wal_recovered' : 'cognee_graph_wal_recovery_noop',
    severity: moved.length > 0 ? 'warn' : 'info',
    message: moved.length > 0
      ? 'Recovered a corrupted Cognee graph WAL by moving WAL files aside before retrying'
      : 'Cognee graph WAL recovery was requested, but no active graph WAL files were found',
    databasePath,
    fileCount: moved.length,
    files: moved,
  }];
}

export type CogneeSidecarProgress = {
  stage?: string;
  message?: string;
  processedDocumentCount?: number;
  ingestedDocumentCount?: number;
  cognifiedDocumentCount?: number;
  documentCount?: number;
  candidateCount?: number;
  documentsToIngestCount?: number;
  addedDocumentCount?: number;
  changedDocumentCount?: number;
  deletedDocumentCount?: number;
  unchangedDocumentCount?: number;
  uncognifiedRetryCount?: number;
  storageRoot?: string;
  systemRoot?: string;
  databasePath?: string;
  storageExisting?: boolean;
  datasetExisting?: boolean;
};

export type CogneeSidecarOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

const COGNEE_PROGRESS_PREFIX = '__ALLEN_COGNEE_PROGRESS__';
const DEFAULT_COGNEE_INGEST_TIMEOUT_MS = 4 * 60 * 60_000;
const DEFAULT_COGNEE_SEARCH_TIMEOUT_MS = 120_000;
const DEFAULT_COGNEE_GRAPH_EXPANSION_TIMEOUT_MS = 300_000;
const MAX_COGNEE_STDERR_CHARS = 256_000;
const MAX_COGNEE_STDOUT_CHARS = 10_000_000;
const MAX_COGNEE_STDERR_LINE_CHARS = 64_000;

export async function runCogneeSidecar(
  action: 'search' | 'ingest',
  payload: Record<string, unknown>,
  onProgress?: (progress: CogneeSidecarProgress) => void,
  options: CogneeSidecarOptions = {},
): Promise<Record<string, unknown>> {
  if (!isCogneeContextEnabled()) throw contextProviderDisabledError('Cognee context provider is disabled.');
  const python = resolveAllenPython();
  const script = resolveCogneeScript();
  const defaultTimeoutMs = action === 'ingest' ? DEFAULT_COGNEE_INGEST_TIMEOUT_MS : DEFAULT_COGNEE_SEARCH_TIMEOUT_MS;
  const timeoutMs = Number(options.timeoutMs ?? process.env.ALLEN_COGNEE_TIMEOUT_MS ?? defaultTimeoutMs);
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
  const llm = resolveContextLlmConfig({ purpose: 'cognee' });
  const body = {
    action,
    embeddingProvider: process.env.ALLEN_COGNEE_EMBEDDING_PROVIDER ?? 'local',
    embeddingModel: process.env.ALLEN_COGNEE_EMBEDDING_MODEL ?? 'BAAI/bge-small-en-v1.5',
    llmProvider: llm.provider,
    llmModel: llm.model,
    llmUrl: cogneeLlmUrl(),
    llmSecret: cogneeLlmSecret(),
    ...payload,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stderrLineBuffer = '';
    let stdoutTruncated = false;
    let settled = false;
    let stopKillTimer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopKillTimer) clearTimeout(stopKillTimer);
      options.signal?.removeEventListener('abort', abort);
      fn();
    };
    const abort = () => {
      if (settled) return;
      child.kill('SIGTERM');
      stopKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5_000);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new Error(`Cognee ${action} timed out after ${Math.round(effectiveTimeoutMs / 1000)} seconds`)));
    }, effectiveTimeoutMs);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk.toString(), MAX_COGNEE_STDOUT_CHARS);
      stdoutTruncated ||= next.truncated;
      stdout = next.value;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = appendBounded(stderr, text, MAX_COGNEE_STDERR_CHARS).value;
      const lines = `${stderrLineBuffer}${text}`.split(/\r?\n/);
      stderrLineBuffer = tail(lines.pop() ?? '', MAX_COGNEE_STDERR_LINE_CHARS);
      for (const line of lines) {
        if (!line.startsWith(COGNEE_PROGRESS_PREFIX)) continue;
        try {
          const parsed = JSON.parse(line.slice(COGNEE_PROGRESS_PREFIX.length));
          if (isRecord(parsed)) onProgress?.(parsed as CogneeSidecarProgress);
        } catch {
          // Keep malformed progress lines in stderr for diagnostics.
        }
      }
    });
    child.on('error', (err) => {
      finish(() => reject(err));
    });
    child.on('close', (code) => {
      if (options.signal?.aborted) {
        finish(() => reject(new CogneeSidecarStoppedError(`Cognee ${action} stopped by user`)));
        return;
      }
      if (code !== 0) {
        finish(() => reject(new Error(stderr.trim() || `Cognee ${action} sidecar exited with code ${code}`)));
        return;
      }
      if (stdoutTruncated) {
        finish(() => reject(new Error(`Cognee ${action} sidecar stdout exceeded ${MAX_COGNEE_STDOUT_CHARS} characters`)));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (isRecord(parsed)) finish(() => resolve(parsed));
        else finish(() => reject(new Error(`Cognee ${action} sidecar returned non-object JSON`)));
      } catch (err) {
        finish(() => reject(new Error(`Cognee ${action} sidecar returned invalid JSON: ${(err as Error).message}`)));
      }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

export class CogneeSidecarStoppedError extends Error {
  constructor(message = 'Cognee sidecar stopped by user') {
    super(message);
    this.name = 'CogneeSidecarStoppedError';
  }
}

export function isCogneeSidecarStoppedError(error: unknown): boolean {
  return error instanceof CogneeSidecarStoppedError
    || (error instanceof Error && error.name === 'CogneeSidecarStoppedError');
}

function appendBounded(current: string, next: string, maxChars: number): { value: string; truncated: boolean } {
  if (next.length >= maxChars) {
    return { value: next.slice(-maxChars), truncated: true };
  }
  const total = current.length + next.length;
  if (total <= maxChars) {
    return { value: current + next, truncated: false };
  }
  return { value: `${current}${next}`.slice(-maxChars), truncated: true };
}

function tail(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

async function findCogneeGraphWalFiles(root: string): Promise<string[]> {
  const pending = [root];
  const files: string[] = [];
  while (pending.length) {
    const dir = pending.pop()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && isActiveCogneeGraphWalFile(entry.name)) {
        files.push(path);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function isActiveCogneeGraphWalFile(name: string): boolean {
  return name.includes('.lbug.wal') && !name.includes('.corrupt-');
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function normalizeCogneeRefs(value: unknown, providerId: string): KnowledgeCandidateRef[] {
  return normalizeUsageArray(value).map((row, index) => {
    const normalizedRow = normalizeCogneeEnvelopeRow(row);
    const sourceMetadata = normalizeSourceMetadata(normalizedRow);
    const content = firstString(normalizedRow.content, normalizedRow.text, normalizedRow.body);
    const path = firstPortablePath(sourceMetadata.path, normalizedRow.path, normalizedRow.label);
    const title = firstString(normalizedRow.title, normalizedRow.name, sourceMetadata.title) ?? path ?? `Cognee memory ${index + 1}`;
    const kind = firstString(normalizedRow.kind, sourceMetadata.kind);
    const documentRole = classifyDocumentRole({ path, title, content, kind });
    const containsCodeBlocks = Boolean(content && /```/.test(content));
    const grounding = path ? 'repo_backed' : firstString(normalizedRow.grounding) === 'provider_text' ? 'provider_text' : 'provider_generated';
    const itemType = path ? (content ? 'repo_chunk' : 'repo_file') : firstString(normalizedRow.itemType) === 'provider_text' ? 'provider_text' : 'provider_generated';
    const cogneeChunkId = firstString(normalizedRow.chunkId, normalizedRow.chunk_id, normalizedRow.id, normalizedRow.uuid);
    const refId = cogneeChunkId ? `cognee:${cogneeChunkId}` : firstString(normalizedRow.refId) ?? `cognee:${index}:${sha256(`${path ?? ''}:${content ?? ''}`).slice(0, 16)}`;
    return {
      refId,
      kind: normalizeKind(kind),
      title,
      path,
      summary: firstString(normalizedRow.summary, normalizedRow.reason, content?.slice(0, 500)),
      tags: Array.from(new Set([...(Array.isArray(normalizedRow.tags) ? normalizedRow.tags.map(String) : ['cognee']), documentRole])),
      providerId,
      source: firstString(normalizedRow.source) ?? 'cognee_recall',
      reason: firstString(normalizedRow.reason, normalizedRow.explanation) ?? 'Cognee recalled this context for the task intent.',
      score: normalizeScore(normalizedRow.score, normalizedRow.confidence, normalizedRow.distance),
      loadable: Boolean(path || content),
      mandatory: false,
      itemType,
      grounding,
      content,
      contentSha256: content ? sha256(content) : undefined,
      providerMetadata: normalizeProviderMetadata(normalizedRow, {
        documentRole,
        containsCodeBlocks,
        chunkId: cogneeChunkId,
        cogneeChunkId,
        chunkIndex: normalizedRow.chunkIndex ?? normalizedRow.chunk_index,
        chunkSize: normalizedRow.chunkSize ?? normalizedRow.chunk_size,
        cutType: normalizedRow.cutType ?? normalizedRow.cut_type,
        sourceMetadata,
      }),
    };
  });
}

function normalizeCogneeEnvelopeRow(row: Record<string, unknown>): Record<string, unknown> {
  const envelope = findCogneeEnvelope(row);
  if (!envelope) return row;
  return {
    ...row,
    ...envelope,
    metadata: isRecord(row.metadata) ? { ...row.metadata, originalEnvelope: true } : row.metadata,
  };
}

function normalizeScore(score: unknown, confidence: unknown, distance: unknown): number | undefined {
  const direct = Number(score ?? confidence);
  if (Number.isFinite(direct)) return direct;
  const distanceValue = Number(distance);
  return Number.isFinite(distanceValue) ? 1 / (1 + Math.max(0, distanceValue)) : undefined;
}

function normalizeProviderMetadata(row: Record<string, unknown>, derived: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    datasetId: row.datasetId ?? row.dataset_id,
    datasetName: row.datasetName ?? row.dataset_name,
    sourceId: row.sourceId ?? row.source_id,
    chunkId: row.chunkId ?? row.chunk_id ?? row.id ?? row.uuid,
    entityIds: row.entityIds ?? row.entity_ids,
    confidence: row.confidence,
    searchMode: row.searchMode,
    latencyMs: row.latencyMs,
    ...derived,
  };
}

function normalizeSourceMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const candidates = [
    row.externalMetadata,
    row.external_metadata,
    row.sourceMetadata,
    row.source_metadata,
    isRecord(row.metadata) ? row.metadata.externalMetadata : undefined,
    isRecord(row.metadata) ? row.metadata.external_metadata : undefined,
    isRecord(row.document) ? row.document.externalMetadata : undefined,
    isRecord(row.document) ? row.document.external_metadata : undefined,
    isRecord(row.isPartOf) ? row.isPartOf.externalMetadata : undefined,
    isRecord(row.is_part_of) ? row.is_part_of.external_metadata : undefined,
  ];
  for (const candidate of candidates) {
    const parsed = normalizeMetadataObject(candidate);
    if (parsed) return parsed;
  }
  return {};
}

function normalizeMetadataObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function classifyDocumentRole(input: { path?: string; title?: string; content?: string; kind?: string }): string {
  const haystack = [input.path, input.title, input.kind, input.content?.slice(0, 4000)].filter(Boolean).join(' ').toLowerCase();
  if (/\b(agent|agents|coding|security|guideline|guidelines|instructions?|standards?)\b/.test(haystack)) return 'guideline';
  if (/\b(runbook|playbook|ops|incident|production)\b/.test(haystack)) return 'guideline';
  if (/\b(prd|product[ _-]?requirements?|requirements?[ _-]?doc|specification|user[ _-]?story)\b/.test(haystack)) return 'prd';
  if (/\b(design|architecture|proposal|rfc|adr)\b/.test(haystack)) return 'design';
  if (/\b(generated|llm|ai[ _-]?generated)\b/.test(haystack)) return 'generated_doc';
  if (input.path && /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|cpp|c|h|sql|sh|yaml|yml|json)$/i.test(input.path)) return 'source';
  return 'unknown';
}

function findCogneeEnvelope(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    return parsed ? normalizeCogneeEnvelope(parsed, depth + 1) : undefined;
  }
  if (isRecord(value)) {
    const normalized = normalizeCogneeEnvelope(value, depth + 1);
    if (normalized) return normalized;
    for (const key of ['content', 'text', 'page_content', 'body', 'document', 'data', 'value', 'payload']) {
      const found = findCogneeEnvelope(value[key], depth + 1);
      if (found) return found;
    }
    const foundMetadata = findCogneeEnvelope(value.metadata, depth + 1);
    if (foundMetadata) return foundMetadata;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCogneeEnvelope(item, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function normalizeCogneeEnvelope(value: Record<string, unknown>, depth: number): Record<string, unknown> | undefined {
  const hasEnvelopeShape = ['title', 'path', 'kind', 'repoId', 'repo_id'].some((key) => key in value) && 'content' in value;
  if (!hasEnvelopeShape) return undefined;
  const nested = findCogneeEnvelope(value.content, depth + 1);
  return nested ? { ...value, ...nested } : value;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const text = value.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeKind(value: unknown): KnowledgeNodeKind {
  const kind = String(value ?? 'historical_learning');
  const supported = new Set([
    'repo', 'module', 'source_file', 'context_file', 'doc', 'runbook', 'skill', 'skill_reference',
    'production_note', 'instruction_file', 'command', 'command_profile', 'imported_agent', 'historical_learning',
  ]);
  return (supported.has(kind) ? kind : 'historical_learning') as KnowledgeNodeKind;
}

function resolveCogneeScript(): string {
  if (process.env.ALLEN_COGNEE_SIDECAR_SCRIPT) return process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '../../scripts/cognee-context-provider.py'),
    join(process.cwd(), 'packages/server/src/scripts/cognee-context-provider.py'),
    join(process.cwd(), 'src/scripts/cognee-context-provider.py'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function cogneeLlmUrl(): string {
  if (process.env.ALLEN_COGNEE_LLM_URL) return process.env.ALLEN_COGNEE_LLM_URL;
  const base = process.env.ALLEN_INTERNAL_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '4000'}`;
  return `${base.replace(/\/+$/, '')}/api/internal/context-evaluation/cognee-llm/v1`;
}

function cogneeLlmSecret(): string | undefined {
  return process.env.ALLEN_CONTEXT_LLM_SECRET ?? process.env.ALLEN_COGNEE_LLM_SECRET ?? process.env.ALLEN_CONTEXT_EVAL_JUDGE_SECRET ?? process.env.JWT_ACCESS_SECRET;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function firstPortablePath(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().replace(/\\/g, '/');
    if (!normalized || normalized === '.') continue;
    if (normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../')) continue;
    if (/^[a-zA-Z]:\//.test(normalized) || /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) continue;
    return normalized;
  }
  return undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
