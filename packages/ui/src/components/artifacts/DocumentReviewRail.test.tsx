import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentReviewRail from './DocumentReviewRail';
import type { DocumentCommentDoc } from '../../services/documents';

const mocks = vi.hoisted(() => ({
  resolveComment: vi.fn(),
  reopenComment: vi.fn(),
  replyToComment: vi.fn(),
  listVersions: vi.fn(),
}));

vi.mock('../../services/documents', () => ({
  documents: mocks,
}));

function comment(id: string): DocumentCommentDoc {
  return {
    commentId: id,
    documentId: 'document-1',
    threadId: `thread-${id}`,
    authorType: 'human',
    body: `Comment ${id}`,
    status: 'open',
    anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'Line', anchoredAtVersion: 1 },
    reopenCount: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
}

describe('DocumentReviewRail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('matches the prototype action row and publishes an individually resolved thread', async () => {
    const openComment = comment('one');
    const resolvedComment = {
      ...openComment,
      status: 'resolved' as const,
      resolution: {
        resolvedAtVersion: 1,
        resolutionNote: 'Addressed in the current document version.',
        resolvedAt: '2026-07-21T01:00:00.000Z',
      },
    };
    mocks.resolveComment.mockResolvedValue(resolvedComment);
    const onCommentsChanged = vi.fn();

    render(
      <DocumentReviewRail
        documentId="document-1"
        documentTitle="Document"
        currentVersion={1}
        comments={[openComment]}
        onClose={vi.fn()}
        onCommentDocument={vi.fn()}
        onJumpToAnchor={vi.fn()}
        onCommentsChanged={onCommentsChanged}
        onViewVersion={vi.fn()}
      />,
    );

    const documentAction = screen.getByRole('button', { name: 'Comment on document' });
    expect(documentAction.closest('.document-review-comments__topbar')?.querySelectorAll('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Resolve all/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));

    await waitFor(() => {
      expect(mocks.resolveComment).toHaveBeenCalledWith('document-1', 'one', {
        resolutionNote: 'Addressed in the current document version.',
      });
      expect(onCommentsChanged).toHaveBeenCalledWith([resolvedComment]);
    });
  });
});
