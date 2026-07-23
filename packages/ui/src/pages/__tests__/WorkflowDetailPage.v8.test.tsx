import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkflowDetailPage from '../WorkflowDetailPage';

vi.mock('../../services/api', () => ({
  workflows: { get: vi.fn(), exportYaml: vi.fn() },
  executions: { listPaged: vi.fn() },
}));
vi.mock('../../components/workflow/WorkflowRunDialog', () => ({ default: () => null }));
vi.mock('../WorkflowBuilderPage', () => ({ default: () => <div>Workflow editor</div> }));

const { workflows, executions } = await import('../../services/api');

describe('WorkflowDetailPage V8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workflows.get).mockResolvedValue({
      _id: 'wf1', name: 'bug-fix-by-severity', version: 3,
      description: 'Fixes a reported bug with effort matched to its size.',
      validation: { valid: true },
      parsed: {
        input: { bug_report: { required: true }, repo_path: { required: true } },
        nodes: {
          investigate: { type: 'agent', agent: 'bug-investigator', name: 'Investigate and classify' },
          approve: { type: 'human', name: 'Approve fix scope' },
          implement: { type: 'agent', agent: 'engineering-lead', name: 'Implement fix' },
        },
        edges: [{ from: 'investigate', to: 'approve' }, { from: 'approve', to: 'implement' }],
      },
    } as any);
    vi.mocked(executions.listPaged).mockResolvedValue({ items: [{ id: 'exc_24ea2b', status: 'completed', title: 'Payment retry fix', startedAt: '2026-06-30T10:00:00Z' }], total: 1 } as any);
  });

  it('defaults to the prototype description view and exposes visual and run tabs', async () => {
    render(
      <MemoryRouter initialEntries={['/workflows/wf1']}>
        <Routes><Route path="/workflows/:id" element={<WorkflowDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /bug-fix-by-severity/ })).toBeInTheDocument());
    expect(screen.getByText(/What it does:/)).toBeInTheDocument();
    expect(screen.getByText('human gates')).toBeInTheDocument();
    expect(screen.getByText('1', { selector: 'dd' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    expect(screen.getByRole('img', { name: 'bug-fix-by-severity flow' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Runs/ }));
    expect(await screen.findByText('Payment retry fix')).toBeInTheDocument();
  });

  it('uses the wide staged ensemble treatment for large multi-model workflows', async () => {
    const nodes = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [
      `stage_${index + 1}`,
      index === 23
        ? { type: 'human', name: 'Approve strategy' }
        : { type: index % 7 === 0 ? 'condition' : 'agent', name: `Strategy step ${index + 1}`, agent: 'marketing-lead', model: index % 2 ? 'gpt-5.5' : 'opus-4.8' },
    ]));
    vi.mocked(workflows.get).mockResolvedValue({
      _id: 'wf1', name: 'growth-strategy-reviewed-ensemble', version: 6,
      description: 'Turns one growth objective into a single reviewed strategy.',
      validation: { valid: true },
      parsed: {
        input: {
          growth_objective: { required: true },
          products_context: {},
          target_market_hint: {},
          repo_path: {},
          growth_context_drive_url: {},
        },
        nodes,
        edges: Array.from({ length: 32 }, (_, index) => ({ index })),
      },
    } as any);
    vi.mocked(executions.listPaged).mockResolvedValue({ items: [], total: 5 } as any);

    render(
      <MemoryRouter initialEntries={['/workflows/wf1']}>
        <Routes><Route path="/workflows/:id" element={<WorkflowDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /growth-strategy-reviewed-ensemble/ })).toBeInTheDocument());
    expect(screen.getByText(/one human gate/)).toBeInTheDocument();
    expect(screen.getByText('Stage 2 — three drafts, cross-model reviews')).toBeInTheDocument();
    expect(screen.getByText(/no model grades its own homework/)).toBeInTheDocument();
    expect(screen.getByText('If things fail')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4.8 · draft + synth')).toBeInTheDocument();
    expect(screen.getByText('growth_objective *')).toBeInTheDocument();
    expect(screen.getByText('draft timeout')).toBeInTheDocument();
    expect(screen.getByText('8 min')).toBeInTheDocument();
    expect(screen.queryByText('The flow')).not.toBeInTheDocument();
    expect(screen.queryByText('inputs', { selector: 'dt' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    expect(screen.getByRole('img', { name: 'growth-strategy-reviewed-ensemble flow' })).toHaveAttribute('width', '856');
  });
});
