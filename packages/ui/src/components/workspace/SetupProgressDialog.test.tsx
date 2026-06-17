import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupProgressDialog } from './SetupProgressDialog';
import { workspaces } from '../../services/workspaceService';

vi.mock('../../services/workspaceService', () => ({
  workspaces: {
    get: vi.fn(async () => ({
      _id: 'workspace-1',
      name: 'feature/test',
      status: 'setting_up',
      setupProgress: {
        currentStep: 1,
        totalSteps: 2,
        currentCommand: 'npm install',
        log: [],
        status: 'running',
      },
    })),
    archive: vi.fn(async () => ({ archived: true })),
  },
}));

let container: HTMLElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
});

describe('SetupProgressDialog', () => {
  it('archives the pending workspace when the cancel close icon is clicked', async () => {
    const onCancel = vi.fn();

    await act(async () => {
      root.render(
        <SetupProgressDialog
          workspaceId="workspace-1"
          onComplete={() => undefined}
          onFailed={() => undefined}
          onCancel={onCancel}
        />,
      );
    });

    const cancelButton = container.querySelector('button[aria-label="Cancel workspace creation"]') as HTMLButtonElement | null;
    expect(cancelButton).toBeTruthy();

    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(workspaces.archive).toHaveBeenCalledWith('workspace-1');
    expect(onCancel).toHaveBeenCalledWith('workspace-1');
  });
});
