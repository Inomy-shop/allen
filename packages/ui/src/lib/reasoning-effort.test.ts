import { describe, expect, it } from 'vitest';
import { reasoningEffortOptionsFor } from './reasoning-effort';

const valuesFor = (provider: string, model: string) =>
  reasoningEffortOptionsFor(provider, model).map((option) => option.value);

describe('reasoningEffortOptionsFor', () => {
  it('exposes every installed Claude Code effort level', () => {
    const options = reasoningEffortOptionsFor('claude', 'claude-sonnet-5');
    expect(options.map(option => option.value)).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(options.find(option => option.value === 'xhigh')?.label).toBe('Extra high');
  });

  it('exposes model-specific Codex levels', () => {
    expect(valuesFor('codex', 'gpt-5.6-sol')).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(valuesFor('codex', 'gpt-5.5')).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh',
    ]);
    expect(valuesFor('codex', 'gpt-5.6-luna')).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(valuesFor('codex', 'o3')).toEqual(['off']);
    expect(valuesFor('codex', 'unknown-codex-model')).toEqual(['off']);
  });

  it('uses Claude Code levels for configured Claude-compatible providers', () => {
    expect(valuesFor('deepseek', 'deepseek-v4-pro[1m]')).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
  });

  it('only exposes Claude levels for Anthropic models through OpenRouter', () => {
    expect(valuesFor('openrouter', 'anthropic/claude-sonnet-4-6')).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(valuesFor('openrouter', 'google/gemini-2.5-pro')).toEqual(['off']);
  });

  it('does not invent effort levels for unsupported providers', () => {
    expect(valuesFor('gemini', 'gemini-2.5-pro')).toEqual(['off']);
    expect(valuesFor('', '')).toEqual(['off']);
  });
});
