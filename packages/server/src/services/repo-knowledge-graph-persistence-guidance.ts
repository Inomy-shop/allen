const PERSISTENCE_TRIGGER_RE = /\b(save|persist|index|refresh|recreate|replace|rebuild)\b/i;
const GRAPH_TRIGGER_RE = /\b(repo[- ]knowledge[- ]graph|knowledge[- ]graph|graph)\b/i;

export const REPO_KNOWLEDGE_GRAPH_PERSISTENCE_GUIDANCE_SENTINEL =
  'repo_knowledge_graph_persistence_contract';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function shouldInjectRepoKnowledgeGraphPersistenceGuidance(agentName: string, prompt: string): boolean {
  return (
    agentName === 'repo-knowledge-graph-indexer' &&
    PERSISTENCE_TRIGGER_RE.test(prompt) &&
    GRAPH_TRIGGER_RE.test(prompt)
  );
}

export function withRepoKnowledgeGraphPersistenceGuidance(
  systemPrompt: string | undefined,
  input: { agentName: string; prompt: string; repoPath?: string },
): string {
  const existing = systemPrompt ?? '';
  if (!shouldInjectRepoKnowledgeGraphPersistenceGuidance(input.agentName, input.prompt)) {
    return existing;
  }
  if (existing.includes(REPO_KNOWLEDGE_GRAPH_PERSISTENCE_GUIDANCE_SENTINEL)) {
    return existing;
  }

  const repoPathLine = input.repoPath
    ? `\n  <repo_path>${escapeXml(input.repoPath)}</repo_path>`
    : '';

  return `
<${REPO_KNOWLEDGE_GRAPH_PERSISTENCE_GUIDANCE_SENTINEL} priority="critical">
  <rule>When this task asks you to index, save, persist, refresh, recreate, rebuild, or replace a repo knowledge graph, you MUST call the Allen MCP tool save_repo_knowledge_graph, shown by Claude as mcp__allen__save_repo_knowledge_graph when namespaced.</rule>
  <rule>Pass repo_path and the full generated graph as graph or graph_json.${repoPathLine}</rule>
  <rule>Saving with allen_save_artifact, printing JSON, writing a markdown report, or final-answering is not graph persistence. Artifacts are supplemental only.</rule>
  <rule>Do not finish until save_repo_knowledge_graph returns success.</rule>
  <rule>If the tool returns KNOWLEDGE_GRAPH_VALIDATION_FAILED or other structured validation errors, repair the graph and call save_repo_knowledge_graph again. If you cannot repair it, report the structured validation errors and do not claim the graph was saved.</rule>
</${REPO_KNOWLEDGE_GRAPH_PERSISTENCE_GUIDANCE_SENTINEL}>

${existing}`.trimStart();
}
