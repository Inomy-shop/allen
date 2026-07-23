import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ProviderIcon, { normalizeProviderIconId, providerIconColor } from './ProviderIcon';

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
});
