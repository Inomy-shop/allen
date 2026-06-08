import type { Db } from 'mongodb';
import { CogneeMemoryService, type CogneeGraphNodeDetailPayload, type CogneeGraphPayload } from '../cognee/cognee-memory.service.js';
import { RepoMandatoryContextService } from '../mandatory/repo-mandatory-context.service.js';

export type ContextGraphOptions = {
  maxNodes?: number;
  maxEdges?: number;
  query?: string;
  nodeType?: string;
  relationship?: string;
  expandNodeId?: string;
};

export type ContextGraphNodeDetailOptions = {
  maxRelatedNodes?: number;
  maxRelatedEdges?: number;
  includeDocuments?: boolean;
};

export type ContextGraphPayload = CogneeGraphPayload | Record<string, unknown>;
export type ContextGraphNodeDetailPayload = CogneeGraphNodeDetailPayload | Record<string, unknown>;

export class RepoContextGraphService {
  constructor(
    private db: Db,
    private cogneeMemory: CogneeMemoryService,
    private mandatoryContext: RepoMandatoryContextService,
  ) {}

  async getGraph(repoId: string, options: ContextGraphOptions = {}): Promise<ContextGraphPayload> {
    const cogneeStatus = await this.cogneeMemory.getStatus(repoId).catch(() => null);
    if (cogneeStatus && ['completed', 'partial'].includes(String(cogneeStatus.status ?? ''))) {
      return this.cogneeMemory.getGraph(repoId, options).catch(async (err) => ({
        ...await this.getAllenGraph(repoId, options),
        cogneeGraphError: (err as Error).message,
      }));
    }

    return this.getAllenGraph(repoId, options);
  }

  private async getAllenGraph(repoId: string, options: ContextGraphOptions): Promise<Record<string, unknown>> {
    const [allEntries, mandatoryMappings, agents] = await Promise.all([
      this.db.collection('repo_context_curation_entries').find({ repoId, active: { $ne: false } }, { sort: { path: 1, updatedAt: -1 } }).toArray(),
      this.mandatoryContext.list(repoId),
      this.mandatoryContext.listAgents(),
    ]);
    return buildAllenContextManagementGraph(activeCurationEntries(allEntries), mandatoryMappings, agents, options);
  }

  async getNodeDetail(repoId: string, nodeId: string, options: ContextGraphNodeDetailOptions = {}): Promise<ContextGraphNodeDetailPayload> {
    const cogneeStatus = await this.cogneeMemory.getStatus(repoId).catch(() => null);
    if (!cogneeStatus || !['completed', 'partial'].includes(String(cogneeStatus.status ?? ''))) {
      return {
        source: 'context_graph_unavailable',
        provider: 'allen',
        node: null,
        relatedNodes: [],
        relatedEdges: [],
        relatedNodeCount: 0,
        relatedEdgeCount: 0,
        limited: false,
        documentChunks: [],
        error: 'Context graph is not available for this repo.',
      };
    }
    return this.cogneeMemory.getGraphNodeDetail(repoId, nodeId, options);
  }
}

function buildAllenContextManagementGraph(
  entries: Array<Record<string, unknown>>,
  mandatoryMappings: Array<Record<string, unknown>>,
  agents: Array<Record<string, unknown>>,
  options: ContextGraphOptions = {},
): Record<string, unknown> {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const entryByPath = new Map<string, string>();
  for (const entry of entries.slice(0, 500)) {
    const entryId = String(entry.entryId ?? entry._id ?? '');
    if (!entryId) continue;
    const id = `entry:${entryId}`;
    nodes.push({ id, type: 'curated_entry', label: entry.title ?? entry.path ?? entryId, path: entry.path, category: entry.category });
    if (entry.path) entryByPath.set(String(entry.path), id);
  }
  const agentNames = new Set(mandatoryMappings.map((mapping) => String(mapping.agentName ?? '')).filter(Boolean));
  for (const agent of agents.filter((item) => agentNames.has(String(item.name ?? '')))) {
    const id = `agent:${String(agent.name)}`;
    nodes.push({ id, type: 'allen_agent', label: agent.name, teamName: agent.teamName });
  }
  for (const mapping of mandatoryMappings.slice(0, 500)) {
    const mappingId = String(mapping.mappingId ?? mapping._id ?? '');
    if (!mappingId) continue;
    const id = `mandatory:${mappingId}`;
    nodes.push({ id, type: 'mandatory_mapping', label: mapping.title ?? mapping.sourcePath ?? mapping.agentName, sourcePath: mapping.sourcePath, enabled: mapping.enabled !== false });
    if (mapping.agentName) edges.push({ id: `${id}->agent:${String(mapping.agentName)}`, source: id, target: `agent:${String(mapping.agentName)}`, label: 'injects_for' });
    const entryNodeId = mapping.sourcePath ? entryByPath.get(String(mapping.sourcePath)) : undefined;
    if (entryNodeId) edges.push({ id: `${entryNodeId}->${id}`, source: entryNodeId, target: id, label: 'source_for' });
  }
  const filteredEdges = options.relationship
    ? edges.filter((edge) => String(edge.label ?? '').toLowerCase() === String(options.relationship).toLowerCase())
    : edges;
  const filteredNodeIds = new Set<string>();
  for (const edge of filteredEdges) {
    filteredNodeIds.add(String(edge.source));
    filteredNodeIds.add(String(edge.target));
  }
  const filteredNodes = nodes.filter((node) => {
    const matchesType = !options.nodeType || String(node.type ?? '') === options.nodeType;
    const matchesQuery = !options.query || JSON.stringify(node).toLowerCase().includes(String(options.query).toLowerCase());
    const matchesRelationship = !options.relationship || filteredNodeIds.has(String(node.id));
    return matchesType && matchesQuery && matchesRelationship;
  });
  const visibleNodeIds = new Set(filteredNodes.map((node) => String(node.id)));
  const visibleEdges = filteredEdges.filter((edge) => visibleNodeIds.has(String(edge.source)) && visibleNodeIds.has(String(edge.target)));
  const maxNodes = options.maxNodes ?? 500;
  const maxEdges = options.maxEdges ?? 1000;
  const previewNodes = filteredNodes.slice(0, maxNodes);
  const previewNodeIds = new Set(previewNodes.map((node) => String(node.id)));
  const previewEdges = visibleEdges.filter((edge) => previewNodeIds.has(String(edge.source)) && previewNodeIds.has(String(edge.target))).slice(0, maxEdges);
  return {
    source: 'allen_context_management',
    provider: 'allen',
    accessMode: 'allen_mongodb',
    nodes: previewNodes,
    edges: previewEdges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    previewNodeCount: previewNodes.length,
    previewEdgeCount: previewEdges.length,
    nodeTypeCounts: countValues(nodes, 'type', 'type'),
    relationshipCounts: countValues(edges, 'label', 'relationship'),
    limited: filteredNodes.length > previewNodes.length || visibleEdges.length > previewEdges.length,
  };
}

function activeCurationEntries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries.filter((entry) => entry.active !== false && entry.inclusion === 'include');
}

function countValues(items: Array<Record<string, unknown>>, field: string, outputField: string): Array<Record<string, unknown>> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = String(item[field] ?? 'unknown');
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ [outputField]: value, count }));
}
