import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DesignStudioPage from './DesignStudioPage';

vi.mock('../services/designStudioService', () => ({
  designStudio: {
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/api', () => ({
  repos: { list: vi.fn().mockResolvedValue([{ _id: 'r1', name: 'Acme' }]) },
}));

import { designStudio } from '../services/designStudioService';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/studio']}>
      <Routes>
        <Route path="/studio" element={<DesignStudioPage />} />
        <Route path="/studio/workspaces/:id" element={<div>workspace</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DesignStudioPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows empty state when there are no workspaces', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No design workspaces yet/i)).toBeTruthy());
  });

  it('lists workspaces with their status', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Acme', sourceRepoPath: '/repos/acme', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
      { _id: 'w2', kind: 'greenfield', name: 'My idea', profileStatus: 'pending', createdAt: '', updatedAt: '' } as any,
    ]);
    renderPage();
    expect(screen.getByRole('heading', { name: 'Allen Design' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(screen.getByText('My idea')).toBeTruthy();
    expect(screen.getByText('/repos/acme')).toBeTruthy();
    expect(screen.getByText('Greenfield design workspace')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Setup needed')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search design workspaces' }), { target: { value: 'greenfield' } });
    expect(screen.queryByText('Acme')).toBeNull();
    expect(screen.getByText('My idea')).toBeTruthy();
  });

  it('opens the new-design modal with both entry modes', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([]);
    renderPage();
    await waitFor(() => screen.getByText(/No design workspaces yet/i));
    fireEvent.click(screen.getAllByRole('button', { name: 'New design' })[0]);
    await waitFor(() => {
      expect(screen.getByText('From a repository')).toBeTruthy();
      expect(screen.getByText('From a new idea')).toBeTruthy();
    });
  });
});
