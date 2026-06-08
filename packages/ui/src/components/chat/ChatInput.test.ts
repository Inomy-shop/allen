import { describe, expect, it } from 'vitest';
import { modelOptionsForProvider } from './ChatInput';

describe('modelOptionsForProvider', () => {
  it('uses fixed models for normal providers', () => {
    expect(modelOptionsForProvider({
      provider: 'codex',
      label: 'Codex',
      models: ['gpt-5.5', 'o3'],
      defaultModel: 'gpt-5.5',
    })).toEqual(['gpt-5.5', 'o3']);
  });

  it('uses default and suggestions for open providers with empty fixed models', () => {
    expect(modelOptionsForProvider({
      provider: 'deepseek',
      label: 'DeepSeek',
      models: [],
      modelSuggestions: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
      defaultModel: 'deepseek-v4-pro[1m]',
      open: true,
    })).toEqual(['deepseek-v4-pro[1m]', 'deepseek-v4-flash']);
  });

  it('keeps the current custom model selectable for open providers', () => {
    expect(modelOptionsForProvider({
      provider: 'deepseek',
      label: 'DeepSeek',
      models: [],
      modelSuggestions: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
      defaultModel: 'deepseek-v4-pro[1m]',
      open: true,
    }, 'deepseek-r2-custom')).toEqual([
      'deepseek-r2-custom',
      'deepseek-v4-pro[1m]',
      'deepseek-v4-flash',
    ]);
  });
});
