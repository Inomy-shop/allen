import { describe, expect, it } from 'vitest';
import { buildContextQueryIntent } from '../core/context-query-intent.js';
import type { KnowledgeCandidateRef, KnowledgeRetrievalInput } from '../core/repo-context-engine.js';
import { selectCogneeRefs } from './cognee-retrieval-policy.js';

function input(): KnowledgeRetrievalInput {
  return {
    repoId: 'repo1',
    repoName: 'repo',
    repoPath: '/tmp/repo',
    indexId: 'idx',
    indexFreshness: 'fresh',
    workflowName: 'workflow',
    nodeName: 'backend-worker',
    nodeRole: 'backend-worker',
    attempt: 1,
    state: {},
    prompt: 'Implement checkout API fix.',
    provider: 'codex',
    currentFiles: ['src/api/checkout.ts'],
    nodes: [],
  };
}

function candidate(overrides: Partial<KnowledgeCandidateRef> = {}): KnowledgeCandidateRef {
  return {
    refId: 'cognee:curated',
    kind: 'doc',
    title: 'Checkout API guide',
    path: 'src/api/checkout.md',
    summary: 'Checkout API details',
    tags: ['source'],
    providerId: 'cognee_memory',
    source: 'cognee_recall',
    reason: 'recalled',
    loadable: true,
    mandatory: false,
    itemType: 'repo_chunk',
    grounding: 'repo_backed',
    content: 'Use the checkout API contract when changing billing.',
    providerMetadata: {
      curatedInjectionPolicy: 'snippet',
      curationEntryId: 'entry1',
      curationCategory: 'source',
      curationResolutionMethod: 'entry_id',
    },
    ...overrides,
  };
}

describe('curated Cognee retrieval policy', () => {
  it('can select and mark curated snippets injectable without a raw Cognee score', () => {
    const retrievalInput = input();
    const envelope = buildContextQueryIntent(retrievalInput);

    const result = selectCogneeRefs([candidate({ score: undefined })], retrievalInput, envelope, 'primary');

    expect(result.selectedRefs).toHaveLength(1);
    expect(result.selectedRefs[0].providerMetadata?.curatedInjectionPolicy).toBe('snippet');
    expect(result.selectedRefs[0].providerMetadata?.injectionDecision).toBe('snippet');
    expect(result.selectedRefs[0].providerMetadata?.injectable).toBe(true);
    expect(result.selectedRefs[0].providerMetadata?.cogneeRawScore).toBeUndefined();
    expect(result.selectedRefs[0].providerMetadata?.retrievalReasons).toContain('missing_cognee_score');
  });

  it('preserves curated manifest-only as non-injectable', () => {
    const retrievalInput = input();
    const envelope = buildContextQueryIntent(retrievalInput);

    const result = selectCogneeRefs([
      candidate({ providerMetadata: { curatedInjectionPolicy: 'manifest_only', curationEntryId: 'entry1', curationCategory: 'source' } }),
    ], retrievalInput, envelope, 'primary');

    expect(result.selectedRefs).toHaveLength(1);
    expect(result.selectedRefs[0].providerMetadata?.curatedInjectionPolicy).toBe('manifest_only');
    expect(result.selectedRefs[0].providerMetadata?.injectionDecision).toBe('manifest_only');
    expect(result.selectedRefs[0].providerMetadata?.injectable).toBe(false);
  });

  it('preserves curated never-full-auto as rejected and never injectable', () => {
    const retrievalInput = input();
    const envelope = buildContextQueryIntent(retrievalInput);

    const result = selectCogneeRefs([
      candidate({ providerMetadata: { curatedInjectionPolicy: 'never_full_auto', curationEntryId: 'entry1', curationCategory: 'source' } }),
    ], retrievalInput, envelope, 'primary');

    expect(result.selectedRefs).toHaveLength(0);
    expect(result.rejectedRefs[0].providerMetadata?.injectionDecision).toBe('never_full_auto');
    expect(result.rejectedRefs[0].providerMetadata?.injectable).toBe(false);
  });
});
