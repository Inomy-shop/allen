import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import RepoContextManagementPage from '../RepoContextManagementPage';

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));

vi.mock('../../services/api', () => ({
  repos: {
    get: vi.fn().mockResolvedValue({ _id: 'repo-1', name: 'inomy-ai-service', path: '/repo' }),
    getContextManagement: vi.fn().mockResolvedValue({
      entries: [{ inclusion: 'include' }, { inclusion: 'include' }],
      mandatoryMappings: [{ id: 'mandatory-1' }],
      agents: [],
      cogneeStatus: { status: 'completed', stage: 'completed' },
      graph: { nodes: [], edges: [], nodeCount: 3956, edgeCount: 11679, nodeTypeCounts: [], relationshipCounts: [] },
    }),
    getContextGraph: vi.fn(),
    getCogneeStatus: vi.fn().mockResolvedValue({ status: 'completed', stage: 'completed' }),
  },
}));
vi.mock('../../components/common/Toast', () => ({
  useToast: () => toast,
}));
vi.mock('../../components/context-management/RepoContextSetupCard', () => ({
  default: () => <div>context setup completed successfully</div>,
}));
vi.mock('../../components/context-management/ContextImportExport', () => ({
  default: () => <><button type="button">Export</button><button type="button">Import</button></>,
}));
vi.mock('../../components/context-management/ContextGraphFlow', async () => {
  const actual = await vi.importActual<any>('../../components/context-management/ContextGraphFlow');
  return { ...actual, ContextReactFlow: () => <div aria-label="Context graph canvas" /> };
});
vi.mock('../../components/context/ContextReviewTab', () => ({ default: () => null }));

describe('RepoContextManagementPage V8', () => {
  it('renders the dense repository header, metric strip, and context tabs', async () => {
    render(
      <MemoryRouter initialEntries={['/repos/repo-1/context-management']}>
        <Routes><Route path="/repos/:id/context-management" element={<RepoContextManagementPage />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Curated active')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'inomy-ai-service' })).toBeInTheDocument();
    expect(screen.getByText('3,956')).toBeInTheDocument();
    expect(screen.getByText('11,679')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Context Graph/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Curated Context/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import' })).toBeVisible();
    expect(screen.getByRole('button', { name: /^Refresh$/ })).toBeVisible();
  });
});
