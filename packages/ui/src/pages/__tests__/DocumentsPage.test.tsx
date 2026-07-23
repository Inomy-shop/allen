import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentsPage from '../DocumentsPlaceholderPage';
import { useDocumentTabStore } from '../../stores/documentTabStore';

vi.mock('../../services/api', () => ({
  artifacts: {
    list: vi.fn(),
    updateLibraryState: vi.fn(),
    updateClassification: vi.fn(),
    contentUrl: (id: string) => `/api/artifacts/${id}/content`,
  },
}));

const { artifacts } = await import('../../services/api');

describe('DocumentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDocumentTabStore.getState().closeAllDocuments();
  });

  it('groups real artifacts and filters them by space', async () => {
    vi.mocked(artifacts.list).mockResolvedValue([
      {
        artifactId: 'a1', rootType: 'chat', rootId: 's1', spawnContext: { originType: 'chat' },
        filename: 'launch-plan.md', relativePath: 'launch-plan.md', contentType: 'markdown', sizeBytes: 42,
        description: 'Launch campaign', teamClassification: 'marketing', createdAt: new Date().toISOString(), createdByAgent: 'content-writer', saved: true,
      },
      {
        artifactId: 'a2', rootType: 'chat', rootId: 's2', spawnContext: { originType: 'chat' },
        filename: 'api-notes.md', relativePath: 'api-notes.md', contentType: 'markdown', sizeBytes: 42,
        description: 'Backend notes', teamClassification: 'engineering', createdAt: new Date().toISOString(), createdByAgent: 'backend-developer', saved: true,
      },
    ] as any);

    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('launch plan')).toBeInTheDocument());
    expect(screen.getByText('api notes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Marketing 1/i }));
    expect(screen.getByText('launch plan')).toBeInTheDocument();
    expect(screen.queryByText('api notes')).not.toBeInTheDocument();
  });

  it('opens the prototype-matched new-document form', async () => {
    vi.mocked(artifacts.list).mockResolvedValue([]);
    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('No saved documents yet')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'New document' })[0]);
    expect(screen.getByRole('dialog', { name: 'New document' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
  });

  it('opens every document as a first-class document tab', async () => {
    vi.mocked(artifacts.list).mockResolvedValue([{
      artifactId: 'a1', rootType: 'workflow', rootId: 'run-1', spawnContext: { originType: 'workflow' },
      filename: 'document-management.md', relativePath: 'document-management.md', contentType: 'markdown', sizeBytes: 42,
      description: 'Document management', createdAt: new Date().toISOString(), createdByAgent: 'docs-writer', saved: true,
    }] as any);

    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /document management/i }));
    expect(useDocumentTabStore.getState().activeArtifactId).toBe('a1');
    expect(useDocumentTabStore.getState().tabs[0]).toMatchObject({
      sourceLabel: 'Documents',
      artifact: { filename: 'document-management.md' },
    });
  });

  it('shows only explicitly saved documents and does not favorite them by default', async () => {
    vi.mocked(artifacts.list).mockResolvedValue([
      {
        artifactId: 'saved', rootType: 'chat', rootId: 's1', spawnContext: { originType: 'chat' },
        filename: 'saved-note.md', relativePath: 'saved-note.md', contentType: 'markdown', sizeBytes: 42,
        createdAt: new Date().toISOString(), saved: true, favorite: false,
      },
      {
        artifactId: 'unsaved', rootType: 'chat', rootId: 's1', spawnContext: { originType: 'chat' },
        filename: 'session-output.md', relativePath: 'session-output.md', contentType: 'markdown', sizeBytes: 42,
        createdAt: new Date().toISOString(), saved: false, favorite: false,
      },
    ] as any);

    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    expect(await screen.findByText('saved note')).toBeInTheDocument();
    expect(screen.queryByText('session output')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add saved-note.md to favorites' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('updates favorite state without changing saved state', async () => {
    vi.mocked(artifacts.list).mockResolvedValue([{
      artifactId: 'saved', rootType: 'chat', rootId: 's1', spawnContext: { originType: 'chat' },
      filename: 'saved-note.md', relativePath: 'saved-note.md', contentType: 'markdown', sizeBytes: 42,
      createdAt: new Date().toISOString(), saved: true, favorite: false,
    }] as any);
    vi.mocked(artifacts.updateLibraryState).mockResolvedValue({
      artifactId: 'saved',
      saved: true,
      favorite: true,
    } as any);

    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add saved-note.md to favorites' }));
    await waitFor(() => expect(artifacts.updateLibraryState).toHaveBeenCalledWith('saved', { favorite: true }));
    expect(screen.getByRole('button', { name: 'Remove saved-note.md from favorites' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('updates a document classification as a manual override', async () => {
    vi.mocked(artifacts.list).mockResolvedValue([{
      artifactId: 'saved', rootType: 'chat', rootId: 's1', spawnContext: { originType: 'chat' },
      filename: 'saved-note.md', relativePath: 'saved-note.md', contentType: 'markdown', sizeBytes: 42,
      createdAt: new Date().toISOString(), saved: true, teamClassification: null, teamClassificationSource: 'inherited',
    }] as any);
    vi.mocked(artifacts.updateClassification).mockResolvedValue({
      artifactId: 'saved',
      teamClassification: 'product',
      teamClassificationSource: 'manual',
      saved: true,
    } as any);

    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Team for saved-note.md' }), {
      target: { value: 'product' },
    });
    await waitFor(() => expect(artifacts.updateClassification).toHaveBeenCalledWith('saved', 'product'));
  });
});
