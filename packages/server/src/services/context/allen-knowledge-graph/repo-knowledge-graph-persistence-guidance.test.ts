import { describe, expect, it } from 'vitest';
import {
  REPO_KNOWLEDGE_GRAPH_PERSISTENCE_GUIDANCE_SENTINEL,
  shouldInjectRepoKnowledgeGraphPersistenceGuidance,
  withRepoKnowledgeGraphPersistenceGuidance,
} from './repo-knowledge-graph-persistence-guidance.js';

describe('repo knowledge graph persistence guidance', () => {
  it('targets repo knowledge graph indexer persistence prompts', () => {
    expect(
      shouldInjectRepoKnowledgeGraphPersistenceGuidance(
        'repo-knowledge-graph-indexer',
        'Fresh start: recreate the repository knowledge graph and save it in Allen DB',
      ),
    ).toBe(true);
  });

  it('does not target other agents', () => {
    expect(
      shouldInjectRepoKnowledgeGraphPersistenceGuidance(
        'backend-developer',
        'Recreate the repository knowledge graph and save it in Allen DB',
      ),
    ).toBe(false);
  });

  it('prepends mandatory MCP save instructions to the system prompt', () => {
    const system = withRepoKnowledgeGraphPersistenceGuidance('Existing system prompt', {
      agentName: 'repo-knowledge-graph-indexer',
      prompt: 'Refresh and persist the repo knowledge graph',
      repoPath: '/tmp/repo',
    });

    expect(system).toContain(REPO_KNOWLEDGE_GRAPH_PERSISTENCE_GUIDANCE_SENTINEL);
    expect(system).toContain('mode full_graph or mandatory_context_map');
    expect(system).toContain('graph_mode');
    expect(system).toContain('MUST call the Allen MCP tool save_repo_knowledge_graph');
    expect(system).toContain('mcp__allen__save_repo_knowledge_graph');
    expect(system).toContain('allen_save_artifact');
    expect(system).toContain('is not graph persistence');
    expect(system.indexOf(REPO_KNOWLEDGE_GRAPH_PERSISTENCE_GUIDANCE_SENTINEL)).toBeLessThan(
      system.indexOf('Existing system prompt'),
    );
  });
});
