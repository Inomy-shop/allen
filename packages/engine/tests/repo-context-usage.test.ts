import { describe, expect, it } from 'vitest';
import { withRepoContextUsageOutput } from '../src/repo-context-usage.js';

describe('repo context usage helpers', () => {
  it('does not add repo_context_usage output for freeform nodes', () => {
    const node = {
      output_format: 'freeform' as const,
      outputs: { summary: 'Plain text summary.' },
    };

    expect(withRepoContextUsageOutput(node)).toBe(node);
  });

  it('adds repo_context_usage output for structured nodes', () => {
    const node = { outputs: { summary: 'Summary.' } };

    expect(withRepoContextUsageOutput(node).outputs).toEqual({
      summary: 'Summary.',
      repo_context_usage: 'Repo context usage report following the injected system repo_context_usage contract.',
    });
  });

  it('keeps an authored repo_context_usage output description', () => {
    const node = { outputs: { repo_context_usage: 'Custom usage contract.' } };

    expect(withRepoContextUsageOutput(node).outputs?.repo_context_usage).toBe('Custom usage contract.');
  });

});
