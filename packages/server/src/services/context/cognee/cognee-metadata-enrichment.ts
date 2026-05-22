import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import type { KnowledgeCandidateRef } from '../core/repo-context-engine.js';
import { isRecord } from '../allen-knowledge-graph/repo-knowledge-graph-utils.js';

export const COGNEE_METADATA_SCHEMA_VERSION = 1;

export type CogneeInjectionDecision = 'mandatory_full' | 'snippet' | 'manifest_only' | 'never_full_auto';

export type CogneeContextMetadata = {
  repoId: string;
  path: string;
  fileHash: string;
  schemaVersion: number;
  title: string;
  kind: string;
  categories: string[];
  sourceAuthority: 'high' | 'medium' | 'low';
  injectionDecision: CogneeInjectionDecision;
  confidence: number;
  active: boolean;
  generatedFrom: 'deterministic';
  generatedAt: Date;
  headings: string[];
};

export async function enrichCogneeCandidates(input: {
  db?: Db;
  repoId: string;
  candidates: KnowledgeCandidateRef[];
}): Promise<{
  candidates: KnowledgeCandidateRef[];
  diagnostics: Array<Record<string, unknown>>;
}> {
  const diagnostics: Array<Record<string, unknown>> = [];
  const enriched: KnowledgeCandidateRef[] = [];
  let generated = 0;
  let joined = 0;
  let lowConfidence = 0;
  let curationJoined = 0;

  for (const candidate of input.candidates) {
    const sourceMetadata = sourceMetadataFor(candidate);
    const curationResolution = await loadCuratedEntry(input.db, input.repoId, candidate, sourceMetadata);
    if (curationResolution.entry) curationJoined += 1;
    await persistObservedChunkMapping(input.db, input.repoId, candidate, curationResolution.entry, curationResolution.method);
    const path = firstString(candidate.path, sourceMetadata.path, firstString(curationResolution.entry?.path));
    if (!path) {
      lowConfidence += 1;
      enriched.push(withMetadata(withCuratedContext(candidate, curationResolution), undefined, ['metadata_missing_path']));
      continue;
    }

    const fileHash = firstString(
      sourceMetadata.fileHash,
      sourceMetadata.file_hash,
      candidate.contentSha256,
      candidate.content ? sha256(candidate.content) : undefined,
    ) ?? sha256(`${path}:${candidate.title}`);
    const collectionKey = {
      repoId: input.repoId,
      path,
      fileHash,
      schemaVersion: COGNEE_METADATA_SCHEMA_VERSION,
    };
    const cached = await input.db?.collection('repo_context_metadata').findOne(collectionKey).catch(() => null);
    const metadata = normalizeMetadata(cached)
      ?? generateDeterministicMetadata({
        repoId: input.repoId,
        path,
        fileHash,
        title: firstString(candidate.title, sourceMetadata.title) ?? path,
        kind: firstString(candidate.kind, sourceMetadata.kind) ?? 'doc',
        content: candidate.content,
      });
    if (!cached) generated += 1;
    if (!cached && input.db) {
      await input.db.collection('repo_context_metadata').updateOne(
        collectionKey,
        { $set: metadata, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      ).catch(() => {
        diagnostics.push({
          code: 'cognee_metadata_cache_write_failed',
          severity: 'warn',
          path,
          message: 'Allen generated deterministic Cognee metadata but could not cache it.',
        });
      });
    } else if (cached) {
      joined += 1;
    }
    if (metadata.confidence < 0.5) lowConfidence += 1;
    enriched.push(withMetadata(withCuratedContext(candidate, curationResolution), metadata, metadata.confidence < 0.5 ? ['metadata_low_confidence'] : []));
  }

  diagnostics.push({
    code: 'cognee_metadata_enrichment_complete',
    severity: 'info',
    candidateCount: input.candidates.length,
    joinedMetadataCount: joined,
    generatedMetadataCount: generated,
    lowConfidenceMetadataCount: lowConfidence,
    curationJoinedCount: curationJoined,
    schemaVersion: COGNEE_METADATA_SCHEMA_VERSION,
    message: 'Cognee candidates were joined to Allen deterministic metadata before selection.',
  });

  return { candidates: enriched, diagnostics };
}

type CurationResolution = {
  entry?: Record<string, unknown>;
  method: 'entry_id' | 'label_entry_id' | 'source_mapping' | 'path_fallback' | 'unresolved';
  mapping?: Record<string, unknown>;
};

async function loadCuratedEntry(
  db: Db | undefined,
  repoId: string,
  ref: KnowledgeCandidateRef,
  sourceMetadata: Record<string, unknown>,
): Promise<CurationResolution> {
  if (!db) return { method: 'unresolved' };
  const providerMetadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : {};
  const entryId = firstString(sourceMetadata.entryId, sourceMetadata.entry_id);
  const label = firstString(providerMetadata.label, sourceMetadata.label);
  const labelEntryId = curatedEntryIdFromLabel(label);
  const path = firstString(ref.path, sourceMetadata.path);
  const chunkId = firstString(providerMetadata.cogneeChunkId, providerMetadata.chunkId);
  const dataId = firstString(sourceMetadata.dataId, sourceMetadata.data_id, providerMetadata.sourceId);
  const cogneeDataId = firstString(sourceMetadata.cogneeDataId, sourceMetadata.cognee_data_id, providerMetadata.sourceId);
  const datasetName = firstString(providerMetadata.datasetName);
  if (entryId) {
    const entry = await findCurationEntry(db, repoId, { entryId });
    if (entry) return { entry, method: 'entry_id' };
  }
  if (labelEntryId) {
    const entry = await findCurationEntry(db, repoId, { entryId: labelEntryId });
    if (entry) return { entry, method: 'label_entry_id' };
  }
  const mapping = await loadSourceMapping(db, {
    repoId,
    datasetName,
    chunkId,
    dataId,
    cogneeDataId,
    label,
    path,
  });
  const mappedEntryId = firstString(mapping?.entryId, mapping?.entry_id);
  const mappedPath = firstString(mapping?.path);
  if (mappedEntryId) {
    const entry = await findCurationEntry(db, repoId, { entryId: mappedEntryId });
    if (entry) return { entry, method: 'source_mapping', mapping };
  }
  if (mappedPath) {
    const entry = await findCurationEntry(db, repoId, { path: mappedPath });
    if (entry) return { entry, method: 'source_mapping', mapping };
  }
  if (path) {
    const entry = await findCurationEntry(db, repoId, { path });
    if (entry) return { entry, method: 'path_fallback' };
  }
  return { method: 'unresolved', mapping };
}

async function findCurationEntry(db: Db, repoId: string, filter: { entryId?: string; path?: string }): Promise<Record<string, unknown> | undefined> {
  const clauses: Array<Record<string, unknown>> = [];
  if (filter.entryId) clauses.push({ entryId: filter.entryId });
  if (filter.path) clauses.push({ path: filter.path });
  if (!clauses.length) return undefined;
  const rows = await db.collection('repo_context_curation_entries')
    .find({ repoId, $or: clauses })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(10)
    .toArray()
    .catch(() => []);
  return rows.find(hasGeneratedCurationContent) ?? rows[0];
}

async function loadSourceMapping(
  db: Db,
  input: {
    repoId: string;
    datasetName?: string;
    chunkId?: string;
    dataId?: string;
    cogneeDataId?: string;
    label?: string;
    path?: string;
  },
): Promise<Record<string, unknown> | undefined> {
  const base = {
    repoId: input.repoId,
    active: true,
    ...(input.datasetName ? { datasetName: input.datasetName } : {}),
  };
  const candidates: Array<Record<string, unknown>> = [];
  if (input.chunkId) candidates.push({ ...base, chunkId: input.chunkId });
  if (input.dataId) candidates.push({ ...base, dataId: input.dataId });
  if (input.cogneeDataId) candidates.push({ ...base, cogneeDataId: input.cogneeDataId });
  if (input.label) candidates.push({ ...base, label: input.label });
  if (input.path) candidates.push({ ...base, path: input.path });
  for (const query of candidates) {
    const row = await db.collection('repo_cognee_source_mappings')
      .findOne(query, { sort: { mappingType: 1, updatedAt: -1, createdAt: -1 } })
      .catch(() => null);
    if (isRecord(row)) return row;
  }
  return undefined;
}

async function persistObservedChunkMapping(
  db: Db | undefined,
  repoId: string,
  ref: KnowledgeCandidateRef,
  entry: Record<string, unknown> | undefined,
  method: CurationResolution['method'],
): Promise<void> {
  if (!db || !entry) return;
  const providerMetadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : {};
  const chunkId = firstString(providerMetadata.cogneeChunkId, providerMetadata.chunkId);
  const datasetName = firstString(providerMetadata.datasetName);
  const label = firstString(providerMetadata.label);
  if (!chunkId || !datasetName) return;
  const now = new Date();
  await db.collection('repo_cognee_source_mappings').updateOne(
    { repoId, datasetName, chunkId, mappingType: 'chunk' },
    {
      $set: {
        repoId,
        datasetName,
        chunkId,
        mappingType: 'chunk',
        ingestFormat: 'curated_context_entry_v1',
        entryId: firstString(entry.entryId),
        label,
        path: firstString(entry.path),
        title: firstString(entry.title),
        fileHash: firstString(entry.sourceHash),
        source: `observed_search_${method}`,
        active: true,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  ).catch(() => {});
}

function withCuratedContext(ref: KnowledgeCandidateRef, resolution: CurationResolution): KnowledgeCandidateRef {
  const entry = resolution.entry;
  if (!entry) return ref;
  const curatedContext = firstString(entry.curatedContext);
  const retrievalText = firstString(entry.retrievalText);
  const entryId = firstString(entry.entryId);
  const path = firstString(entry.path) ?? ref.path;
  const existingSourceMetadata = isRecord(ref.providerMetadata?.sourceMetadata) ? ref.providerMetadata.sourceMetadata : {};
  const injectionPolicy = injectionDecisionValue(entry.injectionPolicy) === 'mandatory_full'
    ? 'snippet'
    : injectionDecisionValue(entry.injectionPolicy);
  return {
    ...ref,
    title: firstString(entry.title) ?? ref.title,
    path,
    summary: firstString(entry.summary) ?? ref.summary,
    content: curatedContext ?? ref.content,
    contentSha256: curatedContext ? sha256(curatedContext) : ref.contentSha256,
    grounding: path ? 'repo_backed' : ref.grounding,
    itemType: path ? 'repo_chunk' : ref.itemType,
    loadable: true,
    providerMetadata: {
      ...ref.providerMetadata,
      curationEntryId: entryId ?? entry.entryId,
      curationSourceHash: entry.sourceHash,
      curationCategory: entry.category,
      curationResolutionMethod: resolution.method,
      curationResolutionMappingId: resolution.mapping?._id,
      curatedContextHash: curatedContext ? sha256(curatedContext) : undefined,
      retrievalTextHash: retrievalText ? sha256(retrievalText) : undefined,
      injectionDecision: injectionPolicy,
      injectionPolicy,
      cogneeChunkText: ref.content,
      sourceMetadata: {
        ...existingSourceMetadata,
        repoId: firstString(existingSourceMetadata.repoId, existingSourceMetadata.repo_id) ?? firstString(entry.repoId),
        label: firstString(ref.providerMetadata?.label, existingSourceMetadata.label),
        path,
        title: firstString(entry.title) ?? ref.title,
        kind: firstString(entry.category, ref.kind),
        entryId: entryId ?? firstString(existingSourceMetadata.entryId, existingSourceMetadata.entry_id),
        fileHash: firstString(entry.sourceHash, existingSourceMetadata.fileHash, existingSourceMetadata.file_hash),
        ingestFormat: firstString(existingSourceMetadata.ingestFormat) ?? 'curated_context_entry_v1',
      },
    },
  };
}

function curatedEntryIdFromLabel(value: unknown): string | undefined {
  const label = firstString(value);
  const prefix = 'allen-curated-entry:';
  return label?.startsWith(prefix) ? firstString(label.slice(prefix.length)) : undefined;
}

function hasGeneratedCurationContent(entry: Record<string, unknown>): boolean {
  return Boolean(
    firstString(entry.curatedContext)
    || firstString(entry.retrievalText)
    || (Array.isArray(entry.chunks) && entry.chunks.some((chunk) => isRecord(chunk) && firstString(chunk.text))),
  );
}

export function generateDeterministicMetadata(input: {
  repoId: string;
  path: string;
  fileHash: string;
  title: string;
  kind: string;
  content?: string;
}): CogneeContextMetadata {
  const categories = categoriesFor(input.path, input.title, input.kind, input.content);
  const sourceAuthority = sourceAuthorityFor(input.path, categories);
  const injectionDecision = defaultInjectionDecisionFor(input.path, categories, sourceAuthority);
  const headings = markdownHeadings(input.content);
  return {
    repoId: input.repoId,
    path: input.path,
    fileHash: input.fileHash,
    schemaVersion: COGNEE_METADATA_SCHEMA_VERSION,
    title: input.title,
    kind: input.kind,
    categories,
    sourceAuthority,
    injectionDecision,
    confidence: confidenceFor(input.path, categories, headings),
    active: true,
    generatedFrom: 'deterministic',
    generatedAt: new Date(),
    headings,
  };
}

function withMetadata(ref: KnowledgeCandidateRef, metadata: CogneeContextMetadata | undefined, warnings: string[]): KnowledgeCandidateRef {
  return {
    ...ref,
    path: metadata?.path ?? ref.path,
    tags: Array.from(new Set([...(ref.tags ?? []), ...(metadata?.categories ?? [])])),
    providerMetadata: {
      ...ref.providerMetadata,
      allenMetadata: metadata,
      metadataSchemaVersion: metadata?.schemaVersion ?? COGNEE_METADATA_SCHEMA_VERSION,
      metadataCategories: metadata?.categories,
      metadataConfidence: metadata?.confidence,
      sourceAuthority: metadata?.sourceAuthority,
      metadataWarnings: warnings,
    },
  };
}

function normalizeMetadata(value: unknown): CogneeContextMetadata | undefined {
  if (!isRecord(value)) return undefined;
  if (value.active === false) return undefined;
  const categories = Array.isArray(value.categories) ? value.categories.map(String).filter(Boolean) : [];
  const path = firstString(value.path);
  const repoId = firstString(value.repoId);
  const fileHash = firstString(value.fileHash);
  if (!repoId || !path || !fileHash || categories.length === 0) return undefined;
  return {
    repoId,
    path,
    fileHash,
    schemaVersion: Number(value.schemaVersion) || COGNEE_METADATA_SCHEMA_VERSION,
    title: firstString(value.title) ?? path,
    kind: firstString(value.kind) ?? 'doc',
    categories,
    sourceAuthority: sourceAuthorityValue(value.sourceAuthority),
    injectionDecision: injectionDecisionValue(value.injectionDecision),
    confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : 0.5,
    active: true,
    generatedFrom: 'deterministic',
    generatedAt: value.generatedAt instanceof Date ? value.generatedAt : new Date(),
    headings: Array.isArray(value.headings) ? value.headings.map(String).filter(Boolean) : [],
  };
}

function categoriesFor(path: string, title: string, kind: string, content?: string): string[] {
  const haystack = [path, title, kind, content?.slice(0, 4000)].filter(Boolean).join(' ').toLowerCase();
  const categories: string[] = [];
  if (/\b(agent|agents|persona|subagent|claude\/agents|instructions?|guidelines?|standards?)\b/.test(haystack)) categories.push('guideline');
  if (/\b(prd|requirements?|acceptance criteria|user story|specification)\b/.test(haystack)) categories.push('prd');
  if (/\b(runbook|playbook|incident|production|ops|deploy)\b/.test(haystack)) categories.push('runbook');
  if (/\b(design|architecture|proposal|rfc|adr)\b/.test(haystack)) categories.push('design');
  if (/\b(generated|llm|ai-generated|dist|build|coverage|snapshot)\b/.test(haystack)) categories.push('generated_doc');
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|cpp|c|h|sql|sh|ya?ml|json)$/i.test(path)) categories.push('source');
  if (path === 'AGENTS.md' || path.endsWith('/AGENTS.md')) categories.push('instruction');
  if (path.includes('.claude/agents/') || /\bpersona\b/.test(haystack)) categories.push('agent_persona');
  if (!categories.length) categories.push('doc');
  return Array.from(new Set(categories));
}

function defaultInjectionDecisionFor(path: string, categories: string[], authority: CogneeContextMetadata['sourceAuthority']): CogneeInjectionDecision {
  if (categories.includes('agent_persona') || categories.includes('generated_doc')) return 'never_full_auto';
  if (categories.includes('instruction') || (authority === 'high' && categories.includes('runbook'))) return 'snippet';
  if (categories.includes('source')) return 'snippet';
  return 'manifest_only';
}

function sourceAuthorityFor(path: string, categories: string[]): CogneeContextMetadata['sourceAuthority'] {
  if (path === 'AGENTS.md' || path.endsWith('/AGENTS.md')) return 'high';
  if (categories.some((category) => ['runbook', 'prd', 'design', 'source', 'instruction'].includes(category))) return 'medium';
  if (categories.includes('agent_persona') || categories.includes('generated_doc')) return 'low';
  return 'medium';
}

function confidenceFor(path: string, categories: string[], headings: string[]): number {
  let confidence = path ? 0.45 : 0.2;
  if (categories.length > 0 && !categories.includes('doc')) confidence += 0.25;
  if (headings.length > 0) confidence += 0.15;
  if (path.includes('/')) confidence += 0.1;
  return Math.min(1, Math.round(confidence * 100) / 100);
}

function markdownHeadings(content?: string): string[] {
  if (!content) return [];
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, 12);
}

function sourceMetadataFor(ref: KnowledgeCandidateRef): Record<string, unknown> {
  const metadata = ref.providerMetadata?.sourceMetadata;
  return isRecord(metadata) ? metadata : {};
}

function injectionDecisionValue(value: unknown): CogneeInjectionDecision {
  if (value === 'mandatory_full' || value === 'snippet' || value === 'manifest_only' || value === 'never_full_auto') return value;
  if (value === 'injectable') return 'snippet';
  return 'manifest_only';
}

function sourceAuthorityValue(value: unknown): CogneeContextMetadata['sourceAuthority'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
