import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { resourceScopeKey, useDocumentTabStore } from '../../stores/documentTabStore';
import DocumentTabHost from './DocumentTabHost';

vi.mock('./ArtifactViewer', () => ({
  default: () => <div>Document content</div>,
}));

vi.mock('../common/DirectMonacoEditor', () => ({
  default: ({ value, language }: { value: string; language: string }) => (
    <pre data-testid="direct-file-viewer" data-language={language}>{value}</pre>
  ),
}));

const artifact = {
  artifactId: 'artifact-1',
  rootType: 'chat' as const,
  rootId: 'chat-1',
  spawnContext: { originType: 'chat' as const },
  filename: 'plan.md',
  relativePath: 'plan.md',
  contentType: 'markdown' as const,
  sizeBytes: 12,
  createdAt: '2026-07-21T00:00:00.000Z',
};

describe('DocumentTabHost tab creation', () => {
  const scopeKey = resourceScopeKey('chat', 'chat-1');

  beforeEach(() => {
    useDocumentTabStore.getState().closeAllDocuments();
    useDocumentTabStore.getState().closeAllFiles();
    useDocumentTabStore.getState().setActiveScope(scopeKey);
    useDocumentTabStore.getState().openDocument(artifact, { scopeKey, sourceLabel: 'Chat' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the add-tab menu visible on a workspace document and creates a terminal tab', () => {
    const onCreate = vi.fn();
    window.addEventListener('allen:workspace-tab-create', onCreate);

    render(
      <MemoryRouter>
        <DocumentTabHost workspaceId="workspace-1" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    expect(screen.getByRole('menuitem', { name: 'New chat' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Code diff' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'File explorer' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect((onCreate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      kind: 'terminal',
      workspaceId: 'workspace-1',
    });
    expect(useDocumentTabStore.getState().activeArtifactId).toBeNull();

    window.removeEventListener('allen:workspace-tab-create', onCreate);
  });

  it.each([
    ['Code diff', 'code-diff'],
    ['File explorer', 'file-explorer'],
  ])('routes %s from the resource tab menu back to the workspace', (menuItem, kind) => {
    const onCreate = vi.fn();
    window.addEventListener('allen:workspace-tab-create', onCreate);

    render(
      <MemoryRouter>
        <DocumentTabHost workspaceId="workspace-1" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: menuItem }));

    expect((onCreate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      kind,
      workspaceId: 'workspace-1',
    });
    expect(useDocumentTabStore.getState().activeArtifactId).toBeNull();

    window.removeEventListener('allen:workspace-tab-create', onCreate);
  });

  it('notifies the chat surface when the last open resource is closed', () => {
    const onAllResourcesClosed = vi.fn();

    render(
      <MemoryRouter>
        <DocumentTabHost onAllResourcesClosed={onAllResourcesClosed} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));

    expect(onAllResourcesClosed).toHaveBeenCalledOnce();
    expect(useDocumentTabStore.getState().activeArtifactId).toBeNull();
    expect(screen.queryByRole('region', { name: /Open resource:/ })).not.toBeInTheDocument();
  });

  it('opens resources as sibling chat tabs even without a workspace', () => {
    const onCreateTab = vi.fn();

    render(
      <MemoryRouter>
        <DocumentTabHost onCreateTab={onCreateTab} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Code diff' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'File explorer' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'File explorer' }));

    expect(onCreateTab).toHaveBeenCalledWith('file-explorer');
    expect(useDocumentTabStore.getState().activeArtifactId).toBeNull();
  });

  it('renders workspace files with the bundled editor instead of the CDN-backed loader', () => {
    useDocumentTabStore.getState().openFile({
      path: 'docs/concepts/workflows.md',
      content: '# Workflows\nVisible immediately.',
      sourceKind: 'workspace',
      sourceId: 'workspace-1',
      sourceLabel: 'UI workspace',
      scopeKey,
    });

    render(
      <MemoryRouter>
        <DocumentTabHost workspaceId="workspace-1" showTabStrip={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Chat and open resources')).not.toBeInTheDocument();
    expect(screen.getByTestId('direct-file-viewer')).toHaveAttribute('data-language', 'markdown');
    expect(screen.getByTestId('direct-file-viewer')).toHaveTextContent('Visible immediately.');
  });
});
