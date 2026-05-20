import { createHash } from 'node:crypto';
import type { KnowledgeNodeKind, KnowledgeRelation, RawGraphNode } from './repo-knowledge-graph.types.js';

export function stableNodeKey(raw: RawGraphNode): string {
  const base = raw.id || raw.path || `${raw.kind}:${raw.title}`;
  return String(base).toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').slice(0, 180);
}

export function normalizeKind(kind: unknown): KnowledgeNodeKind {
  const allowed = new Set(['repo', 'module', 'source_file', 'context_file', 'doc', 'runbook', 'skill', 'skill_reference', 'production_note', 'instruction_file', 'command', 'command_profile', 'imported_agent', 'historical_learning']);
  return allowed.has(String(kind)) ? kind as KnowledgeNodeKind : 'doc';
}

export function normalizeRelation(relation: unknown): KnowledgeRelation {
  const allowed = new Set(['CONTAINS', 'APPLIES_TO', 'REQUIRES', 'REFERENCES', 'IMPLEMENTS', 'VALIDATED_BY', 'RECOMMENDED_FOR_ROLE', 'MANDATORY_FOR_ROLE', 'SUPERSEDES', 'DERIVED_FROM']);
  return allowed.has(String(relation)) ? relation as KnowledgeRelation : 'REFERENCES';
}

export function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && v.length > 0);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
