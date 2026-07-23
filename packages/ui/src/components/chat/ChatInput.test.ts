import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ChatInput, { modelOptionsForProvider } from './ChatInput';

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

describe('V8 Home composer presentation', () => {
  it('keeps the approved labels and provider-aware icon set visible', () => {
    const { container } = render(createElement(ChatInput, {
      onSend: vi.fn(),
      streaming: false,
      providers: [],
      repos: [],
      inheritedEffort: 'high',
      controlPresentation: 'v8-home',
    }));

    expect(screen.getByText('Opus 4.8')).toBeInTheDocument();
    expect(screen.getByText('· High')).toBeInTheDocument();
    expect(screen.getByText('allen-internal')).toBeInTheDocument();
    expect(screen.getByText('· auto')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach files' })).toHaveAttribute('title', 'Attach files');
    expect(screen.getByRole('button', { name: 'Start session' })).toHaveAttribute('title', 'Start session (⏎)');
    expect(container.querySelector('[data-provider-icon="claude"]')).toBeInTheDocument();
    expect(container.querySelector('[data-v8-icon="plan-shield"]')).toBeInTheDocument();
    expect(container.querySelector('[data-v8-icon="paperclip"]')).toBeInTheDocument();
    expect(container.querySelector('[data-v8-icon="arrow-up"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-v8-icon="chevron-down"]')).toHaveLength(2);
  });

  it('uses the compact textarea rhythm shared by the home and chat composers', () => {
    const { container, rerender } = render(createElement(ChatInput, {
      onSend: vi.fn(),
      streaming: false,
      controlPresentation: 'v8-home',
    }));

    expect(container.querySelector('textarea')).toHaveStyle({ minHeight: '50px' });

    rerender(createElement(ChatInput, {
      onSend: vi.fn(),
      streaming: false,
      controlPresentation: 'v8-chat',
    }));

    expect(container.querySelector('textarea')).toHaveStyle({ minHeight: '50px' });
  });

  it('shows all supported Codex effort levels in an evenly aligned grid', () => {
    render(createElement(ChatInput, {
      onSend: vi.fn(),
      streaming: false,
      controlPresentation: 'v8-home',
      selectedProvider: 'codex',
      selectedModel: 'gpt-5.6-sol',
      inheritedEffort: 'high',
      providers: [{
        provider: 'codex',
        label: 'Codex',
        models: ['gpt-5.6-sol'],
        defaultModel: 'gpt-5.6-sol',
      }],
    }));

    fireEvent.click(screen.getByTitle('Model & reasoning effort'));

    for (const label of ['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Ultra' })).toHaveClass('col-span-2');
  });
});
