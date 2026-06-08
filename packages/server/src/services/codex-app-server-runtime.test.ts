import { describe, expect, it } from 'vitest';
import { normalizeCodexRuntimeUsage } from './codex-app-server-runtime.js';

describe('normalizeCodexRuntimeUsage', () => {
  it('uses app-server last turn usage instead of cumulative totals', () => {
    expect(normalizeCodexRuntimeUsage({
      total: {
        input_tokens: 10_000,
        cached_input_tokens: 4_000,
        output_tokens: 1_000,
      },
      last: {
        input_tokens: 1_500,
        cached_input_tokens: 500,
        output_tokens: 200,
      },
    })).toEqual({
      inputCachedTokens: 500,
      inputNonCachedTokens: 1_000,
      outputTokens: 200,
    });
  });

  it('accepts camelCase app-server usage fields', () => {
    expect(normalizeCodexRuntimeUsage({
      last: {
        inputTokens: 2_000,
        cachedInputTokens: 250,
        outputTokens: 300,
      },
    })).toEqual({
      inputCachedTokens: 250,
      inputNonCachedTokens: 1_750,
      outputTokens: 300,
    });
  });
});
