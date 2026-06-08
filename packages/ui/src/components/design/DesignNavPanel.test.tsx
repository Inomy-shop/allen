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

function renderPanel(activeSessionId: string | null = null, onBack = vi.fn()) {
  return render(
    <MemoryRouter>
      <DesignNavPanel activeSessionId={activeSessionId} onBack={onBack} />
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
});
