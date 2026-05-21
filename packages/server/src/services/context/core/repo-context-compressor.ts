import type { KnowledgeCandidateRef } from './repo-context-engine.js';

export type ContextPackingTransformation = 'full_body' | 'section_extracted' | 'compressed' | 'skipped';
export type ContextRiskClass = 'exact' | 'narrative';

export interface ContextCompressionInput {
  ref: KnowledgeCandidateRef;
  content: string;
  taskText?: string;
  maxChars: number;
  allowCompression: boolean;
}

export interface ContextCompressionResult {
  providerId: string;
  transformation: ContextPackingTransformation;
  riskClass: ContextRiskClass;
  content?: string;
  originalChars: number;
  finalChars: number;
  compressionRatio: number;
  sectionCount: number;
  warnings: string[];
  diagnostics: Array<Record<string, unknown>>;
}

export interface ContextCompressor {
  readonly providerId: string;
  compress(input: ContextCompressionInput): Promise<ContextCompressionResult>;
}

export class DeterministicContextCompressor implements ContextCompressor {
  readonly providerId = 'deterministic_section_extractor';

  async compress(input: ContextCompressionInput): Promise<ContextCompressionResult> {
    const originalChars = input.content.length;
    const riskClass = contextRiskClass(input.ref);
    if (originalChars <= input.maxChars) {
      return result({
        providerId: this.providerId,
        transformation: 'full_body',
        riskClass,
        content: input.content,
        originalChars,
        warnings: [],
        sectionCount: 0,
      });
    }

    if (riskClass === 'exact') {
      return result({
        providerId: this.providerId,
        transformation: 'skipped',
        riskClass,
        originalChars,
        warnings: ['Exact context exceeds the file budget and was not compressed.'],
        sectionCount: 0,
        diagnostics: [{
          code: 'exact_context_too_large',
          severity: 'warn',
          refId: input.ref.refId,
          path: input.ref.path,
          message: 'Exact mandatory context exceeded the file budget and was not compressed.',
        }],
      });
    }

    const extracted = extractRelevantSections(input.content, input.taskText ?? contextQueryFromRef(input.ref), input.maxChars);
    if (!extracted.content) {
      return result({
        providerId: this.providerId,
        transformation: 'skipped',
        riskClass,
        originalChars,
        warnings: ['No deterministic section fit within the file budget.'],
        sectionCount: 0,
      });
    }

    return result({
      providerId: this.providerId,
      transformation: 'section_extracted',
      riskClass,
      content: extracted.content,
      originalChars,
      warnings: ['Large narrative context was section-extracted; exact full body was too large.'],
      sectionCount: extracted.sectionCount,
      diagnostics: [{
        code: 'context_section_extracted',
        severity: 'info',
        refId: input.ref.refId,
        path: input.ref.path,
        originalChars,
        finalChars: extracted.content.length,
        message: 'Large narrative context was section-extracted before packing.',
      }],
    });
  }
}

export function contextRiskClass(ref: KnowledgeCandidateRef): ContextRiskClass {
  if (['doc', 'runbook', 'historical_learning'].includes(ref.kind)) return 'narrative';
  return 'exact';
}

function extractRelevantSections(content: string, query: string, maxChars: number): { content?: string; sectionCount: number } {
  if (maxChars < 1_000) return { sectionCount: 0 };
  const chunks = splitIntoSections(content);
  const terms = queryTerms(query);
  const scored = chunks
    .map((chunk, index) => ({ chunk, index, score: scoreChunk(chunk, terms) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: Array<{ chunk: string; index: number }> = [];
  let total = 0;
  for (const entry of scored) {
    const chunk = entry.chunk.trim();
    if (!chunk) continue;
    const nextSize = total + chunk.length + 2;
    if (nextSize > maxChars) continue;
    selected.push({ chunk, index: entry.index });
    total = nextSize;
    if (total >= maxChars * 0.9) break;
  }
  if (selected.length === 0) {
    const fallback = content.slice(0, maxChars).trim();
    return fallback ? { content: fallback, sectionCount: 1 } : { sectionCount: 0 };
  }
  selected.sort((a, b) => a.index - b.index);
  return {
    content: selected.map((item) => item.chunk).join('\n\n'),
    sectionCount: selected.length,
  };
}

function splitIntoSections(content: string): string[] {
  const headingSections = content
    .split(/\n(?=#{1,6}\s+)/g)
    .map((section) => section.trim())
    .filter(Boolean);
  if (headingSections.length > 1) return headingSections;
  const paragraphs = content
    .split(/\n{2,}/g)
    .map((section) => section.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += 4_000) chunks.push(content.slice(i, i + 4_000));
  return chunks;
}

function scoreChunk(chunk: string, terms: Set<string>): number {
  const value = chunk.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (value.includes(term)) score += term.length > 8 ? 3 : 1;
  }
  if (/must|required|never|always|production|incident|validation|test|security|migration/i.test(chunk)) score += 2;
  return score;
}

function queryTerms(query: string): Set<string> {
  return new Set(query.toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3));
}

function contextQueryFromRef(ref: KnowledgeCandidateRef): string {
  return [
    ref.title,
    ref.path,
    ref.summary,
    ...(ref.tags ?? []),
  ].filter(Boolean).join(' ');
}

function result(input: {
  providerId: string;
  transformation: ContextPackingTransformation;
  riskClass: ContextRiskClass;
  content?: string;
  originalChars: number;
  warnings: string[];
  sectionCount: number;
  diagnostics?: Array<Record<string, unknown>>;
}): ContextCompressionResult {
  const finalChars = input.content?.length ?? 0;
  return {
    providerId: input.providerId,
    transformation: input.transformation,
    riskClass: input.riskClass,
    content: input.content,
    originalChars: input.originalChars,
    finalChars,
    compressionRatio: input.originalChars > 0 ? Math.round((finalChars / input.originalChars) * 1000) / 1000 : 1,
    sectionCount: input.sectionCount,
    warnings: input.warnings,
    diagnostics: input.diagnostics ?? [],
  };
}
