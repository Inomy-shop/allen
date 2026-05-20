import type { NodeDef } from './types.js';

export function withRepoContextUsageOutput(nodeDef: NodeDef): NodeDef {
  if (nodeDef.output_format === 'freeform') return nodeDef;
  const outputs = { ...(nodeDef.outputs ?? {}) };
  if (!outputs.repo_context_usage) {
    outputs.repo_context_usage = 'Repo context usage report following the injected system repo_context_usage contract.';
  }
  return { ...nodeDef, outputs };
}
