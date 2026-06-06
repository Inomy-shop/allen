import { MarkerType, type Edge } from '@xyflow/react';

/**
 * Workflow control-flow semantics carried on an edge's `data`. Mirrors the
 * `EdgeDef` schema in packages/engine/src/types.ts. These are the fields the
 * visual EdgeProperties panel authors and that reactflow-to-yaml serializes.
 */
export interface EdgeSemantics {
  condition?: string;
  parallel?: boolean;
  join?: 'wait-all' | 'wait-any' | 'fail-fast';
  merge?: Record<string, 'last' | 'concat' | 'min' | 'max' | 'all' | 'any'>;
  max_retries?: number;
  retry_context?: string;
  /** Which side a retry edge loops back on. Derived, not user-authored. */
  retrySide?: 'left' | 'right';
}

/**
 * Given an edge whose `data` carries workflow semantics (condition, parallel,
 * max_retries, …), return a copy with `type`, `style`, `markerEnd`, `label`,
 * and handles set to match. Mirrors the decoration logic in
 * yaml-to-reactflow so an edge hand-edited in the builder renders identically
 * to one loaded from YAML.
 *
 * Precedence matches the engine's: a `max_retries` edge is a retry (backward)
 * edge regardless of any condition; otherwise a `condition` makes it a
 * conditional edge; otherwise it's a plain auto-routed forward edge.
 */
export function decorateEdge(edge: Edge): Edge {
  const data = (edge.data ?? {}) as EdgeSemantics;
  const isRetry = data.max_retries != null;
  const isConditional = !isRetry && !!data.condition;
  const retrySide: 'left' | 'right' = data.retrySide ?? 'right';

  const color = isRetry
    ? 'rgb(var(--color-flow-edge-retry))'
    : isConditional
      ? 'rgb(var(--color-flow-edge-conditional))'
      : 'rgb(var(--color-flow-edge-default))';

  return {
    ...edge,
    type: isRetry ? 'al-retry' : isConditional ? 'al-conditional' : 'al-auto',
    // Retry edges loop back on a fixed side; forward edges use the
    // top/bottom handles (applyPositionHandles re-picks these live).
    sourceHandle: isRetry ? retrySide : 'bottom',
    targetHandle: isRetry ? retrySide : 'top',
    label: data.condition ?? (data.parallel ? '∥' : undefined),
    animated: !!data.parallel,
    data: { ...edge.data, retrySide: isRetry ? retrySide : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
    style: isRetry
      ? { stroke: color, strokeDasharray: '8 5', strokeWidth: 2.5 }
      : { stroke: color, strokeWidth: 2.5 },
  };
}
