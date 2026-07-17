import { describe, expect, it } from 'vitest';
import type { WorkflowDef } from '@allen/engine';
import {
  applyWorkflowRuntimeModelOverrides,
  normalizeRuntimeModelOverrides,
} from './execution.service.js';

describe('runtime model overrides', () => {
  it('normalizes top-level, default, node, and agent runtime choices', () => {
    const normalized = normalizeRuntimeModelOverrides({
      provider: ' claude ',
      model: ' claude-sonnet-4-6 ',
      default: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      agents: {
        'code-reviewer': { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' },
        blank: { provider: '   ' },
      },
      nodes: {
        review: { model: 'claude-opus-4-7', planMode: false },
      },
      descendants: 'agent_defaults',
    });

    expect(normalized).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      default: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      agents: {
        'code-reviewer': { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' },
      },
      nodes: {
        review: { model: 'claude-opus-4-7', planMode: false },
      },
      descendants: 'agent_defaults',
    });
  });

  it('applies runtime choices to a cloned workflow without mutating the original', () => {
    const workflow: WorkflowDef = {
      name: 'runtime-model-workflow',
      version: 1,
      nodes: {
        plan: {
          type: 'agent',
          agent: 'technical-designer',
          agentOverrides: { provider: 'claude', model: 'claude-sonnet-4-6' },
          prompt: 'plan',
        },
        review: {
          type: 'agent',
          agent: 'code-reviewer',
          prompt: 'review',
        },
        summarize: {
          type: 'code',
          function: 'noop',
        },
      },
      edges: [],
    };

    const updated = applyWorkflowRuntimeModelOverrides(workflow, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      agents: {
        'code-reviewer': { provider: 'claude', model: 'claude-sonnet-4-6' },
      },
      nodes: {
        plan: { provider: 'claude', model: 'claude-opus-4-7' },
      },
    });

    expect(updated).not.toBe(workflow);
    expect(workflow.nodes.plan.agentOverrides).toEqual({ provider: 'claude', model: 'claude-sonnet-4-6' });

    expect(updated.nodes.plan.agentOverrides).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-7',
      runtimeModelOverrideSources: { provider: 'runtime', model: 'runtime' },
    });
    expect(updated.nodes.review.agentOverrides).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      runtimeModelOverrideSources: { provider: 'runtime', model: 'runtime' },
    });
    expect(updated.nodes.summarize.agentOverrides).toBeUndefined();
  });
});
