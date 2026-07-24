import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import ExecutionListPage, { groupConsecutiveScheduledExecutions } from '../ExecutionListPage';

vi.mock('../../services/api', () => ({
  executions: {
    listPaged: vi.fn().mockResolvedValue({
      total: 2,
      items: [
        {
          id: 'exec-running',
          title: 'Pinned workflows — feature build',
          workflowName: 'feature-plan-and-implement',
          type: 'workflow',
          status: 'running',
          startedAt: '2026-07-20T10:00:00Z',
          completedNodes: ['plan', 'develop'],
          progress: { completed: 2, total: 5 },
          workspace: { branch: 'ui/redesign-implementation', repoName: 'allen-internal' },
        },
        {
          id: 'exec-completed',
          title: 'Product launch film',
          workflowName: 'product-launch-film',
          type: 'agent',
          status: 'completed',
          startedAt: '2026-07-20T08:12:00Z',
          durationMs: 5_204_000,
          origin: 'chat',
          meta: { chatSessionId: 'chat-1' },
          repository: { name: 'inomy-marketing', defaultBranch: 'main' },
        },
      ],
    }),
  },
}));

describe('ExecutionListPage V8', () => {
  it('groups consecutive scheduled executions from the same job and day', () => {
    const items = groupConsecutiveScheduledExecutions([
      { id: '1', startedAt: '2026-07-24T10:00:00Z', meta: { origin: 'cron', triggeredBy: 'schedule', cronJobName: 'health' } },
      { id: '2', startedAt: '2026-07-24T09:00:00Z', meta: { origin: 'cron', triggeredBy: 'schedule', cronJobName: 'health' } },
      { id: '3', startedAt: '2026-07-24T08:00:00Z', meta: { origin: 'chat' } },
    ]);
    expect(items[0]).toMatchObject({ kind: 'scheduled-group', cronJobName: 'health' });
    expect(items[0].kind === 'scheduled-group' ? items[0].executions : []).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: 'execution', exec: { id: '3' } });
  });

  it('renders the type-led execution ledger and readable controls', async () => {
    render(<MemoryRouter><ExecutionListPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Executions' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Pinned workflows — feature build')).toBeInTheDocument());
    expect(screen.getByText('Product launch film')).toBeInTheDocument();
    expect(screen.getByText('1 running')).toBeInTheDocument();
    expect(screen.getByText('1 recent')).toBeInTheDocument();
    expect(screen.getByText('2 shown')).toBeInTheDocument();
    expect(screen.getByText('running · 2/5')).toBeInTheDocument();
    expect(screen.getAllByText('workflow').length).toBeGreaterThan(0);
    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(screen.getByText(/ui\/redesign-implementation · allen-internal/)).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search execution, workflow, or node')).toBeVisible();
    expect(screen.getByRole('group', { name: 'Filter executions by source' })).toBeVisible();
    expect(screen.getByText('Click a run to open its detail. Failed runs open at the step that stopped.')).toBeVisible();
  });
});
