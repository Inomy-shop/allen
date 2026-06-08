// Tests that all required v4 canonical taxonomy values are valid union members
// and that legacy→canonical mapping covers all legacy values

import { describe, it, expect } from 'vitest';
import type { FindingClassification, FixType } from '../../../services/context/judge/context-judge.types.js';
import {
  TAXONOMY_LEGACY_TO_CANONICAL,
  FIX_TYPE_LEGACY_TO_CANONICAL,
} from '../../../services/context/judge/context-judge.types.js';

const REQUIRED_CLASSIFICATIONS: FindingClassification[] = [
  'missing_context', 'missing_mandatory_context', 'incomplete_context', 'source_inspection_gap',
  'wrong_context', 'overbroad_context', 'context_bloat', 'duplicate_context', 'conflicting_context',
  'stale_context', 'stale_index', 'ingestion_gap', 'source_mapping_gap', 'chunking_gap',
  'retrieval_gap', 'reranker_gap', 'filtering_gap', 'injection_policy_gap', 'manifest_policy_violation',
  'provider_native_gap', 'unverified_context_claim', 'context_ignored', 'ungrounded_output',
  'incorrect_context_application', 'context_scope_violation', 'sensitive_context_risk', 'trace_gap',
  'judge_uncertain', 'schema_violation',
  'learning_to_curated_context_candidate', 'learning_updates_existing_context',
  'learning_conflicts_with_context', 'learning_requires_source_validation',
  'learning_not_context_worthy', 'false_positive', 'no_action_needed',
];

const REQUIRED_FIX_TYPES: FixType[] = [
  'curated_context_fix', 'mandatory_context_fix', 'global_context_fix', 'cross_repo_context_fix',
  'learning_to_curated_context_fix', 'learning_context_remediation_fix',
  'learning_context_conflict_review', 'learning_source_validation_task',
  'ingestion_fix', 'retrieval_fix', 'reranking_fix',
  'injection_policy_fix', 'prompt_contract_fix', 'code_fix', 'instrumentation_fix',
  'task_split_required', 'no_fix',
];

describe('Taxonomy completeness — v4 required values', () => {
  it('all required FindingClassification values are valid union members', () => {
    for (const val of REQUIRED_CLASSIFICATIONS) {
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
    }
    expect(REQUIRED_CLASSIFICATIONS.length).toBeGreaterThanOrEqual(35);
  });

  it('all required FixType values are valid union members', () => {
    for (const val of REQUIRED_FIX_TYPES) {
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
    }
    expect(REQUIRED_FIX_TYPES.length).toBeGreaterThanOrEqual(17);
  });

  it('TAXONOMY_LEGACY_TO_CANONICAL covers all legacy classification names', () => {
    const legacyKeys = Object.keys(TAXONOMY_LEGACY_TO_CANONICAL);
    expect(legacyKeys).toContain('mandatory_missing');
    expect(legacyKeys).toContain('retrieval_miss');
    expect(legacyKeys).toContain('reranker_demoted');
    expect(legacyKeys).toContain('learning_candidate');
    expect(legacyKeys).toContain('learning_conflict');
    // Canonical values must be valid FindingClassification members
    for (const canonical of Object.values(TAXONOMY_LEGACY_TO_CANONICAL)) {
      expect(REQUIRED_CLASSIFICATIONS).toContain(canonical);
    }
  });

  it('FIX_TYPE_LEGACY_TO_CANONICAL covers all legacy fix type names', () => {
    expect(Object.keys(FIX_TYPE_LEGACY_TO_CANONICAL)).toContain('curated_context_edit');
    expect(Object.keys(FIX_TYPE_LEGACY_TO_CANONICAL)).toContain('ingestion_repair');
    for (const canonical of Object.values(FIX_TYPE_LEGACY_TO_CANONICAL)) {
      expect(REQUIRED_FIX_TYPES).toContain(canonical);
    }
  });
});
