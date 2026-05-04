import type { MergeStrategy } from './types.js';

interface BranchResult {
  node: string;
  outputs: Record<string, unknown>;
}

/**
 * Merge outputs from parallel branches into a single state update.
 */
export function mergeParallelOutputs(
  results: BranchResult[],
  mergeConfig?: Record<string, MergeStrategy>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const conflicts: string[] = [];

  // Sort by node name for deterministic ordering
  results.sort((a, b) => a.node.localeCompare(b.node));

  for (const { outputs } of results) {
    for (const [key, value] of Object.entries(outputs)) {
      if (key in merged && mergeConfig?.[key]) {
        switch (mergeConfig[key]) {
          case 'concat':
            merged[key] = Array.isArray(merged[key])
              ? [...(merged[key] as unknown[]), ...asArray(value)]
              : `${merged[key]}\n${value}`;
            break;
          case 'min':
            merged[key] = Math.min(merged[key] as number, value as number);
            break;
          case 'max':
            merged[key] = Math.max(merged[key] as number, value as number);
            break;
          case 'all':
            merged[key] = (merged[key] as boolean) && !!value;
            break;
          case 'any':
            merged[key] = (merged[key] as boolean) || !!value;
            break;
          default:
            merged[key] = value;
        }
      } else {
        if (key in merged) conflicts.push(key);
        merged[key] = value;
      }
    }
  }

  if (conflicts.length > 0) {
    console.warn(
      `Parallel merge: conflicting keys [${conflicts.join(', ')}] resolved by alphabetical last-write-wins`,
    );
  }

  return merged;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}
