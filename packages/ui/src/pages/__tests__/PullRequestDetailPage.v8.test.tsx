import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PullRequestDetailPage from '../PullRequestDetailPage';

vi.mock('../../services/workspaceService', () => ({
  pullRequests: {
    get: vi.fn(), getDiff: vi.fn(), getComments: vi.fn(), createWorkspace: vi.fn(),
  },
}));

vi.mock('../../components/workspace/SetupProgressDialog', () => ({ SetupProgressDialog: () => null }));

const { pullRequests } = await import('../../services/workspaceService');

describe('PullRequestDetailPage V8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pullRequests.get).mockResolvedValue({
      _id: 'pr1', number: 745, title: 'Seller portal onboarding', repoName: 'inomy-mono',
      branch: 'feature/onboarding', baseBranch: 'development', author: 'ashish', status: 'open',
      description: 'Implements the approved onboarding recovery.', additions: 715, deletions: 85,
      changedFiles: 1, updatedAt: new Date().toISOString(), url: 'https://example.com/pr/745',
    } as any);
    vi.mocked(pullRequests.getDiff).mockResolvedValue({
      diff: '', files: [{ path: 'src/onboarding.ts', diff: '', additions: 64, deletions: 2 }],
    } as any);
    vi.mocked(pullRequests.getComments).mockResolvedValue({ comments: [] } as any);
  });

  it('renders prototype metadata and the compact files view', async () => {
    render(
      <MemoryRouter initialEntries={['/pull-requests/pr1']}>
        <Routes><Route path="/pull-requests/:id" element={<PullRequestDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: '#745 · Seller portal onboarding' })).toBeInTheDocument());
    expect(screen.getByText('Implements the approved onboarding recovery.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Files changed/ }));
    expect(screen.getByText('src/onboarding.ts')).toBeInTheDocument();
    expect(screen.getByText('+64')).toBeInTheDocument();
  });
});
