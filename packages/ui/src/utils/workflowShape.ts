export function workflowNodes(workflow: any): Record<string, any> {
  const nodes = workflow?.parsed?.nodes ?? workflow?.parsed?.workflow?.nodes ?? workflow?.nodes;
  if (Array.isArray(nodes)) {
    return Object.fromEntries(nodes.map((node, index) => [node?.id ?? node?.name ?? String(index), node]));
  }
  if (nodes && typeof nodes === 'object') return nodes;
  return {};
}

export function workflowEdges(workflow: any): any[] {
  const edges = workflow?.parsed?.edges ?? workflow?.parsed?.workflow?.edges ?? workflow?.edges;
  return Array.isArray(edges) ? edges : [];
}

export function workflowInput(workflow: any): Record<string, any> {
  const input = workflow?.parsed?.input ?? workflow?.parsed?.workflow?.input ?? workflow?.input;
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

export function workflowName(workflow: any): string {
  return workflow?.name ?? workflow?.parsed?.name ?? workflow?.parsed?.workflow?.name ?? 'Untitled workflow';
}

export function workflowDescription(workflow: any): string {
  return workflow?.description ?? workflow?.parsed?.description ?? workflow?.parsed?.workflow?.description ?? '';
}
