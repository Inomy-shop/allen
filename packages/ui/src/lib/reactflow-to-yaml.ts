import type { Node, Edge } from '@xyflow/react';
import yaml from 'js-yaml';

/**
 * Convert React Flow nodes and edges back to a workflow YAML string.
 */
export function reactFlowToYaml(
  nodes: Node[],
  edges: Edge[],
  metadata: { name?: string; description?: string; version?: number; context?: any; input?: any },
): string {
  const workflow: any = {
    name: metadata.name ?? 'untitled',
    description: metadata.description ?? '',
    version: metadata.version ?? 1,
  };

  if (metadata.context) workflow.context = metadata.context;
  if (metadata.input) workflow.input = metadata.input;

  // Convert nodes
  const yamlNodes: Record<string, any> = {};
  for (const node of nodes) {
    if (node.id === 'START' || node.id === 'END') continue;
    const data = { ...node.data };
    delete data.label;
    if (data.agent == null && data.role != null) data.agent = data.role;
    delete data.role;

    // Clean up undefined fields
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== null && v !== '') {
        clean[k] = v;
      }
    }

    yamlNodes[node.id] = clean;
  }
  workflow.nodes = yamlNodes;

  // Convert edges — group by source+target to reconstruct array forms
  const yamlEdges: any[] = [];
  const processed = new Set<string>();

  for (const edge of edges) {
    const key = `${edge.source}→${edge.target}`;
    if (processed.has(key)) continue;
    processed.add(key);

    const edgeData = (edge.data ?? {}) as any;
    const yamlEdge: any = { from: edge.source, to: edge.target };

    if (edgeData.condition) yamlEdge.condition = edgeData.condition;
    if (edgeData.parallel) {
      // Group every parallel edge leaving this source into a single
      // fan-out edge with an array `to`. A lone parallel edge still keeps
      // its `parallel: true` flag.
      const parallelTargets = edges
        .filter(e => e.source === edge.source && (e.data as any)?.parallel)
        .map(e => e.target);
      if (parallelTargets.length > 1) {
        yamlEdge.to = parallelTargets;
        for (const t of parallelTargets) processed.add(`${edge.source}→${t}`);
      }
      yamlEdge.parallel = true;
    }
    // join/merge are independent of the grouping above — emit them whenever
    // present so a join authored on a single edge isn't silently dropped.
    if (edgeData.join) yamlEdge.join = edgeData.join;
    if (edgeData.merge && typeof edgeData.merge === 'object' && Object.keys(edgeData.merge).length > 0) {
      yamlEdge.merge = edgeData.merge;
    }
    if (edgeData.max_retries != null) yamlEdge.max_retries = edgeData.max_retries;
    if (edgeData.retry_context) yamlEdge.retry_context = edgeData.retry_context;

    yamlEdges.push(yamlEdge);
  }

  workflow.edges = yamlEdges;

  return yaml.dump(workflow, { lineWidth: 120, noRefs: true, sortKeys: false });
}
