import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommentInput from './CommentInput';
import type { DocumentCommentDoc } from '../../services/documents';

const mocks = vi.hoisted(() => ({ createComment: vi.fn() }));

vi.mock('../../services/api', () => ({
  documents: { createComment: mocks.createComment },
}));

const createdComment: DocumentCommentDoc = {
  commentId: 'comment-1',
  documentId: 'document-1',
  threadId: 'thread-1',
  authorType: 'human',
  body: 'Needs clarification',
  status: 'open',
  anchor: {
    type: 'line',
    lineStart: 2,
    lineEnd: 2,
    context: 'Selected line',
    anchoredAtVersion: 1,
  },
  reopenCount: 0,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
};

describe('CommentInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createComment.mockResolvedValue(createdComment);
  });

  it('returns the created comment so the viewer can display it immediately', async () => {
    const onSubmitted = vi.fn();
    render(
      <CommentInput
        documentId="document-1"
        anchor={{ type: 'line', lineStart: 2, lineEnd: 2, context: 'Selected line' }}
        onSubmitted={onSubmitted}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), { target: { value: 'Needs clarification' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(createdComment));
  });
});
