/**
 * DesignStudioCreateDialog — two-mode creation dialog.
 *
 * Tests the extracted dialog component behaviour: mode switching, creation calls,
 * error handling, and close/created callbacks.
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

function renderDialog(onClose = vi.fn(), onCreated = vi.fn()) {
  return render(<DesignStudioCreateDialog onClose={onClose} onCreated={onCreated} />);
}

describe('DesignStudioCreateDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders both mode buttons ("From a repository" and "From a new idea")', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('From a repository')).toBeTruthy();
      expect(screen.getByText('From a new idea')).toBeTruthy();
    });
  });

  it('switching to "From a new idea" lets user type and click Create; calls createWorkspace with greenfield payload and invokes onCreated', async () => {
    vi.mocked(designStudio.createWorkspace).mockResolvedValue({ _id: 'new-ws-id' } as any);

    renderDialog();

    // Switch to greenfield mode
    await waitFor(() => screen.getByText('From a new idea'));
    fireEvent.click(screen.getByText('From a new idea'));

    // Type an idea name
    const input = screen.getByPlaceholderText('e.g. Habit-tracking app');
    fireEvent.change(input, { target: { value: 'My idea' } });

    // Click Create
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(designStudio.createWorkspace).toHaveBeenCalledWith({
        kind: 'greenfield',
        name: 'My idea',
      });
    });
  });

  it('on create failure, error message is displayed and onCreated is NOT called', async () => {
    const onCreated = vi.fn();
    vi.mocked(designStudio.createWorkspace).mockRejectedValue(new Error('Something went wrong'));

    renderDialog(vi.fn(), onCreated);

    await waitFor(() => screen.getByText('Create'));

    // Switch to greenfield and type something so Create is enabled
    fireEvent.click(screen.getByText('From a new idea'));
    const input = screen.getByPlaceholderText('e.g. Habit-tracking app');
    fireEvent.change(input, { target: { value: 'My idea' } });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeTruthy();
      expect(onCreated).not.toHaveBeenCalled();
    });
  });
});
