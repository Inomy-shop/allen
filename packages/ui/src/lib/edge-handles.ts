import type { Node, Edge } from '@xyflow/react';

export type HandleSide = 'top' | 'bottom' | 'left' | 'right';

const OPPOSITE: Record<HandleSide, HandleSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

// Assumed node box size used to compute a center point when a node has
// no measured width/height yet. Matches the layout constants in
// yaml-to-reactflow / LiveGraph.
const FALLBACK_W = 280;
const FALLBACK_H = 80;

function centerOf(n: Node): { x: number; y: number } {
  const w = (n as any).width ?? (n as any).measured?.width ?? FALLBACK_W;
  const h = (n as any).height ?? (n as any).measured?.height ?? FALLBACK_H;
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

/**
 * Pick the best source/target handle pair for an edge based on the
 * relative geometry of the two nodes.
 *
 * Rule: whichever axis separates the two nodes more (dx vs dy) wins.
 *   - horizontal dominance → source exits right/left, target enters opposite
 *   - vertical dominance   → source exits bottom/top, target enters opposite
 *
 * This reduces edge overlap by letting edges approach a node from the
 * side that actually faces their source, instead of always funneling
 * into the top handle.
 */
export function pickHandles(
  source: Node,
  target: Node,
): { sourceHandle: HandleSide; targetHandle: HandleSide } {
  const s = centerOf(source);
  const t = centerOf(target);
  const dx = t.x - s.x;
  const dy = t.y - s.y;

  const sourceSide: HandleSide =
    Math.abs(dx) > Math.abs(dy)
      ? dx >= 0 ? 'right' : 'left'
      : dy >= 0 ? 'bottom' : 'top';

  return { sourceHandle: sourceSide, targetHandle: OPPOSITE[sourceSide] };
}

/**
 * Reassign sourceHandle / targetHandle on every edge based on current
 * node positions. Retry edges keep whatever side-handle the caller
 * already picked (they intentionally loop back on a fixed side), so
 * they're passed through unchanged.
 */
export function applyPositionHandles(nodes: Node[], edges: Edge[]): Edge[] {
  const byId = new Map<string, Node>();
  for (const n of nodes) byId.set(n.id, n);

  return edges.map((e) => {
    if (e.type === 'al-retry') return e;
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (!src || !tgt) return e;
    const { sourceHandle, targetHandle } = pickHandles(src, tgt);
    if (e.sourceHandle === sourceHandle && e.targetHandle === targetHandle) return e;
    return { ...e, sourceHandle, targetHandle };
  });
}
