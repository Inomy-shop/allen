import type { WorkflowDef, RoleDef, ValidationResult } from './types.js';
import { validateCondition } from './condition-parser.js';

export function validateWorkflow(
  workflow: WorkflowDef,
  roles: Record<string, RoleDef>,
  builtInNames: string[],
  knownWorkflows?: string[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeNames = Object.keys(workflow.nodes);

  // 1. Check START edge exists
  const hasStart = workflow.edges.some(e => {
    const from = Array.isArray(e.from) ? e.from : [e.from];
    return from.includes('START');
  });
  if (!hasStart) errors.push('No edge from START found');

  // 2. Check END is reachable
  const hasEnd = workflow.edges.some(e => {
    const to = Array.isArray(e.to) ? e.to : [e.to];
    return to.includes('END');
  });
  if (!hasEnd) errors.push('No edge to END found — at least one path must reach END');

  // 3. All edge refs point to existing nodes
  for (const edge of workflow.edges) {
    const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
    const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
    for (const f of froms) {
      if (f !== 'START' && !nodeNames.includes(f)) {
        errors.push(`Edge references non-existent node: ${f}`);
      }
    }
    for (const t of tos) {
      if (t !== 'END' && !nodeNames.includes(t)) {
        errors.push(`Edge references non-existent node: ${t}`);
      }
    }
  }

  // 4. No orphan nodes
  const referencedNodes = new Set<string>();
  for (const edge of workflow.edges) {
    const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
    const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
    froms.forEach(f => referencedNodes.add(f));
    tos.forEach(t => referencedNodes.add(t));
  }
  for (const name of nodeNames) {
    if (!referencedNodes.has(name)) {
      errors.push(`Orphan node: ${name} is not referenced by any edge`);
    }
  }

  // 5. Backward edges must have max_retries
  for (const edge of workflow.edges) {
    const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
    const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
    // A backward edge targets a node that appears as source in an earlier edge
    // Skip START/END — they are not real nodes
    for (const t of tos) {
      if (t === 'END' || t === 'START') continue;
      if (froms.some(f => f !== 'START' && f !== 'END' && nodeNames.indexOf(t) <= nodeNames.indexOf(f))) {
        // Only flag if no max_retries AND no condition (conditional edges without retries are OK — they're routing, not loops)
        if (edge.max_retries == null && !edge.condition) {
          errors.push(`Backward edge to ${t} must have max_retries to prevent infinite loops`);
        }
      }
    }
  }

  // 6. Validate each node
  for (const [name, node] of Object.entries(workflow.nodes)) {
    const type = node.type ?? 'agent';

    // Roles exist
    if (type === 'agent' && node.role) {
      if (!roles[node.role]) {
        errors.push(`Node ${name} references non-existent role: ${node.role}`);
      }
    }

    // Code functions exist
    if (type === 'code' && node.function) {
      if (!builtInNames.includes(node.function)) {
        errors.push(`Node ${name} references non-existent function: ${node.function}`);
      }
    }

    // Workflow refs exist
    if (type === 'workflow' && node.workflow) {
      if (knownWorkflows && !knownWorkflows.includes(node.workflow)) {
        errors.push(`Node ${name} references non-existent workflow: ${node.workflow}`);
      }
    }

    // max_retries sanity
    if (node.retries != null && node.retries > 10) {
      warnings.push(`Node ${name} has retries=${node.retries} — this seems high`);
    }
  }

  // 7. Validate conditions
  for (const edge of workflow.edges) {
    if (edge.condition) {
      try {
        validateCondition(edge.condition);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Invalid condition "${edge.condition}": ${msg}`);
      }
    }
  }
  for (const [name, node] of Object.entries(workflow.nodes)) {
    if (node.conditions) {
      for (const cond of node.conditions) {
        try {
          validateCondition(cond.expression);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Invalid condition in node ${name}: "${cond.expression}": ${msg}`);
        }
      }
    }
  }

  // 8. Template variable warnings
  const allOutputs = new Set<string>();
  for (const node of Object.values(workflow.nodes)) {
    for (const o of node.outputs ?? []) allOutputs.add(o);
  }
  if (workflow.input) {
    for (const key of Object.keys(workflow.input)) allOutputs.add(key);
  }
  // Check prompts for {{var}} references
  for (const [name, node] of Object.entries(workflow.nodes)) {
    if (node.prompt) {
      const refs = [...node.prompt.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g)];
      for (const match of refs) {
        const varName = match[1].split('.')[0];
        if (!allOutputs.has(varName) && varName !== 'retry_context') {
          warnings.push(`Node ${name} uses {{${match[1]}}} but no upstream node outputs '${varName}'`);
        }
      }
    }
  }

  // 8b. Condition variable warnings — check variables used in conditions
  const reservedCondVars = new Set(['true', 'false', 'null', 'AND', 'OR', 'NOT']);
  for (const edge of workflow.edges) {
    if (edge.condition) {
      const condVars = extractConditionVariables(edge.condition);
      for (const v of condVars) {
        if (!allOutputs.has(v) && !reservedCondVars.has(v)) {
          warnings.push(`Condition "${edge.condition}" uses '${v}' but no node outputs it`);
        }
      }
    }
  }
  for (const [name, node] of Object.entries(workflow.nodes)) {
    if (node.conditions) {
      for (const cond of node.conditions) {
        const condVars = extractConditionVariables(cond.expression);
        for (const v of condVars) {
          if (!allOutputs.has(v) && !reservedCondVars.has(v)) {
            warnings.push(`Condition in node ${name} uses '${v}' but no node outputs it`);
          }
        }
      }
    }
  }

  // 9. Parallel forks should have corresponding joins
  for (const edge of workflow.edges) {
    if (edge.parallel && Array.isArray(edge.to) && edge.to.length > 1) {
      const hasJoin = workflow.edges.some(e => {
        const from = Array.isArray(e.from) ? e.from : [e.from];
        return from.length > 1 && (edge.to as string[]).every(t => from.includes(t));
      });
      if (!hasJoin) {
        warnings.push(`Parallel fork to [${(edge.to as string[]).join(', ')}] has no corresponding join edge`);
      }
    }
  }

  // 10. Edge max_retries sanity
  for (const edge of workflow.edges) {
    if (edge.max_retries != null && edge.max_retries > 10) {
      warnings.push(`Edge max_retries=${edge.max_retries} seems high`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Extract variable names from a condition expression.
 * Matches identifiers that are not string literals, operators, or numbers.
 */
function extractConditionVariables(expression: string): string[] {
  // Remove string literals
  const cleaned = expression.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  // Extract identifiers
  const matches = cleaned.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) ?? [];
  // Filter out operators and keywords
  const keywords = new Set(['AND', 'OR', 'NOT', 'and', 'or', 'not', 'true', 'false', 'null', 'in', 'of', 'then', 'else']);
  return [...new Set(matches.filter(m => !keywords.has(m)))];
}
