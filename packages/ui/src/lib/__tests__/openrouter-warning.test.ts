import { describe, it, expect } from 'vitest';
import { isNonClaudeOpenRouterModel, OPENROUTER_NON_CLAUDE_WARNING } from '../openrouter-warning';

describe('isNonClaudeOpenRouterModel', () => {
  it('returns true for openrouter + non-anthropic/ model', () => {
    expect(isNonClaudeOpenRouterModel('openrouter', 'google/gemini-2.5-pro')).toBe(true);
  });

  it('returns true for openrouter + deepseek model', () => {
    expect(isNonClaudeOpenRouterModel('openrouter', 'deepseek/deepseek-chat-v4')).toBe(true);
  });

  it('returns false for openrouter + anthropic/ model', () => {
    expect(isNonClaudeOpenRouterModel('openrouter', 'anthropic/claude-sonnet-4-6')).toBe(false);
  });

  it('returns false for openrouter + anthropic/ opus model', () => {
    expect(isNonClaudeOpenRouterModel('openrouter', 'anthropic/claude-opus-4-8')).toBe(false);
  });

  it('returns false for claude provider with any model', () => {
    expect(isNonClaudeOpenRouterModel('claude', 'google/gemini-2.5-pro')).toBe(false);
  });

  it('returns false for codex provider with any model', () => {
    expect(isNonClaudeOpenRouterModel('codex', 'google/gemini-2.5-pro')).toBe(false);
  });

  it('returns false for deepseek provider with any model', () => {
    expect(isNonClaudeOpenRouterModel('deepseek', 'google/gemini-2.5-pro')).toBe(false);
  });

  it('returns false for null provider and null model', () => {
    expect(isNonClaudeOpenRouterModel(null, null)).toBe(false);
  });

  it('returns false for undefined provider and undefined model', () => {
    expect(isNonClaudeOpenRouterModel(undefined, undefined)).toBe(false);
  });

  it('returns false for provider=openrouter with null model', () => {
    expect(isNonClaudeOpenRouterModel('openrouter', null)).toBe(false);
  });

  it('returns false for provider=openrouter with undefined model', () => {
    expect(isNonClaudeOpenRouterModel('openrouter', undefined)).toBe(false);
  });

  it('returns false for null provider with valid model', () => {
    expect(isNonClaudeOpenRouterModel(null, 'google/gemini-2.5-pro')).toBe(false);
  });
});

describe('OPENROUTER_NON_CLAUDE_WARNING', () => {
  it('is a non-empty string', () => {
    expect(typeof OPENROUTER_NON_CLAUDE_WARNING).toBe('string');
    expect(OPENROUTER_NON_CLAUDE_WARNING.length).toBeGreaterThan(0);
  });

  it('mentions "experimental" and "Claude Code"', () => {
    expect(OPENROUTER_NON_CLAUDE_WARNING.toLowerCase()).toContain('experimental');
    expect(OPENROUTER_NON_CLAUDE_WARNING.toLowerCase()).toContain('claude code');
    expect(OPENROUTER_NON_CLAUDE_WARNING.toLowerCase()).toContain('non-claude');
  });
});
