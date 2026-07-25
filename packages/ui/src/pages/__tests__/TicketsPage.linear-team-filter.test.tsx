/**
 * Tests for the Linear team filter feature on TicketsPage.
 *
 * Covers:
 *   AC-001 – team select visible with "All teams" ('') selected after successful load
 *   AC-002 – options render in API-provided order after "All teams"
 *   AC-003 – selecting a team calls linear.issues with that teamId
 *   AC-004 – re-selecting All teams calls linear.issues WITHOUT teamId
 *   AC-005 – changing search/project does not reset teamFilter
 *   AC-007 – list↔board toggle keeps the same scoped issue set
 *   AC-008 – teams load failure: existing error surface appears; retry path recovers
 *   EC-001 – zero teams: only All teams option; issues still requested
 *   EC-004 – refresh with disappeared team falls back to All teams; issues omit teamId
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TicketsPage from '../TicketsPage';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/api', () => ({
  linear: {
    status: vi.fn(),
    teams: vi.fn(),
    projects: vi.fn(),
    issues: vi.fn(),
    issue: vi.fn(),
    assignAgent: vi.fn(),
    dispatch: vi.fn(),
    dispatchWorkflow: vi.fn(),
  },
  teams: {
    list: vi.fn().mockResolvedValue([]),
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
  },
  workflows: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ agents: [] }),
}));

vi.mock('../../hooks/useRunContext', () => ({
  useRunContext: () => ({ runContext: null, loading: false, error: null }),
}));

vi.mock('../../components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));

vi.mock('../../components/chat/ChatMessageList', () => ({
  renderMarkdown: (content: string) => content,
}));

vi.mock('../../components/linear/DispatchModal', () => ({
  default: () => null,
}));

vi.mock('../../components/executions/RunStatusCard', () => ({
  default: () => null,
}));

vi.mock('../../components/settings/McpServerManager', () => ({
  McpPresetConnectModal: () => null,
}));

vi.mock('../../lib/workspace-routes', () => ({
  workspaceChatPath: (id: string) => `/workspaces/${id}/chat`,
}));

vi.mock('../../components/common/IconTooltipButton', () => ({
  default: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick} type="button">{children}</button>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { linear: linearApi } = await import('../../services/api');

/** A minimal LinearIssue fixture that satisfies the page's type. */
function makeIssue(id: string, title: string) {
  return {
    id,
    identifier: `ENG-${id}`,
    title,
    description: null,
    priority: 0,
    priorityLabel: 'No priority',
    state: { id: 'state-1', name: 'Backlog', type: 'backlog', color: '#aaa' },
    team: { id: 'team-eng', name: 'Engineering', key: 'ENG' },
    project: null,
    linearAssignee: null,
    agentAssignee: null,
    labels: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: `https://linear.app/org/issue/ENG-${id}`,
  };
}

/** Default successful configuration for linearApi mocks. */
function setUpHappyPath(opts: {
  teams?: Array<{ id: string; name: string }>;
  issues?: any[];
} = {}) {
  vi.mocked(linearApi.status).mockResolvedValue({
    configured: true,
    workspaceName: 'Acme',
  } as any);
  vi.mocked(linearApi.teams).mockResolvedValue(
    opts.teams ?? [
      { id: 'team-alpha', name: 'Alpha' },
      { id: 'team-beta', name: 'Beta' },
    ],
  );
  vi.mocked(linearApi.projects).mockResolvedValue([]);
  vi.mocked(linearApi.issues).mockResolvedValue(
    (opts.issues ?? [makeIssue('1', 'Fix login bug')]) as any,
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <TicketsPage />
    </MemoryRouter>,
  );
}

/**
 * Wait for the team select AND for its options to include the given ids
 * before firing selection events.  The initial waitFor(select) only proves
 * the element mounted (status resolved) — it does NOT prove `linearApi.teams()`
 * has resolved and populated `<option>`s.  Firing `change` before the option
 * exists is racey: React's controlled select silently rejects a value that
 * has no matching child option, so `setTeamFilter` never receives the value
 * and `linearApi.issues` is never re-invoked with the new `teamId`.
 */
async function waitForTeamOptions(expectedIds: string[]): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const select = screen.getByRole('combobox', { name: 'Team filter' }) as HTMLSelectElement;
    const ids = Array.from(select.options).map(o => o.value);
    for (const id of expectedIds) {
      if (!ids.includes(id)) {
        throw new Error(`Team option ${id} not yet loaded (have: ${ids.join(',')})`);
      }
    }
    return select;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TicketsPage — Linear team filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── AC-001 ─────────────────────────────────────────────────────────────────
  it('AC-001: team select is visible with All teams selected after successful load', async () => {
    setUpHappyPath();
    renderPage();

    const select = await waitFor(() =>
      screen.getByRole('combobox', { name: 'Team filter' }),
    );

    expect(select).toBeInTheDocument();
    expect((select as HTMLSelectElement).value).toBe('');
  });

  // ── AC-002 ─────────────────────────────────────────────────────────────────
  it('AC-002: team options render in API-provided order after All teams', async () => {
    setUpHappyPath({
      teams: [
        { id: 'team-alpha', name: 'Alpha' },
        { id: 'team-beta', name: 'Beta' },
      ],
    });
    renderPage();

    const select = await waitForTeamOptions(['team-alpha', 'team-beta']);
    const options = Array.from(select.options);
    expect(options[0].value).toBe('');
    expect(options[0].text).toBe('All teams');
    expect(options[1].value).toBe('team-alpha');
    expect(options[1].text).toBe('Alpha');
    expect(options[2].value).toBe('team-beta');
    expect(options[2].text).toBe('Beta');
  });

  // ── AC-003 ─────────────────────────────────────────────────────────────────
  it('AC-003: selecting a team calls linear.issues with that teamId', async () => {
    setUpHappyPath();
    renderPage();

    const select = await waitForTeamOptions(['team-alpha']);

    fireEvent.change(select, { target: { value: 'team-alpha' } });

    await waitFor(() => {
      const calls = vi.mocked(linearApi.issues).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toMatchObject({ teamId: 'team-alpha' });
    });
  });

  // ── AC-004 ─────────────────────────────────────────────────────────────────
  it('AC-004: re-selecting All teams calls linear.issues WITHOUT teamId', async () => {
    setUpHappyPath();
    renderPage();

    const select = await waitForTeamOptions(['team-alpha']);

    // First select a team
    fireEvent.change(select, { target: { value: 'team-alpha' } });
    await waitFor(() => {
      const calls = vi.mocked(linearApi.issues).mock.calls;
      expect(calls[calls.length - 1][0]).toMatchObject({ teamId: 'team-alpha' });
    });

    // Then reset to All teams
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => {
      const calls = vi.mocked(linearApi.issues).mock.calls;
      const lastFilters = calls[calls.length - 1][0] as Record<string, unknown>;
      expect(lastFilters.teamId).toBeUndefined();
    });
  });

  // ── AC-005 ─────────────────────────────────────────────────────────────────
  it('AC-005: changing search input does not reset teamFilter', async () => {
    setUpHappyPath();
    renderPage();

    const teamSelect = await waitForTeamOptions(['team-beta']);

    // Select a team
    fireEvent.change(teamSelect, { target: { value: 'team-beta' } });

    await waitFor(() => {
      const calls = vi.mocked(linearApi.issues).mock.calls;
      expect(calls[calls.length - 1][0]).toMatchObject({ teamId: 'team-beta' });
    });

    // Change the search
    const searchInput = screen.getByPlaceholderText('Search issues…');
    fireEvent.change(searchInput, { target: { value: 'auth' } });

    await waitFor(() => {
      const calls = vi.mocked(linearApi.issues).mock.calls;
      // The teamId must still be present
      expect(calls[calls.length - 1][0]).toMatchObject({ teamId: 'team-beta', q: 'auth' });
    });

    // Team select must still show the selected team
    expect((teamSelect as HTMLSelectElement).value).toBe('team-beta');
  });

  // ── AC-007 ─────────────────────────────────────────────────────────────────
  it('AC-007: list↔board toggle keeps the same scoped issue set', async () => {
    setUpHappyPath({
      issues: [makeIssue('42', 'Fix auth flow')],
    });
    renderPage();

    // Wait for the issue to appear in list view
    await waitFor(() =>
      expect(screen.getByText('Fix auth flow')).toBeInTheDocument(),
    );

    // Switch to board view — use exact name to avoid matching issue text
    const boardButton = screen.getAllByRole('button').find(
      btn => btn.textContent?.trim().replace(/\s+/g, ' ') === 'Board',
    );
    expect(boardButton).toBeDefined();
    fireEvent.click(boardButton!);

    // The same issue should still be visible in board view
    expect(screen.getByText('Fix auth flow')).toBeInTheDocument();
  });

  // ── AC-008 ─────────────────────────────────────────────────────────────────
  it('AC-008: teams load failure shows connection error; retry clears the error', async () => {
    // Simulate teams failure but status OK
    vi.mocked(linearApi.status).mockResolvedValue({
      configured: true,
      workspaceName: 'Acme',
    } as any);
    vi.mocked(linearApi.teams).mockRejectedValueOnce(new Error('Network failure'));
    vi.mocked(linearApi.projects).mockResolvedValue([]);
    vi.mocked(linearApi.issues).mockResolvedValue([]);

    renderPage();

    // The page should surface the error (loadTeams failure sets status.error)
    await waitFor(() => {
      const matches = screen.getAllByText(/Network failure|Linear could not be reached|Could not reach Linear/i);
      expect(matches.length).toBeGreaterThan(0);
    });

    // Set up a successful status response so retry clears the error
    vi.mocked(linearApi.teams).mockResolvedValue([
      { id: 'team-alpha', name: 'Alpha' },
    ]);
    vi.mocked(linearApi.status).mockResolvedValue({ configured: true, workspaceName: 'Acme' } as any);

    // Click the Retry / Recheck button — this calls loadStatus which clears status.error
    const retryButton = screen.getByRole('button', { name: /Retry|Recheck/i });
    fireEvent.click(retryButton);

    // After retry, error text should disappear and page should render normally
    await waitFor(() => {
      expect(
        screen.queryByText(/Could not reach Linear/i),
      ).not.toBeInTheDocument();
    });
    // linearApi.teams should have been called at least once (initial load)
    expect(vi.mocked(linearApi.teams)).toHaveBeenCalled();
  });

  // ── EC-001 ─────────────────────────────────────────────────────────────────
  it('EC-001: zero teams → only All teams option; issues are still requested', async () => {
    setUpHappyPath({ teams: [], issues: [] });
    renderPage();

    const select = await waitFor(() =>
      screen.getByRole('combobox', { name: 'Team filter' }),
    );

    const options = Array.from((select as HTMLSelectElement).options);
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('');
    expect(options[0].text).toBe('All teams');

    // issues should still have been requested (at least once)
    await waitFor(() => {
      expect(vi.mocked(linearApi.issues)).toHaveBeenCalled();
    });
  });

  // ── EC-004 ─────────────────────────────────────────────────────────────────
  it('EC-004: after teams reload without current team, filter reconciles to All teams', async () => {
    // Initial load with two teams
    setUpHappyPath({
      teams: [
        { id: 'team-alpha', name: 'Alpha' },
        { id: 'team-beta', name: 'Beta' },
      ],
    });
    renderPage();

    const teamSelect = await waitForTeamOptions(['team-alpha', 'team-beta']);

    // Wait for the Refresh button to be enabled (initial loading complete)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refresh/ })).not.toBeDisabled();
    });

    // Select Alpha
    fireEvent.change(teamSelect, { target: { value: 'team-alpha' } });

    // Wait for issues to be called with teamId=team-alpha AND for loading to finish
    await waitFor(() => {
      const calls = vi.mocked(linearApi.issues).mock.calls;
      const hasAlphaCall = calls.some(
        c => (c[0] as Record<string, unknown>).teamId === 'team-alpha',
      );
      expect(hasAlphaCall).toBe(true);
    });
    // Wait for loading to finish so the Refresh button is clickable
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refresh/ })).not.toBeDisabled();
    });

    // Now mock teams to return only Beta (Alpha disappeared)
    vi.mocked(linearApi.teams).mockResolvedValue([
      { id: 'team-beta', name: 'Beta' },
    ]);
    vi.mocked(linearApi.issues).mockResolvedValue([] as any);

    // Click refresh — triggers loadTeams which reconciles teamFilter
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    // After reconcile, linearTeams should no longer contain team-alpha.
    // We verify this via the select options list — jsdom controlled-select .value
    // is unreliable when the selected option is removed + React re-sets the value
    // in the same batch.  Checking options[] is stable and proves the reconcile ran.
    await waitFor(() => {
      const sel = screen.getByRole('combobox', { name: 'Team filter' }) as HTMLSelectElement;
      const opts = Array.from(sel.options).map(o => o.value);
      // Alpha must be gone (reconcile removed it from linearTeams)
      expect(opts).not.toContain('team-alpha');
      // "All teams" and Beta must remain
      expect(opts).toContain('');
      expect(opts).toContain('team-beta');
    }, { timeout: 5000 });

    // The issues call after reconcile must not include teamId (teamFilter = '')
    await waitFor(() => {
      const calls = vi.mocked(linearApi.issues).mock.calls;
      const lastFilters = calls[calls.length - 1][0] as Record<string, unknown>;
      expect(lastFilters.teamId).toBeUndefined();
    });
  });
});
