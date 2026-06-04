/**
 * Unit tests for TokenUsageDisplay component.
 *
 * @testing-library/react is not in the project's devDependencies; React
 * components are rendered via React 18's createRoot + act from react-dom.
 *
 * Covers:
 *   - Returns null (renders nothing) when tokenUsage is null
 *   - Returns null (renders nothing) when tokenUsage is undefined
 *   - Returns null when all sub-fields are null
 *   - Renders em-dash for null sub-fields, compact K/M number for present ones
 *   - Never renders "0" for a null sub-field
 *   - Renders compact K/M numbers with up to one decimal
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import TokenUsageDisplay from './TokenUsageDisplay';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    const root = (container as any).__root;
    if (root) root.unmount();
  });
  document.body.removeChild(container);
});

function renderIntoContainer(ui: React.ReactElement): HTMLElement {
  act(() => {
    const root = createRoot(container);
    (container as any).__root = root;
    root.render(ui);
  });
  return container;
}

describe('TokenUsageDisplay', () => {
  it('renders nothing when tokenUsage is null', () => {
    renderIntoContainer(<TokenUsageDisplay tokenUsage={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when tokenUsage is undefined', () => {
    renderIntoContainer(<TokenUsageDisplay tokenUsage={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when all sub-fields are null', () => {
    renderIntoContainer(
      <TokenUsageDisplay
        tokenUsage={{ inputCachedTokens: null, inputNonCachedTokens: null, outputTokens: null }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders em-dash for null sub-fields, compact number for present ones', () => {
    renderIntoContainer(
      <TokenUsageDisplay
        tokenUsage={{ inputCachedTokens: null, inputNonCachedTokens: 5000, outputTokens: 2000 }}
      />,
    );
    const text = container.textContent ?? '';
    // Should NOT render '0' for the null cached field
    expect(text).not.toMatch(/\b0\b/);
    // Should contain em-dash for the null cached sub-field
    expect(text).toContain('—');
    // Should contain compact numbers for the non-null fields
    expect(text).toContain('5K');
    expect(text).toContain('2K');
  });

  it('renders compact K/M numbers with up to one decimal', () => {
    renderIntoContainer(
      <TokenUsageDisplay
        tokenUsage={{ inputCachedTokens: 640211, inputNonCachedTokens: 136368, outputTokens: 1234567 }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('640.2K');
    expect(text).toContain('136.4K');
    expect(text).toContain('1.2M');
  });

  it('does not render the old icon/text label prefix', () => {
    renderIntoContainer(
      <TokenUsageDisplay
        tokenUsage={{ inputCachedTokens: 1000, inputNonCachedTokens: 2000, outputTokens: 500 }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('Tokens:');
  });

  it('renders "(included in parent)" label when inheritedBy is set', () => {
    renderIntoContainer(
      <TokenUsageDisplay
        tokenUsage={{ inputCachedTokens: 100, inputNonCachedTokens: 200, outputTokens: 50 }}
        inheritedBy={{ kind: 'parent-execution', parentExecutionId: 'exec-123' }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('included in parent');
  });

  it('does not render "(included in parent)" when inheritedBy is absent', () => {
    renderIntoContainer(
      <TokenUsageDisplay
        tokenUsage={{ inputCachedTokens: 100, inputNonCachedTokens: 200, outputTokens: 50 }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('included in parent');
  });
});
