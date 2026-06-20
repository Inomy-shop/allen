import { describe, expect, it } from 'vitest';
import { pickRecoveryDefaultModel } from './modelRecoveryDefaults';

describe('pickRecoveryDefaultModel', () => {
  it('prefers Claude Opus 4.8 over default-tier Claude models', () => {
    expect(pickRecoveryDefaultModel('claude', [
      { fullId: 'claude-fable-5', tier: 'default' },
      { fullId: 'claude-sonnet-4-6', tier: 'default' },
      { fullId: 'claude-opus-4-7', tier: 'opus' },
      { fullId: 'claude-opus-4-8', tier: 'opus' },
    ])).toBe('claude-opus-4-8');
  });

  it('falls back to any Claude opus model when Opus 4.8 is unavailable', () => {
    expect(pickRecoveryDefaultModel('claude', [
      { fullId: 'claude-fable-5', tier: 'default' },
      { fullId: 'claude-opus-4-7', tier: 'opus' },
    ])).toBe('claude-opus-4-7');
  });

  it('keeps non-Claude providers on their default-tier model', () => {
    expect(pickRecoveryDefaultModel('codex', [
      { fullId: 'gpt-5.4', tier: null },
      { fullId: 'gpt-5.5', tier: 'default' },
    ])).toBe('gpt-5.5');
  });
});
