/**
 * Tests for the shared model-option builder used by RoleDialog (and
 * BulkAgentModelDialog / ImportAndTeamDialogs) for model selection
 * (ENG-1825 / AC-002).
 *
 * The registry is the source of truth; the only secondary source is the
 * /chat/providers payload (itself registry-patched server-side). There is
 * deliberately NO static catalog fallback (REQ-005) — with neither source,
 * the list is empty apart from the "Other…" escape hatch.
 */

import { describe, it, expect } from 'vitest';
import {
  buildModelOptionsForProvider,
  getOpenProviderModelSuggestions,
} from '../../../lib/model-catalog';

describe('RoleDialog model selection (AC-002)', () => {
  it('uses registry models and appends "Other…" when registry models exist', () => {
    const registryModels = [
      { label: 'Claude Sonnet 4', value: 'sonnet' },
      { label: 'Claude Opus 4', value: 'opus' },
    ];
    const result = buildModelOptionsForProvider('claude', [], registryModels);

    expect(result).toEqual([
      { label: 'Claude Sonnet 4', value: 'sonnet' },
      { label: 'Claude Opus 4', value: 'opus' },
      { label: 'Other…', value: '__other__' },
    ]);
  });

  it('uses the enabled-provider payload models when the registry list is empty', () => {
    const result = buildModelOptionsForProvider(
      'claude',
      [{ provider: 'claude', models: ['claude-sonnet-4-6', 'claude-opus-4-7'] }],
    );

    expect(result).toEqual([
      { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
      { label: 'claude-opus-4-7', value: 'claude-opus-4-7' },
      { label: 'Other…', value: '__other__' },
    ]);
  });

  it('renders only "Other…" when neither registry nor provider payload has models (REQ-005)', () => {
    expect(buildModelOptionsForProvider('claude', [])).toEqual([
      { label: 'Other…', value: '__other__' },
    ]);
    expect(buildModelOptionsForProvider('codex', [])).toEqual([
      { label: 'Other…', value: '__other__' },
    ]);
  });

  it('uses provider modelSuggestions for open providers without registry models', () => {
    const fromSuggestions = buildModelOptionsForProvider(
      'deepseek',
      [{ provider: 'deepseek', open: true, modelSuggestions: ['ds-x'] }],
    );
    expect(fromSuggestions).toEqual([
      { label: 'ds-x', value: 'ds-x' },
      { label: 'Other…', value: '__other__' },
    ]);

    const withoutSuggestions = buildModelOptionsForProvider(
      'deepseek',
      [{ provider: 'deepseek', open: true }],
    );
    expect(withoutSuggestions).toEqual([
      { label: 'Other…', value: '__other__' },
    ]);
  });

  it('registry models take precedence over the provider payload (REQ-013)', () => {
    const registryModels = [{ label: 'Custom Model', value: 'custom-v1' }];
    const claudeResult = buildModelOptionsForProvider(
      'claude',
      [{ provider: 'claude', models: ['claude-sonnet-4-6'] }],
      registryModels,
    );
    const codexResult = buildModelOptionsForProvider(
      'codex',
      [{ provider: 'codex', models: ['gpt-5.5'] }],
      registryModels,
    );

    expect(claudeResult[0].value).toBe('custom-v1');
    expect(codexResult[0].value).toBe('custom-v1');
    expect(claudeResult.length).toBe(2); // 1 registry + "Other…"
    expect(codexResult.length).toBe(2);
  });

  it('does NOT leak payload models when registry has data', () => {
    const registryModels = [{ label: 'Registry Model', value: 'registry-v1' }];
    const result = buildModelOptionsForProvider(
      'codex',
      [{ provider: 'codex', models: ['gpt-5.5', 'o3'] }],
      registryModels,
    );

    expect(result.map((m) => m.value)).toEqual(['registry-v1', '__other__']);
  });

  it('always includes "Other…" in the model list (REQ-013)', () => {
    const withRegistry = buildModelOptionsForProvider('claude', [], [{ label: 'M', value: 'm' }]);
    expect(withRegistry.some((m) => m.value === '__other__')).toBe(true);

    const withoutRegistry = buildModelOptionsForProvider('claude', []);
    expect(withoutRegistry.some((m) => m.value === '__other__')).toBe(true);

    const codexResult = buildModelOptionsForProvider('codex', []);
    expect(codexResult.some((m) => m.value === '__other__')).toBe(true);
  });

  it('open-provider suggestions use server (registry-patched) suggestions only', () => {
    const suggestions = getOpenProviderModelSuggestions([
      { provider: 'deepseek', open: true, modelSuggestions: ['ds-from-registry'] },
      { provider: 'kimi', open: true, defaultModel: 'kimi-k2.5' },
      { provider: 'claude' },
    ]);

    expect(suggestions.deepseek).toEqual(['ds-from-registry']);
    expect(suggestions.kimi).toEqual(['kimi-k2.5']);
    expect(suggestions['claude']).toBeUndefined();
  });

  describe('currentModel preservation (ENG-1825 regression fix)', () => {
    it('appends currentModel as a human-labeled option when not in registry models', () => {
      const registryModels = [
        { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
      ];
      // Saved model is 'claude-opus-4-7' which is NOT in the active registry
      const result = buildModelOptionsForProvider('claude', [], registryModels, 'claude-opus-4-7');

      expect(result).toEqual([
        { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
        { label: 'Claude Opus 4 7', value: 'claude-opus-4-7' },
        { label: 'Other…', value: '__other__' },
      ]);
    });

    it('does NOT duplicate currentModel when it is already in registry models', () => {
      const registryModels = [
        { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
        { label: 'Claude Opus 4.7', value: 'claude-opus-4-7' },
      ];
      const result = buildModelOptionsForProvider('claude', [], registryModels, 'claude-opus-4-7');

      expect(result).toEqual([
        { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
        { label: 'Claude Opus 4.7', value: 'claude-opus-4-7' },
        { label: 'Other…', value: '__other__' },
      ]);
    });

    it('appends currentModel as a human-labeled option when not in provider payload', () => {
      const result = buildModelOptionsForProvider(
        'claude',
        [{ provider: 'claude', models: ['claude-sonnet-4-6'] }],
        [],
        'claude-opus-4-7',
      );

      expect(result).toEqual([
        { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
        { label: 'Claude Opus 4 7', value: 'claude-opus-4-7' },
        { label: 'Other…', value: '__other__' },
      ]);
    });

    it('does not add currentModel when it is undefined', () => {
      const registryModels = [
        { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
      ];
      const result = buildModelOptionsForProvider('claude', [], registryModels);

      expect(result).toEqual([
        { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
        { label: 'Other…', value: '__other__' },
      ]);
    });

    it('appends currentModel when neither registry nor payload has any models', () => {
      const result = buildModelOptionsForProvider('claude', [], [], 'my-custom-model');

      expect(result).toEqual([
        { label: 'My Custom Model', value: 'my-custom-model' },
        { label: 'Other…', value: '__other__' },
      ]);
    });

    it('skips appending currentModel when the value is blank (defensive)', () => {
      const registryModels = [
        { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
      ];
      const result = buildModelOptionsForProvider('claude', [], registryModels, '');

      expect(result).toEqual([
        { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
        { label: 'Other…', value: '__other__' },
      ]);
    });
  });

  describe('blank/whitespace registry label fallback', () => {
    it('falls back to humanLabel(fullId) when a registry model has blank label', () => {
      const registryModels = [
        { label: '', value: 'claude-opus-4-7' },
      ];
      const result = buildModelOptionsForProvider('claude', [], registryModels);

      expect(result).toEqual([
        { label: 'Claude Opus 4 7', value: 'claude-opus-4-7' },
        { label: 'Other…', value: '__other__' },
      ]);
    });

    it('falls back to humanLabel(fullId) when a registry model has whitespace-only label', () => {
      const registryModels = [
        { label: '   ', value: 'gpt-5.2-codex' },
      ];
      const result = buildModelOptionsForProvider('codex', [], registryModels);

      expect(result).toEqual([
        { label: 'Gpt 5.2 Codex', value: 'gpt-5.2-codex' },
        { label: 'Other…', value: '__other__' },
      ]);
    });
  });
});
