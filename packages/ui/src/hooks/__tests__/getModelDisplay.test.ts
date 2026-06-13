/**
 * Tests for getModelDisplay() — the shared cross-surface label resolver
 * introduced in PR #115 (ENG-1825).
 *
 * Covers AC-001 (string-identical labels), AC-002 (no raw fullId / legacy
 * alias rendering, no prefix-stripping), AC-003 (editing displayName reflects
 * after reload via updateRegistrySnapshot).
 */

import { describe, it, expect } from 'vitest';
import {
  getModelDisplay,
  updateRegistrySnapshot,
  registryDefaultModelForProvider,
} from '../useModelRegistry';

// ── Helpers ────────────────────────────────────────────────────────────────

function resetSnapshot(): void {
  updateRegistrySnapshot([]);
}

/** Latest-style registry entry with no alias field. */
function entry(opts: {
  provider: string;
  fullId: string;
  displayName: string;
  providerDisplayName: string;
  isActive?: boolean;
  tier?: string;
  sortOrder?: number;
}) {
  return {
    _id: `id-${opts.fullId}`,
    provider: opts.provider,
    fullId: opts.fullId,
    displayName: opts.displayName,
    providerDisplayName: opts.providerDisplayName,
    isActive: opts.isActive ?? true,
    tier: opts.tier ?? 'default',
    sortOrder: opts.sortOrder ?? 1,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getModelDisplay — AC-001 (cross-surface consistency)', () => {
  beforeEach(() => resetSnapshot());

  // ── registry resolution ──

  it('returns providerDisplayName and displayName from registry snapshot', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
      }),
    ]);
    const result = getModelDisplay('claude', 'claude-sonnet-4-6');
    expect(result).toEqual({
      providerLabel: 'Claude',
      modelLabel: 'Claude Sonnet 4.6',
    });
  });

  it('uses providerDisplayName matching the entry provider (not the first entry)', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        providerDisplayName: 'Codex',
      }),
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
      }),
    ]);
    const result = getModelDisplay('claude', 'claude-sonnet-4-6');
    expect(result).toEqual({
      providerLabel: 'Claude',
      modelLabel: 'Claude Sonnet 4.6',
    });
  });

  it('resolves provider label even when model is undefined', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        providerDisplayName: 'Codex',
      }),
    ]);
    const result = getModelDisplay('codex');
    expect(result.providerLabel).toBe('Codex');
    expect(result.modelLabel).toBe('');
  });

  // ── Legacy alias fallback chain (AC-001 / AC-002) ──

  it('resolves model label via legacy alias when model value is a short alias', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
      }),
    ]);
    // User data stored old-style alias "sonnet" — should resolve to fullId → displayName
    const result = getModelDisplay('claude', 'sonnet');
    expect(result.modelLabel).toBe('Claude Sonnet 4.6');
  });

  it('resolves opus alias to displayName', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-opus-4-7',
        displayName: 'Claude Opus 4.7',
        providerDisplayName: 'Claude',
      }),
    ]);
    expect(getModelDisplay('claude', 'opus').modelLabel).toBe('Claude Opus 4.7');
  });

  it('resolves fable alias to displayName', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-fable-5',
        displayName: 'Claude Fable 5',
        providerDisplayName: 'Claude',
      }),
    ]);
    expect(getModelDisplay('claude', 'fable').modelLabel).toBe('Claude Fable 5');
  });

  it('resolves haiku alias to displayName', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        providerDisplayName: 'Claude',
      }),
    ]);
    expect(getModelDisplay('claude', 'haiku').modelLabel).toBe('Claude Haiku 4.5');
  });

  it('humanizes the raw id when the registry has no entry — no static label maps (REQ-005)', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        providerDisplayName: 'Codex',
      }),
    ]);
    const result = getModelDisplay('claude', 'claude-sonnet-4-6');
    expect(result).toEqual({
      providerLabel: 'Claude',
      modelLabel: 'Claude Sonnet 4 6',
    });
  });

  it('resolves the legacy provider id claude-cli against the renamed registry entries', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
      }),
    ]);
    // Historical executions keep provider 'claude-cli' — display must still resolve.
    expect(getModelDisplay('claude-cli', 'claude-sonnet-4-6')).toEqual({
      providerLabel: 'Claude',
      modelLabel: 'Claude Sonnet 4.6',
    });
  });

  it('falls back to humanLabel() for an unknown model id', () => {
    updateRegistrySnapshot([]);
    const result = getModelDisplay('deepseek', 'my-custom-model-v3');
    expect(result.modelLabel).toBe('My Custom Model V3');
  });

  it('falls back to humanLabel() for unknown provider id', () => {
    updateRegistrySnapshot([]);
    const result = getModelDisplay('some-unknown-provider', 'test-model');
    expect(result.providerLabel).toBe('Some Unknown Provider');
  });

  // ── Bracket annotation normalisation: [1m] → [1M] ──

  it('normalises [1m] bracket annotation to [1M] in humanLabel fallback (AC-001)', () => {
    updateRegistrySnapshot([]);
    const result = getModelDisplay('deepseek', 'deepseek-v4-pro[1m]');
    expect(result.modelLabel).toBe('Deepseek V4 Pro[1M]');
    // Must not preserve lowercase m inside brackets
    expect(result.modelLabel).not.toContain('[1m]');
  });

  it('returns registry displayName with [1M] for deepseek-v4-pro[1m] (AC-001)', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'deepseek',
        fullId: 'deepseek-v4-pro[1m]',
        displayName: 'DeepSeek V4 Pro [1M]',
        providerDisplayName: 'DeepSeek',
      }),
    ]);
    const result = getModelDisplay('deepseek', 'deepseek-v4-pro[1m]');
    expect(result.modelLabel).toBe('DeepSeek V4 Pro [1M]');
  });

  // ── AC-002: No raw fullId / no alias / no prefix stripping ──

  it('never returns a raw fullId when displayName exists (AC-002)', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
      }),
    ]);
    const result = getModelDisplay('claude', 'claude-sonnet-4-6');
    // Must NOT equal the raw fullId
    expect(result.modelLabel).not.toBe('claude-sonnet-4-6');
    // Must NOT be a stripped version of fullId (the old replace(/^claude-/, '') hack)
    expect(result.modelLabel).not.toBe('Sonnet 4.6');
    expect(result.modelLabel).not.toBe('sonnet-4-6');
  });

  it('never returns a stripped prefix for any provider model (AC-002)', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        providerDisplayName: 'Codex',
      }),
    ]);
    const result = getModelDisplay('codex', 'gpt-5.5');
    expect(result.modelLabel).toBe('GPT-5.5');
    // No raw fullId
    expect(result.modelLabel).not.toBe('gpt-5.5');
  });

  it('does NOT expose legacy alias as modelLabel (AC-002)', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
      }),
    ]);
    const result = getModelDisplay('claude', 'claude-sonnet-4-6');
    expect(result.modelLabel).not.toBe('sonnet');
    expect(result.modelLabel).not.toBe('Sonnet');
  });

  it('provider label uses providerDisplayName, never raw provider id (AC-002)', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
      }),
    ]);
    const result = getModelDisplay('claude', 'claude-sonnet-4-6');
    expect(result.providerLabel).not.toBe('claude');
    expect(result.providerLabel).toBe('Claude');
  });

  // ── Blank / whitespace displayName guards (ENG-1825 follow-up) ──

  it('falls back to humanLabel when registry entry has blank displayName', () => {
    updateRegistrySnapshot([
      { _id: 'b1', provider: 'codex', fullId: 'gpt-5.2-codex', displayName: '', providerDisplayName: 'Codex', isActive: true, tier: 'default', sortOrder: 1 },
    ]);
    const result = getModelDisplay('codex', 'gpt-5.2-codex');
    expect(result.modelLabel).toBe('Gpt 5.2 Codex');
  });

  it('falls back to humanLabel when registry entry has whitespace-only displayName', () => {
    updateRegistrySnapshot([
      { _id: 'b2', provider: 'codex', fullId: 'gpt-5.2-codex', displayName: '   ', providerDisplayName: 'Codex', isActive: true, tier: 'default', sortOrder: 1 },
    ]);
    const result = getModelDisplay('codex', 'gpt-5.2-codex');
    expect(result.modelLabel).toBe('Gpt 5.2 Codex');
  });

  it('falls back to humanLabel for provider when providerDisplayName is blank', () => {
    updateRegistrySnapshot([
      { _id: 'b3', provider: 'codex', fullId: 'gpt-5.5', displayName: 'GPT-5.5', providerDisplayName: '', isActive: true, tier: 'default', sortOrder: 1 },
    ]);
    const result = getModelDisplay('codex', 'gpt-5.5');
    expect(result.providerLabel).toBe('Codex');
    expect(result.modelLabel).toBe('GPT-5.5'); // model label still valid
  });

  it('falls back to humanLabel for provider when providerDisplayName is whitespace', () => {
    updateRegistrySnapshot([
      { _id: 'b4', provider: 'codex', fullId: 'gpt-5.5', displayName: 'GPT-5.5', providerDisplayName: '   ', isActive: true, tier: 'default', sortOrder: 1 },
    ]);
    const result = getModelDisplay('codex', 'gpt-5.5');
    expect(result.providerLabel).toBe('Codex');
  });

  it('falls back to humanLabel via legacy alias when registry entry has blank displayName', () => {
    updateRegistrySnapshot([
      { _id: 'b5', provider: 'claude', fullId: 'claude-opus-4-7', displayName: '', providerDisplayName: 'Claude', isActive: true, tier: 'default', sortOrder: 1 },
    ]);
    // "opus" is a legacy alias for claude-opus-4-7
    const result = getModelDisplay('claude', 'opus');
    expect(result.modelLabel).toBe('Claude Opus 4 7');
  });
});

// ── AC-003: Editing displayName reflects after reload ──

describe('getModelDisplay — AC-003 (edit → reload consistency)', () => {
  beforeEach(() => resetSnapshot());

  it('reflects updated displayName after updateRegistrySnapshot is called', () => {
    // Initial load: registry has old name
    updateRegistrySnapshot([
      entry({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        providerDisplayName: 'Codex',
      }),
    ]);
    expect(getModelDisplay('codex', 'gpt-5.5').modelLabel).toBe('GPT-5.5');

    // Admin edits displayName → refetch → updateRegistrySnapshot called with new data
    updateRegistrySnapshot([
      entry({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5 Turbo',
        providerDisplayName: 'Codex',
      }),
    ]);
    expect(getModelDisplay('codex', 'gpt-5.5').modelLabel).toBe('GPT-5.5 Turbo');
  });

  it('reflects updated providerDisplayName after registry snapshot update', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'deepseek',
        fullId: 'deepseek-v4-pro[1m]',
        displayName: 'DeepSeek V4 Pro [1M]',
        providerDisplayName: 'DeepSeek',
      }),
    ]);
    expect(getModelDisplay('deepseek', 'deepseek-v4-pro[1m]').providerLabel).toBe('DeepSeek');

    // Admin edits providerDisplayName
    updateRegistrySnapshot([
      entry({
        provider: 'deepseek',
        fullId: 'deepseek-v4-pro[1m]',
        displayName: 'DeepSeek V4 Pro [1M]',
        providerDisplayName: 'DeepSeek (Official)',
      }),
    ]);
    expect(getModelDisplay('deepseek', 'deepseek-v4-pro[1m]').providerLabel).toBe('DeepSeek (Official)');
  });

  it('regression: multiple providers in snapshot do not interfere', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
      }),
      entry({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        providerDisplayName: 'Codex',
      }),
    ]);
    expect(getModelDisplay('claude', 'claude-sonnet-4-6')).toEqual({
      providerLabel: 'Claude',
      modelLabel: 'Claude Sonnet 4.6',
    });
    expect(getModelDisplay('codex', 'gpt-5.5')).toEqual({
      providerLabel: 'Codex',
      modelLabel: 'GPT-5.5',
    });
  });
});

// ── registryDefaultModelForProvider ──

describe('registryDefaultModelForProvider', () => {
  beforeEach(() => resetSnapshot());

  it('returns fullId of the tier=default entry for a provider', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'claude',
        fullId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        providerDisplayName: 'Claude',
        sortOrder: 1,
        tier: 'default',
      }),
      entry({
        provider: 'claude',
        fullId: 'claude-opus-4-7',
        displayName: 'Claude Opus 4.7',
        providerDisplayName: 'Claude',
        sortOrder: 2,
        tier: 'opus',
      }),
    ]);
    expect(registryDefaultModelForProvider('claude')).toBe('claude-sonnet-4-6');
  });

  it('returns empty string when the registry has no entry for the provider — no static default (REQ-005)', () => {
    updateRegistrySnapshot([
      entry({
        provider: 'codex',
        fullId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        providerDisplayName: 'Codex',
        tier: 'default',
      }),
    ]);
    expect(registryDefaultModelForProvider('codex')).toBe('gpt-5.5');
    expect(registryDefaultModelForProvider('deepseek')).toBe('');
  });

  it('returns empty string when neither registry nor fallbacks have the provider (edge)', () => {
    updateRegistrySnapshot([]);
    expect(registryDefaultModelForProvider('nonexistent-provider')).toBe('');
  });
});
