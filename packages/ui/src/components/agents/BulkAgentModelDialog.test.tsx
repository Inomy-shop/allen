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
}));

vi.mock('../../hooks/useEnabledProviders', () => ({
  useEnabledProvidersStatus: () => ({
    loaded: true,
    providers: [
      {
        provider: 'claude-cli',
        label: 'Claude (CLI)',
        models: ['fable', 'sonnet', 'opus', 'haiku'],
        defaultModel: 'sonnet',
      },
      {
        provider: 'codex',
        label: 'Codex (CLI)',
        models: ['gpt-5.5', 'gpt-5.4'],
        defaultModel: 'gpt-5.5',
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

function renderDialog(props?: Partial<React.ComponentProps<typeof BulkAgentModelDialog>>) {
  act(() => {
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
  it('renders selected count, selected names, and clear warning checkbox defaulted off', () => {
    renderDialog();

    expect(container.textContent).toContain('3 selected');
    expect(container.textContent).toContain('agent-a');
    expect(container.textContent).toContain('agent-b');
    expect(container.textContent).toContain('Clear incompatible settings when needed');
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox?.checked).toBe(false);
  });

  it('submits claude selections as claude-cli and reports updated/skipped counts', async () => {
    const onUpdated = vi.fn();
    const onClose = vi.fn();
    mocks.bulkUpdateModel.mockResolvedValue({
      updated: ['agent-a', 'agent-b'],
      skipped: [{ name: 'agent-c', reason: 'incompatible-settings' }],
    });
    renderDialog({ onUpdated, onClose });

    await clickByText('Update');

    expect(mocks.bulkUpdateModel).toHaveBeenCalledWith({
      agentNames: ['agent-a', 'agent-b', 'agent-c'],
      provider: 'claude-cli',
      model: 'sonnet',
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
    renderDialog();

    await clickByText('claude');
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
    renderDialog();

    await clickByText('claude');
    await clickByText('codex');
    await clickByText('Update');

    expect(container.textContent).toContain('bulk update failed');
    expect(container.textContent).toContain('agent-a');
    expect(container.textContent).toContain('codex');
    expect(container.textContent).toContain('gpt-5.5');
  });
});
