/**
 * TDD §11.3a — Mandatory context mapping injection regression test.
 *
 * Seeds two mappings for the same agent (one enabled, one disabled) and verifies
 * that buildPacket() only emits the enabled one. Flipping to zero enabled records
 * produces zero injectable refs.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

// ── Dependency chain mocks — break @allen/engine resolution ──────────────────
// repo-context-engine.ts → repo-context-cognee-provider.ts → context-llm-config.ts
// → chat-providers.ts → @allen/engine (package not built in worktree)
vi.mock('../../chat-providers.js', () => ({
  PROVIDERS: [],
  ChatProvider: {},
}));
vi.mock('../config/context-llm-config.js', () => ({
  resolveContextLlmConfig: vi.fn(() => ({ provider: 'claude-cli', model: 'claude-sonnet-4-5' })),
}));
vi.mock('../cognee/repo-context-cognee-provider.js', () => ({
  CogneeMemoryProvider: vi.fn().mockImplementation(() => ({
    providerId: 'cognee_memory',
    retrieve: vi.fn(async () => ({ providerId: 'cognee_memory', candidates: [], selectedRefs: [], rejectedRefs: [], diagnostics: [], trace: [] })),
  })),
}));
import {
  MandatoryContextMappingProvider,
  RepoContextEngine,
  type KnowledgeRetrievalInput,
} from './repo-context-engine.js';
import type { ContextReranker, ContextRerankInput, ContextRerankResult } from './repo-context-reranker.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal pass-through reranker that preserves every candidate as-is. */
class PassthroughReranker implements ContextReranker {
  readonly providerId = 'passthrough';

  async rerank(input: ContextRerankInput): Promise<ContextRerankResult> {
    return {
      providerId: this.providerId,
      rankedRefs: input.candidates.map((c, i) => ({
        ...c,
        rerank: {
          providerId: this.providerId,
          rerankScore: 1,
          finalRelevanceScore: 1,
          finalRank: i,
        },
      })),
      diagnostics: [],
      traces: [],
    };
  }
}

/** Build a fake Db that wraps an in-memory mapping store for repo_mandatory_context_mappings. */
function makeDbWithMappings(
  mappings: Array<{
    mappingId: string;
    repoId: string;
    agentName: string;
    title: string;
    content: string;
    enabled: boolean;
    sourcePath?: string;
    reasoning?: string;
  }>,
): { db: Db; store: typeof mappings } {
  const store = [...mappings];

  const db = {
    collection: (name: string) => {
      if (name !== 'repo_mandatory_context_mappings') {
        return { find: () => ({ toArray: async () => [] }) };
      }
      return {
        find: (filter: Record<string, unknown>, _opts?: unknown) => ({
          toArray: async () => {
            return store.filter((doc) => {
              // repoId check
              if (filter.repoId && doc.repoId !== filter.repoId) return false;
              // enabled check
              if ('enabled' in filter && doc.enabled !== filter.enabled) return false;
              // agentName $in check
              if (filter.agentName && typeof filter.agentName === 'object') {
                const $in = (filter.agentName as { $in?: string[] }).$in;
                if ($in && !$in.includes(doc.agentName)) return false;
              } else if (filter.agentName && doc.agentName !== filter.agentName) {
                return false;
              }
              return true;
            });
          },
        }),
      };
    },
  } as unknown as Db;

  return { db, store };
}

function baseInput(agentName = 'code-reviewer'): KnowledgeRetrievalInput & { packetId: string; executionId: string } {
  return {
    packetId: 'pkt-1',
    executionId: 'exec-1',
    repoId: 'repo-1',
    repoName: 'my-repo',
    repoPath: '/tmp/my-repo',
    indexId: 'idx-1',
    indexFreshness: 'fresh',
    workflowName: 'test-workflow',
    nodeName: 'test-node',
    nodeRole: agentName,
    targetRole: agentName,
    attempt: 1,
    state: {},
    prompt: 'test prompt',
    provider: 'claude',
    currentFiles: [],
    nodes: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MandatoryContextMappingProvider — enabled filter (TDD §11.3a)', () => {
  it('emits only the enabled mapping when one enabled and one disabled exist', async () => {
    const { db } = makeDbWithMappings([
      { mappingId: 'm-enabled', repoId: 'repo-1', agentName: 'code-reviewer', title: 'Enabled Guide', content: 'enabled content', enabled: true },
      { mappingId: 'm-disabled', repoId: 'repo-1', agentName: 'code-reviewer', title: 'Disabled Guide', content: 'disabled content', enabled: false },
    ]);

    const provider = new MandatoryContextMappingProvider(db);
    const result = await provider.retrieve(baseInput('code-reviewer'));

    expect(result.selectedRefs).toHaveLength(1);
    expect(result.selectedRefs[0].providerMetadata?.mappingId).toBe('m-enabled');
    expect(result.selectedRefs[0].mandatory).toBe(true);
    expect(result.selectedRefs[0].providerMetadata?.injectionDecision).toBe('mandatory_full');
  });

  it('emits zero refs when the only enabled mapping is flipped to disabled', async () => {
    const { db, store } = makeDbWithMappings([
      { mappingId: 'm-enabled', repoId: 'repo-1', agentName: 'code-reviewer', title: 'Guide', content: 'content', enabled: true },
    ]);

    const provider = new MandatoryContextMappingProvider(db);

    // First call: 1 injectable
    const before = await provider.retrieve(baseInput('code-reviewer'));
    expect(before.selectedRefs).toHaveLength(1);

    // Flip the mapping to disabled (simulates replaceForRun deactivation)
    store[0].enabled = false;

    // Second call: 0 injectable
    const after = await provider.retrieve(baseInput('code-reviewer'));
    expect(after.selectedRefs).toHaveLength(0);
  });

  it('emits zero refs when no mappings exist for the repo', async () => {
    const { db } = makeDbWithMappings([]);
    const provider = new MandatoryContextMappingProvider(db);
    const result = await provider.retrieve(baseInput('code-reviewer'));
    expect(result.selectedRefs).toHaveLength(0);
  });

  it('does not emit mappings for a different repoId', async () => {
    const { db } = makeDbWithMappings([
      { mappingId: 'm-other', repoId: 'other-repo', agentName: 'code-reviewer', title: 'Guide', content: 'content', enabled: true },
    ]);
    const provider = new MandatoryContextMappingProvider(db);
    const result = await provider.retrieve(baseInput('code-reviewer'));
    expect(result.selectedRefs).toHaveLength(0);
  });

  it('does not emit mappings when agentName does not match nodeRole/targetRole', async () => {
    const { db } = makeDbWithMappings([
      { mappingId: 'm-reviewer', repoId: 'repo-1', agentName: 'code-reviewer', title: 'Guide', content: 'content', enabled: true },
    ]);
    const provider = new MandatoryContextMappingProvider(db);
    // targetRole/nodeRole set to a different agent
    const result = await provider.retrieve(baseInput('backend-developer'));
    expect(result.selectedRefs).toHaveLength(0);
  });
});

describe('RepoContextEngine integration — mandatory mappings appear in injectableRefs (TDD §11.3a)', () => {
  it('emits enabled mapping in injectableRefs with mandatory_full decision', async () => {
    const { db } = makeDbWithMappings([
      { mappingId: 'm1', repoId: 'repo-1', agentName: 'code-reviewer', title: 'Review Standard', content: 'Always follow SOLID.', enabled: true },
      { mappingId: 'm2', repoId: 'repo-1', agentName: 'code-reviewer', title: 'Old Guide', content: 'old content', enabled: false },
    ]);

    const engine = new RepoContextEngine(
      [new MandatoryContextMappingProvider(db)],
      new PassthroughReranker(),
    );

    const packet = await engine.buildPacket(baseInput('code-reviewer'));

    // Only the enabled mapping should be in selectedRefs
    expect(packet.selectedRefs).toHaveLength(1);
    expect(packet.selectedRefs[0].providerMetadata?.mappingId).toBe('m1');
    expect(packet.selectedRefs[0].mandatory).toBe(true);

    // Mandatory refs are always injectable
    expect(packet.injectableRefs).toHaveLength(1);
    expect(packet.injectableRefs?.[0].providerMetadata?.finalInjectionDecision).toBe('mandatory_full');

    // Disabled mapping must not appear anywhere
    const allRefs = [...packet.selectedRefs, ...(packet.injectableRefs ?? []), ...packet.rejectedRefs];
    const disabledRef = allRefs.find((r) => r.providerMetadata?.mappingId === 'm2');
    expect(disabledRef).toBeUndefined();
  });

  it('emits zero refs after all mappings are deactivated', async () => {
    const { db, store } = makeDbWithMappings([
      { mappingId: 'm1', repoId: 'repo-1', agentName: 'code-reviewer', title: 'Guide', content: 'content', enabled: true },
    ]);

    const engine = new RepoContextEngine(
      [new MandatoryContextMappingProvider(db)],
      new PassthroughReranker(),
    );

    const before = await engine.buildPacket(baseInput('code-reviewer'));
    expect(before.injectableRefs).toHaveLength(1);

    // Simulate replaceForRun deactivation
    store[0].enabled = false;

    const after = await engine.buildPacket(baseInput('code-reviewer'));
    expect(after.selectedRefs).toHaveLength(0);
    expect(after.injectableRefs).toHaveLength(0);
  });
});
