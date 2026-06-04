import { describe, expect, it } from 'vitest';
import { WorkflowContextInjectionAdapter, type PreviouslyInjectedContextRef } from './workflow-context-injection-adapter.js';
import type { KnowledgeCandidateRef, RepoContextPacket } from './repo-context-engine.js';

function contextRef(overrides: Partial<KnowledgeCandidateRef> = {}): KnowledgeCandidateRef {
  return {
    refId: 'cognee:shared-product-grouping',
    kind: 'doc',
    title: 'Shared Product Grouping Module Guide',
    providerId: 'cognee_memory',
    source: 'cognee_recall',
    reason: 'selected curated context',
    score: 0.8,
    loadable: true,
    mandatory: false,
    itemType: 'repo_chunk',
    grounding: 'repo_backed',
    content: 'Shared product grouping module snippet.',
    providerMetadata: {
      curatedInjectionPolicy: 'snippet',
      curationEntryId: 'curation:repo:src/shared/product-grouping/README.md',
      finalInjectionDecision: 'snippet',
    },
    ...overrides,
  };
}

function packet(ref: KnowledgeCandidateRef): RepoContextPacket {
  return {
    packetId: 'packet1',
    executionId: 'session1',
    executionTraceId: 'message2',
    workflowName: 'chat',
    nodeName: 'assistant',
    nodeRole: 'assistant',
    executionKind: 'chat_agent',
    attempt: 1,
    repoId: 'repo1',
    repoName: 'repo',
    repoPath: '/tmp/repo',
    indexId: 'idx',
    indexFreshness: 'fresh',
    taskPrompt: 'Update product grouping.',
    selectedRefs: [ref],
    injectableRefs: [ref],
    rejectedRefs: [],
    availableRefs: [ref],
    providerTraces: [],
    providerDiagnostics: [],
    rerankerTraces: [],
    rerankerDiagnostics: [],
    rerankerProviders: [],
    retrievalProviders: ['cognee_memory'],
    currentFiles: [],
    createdAt: new Date(),
  };
}

describe('workflow context injection adapter chat repeat suppression', () => {
  it('skips full-body injection for a curated snippet already injected in the chat session', async () => {
    const ref = contextRef();
    const previous: PreviouslyInjectedContextRef = {
      refId: ref.refId,
      curationEntryId: String(ref.providerMetadata?.curationEntryId),
      contextAttemptId: 'packet0',
      messageId: 'message1',
    };

    const injection = await new WorkflowContextInjectionAdapter().buildInjection({
      packet: packet(ref),
      provider: 'codex',
      repoPath: '/tmp/repo',
      targetLayer: 'user_prompt',
      previouslyInjectedRefs: [previous],
    });

    expect(injection.injectedRefs).toHaveLength(0);
    expect(injection.skippedRefs).toHaveLength(1);
    expect(injection.skippedRefs[0].skipReason).toBe('previously_injected');
    expect(injection.skippedRefs[0].providerMetadata?.previouslyInjected).toBe(true);
    expect(injection.skippedRefs[0].providerMetadata?.previousContextAttemptId).toBe('packet0');
    expect(injection.skippedRefs[0].providerMetadata?.previousMessageId).toBe('message1');
  });

  it('does not suppress non-curated snippets with the same ref id', async () => {
    const ref = contextRef({
      providerMetadata: {
        injectionDecision: 'snippet',
        finalInjectionDecision: 'snippet',
      },
    });

    const injection = await new WorkflowContextInjectionAdapter().buildInjection({
      packet: packet(ref),
      provider: 'codex',
      repoPath: '/tmp/repo',
      targetLayer: 'user_prompt',
      previouslyInjectedRefs: [{ refId: ref.refId, contextAttemptId: 'packet0' }],
    });

    expect(injection.injectedRefs).toHaveLength(1);
    expect(injection.skippedRefs).toHaveLength(0);
  });
});
