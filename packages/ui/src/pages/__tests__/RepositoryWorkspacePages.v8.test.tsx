import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/common/Toast';
import RepoManagerPage from '../RepoManagerPage';
import WorkspaceListPage from '../WorkspaceListPage';

const { repoFixtures } = vi.hoisted(() => ({ repoFixtures: [
  {
    _id: 'repo-attention',
    name: 'allen-internal',
    path: '/workspaces/allen-internal',
    detected: {
      language: ['TypeScript'],
      framework: ['React'],
      packageManager: 'npm',
      defaultBranch: 'dev',
      remoteUrl: 'https://github.com/example/allen-internal.git',
    },
    tags: [],
    status: 'active',
    executionCount: 2,
    createdAt: '2026-06-12T08:22:00Z',
    updatedAt: '2026-06-13T08:22:00Z',
  },
  {
    _id: 'repo-ready',
    name: 'design-system',
    path: '/workspaces/design-system',
    context: 'Context is ready',
    contextScan: { status: 'ready' },
    detected: {
      language: ['TypeScript'],
      framework: ['React'],
      packageManager: 'npm',
      defaultBranch: 'main',
    },
    tags: [],
    status: 'active',
    executionCount: 0,
    createdAt: '2026-06-12T08:22:00Z',
    updatedAt: '2026-06-13T09:10:00Z',
  },
] }));

vi.mock('../../services/api', () => ({
  repos: {
    list: vi.fn().mockResolvedValue(repoFixtures),
    pull: vi.fn(),
    scan: vi.fn(),
    cancelScan: vi.fn(),
    delete: vi.fn(),
  },
  workflows: {},
  system: {
    runtimeConfig: vi.fn().mockResolvedValue({
      contextEngine: { enabled: false, provider: null, cogneeEnabled: false },
    }),
  },
}));

vi.mock('../../services/workspaceService', () => ({
  workspaces: {
    list: vi.fn().mockResolvedValue([
      {
        _id: 'workspace-active',
        name: 'UI redesign implementation',
        repoId: 'repo-attention',
        repoName: 'allen-internal',
        branch: 'ui/redesign-implementation',
        baseBranch: 'dev',
        status: 'active',
        changedFiles: 6,
        updatedAt: '2026-07-20T09:30:00Z',
      },
      {
        _id: 'workspace-idle',
        name: 'Design token audit',
        repoId: 'repo-ready',
        repoName: 'design-system',
        branch: 'design/token-audit',
        baseBranch: 'main',
        status: 'idle',
        updatedAt: '2026-07-18T09:30:00Z',
      },
    ]),
  },
}));

vi.mock('../../components/workspace/XTerminal', () => ({ XTerminal: () => null }));
vi.mock('../../components/workspace/EmbeddedChat', () => ({ EmbeddedChat: () => null }));

describe('Repository and workspace V8 pages', () => {
  it('renders the complete prototype repository action strip and attention-only status', async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <RepoManagerPage />
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Repositories' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('allen-internal')).toBeInTheDocument());

    const actionGroups = screen.getAllByRole('group', { name: 'Repository actions' });
    expect(actionGroups).toHaveLength(2);
    for (const label of [
      'Open repository context',
      'Open repository workspace',
      'Pull latest changes',
      'Rescan repository context',
      'Repository settings',
      'Edit repository',
      'Remove repository',
    ]) {
      expect(within(actionGroups[0]).getByRole('button', { name: label })).toBeVisible();
    }

    expect(screen.getAllByText('First scan pending')).toHaveLength(1);
    expect(screen.getAllByText(/^updated Jun 13/)).toHaveLength(2);
    expect(screen.getByText(/status appears only when something needs attention/)).toBeVisible();
  });

  it('renders the prototype workspace grouping, filters, rows, and actions', async () => {
    render(<MemoryRouter><WorkspaceListPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('UI redesign implementation')).toBeInTheDocument());

    const filters = screen.getByRole('group', { name: 'Workspace filters' });
    expect(within(filters).getByRole('button', { name: /All 2/ })).toBeVisible();
    expect(within(filters).getByRole('button', { name: /Active 1/ })).toBeVisible();
    expect(within(filters).getByRole('button', { name: /Idle 1/ })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'allen-internal' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'design-system' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete workspace' })).toHaveLength(2);
    expect(screen.getByText(/Idle workspaces are pruned automatically/)).toBeVisible();
  });
});
