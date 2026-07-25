import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ProviderIcon, { normalizeProviderIconId, providerIconColor } from './ProviderIcon';
import { BRAND_MARKS, getBrandMark } from './brandMarks';

describe('ProviderIcon', () => {
  it.each([
    ['openai', 'openai'],
    ['chatgpt', 'openai'],
    ['codex', 'openai'],
    ['anthropic', 'claude'],
    ['claude', 'claude'],
    ['claude-cli', 'claude'],
    ['deepseek', 'deepseek'],
    ['xiaomi-mimo', 'xiaomi-mimo'],
    ['kimi', 'kimi'],
    ['zai', 'zai'],
  ])('renders the canonical icon for %s', (provider, expected) => {
    const { container } = render(<ProviderIcon provider={provider} />);
    expect(container.querySelector('svg')).toHaveAttribute('data-provider-icon', expected);
  });

  it('uses a stable fallback for unknown providers', () => {
    const { container } = render(<ProviderIcon provider="custom-provider" />);
    expect(container.querySelector('svg')).toHaveAttribute('data-provider-icon', 'custom-provider');
    expect(normalizeProviderIconId()).toBe('unknown');
    expect(providerIconColor('custom-provider')).toBe('text-theme-muted');
  });

  // Every provider in the model registry that has an authentic mark must render
  // it, not the generic sparkle fallback. 'zai' (GLM/Z.AI) regressed to a
  // sparkle before the brand-mark registry existed.
  it.each(['claude', 'zai', 'deepseek', 'kimi', 'xiaomi-mimo'])(
    'renders a real brand mark for %s',
    (provider) => {
      const { container } = render(<ProviderIcon provider={provider} />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('data-brand-mark');
      expect(svg?.querySelector('path')?.getAttribute('d')).toBeTruthy();
    },
  );

  it('gives every provider a distinct mark', () => {
    const paths = ['claude', 'zai', 'deepseek', 'kimi', 'xiaomi-mimo'].map(
      (p) => getBrandMark(p)?.path,
    );
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('brandMarks', () => {
  it('carries a non-empty path and brand hex for every entry', () => {
    for (const [id, mark] of Object.entries(BRAND_MARKS)) {
      expect(mark.id, `${id} id mismatch`).toBe(id);
      expect(mark.path.length, `${id} has no path data`).toBeGreaterThan(0);
      expect(mark.hex, `${id} has a malformed hex`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(mark.slug.length, `${id} has no provenance slug`).toBeGreaterThan(0);
    }
  });

  it('does not reuse one mark for two different brands', () => {
    const paths = Object.values(BRAND_MARKS).map((m) => m.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('normalises lookups and misses cleanly', () => {
    expect(getBrandMark('LINEAR')?.title).toBe('Linear');
    expect(getBrandMark('  linear  ')?.title).toBe('Linear');
    expect(getBrandMark('slack')).toBeUndefined();
    expect(getBrandMark(null)).toBeUndefined();
  });
});
