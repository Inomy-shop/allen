import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { CandidateContextFile } from './repo-context-curation-git.js';
import { shouldBlockAgentAdjacentInjection } from './repo-context-agent-adjacent.js';

export type CurationAssignmentPlan = {
  runId: string;
  source: 'retry_files' | 'expected_files';
  totalFiles: number;
  totalBytes: number;
  assignments: Array<{
    assignmentId: string;
    workerId: string;
    files: CandidateContextFile[];
    fileCount: number;
    totalBytes: number;
  }>;
  concurrencyLimit: number;
  immediateWorkerCount: number;
  registered: boolean;
};

export type CurationStageStatus = {
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
  entries: unknown[];
  diagnostics: Array<Record<string, unknown>>;
};

const MAX_CURATED_CONTEXT_CHARS = 12_000;
const MAX_RETRIEVAL_TEXT_CHARS = 16_000;
const MAX_CHUNK_TEXT_CHARS = 6_000;
const MAX_CHUNKS_PER_FILE = 10;
const MAX_GENERATED_CHARS_PER_FILE = 60_000;
const DEFAULT_MAX_FILES_PER_ASSIGNMENT = 20;
const DEFAULT_MAX_BYTES_PER_ASSIGNMENT = 350_000;
const DEFAULT_LARGE_FILE_BYTES = 350_000;
const MAX_WORKER_CONCURRENCY = 4;
const DEFAULT_WORKER_CONCURRENCY = 4;
const STAGE_RUNS = 'repo_context_curation_runs';
const STAGE_ENTRIES = 'repo_context_curation_stage_entries';
const STAGE_FILE_STATUSES = 'repo_context_curation_stage_file_statuses';
const FILE_STATUSES = new Set(['included', 'excluded', 'condensed', 'omitted_with_reason', 'failed']);

export function curationBudgets(): Record<string, number> {
  return {
    maxCuratedContextChars: MAX_CURATED_CONTEXT_CHARS,
    maxRetrievalTextChars: MAX_RETRIEVAL_TEXT_CHARS,
    maxChunkTextChars: MAX_CHUNK_TEXT_CHARS,
    maxChunksPerFile: MAX_CHUNKS_PER_FILE,
    maxGeneratedCharsPerFile: MAX_GENERATED_CHARS_PER_FILE,
  };
}

export async function createRepoContextCurationRun(db: Db, input: {
  executionId: string;
  profileId: string;
  repoId: string;
  repoName: string;
  expectedFiles: CandidateContextFile[];
  scope?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const existing = await db.collection(STAGE_RUNS).findOne({ executionId: input.executionId, status: { $in: ['running', 'validated'] } });
  if (existing) return existing;
  const now = new Date();
  const doc = {
    runId: randomUUID(),
    executionId: input.executionId,
    profileId: input.profileId,
    repoId: input.repoId,
    repoName: input.repoName,
    status: 'running',
    assignments: [],
    budgets: curationBudgets(),
    expectedFiles: input.expectedFiles,
    expectedFileCount: input.expectedFiles.length,
    scope: input.scope ?? {},
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(STAGE_RUNS).insertOne(doc);
  return doc;
}

export async function registerRepoContextCurationAssignments(db: Db, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = stringValue(body.run_id) ?? stringValue(body.runId);
  if (!runId) throw new Error('run_id is required');
  const run = await db.collection(STAGE_RUNS).findOne({ runId, status: 'running' });
  if (!run) throw new Error('Curation staging run is not active');
  const expected = expectedFileMap(run);
  const rawAssignments = Array.isArray(body.assignments) ? body.assignments as Record<string, unknown>[] : [];
  const existing = Array.isArray(run.assignments) ? run.assignments as Array<Record<string, unknown>> : [];
  const byId = new Map(existing.map((assignment) => [String(assignment.assignmentId), assignment]));
  let accepted = 0;

  for (const raw of rawAssignments) {
    const assignmentId = stringValue(raw.assignmentId) ?? stringValue(raw.assignment_id) ?? randomUUID();
    const workerId = stringValue(raw.workerId) ?? stringValue(raw.worker_id) ?? `worker-${String(byId.size + 1).padStart(2, '0')}`;
    const files = normalizeCandidateFiles(raw.files).filter((file) => expected.has(fileKey(file)));
    if (!files.length) continue;
    byId.set(assignmentId, { assignmentId, workerId, files, updatedAt: new Date() });
    accepted++;
  }

  const assignments = Array.from(byId.values());
  await db.collection(STAGE_RUNS).updateOne(
    { runId },
    { $set: { assignments, updatedAt: new Date() }, $inc: { assignmentRegistrations: 1 } },
  );
  return { runId, acceptedAssignments: accepted, totalAssignments: assignments.length };
}

export async function planRepoContextCurationAssignments(db: Db, body: Record<string, unknown>): Promise<CurationAssignmentPlan> {
  const runId = stringValue(body.run_id) ?? stringValue(body.runId);
  if (!runId) throw new Error('run_id is required');
  const run = await db.collection(STAGE_RUNS).findOne({ runId, status: 'running' });
  if (!run) throw new Error('Curation staging run is not active');

  const stage = await getRepoContextCurationStageStatus(db, runId);
  const retryFiles = normalizeCandidateFiles(stage.retryFiles);
  const expectedFiles = normalizeCandidateFiles(run.expectedFiles);
  const includeAll = body.include_all === true || body.includeAll === true;
  const useExpected = includeAll;
  const files = stage.promotable && !includeAll ? [] : useExpected ? expectedFiles : retryFiles;
  const plan = buildRepoContextCurationAssignmentPlan(runId, files, {
    maxFilesPerAssignment: positiveInt(body.max_files_per_assignment ?? body.maxFilesPerAssignment, DEFAULT_MAX_FILES_PER_ASSIGNMENT),
    maxBytesPerAssignment: positiveInt(body.max_bytes_per_assignment ?? body.maxBytesPerAssignment, DEFAULT_MAX_BYTES_PER_ASSIGNMENT),
    largeFileBytes: positiveInt(body.large_file_bytes ?? body.largeFileBytes, DEFAULT_LARGE_FILE_BYTES),
    concurrencyLimit: cappedPositiveInt(body.concurrency_limit ?? body.concurrencyLimit, DEFAULT_WORKER_CONCURRENCY, MAX_WORKER_CONCURRENCY),
    source: useExpected ? 'expected_files' : 'retry_files',
  });

  const register = body.register !== false;
  if (register && plan.assignments.length) {
    await registerRepoContextCurationAssignments(db, {
      run_id: runId,
      assignments: plan.assignments,
    });
  }
  return { ...plan, registered: register && plan.assignments.length > 0 };
}

export function buildRepoContextCurationAssignmentPlan(runId: string, files: CandidateContextFile[], options: {
  maxFilesPerAssignment?: number;
  maxBytesPerAssignment?: number;
  largeFileBytes?: number;
  concurrencyLimit?: number;
  source?: 'retry_files' | 'expected_files';
} = {}): CurationAssignmentPlan {
  const maxFiles = Math.max(1, Math.floor(options.maxFilesPerAssignment ?? DEFAULT_MAX_FILES_PER_ASSIGNMENT));
  const maxBytes = Math.max(1, Math.floor(options.maxBytesPerAssignment ?? DEFAULT_MAX_BYTES_PER_ASSIGNMENT));
  const largeFileBytes = Math.max(1, Math.floor(options.largeFileBytes ?? DEFAULT_LARGE_FILE_BYTES));
  const concurrencyLimit = Math.min(MAX_WORKER_CONCURRENCY, Math.max(1, Math.floor(options.concurrencyLimit ?? DEFAULT_WORKER_CONCURRENCY)));
  const sortedFiles = uniqueFiles(files).sort((a, b) => assignmentSortKey(a).localeCompare(assignmentSortKey(b)));
  const batches: CandidateContextFile[][] = [];
  let current: CandidateContextFile[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
    currentBytes = 0;
  };

  for (const file of sortedFiles) {
    const fileBytes = Math.max(0, file.bytes ?? 0);
    if (fileBytes >= largeFileBytes) {
      flush();
      batches.push([file]);
      continue;
    }
    const wouldExceedFiles = current.length >= maxFiles;
    const wouldExceedBytes = current.length > 0 && currentBytes + fileBytes > maxBytes;
    const wouldChangeGroup = current.length > 0 && assignmentGroup(current[0]) !== assignmentGroup(file) && currentBytes > maxBytes / 2;
    if (wouldExceedFiles || wouldExceedBytes || wouldChangeGroup) flush();
    current.push(file);
    currentBytes += fileBytes;
  }
  flush();

  const assignments = batches.map((batch, index) => {
    const totalBytes = batch.reduce((sum, file) => sum + Math.max(0, file.bytes ?? 0), 0);
    const ordinal = String(index + 1).padStart(3, '0');
    return {
      assignmentId: `curation-${ordinal}`,
      workerId: `repo-context-curation-worker-${ordinal}`,
      files: batch,
      fileCount: batch.length,
      totalBytes,
    };
  });

  return {
    runId,
    source: options.source ?? 'retry_files',
    totalFiles: sortedFiles.length,
    totalBytes: sortedFiles.reduce((sum, file) => sum + Math.max(0, file.bytes ?? 0), 0),
    assignments,
    concurrencyLimit,
    immediateWorkerCount: Math.min(concurrencyLimit, assignments.length),
    registered: false,
  };
}

export async function saveRepoContextCurationStage(db: Db, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = stringValue(body.run_id) ?? stringValue(body.runId);
  const assignmentId = stringValue(body.assignment_id) ?? stringValue(body.assignmentId);
  const workerId = stringValue(body.worker_id) ?? stringValue(body.workerId);
  if (!runId || !assignmentId || !workerId) throw new Error('run_id, assignment_id, and worker_id are required');
  const run = await db.collection(STAGE_RUNS).findOne({ runId, status: 'running' });
  if (!run) throw new Error('Curation staging run is not active');
  const assignments = Array.isArray(run.assignments) ? run.assignments as Array<Record<string, unknown>> : [];
  const assignment = assignments.find((item) => item.assignmentId === assignmentId && item.workerId === workerId);
  if (!assignment) throw new Error('Curation assignment is not valid for this run');
  const assignedFiles = normalizeCandidateFiles(assignment.files);
  const assigned = new Map(assignedFiles.map((file) => [fileKey(file), file]));
  const now = new Date();
  const entries = Array.isArray(body.entries) ? body.entries as Record<string, unknown>[] : [];
  const fileStatuses = Array.isArray(body.file_statuses) ? body.file_statuses as Record<string, unknown>[]
    : Array.isArray(body.fileStatuses) ? body.fileStatuses as Record<string, unknown>[] : [];
  let savedEntries = 0;
  let savedStatuses = 0;
  let rejectedEntries = 0;
  let rejectedStatuses = 0;

  for (const entry of entries) {
    const path = stringValue(entry.path);
    const sourceHash = stringValue(entry.sourceHash);
    if (!path || !sourceHash || !assigned.has(`${path}:${sourceHash}`)) {
      rejectedEntries++;
      continue;
    }
    const validation = validateStageEntry(entry);
    if (!validation.ok) {
      rejectedEntries++;
      continue;
    }
    await db.collection(STAGE_ENTRIES).updateOne(
      {
        runId,
        path,
        sourceHash,
        entryKey: stringValue(entry.entryKey) ?? stringValue(entry.title) ?? path,
      },
      {
        $set: {
          runId,
          assignmentId,
          workerId,
          repoId: run.repoId,
          executionId: run.executionId,
          path,
          sourceHash,
          entry,
          validation,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    savedEntries++;
  }

  for (const status of fileStatuses) {
    const path = stringValue(status.path);
    const sourceHash = stringValue(status.sourceHash);
    const state = stringValue(status.status);
    if (!path || !sourceHash || !state || !FILE_STATUSES.has(state) || !assigned.has(`${path}:${sourceHash}`)) {
      rejectedStatuses++;
      continue;
    }
    await db.collection(STAGE_FILE_STATUSES).updateOne(
      { runId, path, sourceHash },
      {
        $set: {
          runId,
          assignmentId,
          workerId,
          repoId: run.repoId,
          executionId: run.executionId,
          path,
          sourceHash,
          status: state,
          reason: stringValue(status.reason),
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    savedStatuses++;
  }

  await db.collection(STAGE_RUNS).updateOne({ runId }, { $set: { updatedAt: now }, $inc: { saveCalls: 1 } });
  return { runId, assignmentId, workerId, savedEntries, savedStatuses, rejectedEntries, rejectedStatuses };
}

export async function getRepoContextCurationStageStatus(db: Db, runId: string): Promise<CurationStageStatus> {
  const run = await db.collection(STAGE_RUNS).findOne({ runId });
  if (!run) throw new Error('Curation staging run not found');
  return validateStagingRun(db, run);
}

export async function markRepoContextCurationRunPromoted(db: Db, runId: string, validation: CurationStageStatus): Promise<void> {
  const result = await db.collection(STAGE_RUNS).updateOne(
    { runId, status: { $in: ['running', 'validated'] } },
    { $set: { status: 'promoted', validation: statusForPersistence(validation), updatedAt: new Date(), completedAt: new Date() } },
  );
  if (result.modifiedCount === 0) throw new Error('Curation staging run is not active');
}

async function validateStagingRun(db: Db, run: Record<string, unknown>): Promise<CurationStageStatus> {
  const runId = stringValue(run.runId);
  if (!runId) throw new Error('Curation staging run is missing runId');
  const diagnostics: Array<Record<string, unknown>> = [];
  const entries = await db.collection(STAGE_ENTRIES).find({ runId }).toArray();
  const statuses = await db.collection(STAGE_FILE_STATUSES).find({ runId }).toArray();
  const expectedFiles = normalizeCandidateFiles(run.expectedFiles);
  const expected = new Map(expectedFiles.map((file) => [fileKey(file), file]));
  const statusByFile = new Map<string, Record<string, unknown>[]>();
  for (const status of statuses) {
    const key = `${status.path}:${status.sourceHash}`;
    statusByFile.set(key, [...(statusByFile.get(key) ?? []), status]);
  }
  const entriesByFile = new Map<string, Record<string, unknown>[]>();
  for (const doc of entries) {
    const key = `${doc.path}:${doc.sourceHash}`;
    entriesByFile.set(key, [...(entriesByFile.get(key) ?? []), doc]);
  }

  const missingFiles: CandidateContextFile[] = [];
  const invalidFiles: CandidateContextFile[] = [];
  const duplicateStatusFiles: CandidateContextFile[] = [];
  const completed = new Set<string>();

  for (const [key, file] of expected) {
    const fileStatuses = statusByFile.get(key) ?? [];
    if (fileStatuses.length === 0) {
      missingFiles.push(file);
      diagnostics.push({ code: 'stage_file_status_missing', severity: 'warn', path: file.path, message: 'Expected one staged status for assigned file.' });
      continue;
    }
    if (fileStatuses.length > 1) {
      duplicateStatusFiles.push(file);
      diagnostics.push({ code: 'stage_file_status_duplicate', severity: 'warn', path: file.path, count: fileStatuses.length, message: 'Expected only one staged status for assigned file.' });
    }
    const status = String(fileStatuses[fileStatuses.length - 1].status ?? '');
    const fileEntries = entriesByFile.get(key) ?? [];
    if (status === 'failed') {
      invalidFiles.push(file);
      diagnostics.push({ code: 'stage_file_failed', severity: 'warn', path: file.path, message: 'Worker marked this file failed; it must be retried before promotion.' });
      continue;
    }
    if ((status === 'included' || status === 'condensed') && fileEntries.length === 0) {
      invalidFiles.push(file);
      diagnostics.push({ code: 'stage_included_file_without_entry', severity: 'warn', path: file.path, status, message: 'Included/condensed file has no staged context entry.' });
      continue;
    }
    completed.add(key);
  }

  const validEntries: unknown[] = [];
  const seen = new Set<string>();
  for (const doc of entries) {
    const key = `${doc.path}:${doc.sourceHash}`;
    if (!expected.has(key)) {
      diagnostics.push({ code: 'stage_entry_unexpected_file', severity: 'warn', path: doc.path, message: 'Staged entry references a file outside this run scope.' });
      continue;
    }
    const entry = doc.entry as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const validation = validateStageEntry(entry);
    if (!validation.ok) {
      const file = expected.get(key);
      if (file) invalidFiles.push(file);
      diagnostics.push({ code: 'stage_entry_validation_failed', severity: 'warn', path: doc.path, errors: validation.errors, message: 'Staged entry failed generated-context validation.' });
      continue;
    }
    const entryKey = `${key}:${stringValue(entry.title) ?? ''}:${stringValue(entry.entryKey) ?? ''}`;
    if (seen.has(entryKey)) continue;
    seen.add(entryKey);
    validEntries.push(entry);
  }

  const retryFiles = uniqueFiles([...missingFiles, ...invalidFiles, ...duplicateStatusFiles]);
  diagnostics.push({
    code: retryFiles.length ? 'stage_validation_incomplete' : 'stage_validation_complete',
    severity: retryFiles.length ? 'warn' : 'info',
    expectedFiles: expectedFiles.length,
    stagedEntries: entries.length,
    stagedStatuses: statuses.length,
    validEntries: validEntries.length,
    retryFiles: retryFiles.length,
    message: retryFiles.length ? 'Staging validation found missing or invalid files.' : 'Staging validation passed.',
  });
  return {
    runId,
    status: String(run.status ?? 'unknown'),
    expectedFiles: expectedFiles.length,
    stagedEntries: entries.length,
    validEntries: validEntries.length,
    stagedStatuses: statuses.length,
    completedFiles: completed.size,
    missingFiles: uniqueFiles(missingFiles),
    invalidFiles: uniqueFiles(invalidFiles),
    duplicateStatusFiles: uniqueFiles(duplicateStatusFiles),
    retryFiles,
    promotable: retryFiles.length === 0,
    entries: validEntries,
    diagnostics,
  };
}

export function validateStageEntry(entry: Record<string, unknown>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const inclusion = stringValue(entry.inclusion) ?? 'include';
  const category = stringValue(entry.category) ?? 'doc';
  const injectionPolicy = stringValue(entry.injectionPolicy) ?? 'manifest_only';
  const path = stringValue(entry.path) ?? '';
  const curatedContext = stringValue(entry.curatedContext) ?? '';
  const retrievalText = stringValue(entry.retrievalText) ?? '';
  const chunks = Array.isArray(entry.chunks) ? entry.chunks as Record<string, unknown>[] : [];
  if ((inclusion === 'include' || inclusion === 'condensed') && !curatedContext && !retrievalText && chunks.length === 0) errors.push('included entries require generated context');
  if (curatedContext.length > MAX_CURATED_CONTEXT_CHARS) errors.push('curatedContext exceeds budget');
  if (retrievalText.length > MAX_RETRIEVAL_TEXT_CHARS) errors.push('retrievalText exceeds budget');
  if (chunks.length > MAX_CHUNKS_PER_FILE) errors.push('too many chunks');
  let totalGenerated = curatedContext.length + retrievalText.length;
  for (const chunk of chunks) {
    const text = stringValue(chunk.text) ?? '';
    totalGenerated += text.length;
    if (!text) errors.push('chunk missing text');
    if (text.length > MAX_CHUNK_TEXT_CHARS) errors.push('chunk text exceeds budget');
  }
  const agentAdjacentBlock = shouldBlockAgentAdjacentInjection({
    path,
    category,
    inclusion,
    injectionPolicy,
    text: [
      entry.title,
      entry.summary,
      curatedContext,
      retrievalText,
      ...chunks.map((chunk) => stringValue(chunk.text) ?? ''),
      entry.reasoning,
    ].map((value) => String(value ?? '')).join('\n'),
  });
  if (agentAdjacentBlock) errors.push(agentAdjacentBlock.code);
  if (totalGenerated > MAX_GENERATED_CHARS_PER_FILE) errors.push('generated text per file exceeds budget');
  return { ok: errors.length === 0, errors };
}

function expectedFileMap(run: Record<string, unknown>): Map<string, CandidateContextFile> {
  return new Map(normalizeCandidateFiles(run.expectedFiles).map((file) => [fileKey(file), file]));
}

export function normalizeCandidateFiles(value: unknown): CandidateContextFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const path = stringValue(item.path) ?? '';
      const sourceHash = stringValue(item.sourceHash) ?? '';
      return {
        path,
        sourceHash,
        title: stringValue(item.title) ?? path,
        bytes: typeof item.bytes === 'number' ? item.bytes : Number(item.bytes ?? 0),
        kind: normalizeKind(item.kind),
      };
    })
    .filter((file) => file.path && file.sourceHash);
}

export function normalizeKind(value: unknown): CandidateContextFile['kind'] {
  return value === 'mdx' || value === 'mdc' ? value : 'markdown';
}

function statusForPersistence(status: CurationStageStatus): Record<string, unknown> {
  const { entries: _entries, ...rest } = status;
  return rest;
}

function fileKey(file: CandidateContextFile): string {
  return `${file.path}:${file.sourceHash}`;
}

function uniqueFiles(files: CandidateContextFile[]): CandidateContextFile[] {
  return Array.from(new Map(files.map((file) => [fileKey(file), file])).values());
}

function assignmentSortKey(file: CandidateContextFile): string {
  return `${assignmentGroup(file)}:${String(file.bytes ?? 0).padStart(12, '0')}:${file.path}`;
}

function assignmentGroup(file: CandidateContextFile): string {
  const parts = file.path.split('/').filter(Boolean);
  if (parts[0] === '.claude' && parts[1] && parts[2]) return `${parts[0]}/${parts[1]}/${parts[2]}`;
  if (parts[0] === 'docs' && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? '';
}

function positiveInt(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function cappedPositiveInt(value: unknown, fallback: number, max: number): number {
  return Math.min(max, positiveInt(value, fallback));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
