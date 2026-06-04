import { describe, expect, it } from 'vitest';
import { RepoContextEngine, type KnowledgeCandidateRef, type KnowledgeRetrievalInput, type KnowledgeRetrievalProvider, type KnowledgeRetrievalResult } from './repo-context-engine.js';
import type { ContextReranker, ContextRerankInput, ContextRerankResult } from './repo-context-reranker.js';

function input(): KnowledgeRetrievalInput & { packetId: string; executionId: string } {
  return {
    packetId: 'packet1',
    executionId: 'execution1',
    repoId: 'repo1',
    repoName: 'repo',
    repoPath: '/tmp/repo',
    indexId: 'idx',
    indexFreshness: 'fresh',
    workflowName: 'context_management_playground',
    nodeName: 'data-acquisition',
    nodeRole: 'data-acquisition',
    attempt: 1,
    state: {},
    prompt: 'I want to update product grouping module with asin based variant grouping',
    provider: 'codex',
    currentFiles: [],
    nodes: [],
  };
}

function ref(overrides: Partial<KnowledgeCandidateRef> = {}): KnowledgeCandidateRef {
  return {
    refId: 'cognee:shared-product-grouping',
    kind: 'doc',
    title: 'Shared Product Grouping Module Guide',
    path: 'src/shared/product-grouping/README.md',
    summary: 'Shared product grouping guide',
    tags: ['source_doc'],
    providerId: 'cognee_memory',
    source: 'cognee_recall',
    reason: 'selected by Cognee',
    score: 0.32,
    loadable: true,
    mandatory: false,
    itemType: 'repo_chunk',
    grounding: 'repo_backed',
    content: 'Shared product grouping module snippet.',
    providerMetadata: {
      retrievalStage: 'primary',
      retrievalScore: 0.32,
      retrievalPolicyScore: 0.32,
      curatedInjectionPolicy: 'snippet',
      curationEntryId: 'entry1',
      injectionDecision: 'manifest_only',
      injectionPolicy: 'manifest_only',
    },
    ...overrides,
  };
}

class SingleRefProvider implements KnowledgeRetrievalProvider {
  readonly providerId = 'test_provider';

  constructor(private readonly candidate: KnowledgeCandidateRef) {}

  async retrieve(): Promise<KnowledgeRetrievalResult> {
    return {
      providerId: this.providerId,
      candidates: [this.candidate],
      selectedRefs: [this.candidate],
      rejectedRefs: [],
      diagnostics: [],
      trace: [],
    };
  }
}

class CapturingProvider extends SingleRefProvider {
  seenInput?: KnowledgeRetrievalInput;

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    this.seenInput = input;
    return super.retrieve();
  }
}

class FixedScoreReranker implements ContextReranker {
  readonly providerId = 'fixed_score_reranker';
  seenInput?: ContextRerankInput;

  constructor(private readonly scores: { rerankScore: number; finalRelevanceScore: number }) {}

  async rerank(input: ContextRerankInput): Promise<ContextRerankResult> {
    this.seenInput = input;
    return {
      providerId: this.providerId,
      rankedRefs: input.candidates.map((candidate, index) => ({
        ...candidate,
        rerank: {
          providerId: this.providerId,
          rerankScore: this.scores.rerankScore,
          finalRelevanceScore: this.scores.finalRelevanceScore,
          finalRank: index,
        },
      })),
      diagnostics: [],
      traces: [],
    };
  }
}

describe('repo context engine curated injection composition', () => {
  it('keeps selected curated snippet refs injectable even below the curated injection score', async () => {
    const engine = new RepoContextEngine(
      [new SingleRefProvider(ref())],
      new FixedScoreReranker({ rerankScore: 0.495, finalRelevanceScore: 0.46 }),
    );

    const packet = await engine.buildPacket(input());

    expect(packet.selectedRefs).toHaveLength(1);
    expect(packet.injectableRefs).toHaveLength(1);
    expect(packet.selectedRefs[0].providerMetadata?.curatedInjectionPolicy).toBe('snippet');
    expect(packet.selectedRefs[0].providerMetadata?.finalInjectionDecision).toBe('snippet');
    expect(packet.injectableRefs?.[0].providerMetadata?.finalInjectionDecision).toBe('snippet');
    expect(packet.rejectedRefs.some((candidate) => candidate.refId === 'cognee:shared-product-grouping')).toBe(false);
  });

  it('passes compact semantic query to providers and reranker while preserving path metadata', async () => {
    const provider = new CapturingProvider(ref());
    const reranker = new FixedScoreReranker({ rerankScore: 0.495, finalRelevanceScore: 0.46 });
    const engine = new RepoContextEngine([provider], reranker);
    const runInput = input();
    runInput.contextQuery = {
      user_request: 'Analyze ASIN based product grouping variants',
      task_type: 'read_only_requirement_analysis',
      topics: ['product grouping', 'ASIN identifier', 'variant grouping'],
      target_files: ['src/shared/product-grouping/adaptiveGrouping.ts', 'src/product-grouping/'],
      path_hints: ['src/shared/product-grouping'],
    };

    const packet = await engine.buildPacket(runInput);

    expect(packet.renderedContextQuery).toContain('Current files: src/shared/product-grouping/adaptiveGrouping.ts');
    expect(packet.semanticContextQuery).toContain('User request: Analyze ASIN based product grouping variants');
    expect(packet.semanticContextQuery).toContain('product grouping');
    expect(packet.semanticContextQuery).not.toContain('src/shared/product-grouping/adaptiveGrouping.ts');
    expect(packet.semanticContextQuery).not.toContain('src/product-grouping');
    expect(provider.seenInput?.semanticContextQuery).toBe(packet.semanticContextQuery);
    expect(provider.seenInput?.currentFiles).toContain('src/shared/product-grouping/adaptiveGrouping.ts');
    expect(reranker.seenInput?.semanticContextQuery).toBe(packet.semanticContextQuery);
  });

  it('keeps selected curated manifest-only refs out of injectable refs', async () => {
    const candidate = ref({
      providerMetadata: {
        retrievalStage: 'primary',
        retrievalScore: 0.32,
        retrievalPolicyScore: 0.32,
        curatedInjectionPolicy: 'manifest_only',
        curationEntryId: 'entry1',
        injectionDecision: 'manifest_only',
        injectionPolicy: 'manifest_only',
      },
    });
    const engine = new RepoContextEngine(
      [new SingleRefProvider(candidate)],
      new FixedScoreReranker({ rerankScore: 0.495, finalRelevanceScore: 0.46 }),
    );

    const packet = await engine.buildPacket(input());

    expect(packet.selectedRefs).toHaveLength(1);
    expect(packet.injectableRefs).toHaveLength(0);
    expect(packet.selectedRefs[0].providerMetadata?.finalInjectionDecision).toBe('manifest_only');
  });

  it('keeps non-curated optional snippets behind the injection threshold', async () => {
    const candidate = ref({
      score: 0.5,
      providerMetadata: {
        retrievalStage: 'primary',
        retrievalScore: 0.5,
        retrievalPolicyScore: 0.5,
        injectionDecision: 'snippet',
        injectionPolicy: 'injectable',
      },
    });
    const engine = new RepoContextEngine(
      [new SingleRefProvider(candidate)],
      new FixedScoreReranker({ rerankScore: 0.5, finalRelevanceScore: 0.5 }),
    );

    const packet = await engine.buildPacket(input());

    expect(packet.selectedRefs).toHaveLength(1);
    expect(packet.injectableRefs).toHaveLength(0);
    expect(packet.selectedRefs[0].providerMetadata?.finalInjectionDecision).toBe('manifest_only');
    expect(packet.rejectedRefs[0].providerMetadata?.rejectionReason).toBe('below_injection_threshold');
  });
});
