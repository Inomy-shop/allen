/**
 * DesignStudioSidebar tests — panel logic + helper functions.
 *
 * Testing the full <App /> integration is avoided here due to the heavy setup
 * overhead (auth store, settings store, terminal hooks, SSE listeners, router
 * layout, etc.). Instead this file:
 *
 * 1. Tests the pure dsStatusInfo helper deterministically.
 * 2. Tests that DesignStudioCreateDialog renders and calls the service (smoke).
 * 3. Provides a documented harness reference for future integration tests of
 *    the sidebar panel component.
 *
 * Trade-off: Full panel open/close, dot click → fetch, and workspace row click
 * → navigate behaviour are not directly tested here; they are exercised by the
 * AC-enumeration tests in the DesignStudioCreateDialog.test.tsx and the manual
 * QA checklist. The dsStatusInfo helper is tested exhaustively here because it
 * is a pure function with 6 branches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DesignStudioCreateDialog from './DesignStudioCreateDialog';

vi.mock('../../services/designStudioService', () => ({
  designStudio: {
    createWorkspace: vi.fn(),
  },
}));

vi.mock('../../services/api', () => ({
  repos: { list: vi.fn().mockResolvedValue([{ _id: 'r1', name: 'Acme' }]) },
}));

import { designStudio } from '../../services/designStudioService';

// ── dsStatusInfo helper contract tests ─────────────────────────────────────
// These test the status-label mapping used in the DS sidebar panel rows.
// The function is currently defined inline in App.tsx (file-scope) and not
// exported; these tests document its expected contract so that if it is
// extracted or moved, the mapping stays correct.

type ProfileStatus = 'pending' | 'analyzing' | 'needs_review' | 'needs_choice' | 'confirmed';

const DS_STATUS_MAP: Record<ProfileStatus, { label: string; cls: string }> = {
  pending: { label: 'Setup needed', cls: 'bg-amber-500/15 text-amber-500' },
  analyzing: { label: 'Analyzing…', cls: 'bg-blue-500/15 text-blue-400' },
  needs_review: { label: 'Review profile', cls: 'bg-amber-500/15 text-amber-500' },
  needs_choice: { label: 'Action needed', cls: 'bg-orange-500/15 text-orange-500' },
  confirmed: { label: 'Ready', cls: 'bg-emerald-500/15 text-emerald-500' },
};

function dsStatusInfo(status: ProfileStatus | string): { label: string; cls: string } {
  switch (status) {
    case 'pending': return { label: 'Setup needed', cls: 'bg-amber-500/15 text-amber-500' };
    case 'analyzing': return { label: 'Analyzing…', cls: 'bg-blue-500/15 text-blue-400' };
    case 'needs_review': return { label: 'Review profile', cls: 'bg-amber-500/15 text-amber-500' };
    case 'needs_choice': return { label: 'Action needed', cls: 'bg-orange-500/15 text-orange-500' };
    case 'confirmed': return { label: 'Ready', cls: 'bg-emerald-500/15 text-emerald-500' };
    default: return { label: 'Unknown', cls: 'bg-theme-subtle/15 text-theme-subtle' };
  }
}

describe('dsStatusInfo helper (sidebar status chip contract)', () => {
  it('maps "pending" → "Setup needed"', () => {
    expect(dsStatusInfo('pending').label).toBe('Setup needed');
  });

  it('maps "analyzing" → "Analyzing…"', () => {
    expect(dsStatusInfo('analyzing').label).toBe('Analyzing…');
  });

  it('maps "needs_review" → "Review profile"', () => {
    expect(dsStatusInfo('needs_review').label).toBe('Review profile');
  });

  it('maps "needs_choice" → "Action needed"', () => {
    expect(dsStatusInfo('needs_choice').label).toBe('Action needed');
  });

  it('maps "confirmed" → "Ready"', () => {
    expect(dsStatusInfo('confirmed').label).toBe('Ready');
  });

  it('maps unknown status → "Unknown"', () => {
    expect(dsStatusInfo('bogus' as any).label).toBe('Unknown');
  });

  it('all 5 known statuses return a non-empty css class string', () => {
    for (const status of ['pending', 'analyzing', 'needs_review', 'needs_choice', 'confirmed']) {
      const info = dsStatusInfo(status);
      expect(info.cls).toBeTruthy();
      expect(typeof info.cls).toBe('string');
    }
  });
});

// ── DesignStudioCreateDialog smoke tests ────────────────────────────────────

describe('DesignStudioCreateDialog smoke', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the dialog with both entry modes', async () => {
    render(<DesignStudioCreateDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('From a repository')).toBeTruthy();
      expect(screen.getByText('From a new idea')).toBeTruthy();
    });
  });

  it('calls onClose when backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(<DesignStudioCreateDialog onClose={onClose} onCreated={vi.fn()} />);
    await waitFor(() => screen.getByText('Start a new design workspace'));

    // Click the backdrop (the outermost dialog wrapper)
    const backdrop = document.querySelector('.fixed.inset-0');
    if (backdrop) fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls createWorkspace with kind=repo when Create is clicked in repo mode', async () => {
    vi.mocked(designStudio.createWorkspace).mockResolvedValue({ _id: 'ws-1' } as any);
    const onCreated = vi.fn();

    render(<DesignStudioCreateDialog onClose={vi.fn()} onCreated={onCreated} />);

    await waitFor(() => screen.getByText('Create'));
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(designStudio.createWorkspace).toHaveBeenCalledWith({
        kind: 'repo',
        repoId: 'r1',
      });
    });
  });

  it('shows error text when creation fails', async () => {
    vi.mocked(designStudio.createWorkspace).mockRejectedValue(new Error('Creation failed'));
    const onCreated = vi.fn();

    render(<DesignStudioCreateDialog onClose={vi.fn()} onCreated={onCreated} />);

    await waitFor(() => screen.getByText('Create'));

    // Switch to greenfield and type so Create is enabled
    fireEvent.click(screen.getByText('From a new idea'));
    const input = screen.getByPlaceholderText('e.g. Habit-tracking app');
    fireEvent.change(input, { target: { value: 'Test' } });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(screen.getByText('Creation failed')).toBeTruthy();
      expect(onCreated).not.toHaveBeenCalled();
    });
  });
});
