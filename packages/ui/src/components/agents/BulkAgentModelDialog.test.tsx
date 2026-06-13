import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bulkUpdateModel: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  agents: {
    bulkUpdateModel: mocks.bulkUpdateModel,
  },
  system: {
    models: {
      list: async () => ({
        models: [
          { _id: '1', provider: 'claude', fullId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', providerDisplayName: 'Claude', isActive: true, tier: 'default', sortOrder: 1 },
          { _id: '2', provider: 'codex', fullId: 'gpt-5.5', displayName: 'GPT-5.5', providerDisplayName: 'Codex', isActive: true, tier: 'default', sortOrder: 1 },
          { _id: '3', provider: 'deepseek', fullId: 'deepseek-chat', displayName: 'DeepSeek Chat', providerDisplayName: 'DeepSeek', isActive: true, tier: 'default', sortOrder: 1 },
        ],
      }),
    },
  },
}));

vi.mock('../../hooks/useEnabledProviders', () => ({
  isProviderSelectable: (p: { authStatus?: string }) => p.authStatus === undefined || p.authStatus === 'logged_in',
  useEnabledProvidersStatus: () => ({
    loaded: true,
    providers: [
      {
        provider: 'claude',
        label: 'Claude',
        models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
        defaultModel: 'claude-sonnet-4-6',
        authStatus: 'logged_in',
      },
      {
        provider: 'codex',
        label: 'Codex',
        models: ['gpt-5.5', 'gpt-5.4'],
        defaultModel: 'gpt-5.5',
        authStatus: 'logged_in',
      },
      {
        provider: 'deepseek',
        label: 'DeepSeek',
        models: [],
        defaultModel: 'deepseek-chat',
        modelSuggestions: ['deepseek-chat', 'deepseek-reasoner'],
        open: true,
      },
    ],
  }),
}));

vi.mock('../common/Toast', () => ({
  useToast: () => ({
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import BulkAgentModelDialog from './BulkAgentModelDialog';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.bulkUpdateModel.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

async function renderDialog(props?: Partial<React.ComponentProps<typeof BulkAgentModelDialog>>) {
  // Async act so the registry fetch inside useModelRegistry resolves and the
  // default-model backfill effect runs before the test interacts.
  await act(async () => {
    root.render(
      <BulkAgentModelDialog
        open
        agentNames={['agent-a', 'agent-b', 'agent-c']}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
        {...props}
      />,
    );
  });
}

async function clickByText(text: string) {
  const button = Array.from(document.querySelectorAll('button'))
    .find((item) => item.textContent?.includes(text));
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('BulkAgentModelDialog', () => {
  it('renders selected count, selected names, and clear warning checkbox defaulted off', async () => {
    await renderDialog();

    expect(container.textContent).toContain('3 selected');
    expect(container.textContent).toContain('agent-a');
    expect(container.textContent).toContain('agent-b');
    expect(container.textContent).toContain('Clear incompatible settings when needed');
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox?.checked).toBe(false);
  });

  it('submits claude selections with the canonical provider id and reports updated/skipped counts', async () => {
    const onUpdated = vi.fn();
    const onClose = vi.fn();
    mocks.bulkUpdateModel.mockResolvedValue({
      updated: ['agent-a', 'agent-b'],
      skipped: [{ name: 'agent-c', reason: 'incompatible-settings' }],
    });
    await renderDialog({ onUpdated, onClose });

    await clickByText('Update');

    expect(mocks.bulkUpdateModel).toHaveBeenCalledWith({
      agentNames: ['agent-a', 'agent-b', 'agent-c'],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      clearIncompatibleSettings: false,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Updated 2 agents, skipped 1.');
    expect(onUpdated).toHaveBeenCalledWith({
      updated: ['agent-a', 'agent-b'],
      skipped: [{ name: 'agent-c', reason: 'incompatible-settings' }],
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('resets to an open provider suggestion and submits the clear flag when checked', async () => {
    mocks.bulkUpdateModel.mockResolvedValue({ updated: ['agent-a'], skipped: [] });
    await renderDialog();

    await clickByText('Claude');
    await clickByText('DeepSeek');
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await clickByText('Update');

    expect(mocks.bulkUpdateModel).toHaveBeenCalledWith({
      agentNames: ['agent-a', 'agent-b', 'agent-c'],
      provider: 'deepseek',
      model: 'deepseek-chat',
      clearIncompatibleSettings: true,
    });
  });

  it('preserves input and selection while showing inline errors on failure', async () => {
    mocks.bulkUpdateModel.mockRejectedValue(new Error('bulk update failed'));
    await renderDialog();

    await clickByText('Claude');
    await clickByText('Codex');
    await clickByText('Update');

    expect(container.textContent).toContain('bulk update failed');
    expect(container.textContent).toContain('agent-a');
    expect(container.textContent).toContain('Codex');
    expect(container.textContent).toContain('GPT-5.5');
  });
});
