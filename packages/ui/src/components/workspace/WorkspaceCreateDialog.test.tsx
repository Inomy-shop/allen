import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceCreateDialog, type WorkspaceCreateRepo } from './WorkspaceCreateDialog';

vi.mock('./SetupProgressDialog', () => ({
  SetupProgressDialog: () => <div />,
}));

let container: HTMLElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
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

function renderDialog(repo: WorkspaceCreateRepo) {
  act(() => {
    root.render(
      <WorkspaceCreateDialog
        repo={repo}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    );
  });
}

function baseBranchInput(): HTMLInputElement {
  const inputs = Array.from(container.querySelectorAll('input'));
  const input = inputs[2] as HTMLInputElement | undefined;
  if (!input) throw new Error('Base branch input not found');
  return input;
}

describe('WorkspaceCreateDialog', () => {
  it('defaults the base branch from repo detected metadata', () => {
    renderDialog({
      _id: 'repo-1',
      name: 'test-website',
      path: '/repos/test-website',
      detected: { defaultBranch: 'development' },
    });

    expect(baseBranchInput().value).toBe('development');
  });

  it('resyncs the base branch when a different repo is selected', () => {
    renderDialog({
      _id: 'repo-1',
      name: 'test-website',
      path: '/repos/test-website',
      detected: { defaultBranch: 'main' },
    });

    renderDialog({
      _id: 'repo-2',
      name: 'es-data-pipeline',
      path: '/repos/es-data-pipeline',
      detected: { defaultBranch: 'development' },
    });

    expect(baseBranchInput().value).toBe('development');
  });
});
