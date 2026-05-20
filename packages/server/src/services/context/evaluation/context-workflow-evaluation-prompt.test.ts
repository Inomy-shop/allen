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
    const nodes = ((artifacts.packedEvidencePayload.nodes as Array<Record<string, any>>) ?? []);
    const nodeNames = nodes.map((node) => node.nodeName);

    expect(artifacts.prompt).toContain('Each nodeFinding MUST copy executionId, nodeName, and numeric attempt');
    expect(artifacts.prompt).toContain('never {"nodeName":"implement attempt 1"}');
    expect(artifacts.prompt).toContain('Cognee refs are semantic recall candidates');
    expect(artifacts.prompt).toContain('System-injected refs prove availability, not usefulness');
    expect(artifacts.prompt).toContain('source discovery tool evidence');
    expect(artifacts.prompt.length).toBeLessThanOrEqual(125_000);
    expect(nodeNames).toEqual(expect.arrayContaining(['investigate', 'implement', 'qa']));
    for (const node of nodes) {
      expect(node.selectedRefs.length).toBeGreaterThan(0);
      expect(node.contextLifecycle.length).toBeGreaterThan(0);
    }
    expect((artifacts.evidenceStats.droppedSections as string[]) ?? []).not.toContain('node_details_minimized_to_fit_budget');
    expect(artifacts.evidenceStats).toEqual(expect.objectContaining({
      packingVersion: 2,
      nodeCount: 3,
      originalChars: expect.any(Number),
      packedChars: expect.any(Number),
      targetChars: 120_000,
      sectionChars: expect.objectContaining({
        nodeContextPackets: expect.any(Number),
        executionTraces: expect.any(Number),
      }),
    }));
    expect(Number(artifacts.evidenceStats.packedChars)).toBeLessThan(Number(artifacts.evidenceStats.originalChars));
  });

  it('does not keep duplicated raw injected prompts or full tool logs in workflow evidence', () => {
    const largeInjected = 'repo context block '.repeat(10_000);
    const artifacts = buildWorkflowSemanticEvaluationPromptArtifacts({
      execution: { id: 'exec-raw-trace', workflowName: 'bug-investigate-and-fix', status: 'completed' },
      descendants: [],
      nodeContextPackets: [{
        executionId: 'exec-raw-trace',
        nodeName: 'implement',
        nodeRole: 'engineering-lead',
        attempt: 1,
        packetId: 'packet-raw-trace',
        selectedRefs: [{ refId: 'guide', path: '.claude/rules/coding-guidelines-frontend.md', mandatory: true }],
        contextInjection: { injectedRefs: [{ refId: 'guide', path: '.claude/rules/coding-guidelines-frontend.md', content: largeInjected }] },
      }],
      usageTraces: [],
      nodeEvaluations: [],
      executionTraces: [{
        executionId: 'exec-raw-trace',
        node: 'implement',
        agent: 'engineering-lead',
        attempt: 1,
        status: 'completed',
        repoKnowledgeInjected: largeInjected,
        rawResponse: 'Implemented the fix.',
        toolCalls: [
          { tool: 'Read', args: { path: 'packages/ui/src/vendor.tsx', content: largeInjected }, result: largeInjected },
          { tool: 'Bash', args: { command: 'rg "vendor" packages/ui/src/vendor.tsx' }, result: largeInjected },
        ],
      }],
    });

    const evidenceJson = JSON.stringify(artifacts.evidencePayload);
    const packedJson = JSON.stringify(artifacts.packedEvidencePayload);
    expect(evidenceJson).not.toContain('repoKnowledgeInjected');
    expect(evidenceJson).not.toContain('toolCalls');
    expect(packedJson).toContain('packages/ui/src/vendor.tsx');
    expect(packedJson.length).toBeLessThan(20_000);
  });

  it('packs source discovery tool evidence separately from injected context', () => {
    const artifacts = buildWorkflowSemanticEvaluationPromptArtifacts({
      execution: { id: 'exec-source-discovery', workflowName: 'bug-investigate-and-fix', status: 'completed' },
      descendants: [],
      nodeContextPackets: [],
      usageTraces: [],
      nodeEvaluations: [],
      executionTraces: [{
        executionId: 'exec-source-discovery',
        node: 'investigate',
        agent: 'allen-bug-investigator',
        attempt: 1,
        status: 'completed',
        rawResponse: 'Read the source file and found the root cause.',
        toolCalls: [
          { tool: 'Read', args: { path: 'packages/server/src/services/vendor.service.ts' }, toolUseId: 'read-1' },
          { tool: 'Bash', args: { command: 'rg "vendor" packages/server/src/services/vendor.service.ts' }, toolUseId: 'bash-1' },
        ],
      }],
    });

    const nodes = (artifacts.packedEvidencePayload.nodes as Array<Record<string, unknown>>) ?? [];
    expect(nodes[0]?.sourceDiscoveryEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'Read', paths: expect.arrayContaining(['packages/server/src/services/vendor.service.ts']) }),
      expect.objectContaining({ tool: 'Bash', commandPreview: expect.stringContaining('rg "vendor"') }),
    ]));
    expect(artifacts.evidenceStats).toEqual(expect.objectContaining({
      perNode: expect.arrayContaining([
        expect.objectContaining({ sourceDiscoveryEvidence: 2 }),
      ]),
    }));
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
    const lifecycle = nodes[0].contextLifecycle[0];
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
    expect(lifecycle).toEqual(expect.objectContaining({
      refId: 'cognee:chunk-1',
      providerId: 'cognee_memory',
      selected: true,
      injected: true,
      cogneeChunkId: 'chunk-1',
      path: 'docs/vendor-guidelines.md',
    }));
  });

  it('keeps reconstructed lifecycle when older node eval has empty lifecycle', () => {
    const artifacts = buildWorkflowSemanticEvaluationPromptArtifacts({
      execution: { id: 'exec-old-eval', workflowName: 'bug-investigate-and-fix', status: 'completed' },
      descendants: [],
      nodeContextPackets: [{
        executionId: 'exec-old-eval',
        nodeName: 'investigate',
        nodeRole: 'allen-bug-investigator',
        attempt: 1,
        packetId: 'packet-old-eval',
        selectedRefs: [{
          refId: 'cognee:vendor-doc',
          path: 'docs/vendor-onboarding.md',
          providerId: 'cognee_memory',
          providerMetadata: { cogneeChunkId: 'vendor-doc' },
        }],
        contextInjection: {
          injectedRefs: [{
            refId: 'cognee:vendor-doc',
            path: 'docs/vendor-onboarding.md',
            providerId: 'cognee_memory',
          }],
        },
      }],
      usageTraces: [{
        executionId: 'exec-old-eval',
        nodeName: 'investigate',
        nodeRole: 'allen-bug-investigator',
        attempt: 1,
        packetId: 'packet-old-eval',
        loaded: [{ refId: 'cognee:vendor-doc', providerId: 'cognee_memory' }],
        claimedUsed: [{ refId: 'cognee:vendor-doc', providerId: 'cognee_memory' }],
      }],
      nodeEvaluations: [{
        executionId: 'exec-old-eval',
        nodeName: 'investigate',
        nodeRole: 'allen-bug-investigator',
        attempt: 1,
        status: 'warning',
        contextLifecycle: [],
      }],
      executionTraces: [{
        executionId: 'exec-old-eval',
        node: 'investigate',
        agent: 'allen-bug-investigator',
        attempt: 1,
        status: 'completed',
        toolCalls: [{ tool: 'Read', args: { path: 'docs/vendor-onboarding.md' } }],
      }],
    });

    const nodes = artifacts.packedEvidencePayload.nodes as Array<Record<string, any>>;
    expect(nodes[0].contextLifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({
        refId: 'cognee:vendor-doc',
        selected: true,
        injected: true,
        loaded: true,
        applied: true,
        sourceDiscovered: true,
      }),
    ]));
  });

  it('prefers non-empty lifecycle from node eval when available', () => {
    const artifacts = buildWorkflowSemanticEvaluationPromptArtifacts({
      execution: { id: 'exec-new-eval', workflowName: 'bug-investigate-and-fix', status: 'completed' },
      descendants: [],
      nodeContextPackets: [{
        executionId: 'exec-new-eval',
        nodeName: 'implement',
        nodeRole: 'engineering-lead',
        attempt: 1,
        packetId: 'packet-new-eval',
        selectedRefs: [{ refId: 'reconstructed-ref', path: 'docs/reconstructed.md', providerId: 'cognee_memory' }],
        contextInjection: { injectedRefs: [{ refId: 'reconstructed-ref', providerId: 'cognee_memory' }] },
      }],
      usageTraces: [],
      nodeEvaluations: [{
        executionId: 'exec-new-eval',
        nodeName: 'implement',
        nodeRole: 'engineering-lead',
        attempt: 1,
        status: 'pass',
        contextLifecycle: [{
          refId: 'stored-eval-ref',
          path: 'docs/stored.md',
          providerId: 'cognee_memory',
          selected: true,
          injected: true,
          applied: true,
          cogneeChunkId: 'stored-chunk',
        }],
      }],
      executionTraces: [],
    });

    const nodes = artifacts.packedEvidencePayload.nodes as Array<Record<string, any>>;
    expect(nodes[0].contextLifecycle).toEqual([
      expect.objectContaining({
        refId: 'stored-eval-ref',
        selected: true,
        injected: true,
        applied: true,
        cogneeChunkId: 'stored-chunk',
      }),
    ]);
  });

  it('keeps high-signal refs when workflow evidence must be capped', () => {
    const artifacts = buildWorkflowSemanticEvaluationPromptArtifacts({
      execution: { id: 'exec-signal', workflowName: 'bug-investigate-and-fix', status: 'completed' },
      descendants: [],
      nodeContextPackets: [{
        executionId: 'exec-signal',
        nodeName: 'implement',
        nodeRole: 'engineering-lead',
        attempt: 1,
        packetId: 'packet-signal',
        selectedRefs: [
          ...Array.from({ length: 20 }, (_, index) => ({
            refId: `noisy-${index}`,
            path: `docs/noisy-${index}.md`,
            providerId: 'cognee_memory',
            providerMetadata: { injectionDecision: 'never_full_auto' },
          })),
          {
            refId: 'mandatory-late',
            path: '.claude/rules/coding-guidelines-frontend.md',
            mandatory: true,
            providerId: 'mandatory_graph',
            itemType: 'repo_file',
          },
          {
            refId: 'snippet-late',
            path: 'docs/task-specific.md',
            providerId: 'cognee_memory',
            providerMetadata: { injectionDecision: 'snippet' },
          },
        ],
        contextInjection: { injectedRefs: [] },
      }],
      usageTraces: [],
      nodeEvaluations: [],
      executionTraces: [],
    });

    const nodes = artifacts.packedEvidencePayload.nodes as Array<Record<string, any>>;
    const selectedIds = nodes[0].selectedRefs.map((ref: Record<string, unknown>) => ref.refId);
    expect(selectedIds).toContain('mandatory-late');
    expect(selectedIds).toContain('snippet-late');
  });
});
