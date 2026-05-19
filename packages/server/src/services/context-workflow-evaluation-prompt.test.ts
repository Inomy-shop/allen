import { describe, expect, it } from 'vitest';
import { buildWorkflowSemanticEvaluationPromptArtifacts } from './context-workflow-evaluation-prompt.js';

describe('buildWorkflowSemanticEvaluationPromptArtifacts', () => {
  it('packs oversized workflow evidence without dropping context-relevant nodes', () => {
    const largeText = 'implementation detail '.repeat(20_000);
    const input = {
      execution: {
        id: 'exec-large',
        workflowName: 'bug-investigate-and-fix',
        status: 'completed',
        input: { task: 'Fix grouping fallback' },
        state: { huge: largeText },
      },
      descendants: [],
      nodeContextPackets: ['investigate', 'implement', 'qa'].map((nodeName, index) => ({
        executionId: 'exec-large',
        nodeName,
        nodeRole: `${nodeName}-role`,
        attempt: 1,
        packetId: `packet-${nodeName}`,
        repoName: 'fixture-repo',
        selectedRefs: Array.from({ length: 30 }, (_, refIndex) => ({
          refId: `${nodeName}-ref-${refIndex}`,
          path: `docs/${nodeName}/${refIndex}.md`,
          kind: 'context_file',
          mandatory: refIndex < 5,
          summary: largeText,
        })),
        contextInjection: {
          injectedRefs: [{ refId: `${nodeName}-ref-1`, contentChars: 1000 }],
          skippedRefs: [{ refId: `${nodeName}-ref-2`, path: `docs/${nodeName}/2.md`, skipReason: 'budget' }],
        },
        createdAt: new Date(index).toISOString(),
      })),
      usageTraces: ['investigate', 'implement', 'qa'].map((nodeName) => ({
        executionId: 'exec-large',
        nodeName,
        attempt: 1,
        packetId: `packet-${nodeName}`,
        loaded: [{ refId: `${nodeName}-ref-1` }],
        claimedUsed: [{ refId: `${nodeName}-ref-1`, summary: largeText }],
        diagnostics: [{ code: 'context_budget_bloat', severity: 'warn', message: largeText }],
      })),
      nodeEvaluations: ['investigate', 'implement', 'qa'].map((nodeName) => ({
        executionId: 'exec-large',
        nodeName,
        attempt: 1,
        status: 'warning',
        scores: { overall: 0.5 },
        diagnostics: [{ code: 'missing_mandatory_context', severity: 'warn', message: largeText }],
      })),
      executionTraces: ['investigate', 'implement', 'qa'].map((nodeName) => ({
        executionId: 'exec-large',
        node: nodeName,
        agent: `${nodeName}-role`,
        attempt: 1,
        status: 'completed',
        rawResponse: largeText,
        output: { response: largeText },
        contextUsage: { loadedCount: 1, appliedCount: 1, skippedCount: 1 },
      })),
    };

    const artifacts = buildWorkflowSemanticEvaluationPromptArtifacts(input);
    const nodeNames = ((artifacts.packedEvidencePayload.nodes as Array<Record<string, unknown>>) ?? [])
      .map((node) => node.nodeName);

    expect(artifacts.prompt).toContain('Each nodeFinding MUST copy executionId, nodeName, and numeric attempt');
    expect(artifacts.prompt).toContain('never {"nodeName":"implement attempt 1"}');
    expect(artifacts.prompt.length).toBeLessThanOrEqual(125_000);
    expect(nodeNames).toEqual(expect.arrayContaining(['investigate', 'implement', 'qa']));
    expect(artifacts.evidenceStats).toEqual(expect.objectContaining({
      nodeCount: 3,
      originalChars: expect.any(Number),
      packedChars: expect.any(Number),
      targetChars: 120_000,
    }));
    expect(Number(artifacts.evidenceStats.packedChars)).toBeLessThan(Number(artifacts.evidenceStats.originalChars));
  });

  it('preserves Cognee chunk and source metadata in packed workflow evidence', () => {
    const artifacts = buildWorkflowSemanticEvaluationPromptArtifacts({
      execution: { id: 'exec-cognee', workflowName: 'bug-investigate-and-fix', status: 'completed' },
      descendants: [],
      nodeContextPackets: [{
        executionId: 'exec-cognee',
        nodeName: 'implement',
        nodeRole: 'backend-developer',
        attempt: 1,
        packetId: 'packet-cognee',
        repoName: 'fixture-repo',
        retrievalProviders: ['cognee_memory', 'deterministic_policy_reranker'],
        selectedRefs: [{
          refId: 'cognee:chunk-1',
          path: 'docs/vendor-guidelines.md',
          kind: 'doc',
          title: 'Vendor Guidelines',
          providerId: 'cognee_memory',
          source: 'cognee_recall',
          itemType: 'repo_chunk',
          grounding: 'repo_backed',
          score: 0.9,
          content: 'Use live vendor mappings.',
          providerMetadata: {
            chunkId: 'chunk-1',
            cogneeChunkId: 'chunk-1',
            chunkIndex: 0,
            chunkSize: 4,
            cutType: 'paragraph_end',
            documentRole: 'guideline',
            containsCodeBlocks: false,
            sourceMetadata: {
              repoId: 'repo-id',
              repoName: 'fixture-repo',
              branch: 'main',
              headSha: 'abc123',
              path: 'docs/vendor-guidelines.md',
              title: 'Vendor Guidelines',
              kind: 'doc',
              fileHash: 'doc-hash',
              ingestFormat: 'markdown_file_docmeta_v1',
              source: 'allen_markdown_file_filter',
            },
          },
          rerank: {
            providerId: 'deterministic_policy_reranker',
            score: 0.85,
            finalRank: 1,
            reason: 'Relevant guideline.',
          },
        }],
        contextInjection: {
          injectedRefs: [{
            refId: 'cognee:chunk-1',
            path: 'docs/vendor-guidelines.md',
            kind: 'doc',
            title: 'Vendor Guidelines',
            providerId: 'cognee_memory',
            source: 'allen_system_injection',
            itemType: 'repo_chunk',
            grounding: 'repo_backed',
            contentSha256: 'content-hash',
            providerMetadata: {
              cogneeChunkId: 'chunk-1',
              sourceMetadata: {
                path: 'docs/vendor-guidelines.md',
                fileHash: 'doc-hash',
                ingestFormat: 'markdown_file_docmeta_v1',
              },
            },
          }],
        },
      }],
      usageTraces: [],
      nodeEvaluations: [],
      executionTraces: [],
    });

    const nodes = artifacts.packedEvidencePayload.nodes as Array<Record<string, any>>;
    const selected = nodes[0].selectedRefs[0];
    const injected = nodes[0].injectedRefs[0];
    expect(selected.providerMetadata).toEqual(expect.objectContaining({
      cogneeChunkId: 'chunk-1',
      chunkIndex: 0,
      documentRole: 'guideline',
      sourceMetadata: expect.objectContaining({
        path: 'docs/vendor-guidelines.md',
        fileHash: 'doc-hash',
        ingestFormat: 'markdown_file_docmeta_v1',
      }),
    }));
    expect(selected.rerank).toEqual(expect.objectContaining({
      score: 0.85,
      finalRank: 1,
    }));
    expect(injected.providerMetadata).toEqual(expect.objectContaining({
      cogneeChunkId: 'chunk-1',
      sourceMetadata: expect.objectContaining({
        path: 'docs/vendor-guidelines.md',
        fileHash: 'doc-hash',
      }),
    }));
  });
});
