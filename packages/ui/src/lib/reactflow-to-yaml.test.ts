import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import type { Edge, Node } from '@xyflow/react';
import { reactFlowToYaml } from './reactflow-to-yaml';
import { yamlToReactFlow } from './yaml-to-reactflow';
import { decorateEdge } from './edge-semantics';

function dump(parsed: any): string {
  return yaml.dump(parsed, { lineWidth: 120, noRefs: true, sortKeys: false });
}

describe('reactFlowToYaml edge serialization', () => {
  it('emits join/merge on a non-parallel edge instead of dropping them', () => {
    const nodes: Node[] = [
      { id: 'START', type: 'al-terminal', position: { x: 0, y: 0 }, data: { label: 'START' } },
      { id: 'collect', type: 'al-agent', position: { x: 0, y: 0 }, data: { label: 'collect', type: 'agent' } },
      { id: 'END', type: 'al-terminal', position: { x: 0, y: 0 }, data: { label: 'END' } },
    ];
    const edges: Edge[] = [
      { id: 'e0', source: 'START', target: 'collect' },
      {
        id: 'e1',
        source: 'collect',
        target: 'END',
        data: { join: 'wait-any', merge: { result: 'concat' } },
      },
    ];

    const out = yaml.load(reactFlowToYaml(nodes, edges, { name: 'wf' })) as any;
    const edge = out.edges.find((e: any) => e.from === 'collect' && e.to === 'END');
    expect(edge.join).toBe('wait-any');
    expect(edge.merge).toEqual({ result: 'concat' });
  });

  it('groups parallel siblings into a single array-`to` edge', () => {
    const nodes: Node[] = [
      { id: 'plan', type: 'al-agent', position: { x: 0, y: 0 }, data: { label: 'plan', type: 'agent' } },
      { id: 'a', type: 'al-agent', position: { x: 0, y: 0 }, data: { label: 'a', type: 'agent' } },
      { id: 'b', type: 'al-agent', position: { x: 0, y: 0 }, data: { label: 'b', type: 'agent' } },
    ];
    const edges: Edge[] = [
      { id: 'e1', source: 'plan', target: 'a', data: { parallel: true, join: 'wait-all' } },
      { id: 'e2', source: 'plan', target: 'b', data: { parallel: true } },
    ];

    const out = yaml.load(reactFlowToYaml(nodes, edges, { name: 'wf' })) as any;
    const parallelEdges = out.edges.filter((e: any) => e.from === 'plan');
    expect(parallelEdges).toHaveLength(1);
    expect(parallelEdges[0].to).toEqual(['a', 'b']);
    expect(parallelEdges[0].parallel).toBe(true);
    expect(parallelEdges[0].join).toBe('wait-all');
  });

  it('round-trips condition / parallel / retry edges without losing fields', () => {
    const workflow = {
      name: 'round-trip',
      description: '',
      version: 1,
      nodes: {
        plan: { type: 'agent', agent: 'planner', outputs: { plan: '' } },
        build: { type: 'agent', agent: 'developer', outputs: { patch: '' } },
        review: { type: 'human', fields: [{ name: 'decision' }] },
        validate: { type: 'agent', agent: 'validator', outputs: { valid: '' } },
      },
      edges: [
        { from: 'START', to: 'plan' },
        { from: 'plan', to: ['build', 'review'], parallel: true, join: 'wait-all' },
        { from: 'build', to: 'validate' },
        { from: 'review', to: 'validate' },
        { from: 'validate', to: 'build', condition: 'valid == false', max_retries: 3, retry_context: '{{validate.report}}' },
        { from: 'validate', to: 'END', condition: 'valid == true' },
      ],
    };

    const { nodes, edges } = yamlToReactFlow(workflow);
    const out = yaml.load(reactFlowToYaml(nodes, edges, {
      name: workflow.name,
      description: workflow.description,
      version: workflow.version,
    })) as any;

    const find = (from: string, to: string) =>
      out.edges.find((e: any) => e.from === from && (Array.isArray(e.to) ? e.to.includes(to) : e.to === to));

    expect(find('plan', 'build').parallel).toBe(true);
    expect(find('plan', 'build').join).toBe('wait-all');
    const retry = find('validate', 'build');
    expect(retry.condition).toBe('valid == false');
    expect(retry.max_retries).toBe(3);
    expect(retry.retry_context).toBe('{{validate.report}}');
    expect(find('validate', 'END').condition).toBe('valid == true');
  });
});

describe('reactFlowToYaml node + meta round-trip (Phase 4 fields)', () => {
  it('preserves workflow-builder agent override provider and model together', () => {
    const nodes: Node[] = [
      {
        id: 'draft',
        type: 'al-agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'draft',
          type: 'agent',
          agent: 'requirements-analyst',
          agentOverrides: {
            provider: 'deepseek',
            model: 'deepseek-v4-pro[1m]',
            reasoningEffort: 'high',
          },
        },
      },
    ];

    const out = yaml.load(reactFlowToYaml(nodes, [], { name: 'wf' })) as any;

    expect(out.nodes.draft.agentOverrides).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro[1m]',
      reasoningEffort: 'high',
    });
  });

  it('backfills provider when serializing a legacy model-only override', () => {
    const nodes: Node[] = [
      {
        id: 'draft',
        type: 'al-agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'draft',
          type: 'agent',
          agent: 'requirements-analyst',
          agentOverrides: {
            model: 'deepseek-v4-flash',
          },
        },
      },
    ];

    const out = yaml.load(reactFlowToYaml(nodes, [], { name: 'wf' })) as any;

    expect(out.nodes.draft.agentOverrides).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
  });

  it('preserves advanced node fields and workflow input/context', () => {
    const workflow = {
      name: 'phase4',
      description: 'd',
      version: 2,
      context: { requires: ['repo-a'], tools: ['git'], secrets: ['TOKEN'], concurrency: 3 },
      input: {
        task: { type: 'string', required: true, description: 'the task', widget: 'textarea' },
        severity: { type: 'string', enum: ['low', 'high'], default: 'low' },
      },
      nodes: {
        plan: {
          type: 'agent',
          agent: 'planner',
          outputs: { plan: 'the breakdown' },
          output_format: 'json',
          session_key: 'planner:{{task}}',
          output_extraction: { plan: '$.plan' },
        },
        prep: {
          type: 'code',
          function: 'git-commit',
          config: { message: 'wip' },
          backoff: 'exponential',
          backoff_base_ms: 500,
          retry_on: ['ETIMEDOUT'],
          on_failure: 'fallback',
          fallback_value: { ok: false },
        },
        sub: {
          type: 'workflow',
          workflow: 'bugfix',
          input_map: { bug: 'task' },
          output_map: { fix: 'patch' },
        },
      },
      edges: [
        { from: 'START', to: 'plan' },
        { from: 'plan', to: 'prep' },
        { from: 'prep', to: 'sub' },
        { from: 'sub', to: 'END' },
      ],
    };

    const { nodes, edges } = yamlToReactFlow(workflow);
    const out = yaml.load(reactFlowToYaml(nodes, edges, {
      name: workflow.name,
      description: workflow.description,
      version: workflow.version,
      context: workflow.context,
      input: workflow.input,
    })) as any;

    expect(out.context).toEqual(workflow.context);
    expect(out.input).toEqual(workflow.input);
    expect(out.nodes.plan.output_format).toBe('json');
    expect(out.nodes.plan.session_key).toBe('planner:{{task}}');
    expect(out.nodes.plan.output_extraction).toEqual({ plan: '$.plan' });
    expect(out.nodes.prep.config).toEqual({ message: 'wip' });
    expect(out.nodes.prep.backoff).toBe('exponential');
    expect(out.nodes.prep.backoff_base_ms).toBe(500);
    expect(out.nodes.prep.retry_on).toEqual(['ETIMEDOUT']);
    expect(out.nodes.prep.on_failure).toBe('fallback');
    expect(out.nodes.prep.fallback_value).toEqual({ ok: false });
    expect(out.nodes.sub.input_map).toEqual({ bug: 'task' });
    expect(out.nodes.sub.output_map).toEqual({ fix: 'patch' });
  });
});

describe('decorateEdge', () => {
  it('classifies retry over condition (retry wins)', () => {
    const out = decorateEdge({ id: 'e', source: 'a', target: 'b', data: { condition: 'x', max_retries: 2 } });
    expect(out.type).toBe('al-retry');
    expect((out.data as any).retrySide).toBe('right');
  });

  it('classifies a condition edge', () => {
    const out = decorateEdge({ id: 'e', source: 'a', target: 'b', data: { condition: 'x == 1' } });
    expect(out.type).toBe('al-conditional');
    expect(out.label).toBe('x == 1');
  });

  it('falls back to an auto edge with no semantics', () => {
    const out = decorateEdge({ id: 'e', source: 'a', target: 'b', data: {} });
    expect(out.type).toBe('al-auto');
  });
});
