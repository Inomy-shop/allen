import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactDoc } from '../../services/api';
import type { DocumentCommentDoc, DocumentIdentitySummary } from '../../services/documents';
import ArtifactViewer from './ArtifactViewer';

const mocks = vi.hoisted(() => ({
  createComment: vi.fn(),
  getByArtifactId: vi.fn(),
  listComments: vi.fn(),
  resolveComment: vi.fn(),
  updateLibraryState: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  artifacts: {
    contentUrl: vi.fn(() => '/api/artifacts/artifact-1/content'),
    updateLibraryState: mocks.updateLibraryState,
  },
  documents: {
    createComment: mocks.createComment,
  },
}));

vi.mock('../../services/documents', () => ({
  documents: {
    getByArtifactId: mocks.getByArtifactId,
    listComments: mocks.listComments,
    resolveComment: mocks.resolveComment,
  },
}));

vi.mock('../chat/ChatMessageList', () => ({
  renderMarkdown: vi.fn((value: string) => value),
}));

const artifact: ArtifactDoc = {
  artifactId: 'artifact-1',
  rootType: 'chat',
  rootId: 'chat-1',
  spawnContext: { originType: 'system' },
  filename: 'review.md',
  relativePath: 'review.md',
  contentType: 'markdown',
  sizeBytes: 26,
  createdAt: '2026-07-21T00:00:00.000Z',
};

const identity: DocumentIdentitySummary = {
  documentId: 'document-1',
  sourceArtifactId: 'artifact-1',
  latestVersionNumber: 1,
  contentType: 'markdown',
  latestContent: 'Selected line for comment.',
  unresolvedCommentCount: 0,
  resolvedCommentCount: 0,
  staleCommentCount: 0,
};

const createdComment: DocumentCommentDoc = {
  commentId: 'comment-1',
  documentId: 'document-1',
  threadId: 'thread-1',
  authorType: 'human',
  body: 'Please clarify this line.',
  status: 'open',
  anchor: {
    type: 'line',
    lineStart: 1,
    lineEnd: 1,
    snippet: 'Selected line',
    context: 'Selected line for comment.',
    anchoredAtVersion: 1,
  },
  reopenCount: 0,
  createdAt: '2026-07-21T00:01:00.000Z',
  updatedAt: '2026-07-21T00:01:00.000Z',
};

describe('ArtifactViewer selected-text comments', () => {
  let storedComment: DocumentCommentDoc | null = null;

  beforeEach(() => {
    storedComment = null;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => identity.latestContent,
    }));
    mocks.getByArtifactId.mockResolvedValue(identity);
    mocks.listComments.mockImplementation(() => Promise.resolve(storedComment ? [storedComment] : []));
    mocks.createComment.mockImplementation(async () => {
      storedComment = createdComment;
      return createdComment;
    });
    mocks.resolveComment.mockImplementation(async () => {
      const resolved = {
        ...createdComment,
        status: 'resolved' as const,
        resolution: {
          resolvedAtVersion: 1,
          resolutionNote: 'Addressed in the current document version.',
          resolvedAt: '2026-07-21T00:02:00.000Z',
        },
      };
      storedComment = resolved;
      return resolved;
    });
    mocks.updateLibraryState.mockResolvedValue({ ...artifact, saved: true, favorite: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the composer mounted through mouse-up and displays the submitted comment', async () => {
    render(<ArtifactViewer artifact={artifact} presentation="tab" hideTabStrip />);

    // Workspace navigation belongs to ChatPage and must not be replaced by a
    // second document-specific icon rail when a document is active.
    expect(screen.queryByRole('complementary', { name: 'Document panels' })).not.toBeInTheDocument();

    const selectedLine = await screen.findByText(identity.latestContent);
    const textNode = selectedLine.firstChild ?? selectedLine;
    const range = {
      startContainer: textNode,
      endContainer: textNode,
      startOffset: 0,
      endOffset: 'Selected line'.length,
    } as unknown as Range;
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => 'Selected line',
    } as unknown as Selection;
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue(selection);

    fireEvent.mouseUp(selectedLine);
    const input = await screen.findByPlaceholderText('Comment…');
    fireEvent.change(input, { target: { value: createdComment.body } });

    // A button mouse-up collapses the browser text selection before click.
    // The document selection handler must not treat that as a cancellation.
    getSelection.mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
    } as unknown as Selection);
    const submit = screen.getByRole('button', { name: 'Post' });
    fireEvent.mouseUp(submit);
    expect(screen.getByPlaceholderText('Comment…')).toBeInTheDocument();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(mocks.createComment).toHaveBeenCalledWith('document-1', {
        body: createdComment.body,
        anchor: expect.objectContaining({
          type: 'line',
          lineStart: 1,
          lineEnd: 1,
          snippet: 'Selected line',
        }),
      });
    });
    expect(await screen.findByText(createdComment.body)).toBeInTheDocument();
    expect(screen.getByText(identity.latestContent).closest('.artifact-markdown-line')).toHaveClass('bg-yellow-300/20');
    expect(screen.getByRole('button', { name: '1 comment starting at Line 1' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => {
      expect(mocks.resolveComment).toHaveBeenCalledWith('document-1', 'comment-1', {
        resolutionNote: 'Addressed in the current document version.',
      });
    });
    expect(await screen.findByText('addressed')).toBeInTheDocument();
    expect(screen.getByText(identity.latestContent).closest('.artifact-markdown-line')).not.toHaveClass('bg-yellow-300/20');
    expect(screen.queryByRole('button', { name: '1 comment starting at Line 1' })).not.toBeInTheDocument();
  });

  it('persists Save without marking the document as a favorite', async () => {
    render(<ArtifactViewer artifact={{ ...artifact, saved: false, favorite: false }} presentation="tab" hideTabStrip />);

    const saveButton = await screen.findByRole('button', { name: 'Save' });
    expect(saveButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mocks.updateLibraryState).toHaveBeenCalledWith('artifact-1', { saved: true });
    });
    expect(screen.getByRole('button', { name: 'Saved' })).toHaveAttribute('aria-pressed', 'true');
    await expect(mocks.updateLibraryState.mock.results[0]?.value).resolves.toMatchObject({
      saved: true,
      favorite: false,
    });
  });
});
