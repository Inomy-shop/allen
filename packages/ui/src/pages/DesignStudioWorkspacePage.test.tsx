import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DesignStudioWorkspacePage from './DesignStudioWorkspacePage';

vi.mock('../services/designStudioService', () => ({
  designStudio: {
    getWorkspace: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    listDesigns: vi.fn().mockResolvedValue([]),
    listFiles: vi.fn().mockResolvedValue([]),
    repoChange: vi.fn().mockResolvedValue({ changed: false, hasProfile: true }),
    listModels: vi.fn().mockResolvedValue([]),
    analyze: vi.fn(),
    start: vi.fn(),
    confirmProfile: vi.fn(),
    greenfield: vi.fn(),
    createSession: vi.fn(),
    deleteWorkspace: vi.fn(),
  },
}));

import { designStudio } from '../services/designStudioService';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/studio/workspaces/w1']}>
      <Routes>
        <Route path="/studio" element={<div>Design Studio list</div>} />
        <Route path="/studio/workspaces/:id" element={<DesignStudioWorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const baseProfile = {
  summaryMarkdown: 'A modern look', colors: [{ name: 'Primary', value: '#3b82f6' }],
  typography: 'Inter', spacing: '8px', components: [{ name: 'Button', description: 'rounded' }],
  iconography: 'lucide', layoutPatterns: 'sidebar', consistency: { consistent: true, issues: [] },
};

describe('DesignStudioWorkspacePage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('R4.1: surfaces the mimic-vs-normalize choice for an inconsistent repo and blocks confirm until chosen', async () => {
    vi.mocked(designStudio.getWorkspace).mockResolvedValue({
      _id: 'w1', kind: 'repo', name: 'Acme', profileStatus: 'needs_choice',
      profile: { ...baseProfile, consistency: { consistent: false, issues: ['3 button styles'] } },
    } as any);
    renderPage();
    await waitFor(() => expect(screen.getByText(/Inconsistent styling detected/i)).toBeTruthy());
    expect(screen.getByText('3 button styles')).toBeTruthy();
    // Confirm is disabled until a strategy is picked.
    const confirm = screen.getByText(/Confirm profile/i).closest('button')!;
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByText('Mimic dominant'));
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
  });

  it('R4.2: lists detected themes and requires a pick', async () => {
    vi.mocked(designStudio.getWorkspace).mockResolvedValue({
      _id: 'w1', kind: 'repo', name: 'Acme', profileStatus: 'needs_choice',
      profile: { ...baseProfile, themes: [
        { name: 'Admin', description: 'dense gray', location: 'apps/admin' },
        { name: 'Marketing', description: 'airy blue', location: 'apps/site' },
      ] },
    } as any);
    renderPage();
    await waitFor(() => expect(screen.getByText(/Multiple themes detected/i)).toBeTruthy());
    expect(screen.getByText(/Admin/)).toBeTruthy();
    expect(screen.getByText(/Marketing/)).toBeTruthy();
  });

  it('R6: greenfield workspace shows the discovery interview', async () => {
    vi.mocked(designStudio.getWorkspace).mockResolvedValue({
      _id: 'w1', kind: 'greenfield', name: 'My idea', profileStatus: 'pending',
    } as any);
    renderPage();
    await waitFor(() => expect(screen.getByText(/What is the product/i)).toBeTruthy());
    expect(screen.getByText(/target audience/i)).toBeTruthy();
  });

  it('R22.2: confirmed repo workspace warns when the repo changed', async () => {
    vi.mocked(designStudio.getWorkspace).mockResolvedValue({
      _id: 'w1', kind: 'repo', name: 'Acme', profileStatus: 'confirmed', profile: baseProfile,
    } as any);
    vi.mocked(designStudio.repoChange).mockResolvedValue({ changed: true, hasProfile: true });
    renderPage();
    await waitFor(() => expect(screen.getByText(/repository changed since the profile/i)).toBeTruthy());
  });

  it('lets a repo Design Studio workspace be deleted from the detail page', async () => {
    vi.mocked(designStudio.getWorkspace).mockResolvedValue({
      _id: 'w1',
      kind: 'repo',
      name: 'Acme',
      sourceRepoPath: '/repos/acme',
      profileStatus: 'confirmed',
      profile: baseProfile,
    } as any);
    vi.mocked(designStudio.deleteWorkspace).mockResolvedValue(undefined);

    renderPage();

    await waitFor(() => expect(screen.getByRole('button', { name: /^Delete$/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));

    expect(screen.getByText('Delete Design Studio repository')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Acme'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: /Delete repository/i }));

    await waitFor(() => {
      expect(designStudio.deleteWorkspace).toHaveBeenCalledWith('w1');
      expect(screen.getByText('Design Studio list')).toBeTruthy();
    });
  });
});
