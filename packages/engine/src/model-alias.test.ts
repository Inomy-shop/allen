import { describe, expect, it } from 'vitest';
import { normalizeModelAlias } from './model-alias.js';

describe('normalizeModelAlias', () => {
  it('maps fable to the Claude Fable 5 model ID', () => {
    expect(normalizeModelAlias('fable')).toBe('claude-fable-5');
  });

  it('passes full Claude model IDs through unchanged', () => {
    expect(normalizeModelAlias('claude-fable-5')).toBe('claude-fable-5');
  });
});
