/**
 * App.tsx — Design Studio Sidebar Panel integration tests.
 *
 * Tests mount <App /> in a MemoryRouter with fully mocked stores and services.
 * No real network calls, no real stores, no real router history.
 *
 * Covered acceptance criteria (PRD):
 *   AC1.1–AC1.3  Carousel dots: count, order, click → panel switch
 *   AC2.1        Default sidebar panel is 'navigation'
 *   AC3.1        Workspaces panel renders workspace search JSX
 *   AC4.1–AC4.2  Design Studio panel renders header + Palette icon
 *   AC5.1–AC5.2  Workspace rows render name, kind icon, status chip
 *   AC6.1–AC6.2  Search filtering (substring, no-match text)
 *   AC7.1–AC7.2  Click row → navigate; active class + aria-current
 *   AC8.1        "New design" button appears and opens dialog
 *   AC10.1–AC10.2 Loading text / empty state text
 *   AC13.1       Dot aria-labels and aria-current
 *
 * Trade-off: This file only tests the sidebar carousel / panel behaviour.
 * The full App renders many independent surfaces (topbar, command palette,
 * update prompts, workspace create/delete dialogs) that are not exercised
 * here to keep tests focused and fast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from './App';

// ── Store mocks ─────────────────────────────────────────────────────────────

vi.mock('./stores/authStore', () => ({
  useAuthStore: vi.fn((selector) => {
    const state = {
      user: { name: 'Test User', email: 'test@example.com', role: 'admin' as const },
      accessToken: 'tok',
      refreshToken: 'rtok',
      hydrated: true,
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('./stores/settingsStore', () => ({
  useSettingsStore: vi.fn((selector) => {
    const state = { colorMode: 'light', setColorMode: vi.fn() };
    // .subscribe is called by the store internals on mount; return a no-op teardown
    state.setColorMode.mockReturnValue(undefined);
    return selector ? selector(state) : state;
  }),
}));

// ── Hook mocks ──────────────────────────────────────────────────────────────

vi.mock('./hooks/usePanelLayout', () => ({
  usePanelLayout: vi.fn(() => ({
    collapsed: false,
    toggle: vi.fn(),
    collapse: vi.fn(),
    expand: vi.fn(),
    size: 290,
    onMouseDown: vi.fn(),
  })),
}));

// ── Service mocks ──────────────────────────────────────────────────────────
// These match the imports in App.tsx exactly.

vi.mock('./services/api', () => ({
  executions: { count: vi.fn().mockResolvedValue({ count: 0 }) },
  interventions: { list: vi.fn().mockResolvedValue([]) },
  repos: { list: vi.fn().mockResolvedValue([]) },
  chat: { getSession: vi.fn().mockResolvedValue(null), listSessions: vi.fn().mockResolvedValue([]) },
}));

vi.mock('./services/workspaceService', () => ({
  workspaces: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    archive: vi.fn(),
  },
}));

vi.mock('./services/designStudioService', () => ({
  DESIGN_STUDIO_WORKSPACE_UPDATED_EVENT: 'allen:design-studio-workspace-updated',
  designStudio: { listWorkspaces: vi.fn() },
}));

// ── Test helpers ────────────────────────────────────────────────────────────

import { designStudio } from './services/designStudioService';

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<App />}>
          <Route path="/studio/workspaces/:id" element={<div>workspace detail page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** Helper to get the three carousel dot buttons by aria-label order. */
function getDots() {
  return [
    screen.getByRole('button', { name: 'Design Studio' }),
    screen.getByRole('button', { name: 'App navigation' }),
    screen.getByRole('button', { name: 'Workspaces' }),
  ];
}

/** Data-row buttons inside the DS panel are rendered from filteredDsWorkspaces. */
function getDsRowButtons(): HTMLButtonElement[] {
  return screen
    .getAllByRole('button')
    .filter((b) => b.closest('[class*="scroll-hide"]') !== null)
    .filter((b) => b.getAttribute('tabIndex') === '0');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Sidebar carousel — dots', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC1.1: renders three carousel dots in the expanded sidebar', async () => {
    renderApp();

    const [dsDot, navDot, wsDot] = getDots();
    expect(dsDot).toBeInTheDocument();
    expect(navDot).toBeInTheDocument();
    expect(wsDot).toBeInTheDocument();
  });

  it('AC1.2: dot order left→right matches SIDEBAR_PANEL_ORDER', async () => {
    renderApp();

    // The dots' aria-labels must appear in the DOM order defined by
    // SIDEBAR_PANEL_ORDER = ['design-studio', 'navigation', 'workspaces']
    // with corresponding labels from SIDEBAR_PANEL_LABELS.
    const expectedLabels = ['Design Studio', 'App navigation', 'Workspaces'];
    const dots = getDots();
    expect(dots).toHaveLength(3);
    dots.forEach((dot, i) => {
      expect(dot).toHaveAttribute('aria-label', expectedLabels[i]);
    });
  });

  it('AC1.3 / AC13.1: clicking a dot sets aria-current on that dot and removes it from others', async () => {
    renderApp();

    const [dsDot, navDot, wsDot] = getDots();

    // AC2.1 — default is navigation
    expect(navDot).toHaveAttribute('aria-current', 'true');

    // Click design-studio
    fireEvent.click(dsDot);
    await waitFor(() => {
      expect(dsDot).toHaveAttribute('aria-current', 'true');
      expect(navDot).not.toHaveAttribute('aria-current');
      expect(wsDot).not.toHaveAttribute('aria-current');
    });

    // Click workspaces
    fireEvent.click(wsDot);
    await waitFor(() => {
      expect(wsDot).toHaveAttribute('aria-current', 'true');
      expect(dsDot).not.toHaveAttribute('aria-current');
      expect(navDot).not.toHaveAttribute('aria-current');
    });

    // Click back to navigation
    fireEvent.click(navDot);
    await waitFor(() => {
      expect(navDot).toHaveAttribute('aria-current', 'true');
      expect(dsDot).not.toHaveAttribute('aria-current');
      expect(wsDot).not.toHaveAttribute('aria-current');
    });
  });
});

describe('Sidebar carousel — panels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC3.1: workspaces panel shows the workspace search input when selected', async () => {
    renderApp();

    const wsDot = screen.getByRole('button', { name: 'Workspaces' });
    fireEvent.click(wsDot);

    // The workspace panel has a search placeholder
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search workspaces')).toBeInTheDocument();
    });
  });

  it('AC4.1: design-studio panel shows when selected', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      // "Design Studio" appears in both the nav link and the panel header.
      // The panel header has class "text-theme-secondary" (nav link uses "lbl").
      const labels = screen.getAllByText('Design Studio');
      const panelHeader = labels.find((el) => el.className.includes('text-theme-secondary'));
      expect(panelHeader).toBeInTheDocument();
    });
  });

  it('AC4.2: design-studio panel header contains "Design Studio" text and a Palette icon (SVG)', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      const labels = screen.getAllByText('Design Studio');
      const panelHeader = labels.find((el) => el.className.includes('text-theme-secondary'));
      expect(panelHeader).toBeInTheDocument();

      // The parent flex container should have an SVG (Palette icon)
      const headerRow = panelHeader!.closest('div');
      expect(headerRow).not.toBeNull();
      expect(headerRow!.querySelector('svg')).toBeInTheDocument();
    });
  });

  it('AC10.1: shows loading text while design workspaces are loading', async () => {
    // Create a deferred promise that never resolves within this test
    let resolveLoading!: (value: unknown) => void;
    const loadingPromise = new Promise((resolve) => {
      resolveLoading = resolve;
    });
    vi.mocked(designStudio.listWorkspaces).mockReturnValue(loadingPromise as any);

    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      expect(screen.getByText('Loading design workspaces…')).toBeInTheDocument();
    });

    // Clean up: resolve so the test doesn't leak pending work
    resolveLoading([]);
  });

  it('AC10.2: shows "No design workspaces yet." empty state with a create button', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      // The empty state text is a text node inside a <div> that also contains
      // a <button>Create one</button> + trailing period — use a regex substring match.
      expect(screen.getByText(/No design workspaces yet/)).toBeInTheDocument();
      expect(screen.getByText('Create one')).toBeInTheDocument();
    });
  });
});

describe('Sidebar carousel — workspace rows (AC5–AC7)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC5.1: renders both workspace rows when listWorkspaces returns 2 workspaces', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Acme Corp', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
      { _id: 'w2', kind: 'greenfield', name: 'My Idea', profileStatus: 'pending', createdAt: '', updatedAt: '' } as any,
    ]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
      expect(screen.getByText('My Idea')).toBeInTheDocument();
    });
  });

  it('AC5.2: each row contains a kind icon (FolderGit2 or Lightbulb), name, and status chip', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Acme', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
      { _id: 'w2', kind: 'greenfield', name: 'Idea', profileStatus: 'pending', createdAt: '', updatedAt: '' } as any,
    ]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      // Both names visible
      expect(screen.getByText('Acme')).toBeInTheDocument();
      expect(screen.getByText('Idea')).toBeInTheDocument();

      // Both status chips visible
      expect(screen.getByText('Ready')).toBeInTheDocument();
      expect(screen.getByText('Setup needed')).toBeInTheDocument();

      // Each row (button with tabIndex=0) contains an SVG (the kind icon)
      const rows = getDsRowButtons();
      expect(rows).toHaveLength(2);
      rows.forEach((row) => {
        expect(row.querySelector('svg')).toBeInTheDocument();
      });
    });
  });

  it('updates a Design Studio sidebar status from the workspace update event without reselecting the panel', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Acme', profileStatus: 'pending', createdAt: '', updatedAt: '' } as any,
    ]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      expect(screen.getByText('Acme')).toBeInTheDocument();
      expect(screen.getByText('Setup needed')).toBeInTheDocument();
    });

    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Acme', profileStatus: 'analyzing', createdAt: '', updatedAt: '' } as any,
    ]);
    act(() => {
      window.dispatchEvent(new CustomEvent('allen:design-studio-workspace-updated', {
        detail: { workspaceId: 'w1', profileStatus: 'analyzing' },
      }));
    });

    await waitFor(() => {
      expect(screen.getByText('Analyzing…')).toBeInTheDocument();
      expect(screen.queryByText('Setup needed')).not.toBeInTheDocument();
    });
  });

  it('removes a deleted Design Studio workspace from the sidebar without reselecting the panel', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Acme', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
    ]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      expect(screen.getByText('Acme')).toBeInTheDocument();
      expect(screen.getByText('Ready')).toBeInTheDocument();
    });

    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([]);
    act(() => {
      window.dispatchEvent(new CustomEvent('allen:design-studio-workspace-updated', {
        detail: { workspaceId: 'w1', deleted: true },
      }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Acme')).not.toBeInTheDocument();
      expect(screen.getByText(/No design workspaces yet/i)).toBeInTheDocument();
    });
  });

  it('AC6.1: typing in the search input filters the list (substring, case-insensitive)', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Alpine App', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
      { _id: 'w2', kind: 'greenfield', name: 'Beta Board', profileStatus: 'pending', createdAt: '', updatedAt: '' } as any,
      { _id: 'w3', kind: 'repo', name: 'Alpha Core', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
    ]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));
    await waitFor(() => expect(screen.getByText('Alpine App')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search design workspaces');
    fireEvent.change(searchInput, { target: { value: 'alpha' } });

    await waitFor(() => {
      // Should show only "Alpha Core" (case-insensitive "alpha" match)
      expect(screen.getByText('Alpha Core')).toBeInTheDocument();
      expect(screen.queryByText('Alpine App')).not.toBeInTheDocument();
      expect(screen.queryByText('Beta Board')).not.toBeInTheDocument();
    });
  });

  it('AC6.2: when search matches nothing, shows "No matching workspaces."', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Alpine App', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
    ]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));
    await waitFor(() => expect(screen.getByText('Alpine App')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search design workspaces');
    fireEvent.change(searchInput, { target: { value: 'zzznonexistent' } });

    await waitFor(() => {
      expect(screen.getByText('No matching workspaces.')).toBeInTheDocument();
      expect(screen.queryByText('Alpine App')).not.toBeInTheDocument();
    });
  });

  it('AC7.1: clicking a workspace row navigates to /studio/workspaces/:id', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Acme Studio', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
    ]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    // Wait for the row to render
    await waitFor(() => expect(screen.getByText('Acme Studio')).toBeInTheDocument());

    // Click the workspace row (it is a button with the name as text label)
    const rowButton = screen.getByText('Acme Studio').closest('button');
    expect(rowButton).not.toBeNull();
    fireEvent.click(rowButton!);

    // The Outlet should render the child route content
    await waitFor(() => {
      expect(screen.getByText('workspace detail page')).toBeInTheDocument();
    });
  });

  it('AC7.2: workspace row has text-accent class and aria-current when path matches', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([
      { _id: 'w1', kind: 'repo', name: 'Active WS', profileStatus: 'confirmed', createdAt: '', updatedAt: '' } as any,
      { _id: 'w2', kind: 'greenfield', name: 'Other WS', profileStatus: 'pending', createdAt: '', updatedAt: '' } as any,
    ]);

    // Route is /studio/workspaces/w1 → dsWorkspaceIdFromPath = 'w1'
    renderApp('/studio/workspaces/w1');

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    await waitFor(() => {
      // Active row should have aria-current and text-accent class
      const activeRow = screen.getByText('Active WS').closest('button');
      expect(activeRow).not.toBeNull();
      expect(activeRow).toHaveAttribute('aria-current', 'true');
      expect(activeRow!.className).toContain('text-accent');

      // Non-active row should NOT have aria-current and should NOT have text-accent
      const otherRow = screen.getByText('Other WS').closest('button');
      expect(otherRow).not.toBeNull();
      expect(otherRow).not.toHaveAttribute('aria-current');
    });
  });
});

describe('Sidebar carousel — new design button', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC8.1: "New design" button is present in Design Studio panel header and opens the dialog', async () => {
    vi.mocked(designStudio.listWorkspaces).mockResolvedValue([]);
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Design Studio' }));

    // The "+" button in the header has aria-label="New design"
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New design' })).toBeInTheDocument();
    });

    // Click "New design" → DesignStudioCreateDialog should open
    fireEvent.click(screen.getByRole('button', { name: 'New design' }));

    await waitFor(() => {
      // The dialog shows mode selection
      expect(screen.getByText('From a repository')).toBeInTheDocument();
      expect(screen.getByText('From a new idea')).toBeInTheDocument();
    });
  });
});
