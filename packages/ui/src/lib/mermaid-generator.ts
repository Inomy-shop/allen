/**
 * Generate a Mermaid diagram string from a parsed workflow definition.
 * Client-side mirror of the engine's visualizer.
 */
export function generateMermaid(workflow: any): string {
  if (!workflow?.nodes || !workflow?.edges) return 'graph TD\n  A[No workflow data]';

  const lines: string[] = ['graph TD'];

  lines.push('  classDef agent fill:#3498db,stroke:#2c3e50,color:#fff');
  lines.push('  classDef code fill:#2ecc71,stroke:#27ae60,color:#fff');
  lines.push('  classDef human fill:#e67e22,stroke:#d35400,color:#fff');
  lines.push('  classDef workflow fill:#9b59b6,stroke:#8e44ad,color:#fff');
  lines.push('  classDef condition fill:#f1c40f,stroke:#f39c12,color:#333');
  lines.push('');

  lines.push('  START([START])');
  lines.push('  END([END])');

  for (const [name, node] of Object.entries(workflow.nodes) as [string, any][]) {
    const type = node.type ?? 'agent';
    const agent = node.agent ?? node.role;
    const label = agent ? `${name}\\n(${agent})` : name;

    switch (type) {
      case 'agent':
        lines.push(`  ${name}["${label}"]:::agent`);
        break;
      case 'code':
        lines.push(`  ${name}[/"${name}\\n(${node.function ?? 'code'})"/]:::code`);
        break;
      case 'human':
        lines.push(`  ${name}{{"${name}"}}:::human`);
        break;
      case 'workflow':
        lines.push(`  ${name}[["${name}\\n(→${node.workflow})"]]:::workflow`);
        break;
      case 'condition':
        lines.push(`  ${name}{"${name}"}:::condition`);
        break;
    }
  }

  lines.push('');

  for (const edge of workflow.edges) {
    const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
    const tos = Array.isArray(edge.to) ? edge.to : [edge.to];

    for (const from of froms) {
      for (const to of tos) {
        let label = '';
        if (edge.condition) label = edge.condition;
        if (edge.max_retries != null) {
          label += label ? `\\n(retry ≤${edge.max_retries})` : `retry ≤${edge.max_retries}`;
        }
        if (edge.parallel) {
          label += label ? '\\n∥ parallel' : '∥ parallel';
        }

        if (label) {
          lines.push(`  ${from} -->|"${label}"| ${to}`);
        } else {
          lines.push(`  ${from} --> ${to}`);
        }
      }
    }
  }

  return lines.join('\n');
}
