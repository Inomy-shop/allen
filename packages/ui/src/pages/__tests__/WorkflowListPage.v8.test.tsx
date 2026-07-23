import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import WorkflowListPage from '../WorkflowListPage';

const refresh = vi.fn();

vi.mock('../../hooks/useWorkflows', () => ({
  useWorkflows: () => ({
    loading: false,
    refresh,
    workflows: [
      {
        _id: 'wf-eng', name: 'bug-fix-by-severity', version: 3,
        teamClassification: 'engineering',
        description: 'Fixes a reported bug with effort matched to its size.',
        tags: ['engineering'], runCount: 34, validation: { valid: true },
        parsed: {
          nodes: {
            investigate: { type: 'agent', agent: 'bug-investigator' },
            approve: { type: 'human', name: 'you' },
            implement: { type: 'agent', agent: 'engineering-lead' },
          },
          edges: [{ from: 'investigate', to: 'approve' }, { from: 'approve', to: 'implement' }],
        },
      },
      {
        _id: 'wf-growth', name: 'campaign-planner', version: 1,
        teamClassification: 'marketing',
        description: 'Plans a complete growth campaign.',
        tags: ['growth'], runCount: 2, validation: { valid: true },
        parsed: { nodes: { plan: { type: 'agent', agent: 'growth-lead' } }, edges: [] },
      },
    ],
  }),
}));

vi.mock('../../components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../components/workflow/WorkflowRunDialog', () => ({ default: () => null }));
vi.mock('../../components/common/DeleteConfirmDialog', () => ({ default: () => null }));

describe('WorkflowListPage V8', () => {
  it('renders workflow shape, route metadata, and category filtering', () => {
    render(<MemoryRouter><WorkflowListPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Workflows' })).toBeInTheDocument();
    expect(screen.getByText('3 nodes · 2 edges')).toBeInTheDocument();
    expect(screen.getByText(/bug-investigator → you → engineering-lead/)).toBeInTheDocument();
    expect(screen.getByText('34 runs')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Marketing' }));
    expect(screen.queryByText('bug-fix-by-severity')).not.toBeInTheDocument();
    expect(screen.getByText('campaign-planner')).toBeInTheDocument();
  });
});
