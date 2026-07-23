/** V8 application sidebar integration tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from './App';

vi.mock('./stores/authStore', () => ({
  useAuthStore: vi.fn((selector) => {
    const state = {
      user: { name: 'Test User', email: 'test@example.com', role: 'admin' as const },
      accessToken: 'tok', refreshToken: 'rtok', hydrated: true,
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('./stores/settingsStore', () => ({
  useSettingsStore: vi.fn((selector) => {
    const state = { colorMode: 'light', setColorMode: vi.fn() };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('./hooks/usePanelLayout', () => ({
  usePanelLayout: vi.fn(() => ({
    collapsed: false, toggle: vi.fn(), collapse: vi.fn(), expand: vi.fn(),
    size: 236, onMouseDown: vi.fn(),
  })),
}));

vi.mock('./services/api', () => ({
  executions: { count: vi.fn().mockResolvedValue({ count: 0 }) },
  interventions: { list: vi.fn().mockResolvedValue([]) },
  repos: { list: vi.fn().mockResolvedValue([]), get: vi.fn() },
  chat: { getSession: vi.fn().mockResolvedValue(null), listSessions: vi.fn().mockResolvedValue([]) },
  alerts: {
    count: vi.fn().mockResolvedValue({ count: 0 }),
    list: vi.fn().mockResolvedValue([]),
    markAllRead: vi.fn(), dismiss: vi.fn(),
  },
}));

vi.mock('./services/workspaceService', () => ({
  workspaces: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), archive: vi.fn() },
}));

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<div>home page</div>} />
          <Route path="*" element={<div>child page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function navLabels(): string[] {
  return screen.getAllByRole('link')
    .map((link) => link.textContent?.trim() ?? '')
    .filter(Boolean);
}

describe('V8 sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders the four permanent destinations in the required order', () => {
    renderApp();
    const labels = navLabels();
    const core = ['Home', 'Sessions', 'Executions', 'Workspaces'];
    const positions = core.map((label) => labels.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('renders a persisted, collapsible Library with working destinations', () => {
    renderApp();
    const toggle = screen.getByRole('button', { name: 'Library' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Linear' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const repository = screen.getByRole('link', { name: 'Repos' });
    const linear = screen.getByRole('link', { name: 'Linear' });
    const pullRequests = screen.getByRole('link', { name: 'Pull requests' });
    expect(repository).toBeInTheDocument();
    expect(linear).toBeInTheDocument();
    expect(pullRequests).toBeInTheDocument();
    expect(repository.compareDocumentPosition(linear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(linear.compareDocumentPosition(pullRequests) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workflows' })).toBeInTheDocument();

    expect(localStorage.getItem('allen-nav-lib')).toBe('1');
  });

  it('automatically opens Library for a Library route', async () => {
    localStorage.setItem('allen-nav-lib', '0');
    renderApp('/agents?section=teams-agents');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('link', { name: 'Agents' })).toBeInTheDocument();
    });
  });

  it('uses two pane-swap dots in navigation then workspaces order', () => {
    renderApp();
    const navigation = screen.getByRole('button', { name: 'App navigation' });
    const workspaces = screen.getByRole('button', { name: 'Workspaces' });
    expect(navigation).toHaveAttribute('aria-current', 'true');
    expect(navigation.compareDocumentPosition(workspaces) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the structured workspace pane and loads its search surface', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search workspaces')).toBeInTheDocument();
      expect(screen.getByText('No recent workspaces.')).toBeInTheDocument();
    });
  });

  it('keeps Allen Design and Settings fixed in the bottom product block', () => {
    renderApp();
    expect(screen.getByRole('link', { name: 'Allen Design' })).toHaveAttribute('href', '/studio');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/general');
  });
});
