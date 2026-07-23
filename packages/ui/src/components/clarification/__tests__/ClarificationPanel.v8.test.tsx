import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { artifacts as artifactsApi, type ArtifactDoc } from '../../../services/api';
import ClarificationPanel from '../ClarificationPanel';

vi.mock('../../chat/ChatMessageList', () => ({
  renderMarkdown: (content: string) => content,
}));

vi.mock('../../artifacts/ArtifactViewer', () => ({
  default: ({ presentation, hideTabStrip }: { presentation?: string; hideTabStrip?: boolean }) => (
    <div
      data-testid="artifact-viewer"
      data-presentation={presentation}
      data-hide-tab-strip={String(hideTabStrip)}
    />
  ),
}));

describe('ClarificationPanel V8', () => {
  it('uses the document-viewer reading surface and readable semantic actions', async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <ClarificationPanel
        layout="modal"
        title="Approval Required"
        prompt="Review the implementation before continuing."
        severity="approval"
        fields={[]}
        mode="approval"
        docs={[{ label: 'Investigation report', url: '/api/artifacts/report-1' }]}
        reviewContent="## Highlights\nThe approval copy remains readable."
        reviewContentType="markdown"
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole('button', { name: 'Investigation report' }))
      .toHaveClass('v8-clarification-artifact', 'text-theme-secondary');
    expect(container.querySelector('.v8-clarification-review .artifact-viewer__reading .prose'))
      .toHaveTextContent('Highlights');
    expect(container.querySelector('.prose-invert')).not.toBeInTheDocument();

    const approveDecision = screen.getAllByRole('button', { name: 'Approve' })[0];
    expect(approveDecision).toHaveClass('v8-clarification-decision', 'text-theme-secondary');
    fireEvent.click(approveDecision);
    expect(approveDecision).toHaveClass('text-accent-green');

    const submit = container.querySelector<HTMLButtonElement>('.v8-clarification-submit');
    expect(submit).not.toBeNull();
    fireEvent.click(submit!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        decision: 'approve',
        fieldValues: {},
        feedback: undefined,
        scope: undefined,
      });
    });
  });

  it('opens review artifacts with the same tab presentation as Documents and Chat', async () => {
    const artifact: ArtifactDoc = {
      artifactId: 'report-1',
      rootType: 'workflow',
      rootId: 'execution-1',
      spawnContext: { originType: 'workflow' },
      filename: 'investigation-report.md',
      relativePath: 'investigation-report.md',
      contentType: 'markdown',
      sizeBytes: 42,
      createdAt: '2026-07-23T00:00:00.000Z',
    };
    vi.spyOn(artifactsApi, 'get').mockResolvedValue(artifact);

    render(
      <ClarificationPanel
        title="Approval Required"
        severity="approval"
        fields={[]}
        mode="approval"
        docs={[{ label: 'Investigation report', url: '/api/artifacts/report-1' }]}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Investigation report' }));

    const viewer = await screen.findByTestId('artifact-viewer');
    expect(viewer).toHaveAttribute('data-presentation', 'tab');
    expect(viewer).toHaveAttribute('data-hide-tab-strip', 'true');
    expect(viewer.parentElement).toHaveClass('resource-tab-content');
  });
});
