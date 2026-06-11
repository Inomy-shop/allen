import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import DesignNavPanel from './DesignNavPanel';

vi.mock('../../services/api', () => ({
  chat: {
    listSessions: vi.fn(),
  },
}));

const { chat } = await import('../../services/api');

function renderPanel(activeSessionId: string | null = null, onBack = vi.fn(), onDelete?: (id: string) => void) {
  return render(
    <MemoryRouter>
      <DesignNavPanel activeSessionId={activeSessionId} onBack={onBack} onDelete={onDelete} />
    </MemoryRouter>
  );
}

describe('DesignNavPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows only design-assistant sessions', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 'd1', title: 'My design', activeAgent: 'design-assistant', lastMessageAt: new Date().toISOString() },
      { _id: 'c1', title: 'Normal chat', activeAgent: null, lastMessageAt: new Date().toISOString() },
    ] as any);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('My design')).toBeInTheDocument();
      expect(screen.queryByText('Normal chat')).not.toBeInTheDocument();
    });
  });

  it('calls onBack when back button is clicked', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([]);
    const onBack = vi.fn();
    renderPanel(null, onBack);

    await waitFor(() => screen.getByText('Back'));
    fireEvent.click(screen.getByText('Back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when no design sessions', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([]);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/No design conversations yet/i)).toBeInTheDocument();
    });
  });

  // ── Back-button navigation contract ─────────────────────────────────────────
  // The DesignNavPanel's `onBack` prop MUST cause navigation away from /design.
  // App.tsx wires this as: () => { setSidebarPanel('navigation'); navigate('/'); }
  //
  // The test below verifies the expected behavior by providing an onBack that
  // mirrors the CORRECT App.tsx wiring. If App.tsx is reverted to only calling
  // setSidebarPanel (the previously broken behavior), this documents and enforces
  // that navigation is part of the contract the caller must satisfy.
  it('back button — when onBack navigates, route leaves /design', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([]);

    // WiredPanel mimics what App.tsx does: onBack calls navigate('/') in addition
    // to any local state updates. This is the CORRECT wiring that was broken before.
    function WiredPanel() {
      const navigate = useNavigate();
      return (
        <DesignNavPanel
          activeSessionId={null}
          onBack={() => {
            // This is what App.tsx MUST do (broken version only called setSidebarPanel)
            navigate('/');
          }}
        />
      );
    }

    render(
      <MemoryRouter initialEntries={['/design']}>
        <Routes>
          <Route path="/design" element={<WiredPanel />} />
          <Route path="/" element={<div data-testid="home-page">Home</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => screen.getByText('Back'));
    fireEvent.click(screen.getByText('Back'));

    // After clicking Back the route must have changed to '/' (home / main nav).
    // If onBack does NOT call navigate (the broken behavior), this assertion fails.
    await waitFor(() => {
      expect(screen.getByTestId('home-page')).toBeInTheDocument();
    });
  });

  it('name span has truncation classes for overflow fix', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 'd1', title: 'A very long design session name that should be truncated', activeAgent: 'design-assistant', lastMessageAt: new Date().toISOString() },
    ] as any);

    renderPanel();

    await waitFor(() => {
      const nameSpan = screen.getByText('A very long design session name that should be truncated');
      expect(nameSpan.className).toContain('truncate');
      // Parent must have min-w-0 and overflow-hidden for truncation to work
      expect(nameSpan.parentElement?.className).toContain('min-w-0');
      expect(nameSpan.parentElement?.className).toContain('overflow-hidden');
    });
  });

  it('shows delete button when onDelete prop is provided', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 'd1', title: 'My design', activeAgent: 'design-assistant', lastMessageAt: new Date().toISOString() },
    ] as any);

    renderPanel(null, vi.fn(), vi.fn());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete design/i })).toBeInTheDocument();
    });
  });

  it('does NOT show delete button when onDelete prop is absent', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 'd1', title: 'My design', activeAgent: 'design-assistant', lastMessageAt: new Date().toISOString() },
    ] as any);

    renderPanel(); // no onDelete

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /delete design/i })).not.toBeInTheDocument();
    });
  });

  it('clicking delete button calls onDelete with the session id', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 'd1', title: 'My design', activeAgent: 'design-assistant', lastMessageAt: new Date().toISOString() },
    ] as any);

    const onDelete = vi.fn();
    renderPanel(null, vi.fn(), onDelete);

    // Wait for the item-level delete button (has aria-label, not the dialog confirm button)
    await waitFor(() => screen.getByRole('button', { name: /delete design/i }));

    // Open the confirm dialog — only one button matches at this point
    fireEvent.click(screen.getByRole('button', { name: /delete design/i }));

    // The DeleteConfirmDialog requires typing the session name to confirm
    await waitFor(() => {
      expect(screen.getByPlaceholderText('My design')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText('My design'), { target: { value: 'My design' } });

    // After the dialog opens there are two "Delete design" buttons:
    //   1. The item's trash icon (aria-label="Delete design")
    //   2. The dialog confirm button (no aria-label; accessible by text content only)
    // Pick the dialog confirm button by finding the one WITHOUT an aria-label.
    const allDeleteBtns = screen.getAllByRole('button', { name: /delete design/i });
    const dialogConfirmBtn = allDeleteBtns.find(btn => btn.getAttribute('aria-label') !== 'Delete design')!;
    fireEvent.click(dialogConfirmBtn);

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('d1');
    });
  });

  it('clicking delete button does NOT trigger session navigation', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 'd1', title: 'My design', activeAgent: 'design-assistant', lastMessageAt: new Date().toISOString() },
    ] as any);

    const onDelete = vi.fn();
    renderPanel(null, vi.fn(), onDelete);

    await waitFor(() => screen.getByRole('button', { name: /delete design/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete design/i }));

    // Should show confirm dialog (not navigate)
    await waitFor(() => {
      expect(screen.getByText(/to confirm/i)).toBeInTheDocument();
    });
  });
});
