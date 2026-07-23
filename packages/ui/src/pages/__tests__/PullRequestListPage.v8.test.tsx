import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PullRequestListPage from '../PullRequestListPage';

vi.mock('../../services/workspaceService', () => ({
  pullRequests: { list: vi.fn(), syncAll: vi.fn(), createWorkspace: vi.fn() },
}));

vi.mock('../../services/api', () => ({
  system: { desktopRuntime: vi.fn() },
}));

vi.mock('../../components/settings/McpServerManager', () => ({ McpPresetConnectModal: () => null }));
vi.mock('../../components/workspace/SetupProgressDialog', () => ({ SetupProgressDialog: () => null }));

const { pullRequests } = await import('../../services/workspaceService');
const { system } = await import('../../services/api');

describe('PullRequestListPage V8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(system.desktopRuntime).mockResolvedValue({ secrets: [{ key: 'ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN', configured: true }] } as any);
  });

  it('renders the compact PR ledger and reloads when a status chip changes', async () => {
    vi.mocked(pullRequests.list).mockResolvedValueOnce([{ _id: 'pr1', number: 745, title: 'Seller portal onboarding', repoName: 'inomy-mono', branch: 'feature/onboarding', baseBranch: 'development', author: 'ashish', status: 'open', updatedAt: new Date().toISOString() }] as any).mockResolvedValueOnce([]);
    render(<MemoryRouter><PullRequestListPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('#745 · Seller portal onboarding')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Merged' }));
    await waitFor(() => expect(pullRequests.list).toHaveBeenLastCalledWith({ status: 'merged' }));
  });
});
