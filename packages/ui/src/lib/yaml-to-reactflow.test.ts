import { describe, expect, it } from 'vitest';
import { yamlToReactFlow } from './yaml-to-reactflow';

function boxesOverlap(a: any, b: any): boolean {
  const aw = a.width ?? 280;
  const ah = a.height ?? 112;
  const bw = b.width ?? 280;
  const bh = b.height ?? 112;
  return a.position.x < b.position.x + bw
    && a.position.x + aw > b.position.x
    && a.position.y < b.position.y + bh
    && a.position.y + ah > b.position.y;
}

function segmentIntersectsBox(a: any, b: any, box: any): boolean {
  const bw = box.width ?? 280;
  const bh = box.height ?? 112;
  const left = box.position.x;
  const right = box.position.x + bw;
  const top = box.position.y;
  const bottom = box.position.y + bh;

  if (a.x === b.x) {
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    return a.x >= left && a.x <= right && y2 > top && y1 < bottom;
  }

  if (a.y === b.y) {
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    return a.y >= top && a.y <= bottom && x2 > left && x1 < right;
  }

  return false;
}

describe('yamlToReactFlow layout', () => {
  it('keeps branched workflow nodes from overlapping', () => {
    const workflow = {
      name: 'layout-regression',
      nodes: {
        plan: { type: 'agent', agent: 'planner', outputs: { plan: '', risks: '', tasks: '', notes: '' } },
        build: { type: 'agent', agent: 'developer', outputs: { patch: '', files: '', summary: '' } },
        review: { type: 'human', fields: [{ name: 'decision' }, { name: 'feedback' }] },
        repair: { type: 'agent', agent: 'developer', outputs: { patch: '' } },
        validate: { type: 'agent', agent: 'validator', outputs: { valid: '', blockers: '', report: '' } },
        pr: { type: 'agent', agent: 'pr-creator', outputs: { url: '', commit: '', branch: '' } },
      },
      edges: [
        { from: 'START', to: 'plan' },
        { from: 'plan', to: ['build', 'review'], parallel: true },
        { from: 'build', to: 'validate' },
        { from: 'review', to: 'validate' },
        { from: 'validate', to: 'repair', condition: 'needs_changes' },
        { from: 'repair', to: 'validate', max_retries: 3 },
        { from: 'validate', to: 'pr', condition: 'valid' },
        { from: 'pr', to: 'END' },
      ],
    };

    const { nodes } = yamlToReactFlow(workflow);
    const realNodes = nodes.filter(node => node.id !== 'START' && node.id !== 'END');

    for (let i = 0; i < realNodes.length; i++) {
      for (let j = i + 1; j < realNodes.length; j++) {
        expect(
          boxesOverlap(realNodes[i], realNodes[j]),
          `${realNodes[i].id} overlaps ${realNodes[j].id}`,
        ).toBe(false);
      }
    }
  });

  it('routes long edges around unrelated node boxes', () => {
    const workflow = {
      name: 'edge-routing-regression',
      nodes: {
        plan: { type: 'agent', agent: 'planner', outputs: { milestone: '' } },
        leftReview: { type: 'agent', agent: 'validator', outputs: { decision: '', failures: '' } },
        rightSummary: { type: 'agent', agent: 'writer', outputs: { summary: '', result: '' } },
        leftRepair: { type: 'agent', agent: 'developer', outputs: { patch: '' } },
        rightComplete: { type: 'agent', agent: 'lead', outputs: { completed: '' } },
        final: { type: 'agent', agent: 'publisher', outputs: { url: '' } },
      },
      edges: [
        { from: 'START', to: 'plan' },
        { from: 'plan', to: ['leftReview', 'rightSummary'], parallel: true },
        { from: 'leftReview', to: 'leftRepair', condition: 'needs_repair' },
        { from: 'leftReview', to: 'rightComplete', condition: 'valid' },
        { from: 'rightSummary', to: 'rightComplete', condition: 'summary_ready' },
        { from: 'leftRepair', to: 'rightComplete', condition: 'repaired' },
        { from: 'rightComplete', to: 'final' },
        { from: 'final', to: 'END' },
      ],
    };

    const { nodes, edges } = yamlToReactFlow(workflow);
    const nodeById = new Map(nodes.map(node => [node.id, node]));

    for (const edge of edges) {
      if (edge.type === 'al-retry') continue;
      const points = (edge.data as any)?.routePoints ?? [];
      expect(points.length, `${edge.id} has no route points`).toBeGreaterThan(1);

      for (let i = 1; i < points.length; i++) {
        for (const node of nodes) {
          if (node.id === edge.source || node.id === edge.target) continue;
          expect(
            segmentIntersectsBox(points[i - 1], points[i], nodeById.get(node.id)),
            `${edge.id} crosses ${node.id}`,
          ).toBe(false);
        }
      }
    }
  });

  it('intentionally overlaps duplicate source-target edge routes', () => {
    const workflow = {
      name: 'duplicate-edge-route-regression',
      nodes: {
        review: { type: 'human', fields: [{ name: 'decision' }] },
        repair: { type: 'agent', agent: 'developer', outputs: { patch: '' } },
      },
      edges: [
        { from: 'START', to: 'review' },
        { from: 'review', to: 'repair', condition: 'decision == retry' },
        { from: 'review', to: 'repair', condition: 'decision == revise' },
        { from: 'repair', to: 'END' },
      ],
    };

    const { edges } = yamlToReactFlow(workflow);
    const duplicateRoutes = edges
      .filter(edge => edge.source === 'review' && edge.target === 'repair')
      .map(edge => JSON.stringify((edge.data as any)?.routePoints));

    expect(duplicateRoutes).toHaveLength(2);
    expect(duplicateRoutes[0]).toBe(duplicateRoutes[1]);
  });

  it('keeps all routed forward edge segments orthogonal', () => {
    const workflow = {
      name: 'orthogonal-edge-regression',
      nodes: {
        classify: { type: 'agent', agent: 'classifier', outputs: { severity: '' } },
        askHuman: { type: 'human', fields: [{ name: 'severity' }] },
        investigate: { type: 'agent', agent: 'investigator', outputs: { confidence: '' } },
        implement: { type: 'agent', agent: 'developer', outputs: { patch: '' } },
        qa: { type: 'agent', agent: 'qa', outputs: { verdict: '' } },
      },
      edges: [
        { from: 'START', to: 'classify' },
        { from: 'classify', to: 'askHuman', condition: 'severity == unknown' },
        { from: 'askHuman', to: 'investigate', condition: 'severity != small' },
        { from: 'investigate', to: 'implement', condition: 'confidence > 0.7' },
        { from: 'askHuman', to: 'implement', condition: 'severity == small' },
        { from: 'implement', to: 'qa' },
        { from: 'qa', to: 'investigate', max_retries: 2 },
        { from: 'qa', to: 'END' },
      ],
    };

    const { edges } = yamlToReactFlow(workflow);
    for (const edge of edges) {
      if (edge.type === 'al-retry') continue;
      const points = (edge.data as any)?.routePoints ?? [];
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const point = points[i];
        expect(
          prev.x === point.x || prev.y === point.y,
          `${edge.id} has a diagonal segment`,
        ).toBe(true);
      }
    }
  });
});
