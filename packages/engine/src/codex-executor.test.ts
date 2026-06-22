import { describe, it, expect } from 'vitest';
import { normalizeCodexUsage, aggregateTokenUsage } from './token-usage.js';
import { resolveCodexNodeRuntimeSettings } from './codex-executor.js';

describe('Codex multi-turn token accumulation', () => {
  it('simulates two turns, aggregates usage correctly', () => {
    // Turn 1
    const t1 = normalizeCodexUsage({ input_tokens: 500, output_tokens: 200, cached_input_tokens: 100 });
    // t1 = { inputCachedTokens: 100, inputNonCachedTokens: 400, outputTokens: 200 }

    // Turn 2
    const t2 = normalizeCodexUsage({ input_tokens: 300, output_tokens: 150, cached_input_tokens: 0 });
    // t2 = { inputCachedTokens: 0, inputNonCachedTokens: 300, outputTokens: 150 }

    let acc: ReturnType<typeof normalizeCodexUsage> = null;
    acc = aggregateTokenUsage(acc, t1);
    acc = aggregateTokenUsage(acc, t2);

    expect(acc).toEqual({ inputCachedTokens: 100, inputNonCachedTokens: 700, outputTokens: 350 });
  });

  it('one turn with missing cached: inputCachedTokens stays null across aggregation', () => {
    const t1 = normalizeCodexUsage({ input_tokens: 500, output_tokens: 200 });
    // t1 = { inputCachedTokens: null, inputNonCachedTokens: 500, outputTokens: 200 }
    const t2 = normalizeCodexUsage({ input_tokens: 300, output_tokens: 100 });

    const acc = aggregateTokenUsage(t1, t2);
    // inputCachedTokens: null + null = null
    expect(acc?.inputCachedTokens).toBeNull();
    expect(acc?.inputNonCachedTokens).toBe(800);
    expect(acc?.outputTokens).toBe(300);
  });
});


describe('Codex model recovery override resolution', () => {
  it('uses execution-scoped recovery model before node and agent defaults', () => {
    const settings = resolveCodexNodeRuntimeSettings(
      'plan',
      {
        type: 'agent',
        agent: 'ceo',
        agentOverrides: { model: 'deepseek-v4-flash', reasoningEffort: 'high' },
      },
      {
        __model_overrides: {
          plan: [{
            nodeName: 'plan',
            provider: 'codex',
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            attempt: 1,
            createdAt: '2026-06-20T00:00:00.000Z',
          }],
        },
      },
      { name: 'ceo', model: 'claude-sonnet-4-6', reasoningEffort: 'low' } as any,
    );

    expect(settings).toEqual({ model: 'gpt-5.4', reasoningEffort: 'medium' });
  });
});
