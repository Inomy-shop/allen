/**
 * Unit tests for LinearService.listIssues() filter construction and
 * LinearService.listTeams() behaviour.
 *
 * The service hand-rolls GraphQL calls and builds a `filter` object that is
 * forwarded verbatim to `@linear/sdk`'s underlying rawRequest(). These tests
 * verify that the correct filter shape reaches the SDK for every combination
 * of ListIssuesFilters.
 *
 * Covers:
 *   AC-003a – listIssues({ assigneeEmail: 'user@example.com' })
 *             → rawRequest receives filter with assignee.email.eq === given email
 *   AC-003b – listIssues({ stateTypes: ['started'], assigneeEmail: ... })
 *             → filter includes both state.type.in AND assignee.email.eq
 *   AC-003c – listIssues({}) (no assigneeEmail)
 *             → filter does NOT include assignee key
 *   AC-004  – listIssues({ teamId: '<id>' })
 *             → filter.team.id.eq === '<id>'; absent teamId → no team key
 *   AC-005  – listTeams() caching and sort behaviour
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

// ---------------------------------------------------------------------------
// Hoist mock variables — vi.mock() factories are hoisted to the top of the
// compiled output, so variables used inside them must be created with
// vi.hoisted() to guarantee they're available at hoist time.
// ---------------------------------------------------------------------------
const mockRawRequest = vi.hoisted(() => vi.fn());

vi.mock('@linear/sdk', () => ({
  LinearClient: vi.fn().mockImplementation(() => ({
    // LinearService accesses `(client.client as any).rawRequest`
    client: {
      rawRequest: mockRawRequest,
    },
  })),
}));

// TicketAssignmentService is constructed in LinearService constructor and
// called inside listIssues() via hydrateAssignmentStatuses(). Mock it to
// avoid real MongoDB calls.
vi.mock('../ticket-assignment.service.js', () => ({
  TicketAssignmentService: vi.fn().mockImplementation(() => ({
    getAllAsMap: vi.fn().mockResolvedValue(new Map()),
    get: vi.fn().mockResolvedValue(null),
    patch: vi.fn().mockResolvedValue(null),
    upsertDispatch: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(null),
  })),
}));

// WorkspaceManager, executeChatTool, ExecutionService are only used by
// LinearService.dispatch() / finishDispatch() / dispatchWorkflow() — NOT by
// listIssues() or getIssue(). Mock them so that their transitive
// @allen/engine imports don't break the test environment.
vi.mock('../workspace.service.js', () => ({
  WorkspaceManager: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ _id: 'ws-1', worktreePath: '/tmp/ws', branch: 'main', status: 'active' }),
    get: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../chat-tools.js', () => ({
  executeChatTool: vi.fn().mockResolvedValue({}),
}));

vi.mock('../execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({ id: 'exec-1', status: 'running' }),
  })),
}));

// linear.service.ts imports StateManager directly from @allen/engine. The
// engine package is not built in the test environment, so we stub the whole
// package so that module resolution succeeds.
vi.mock('@allen/engine', () => ({
  StateManager: vi.fn().mockImplementation(() => ({
    updateExecution: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import AFTER mocks are registered so that the service picks up mocked deps.
import { LinearService } from '../linear.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_DB = {} as unknown as Db;

/** rawRequest returns { data: <payload> }; LinearService unwraps .data */
const EMPTY_ISSUES_RESPONSE = { data: { issues: { nodes: [] } } };
const EMPTY_TEAMS_RESPONSE = { data: { teams: { nodes: [] } } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearService.listIssues() — filter construction', () => {
  beforeEach(() => {
    process.env.ALLEN_LINEAR_ACCESS_TOKEN = 'test-token-abc';
    // Clear the module-level caches so each test starts fresh and actually
    // calls rawRequest rather than returning a cached result.
    LinearService.invalidateCaches();
    mockRawRequest.mockClear();
    mockRawRequest.mockResolvedValue(EMPTY_ISSUES_RESPONSE);
  });

  afterEach(() => {
    delete process.env.ALLEN_LINEAR_ACCESS_TOKEN;
    LinearService.invalidateCaches();
  });

  // ── AC-003a ──────────────────────────────────────────────────────────────

  describe('AC-003a: assigneeEmail is set → filter.assignee.email.eq is correct', () => {
    it('sends filter with assignee.email.eq equal to the provided email', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({ assigneeEmail: 'user@example.com' });

      expect(mockRawRequest).toHaveBeenCalledOnce();

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      const filter = variables.filter as Record<string, unknown>;

      expect(filter).toHaveProperty('assignee');
      const assignee = filter.assignee as { email: { eq: string } };
      expect(assignee.email.eq).toBe('user@example.com');
    });

    it('passes the email exactly (preserves case)', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({ assigneeEmail: 'Alice@MyCompany.com' });

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      const filter = variables.filter as { assignee: { email: { eq: string } } };
      expect(filter.assignee.email.eq).toBe('Alice@MyCompany.com');
    });

    it('constructs the exact nested filter shape: { assignee: { email: { eq } } }', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({ assigneeEmail: 'user@example.com' });

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      expect(variables.filter).toStrictEqual(
        expect.objectContaining({
          assignee: { email: { eq: 'user@example.com' } },
        }),
      );
    });
  });

  // ── AC-003b ──────────────────────────────────────────────────────────────

  describe('AC-003b: stateTypes + assigneeEmail → filter includes both keys', () => {
    it('sends filter with both state.type.in and assignee.email.eq', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({
        stateTypes: ['started'],
        assigneeEmail: 'user@example.com',
      });

      expect(mockRawRequest).toHaveBeenCalledOnce();

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      const filter = variables.filter as Record<string, unknown>;

      // Both keys must be present
      expect(filter).toHaveProperty('assignee');
      expect(filter).toHaveProperty('state');

      const assignee = filter.assignee as { email: { eq: string } };
      expect(assignee.email.eq).toBe('user@example.com');

      const state = filter.state as { type: { in: string[] } };
      expect(state.type.in).toEqual(['started']);
    });

    it('handles multiple stateTypes alongside assigneeEmail', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({
        stateTypes: ['started', 'unstarted', 'backlog'],
        assigneeEmail: 'dev@example.com',
      });

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      const filter = variables.filter as {
        state: { type: { in: string[] } };
        assignee: { email: { eq: string } };
      };
      expect(filter.state.type.in).toEqual(['started', 'unstarted', 'backlog']);
      expect(filter.assignee.email.eq).toBe('dev@example.com');
    });

    it('constructs exact combined filter shape for stateTypes + assigneeEmail', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({ stateTypes: ['started'], assigneeEmail: 'user@example.com' });

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      expect(variables.filter).toStrictEqual({
        state: { type: { in: ['started'] } },
        assignee: { email: { eq: 'user@example.com' } },
      });
    });
  });

  // ── AC-003c ──────────────────────────────────────────────────────────────

  describe('AC-003c: no assigneeEmail → filter does NOT include assignee key', () => {
    it('omits assignee key when assigneeEmail is not provided', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({});

      expect(mockRawRequest).toHaveBeenCalledOnce();

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      const filter = variables.filter as Record<string, unknown>;
      expect(filter).not.toHaveProperty('assignee');
    });

    it('omits assignee key when calling with stateTypes only', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({ stateTypes: ['started'] });

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      const filter = variables.filter as Record<string, unknown>;
      expect(filter).not.toHaveProperty('assignee');
    });

    it('omits assignee key when calling with projectId only', async () => {
      const svc = new LinearService(FAKE_DB);
      await svc.listIssues({ projectId: 'proj-123' });

      const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
      const filter = variables.filter as Record<string, unknown>;
      expect(filter).not.toHaveProperty('assignee');
    });

    it('returns empty array without calling rawRequest when token is missing', async () => {
      delete process.env.ALLEN_LINEAR_ACCESS_TOKEN;
      const svc = new LinearService(FAKE_DB);
      const issues = await svc.listIssues({ assigneeEmail: 'user@example.com' });
      expect(issues).toEqual([]);
      expect(mockRawRequest).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// AC-004: teamId filter
// ---------------------------------------------------------------------------

describe('LinearService.listIssues() — teamId filter', () => {
  beforeEach(() => {
    process.env.ALLEN_LINEAR_ACCESS_TOKEN = 'test-token-abc';
    LinearService.invalidateCaches();
    mockRawRequest.mockClear();
    mockRawRequest.mockResolvedValue(EMPTY_ISSUES_RESPONSE);
  });

  afterEach(() => {
    delete process.env.ALLEN_LINEAR_ACCESS_TOKEN;
    LinearService.invalidateCaches();
  });

  it('AC-004a: teamId → filter.team.id.eq is set to the given id', async () => {
    const svc = new LinearService(FAKE_DB);
    await svc.listIssues({ teamId: 'team-abc' });

    expect(mockRawRequest).toHaveBeenCalledOnce();
    const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
    const filter = variables.filter as Record<string, unknown>;
    expect(filter).toHaveProperty('team');
    const team = filter.team as { id: { eq: string } };
    expect(team.id.eq).toBe('team-abc');
  });

  it('AC-004b: absent teamId → filter does NOT include team key', async () => {
    const svc = new LinearService(FAKE_DB);
    await svc.listIssues({});

    const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
    const filter = variables.filter as Record<string, unknown>;
    expect(filter).not.toHaveProperty('team');
  });

  it('AC-004c: teamId composes as sibling with projectId, stateTypes, q, and assigneeEmail', async () => {
    const svc = new LinearService(FAKE_DB);
    await svc.listIssues({
      teamId: 'team-x',
      projectId: 'proj-y',
      stateTypes: ['started'],
      q: 'bug',
      assigneeEmail: 'dev@example.com',
    });

    const variables = mockRawRequest.mock.calls[0][1] as Record<string, unknown>;
    const filter = variables.filter as Record<string, unknown>;
    expect(filter).toHaveProperty('team');
    expect(filter).toHaveProperty('project');
    expect(filter).toHaveProperty('state');
    expect(filter).toHaveProperty('or');
    expect(filter).toHaveProperty('assignee');
    const team = filter.team as { id: { eq: string } };
    expect(team.id.eq).toBe('team-x');
  });

  it('AC-004d: Team A and Team B each trigger upstream rawRequest; repeated Team A call within TTL returns cached data; unfiltered request has its own cache entry', async () => {
    const teamANodes = [{ id: 'i-a', identifier: 'A-1', title: 'Alpha', description: null, priority: 0, createdAt: '2024-01-01', updatedAt: '2024-01-01', url: 'https://a', state: null, team: null, project: null, assignee: null, labels: null }];
    const teamBNodes = [{ id: 'i-b', identifier: 'B-1', title: 'Beta', description: null, priority: 0, createdAt: '2024-01-01', updatedAt: '2024-01-01', url: 'https://b', state: null, team: null, project: null, assignee: null, labels: null }];

    mockRawRequest
      .mockResolvedValueOnce({ data: { issues: { nodes: teamANodes } } })
      .mockResolvedValueOnce({ data: { issues: { nodes: teamBNodes } } })
      .mockResolvedValueOnce(EMPTY_ISSUES_RESPONSE); // unfiltered

    const svc = new LinearService(FAKE_DB);

    // First call: Team A — triggers upstream
    const resultA1 = await svc.listIssues({ teamId: 'team-a' });
    expect(resultA1.map(i => i.id)).toEqual(['i-a']);

    // Second call: Team B — triggers a second upstream call
    const resultB = await svc.listIssues({ teamId: 'team-b' });
    expect(resultB.map(i => i.id)).toEqual(['i-b']);

    // Third call: Team A again — served from cache, no additional rawRequest
    const resultA2 = await svc.listIssues({ teamId: 'team-a' });
    expect(resultA2.map(i => i.id)).toEqual(['i-a']);

    // Fourth call: unfiltered — separate cache entry, triggers upstream
    await svc.listIssues({});

    // Total upstream calls: Team A (1) + Team B (1) + unfiltered (1) = 3
    expect(mockRawRequest).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// AC-005: listTeams()
// ---------------------------------------------------------------------------

describe('LinearService.listTeams()', () => {
  beforeEach(() => {
    process.env.ALLEN_LINEAR_ACCESS_TOKEN = 'test-token-abc';
    LinearService.invalidateCaches();
    mockRawRequest.mockClear();
    mockRawRequest.mockResolvedValue(EMPTY_TEAMS_RESPONSE);
  });

  afterEach(() => {
    delete process.env.ALLEN_LINEAR_ACCESS_TOKEN;
    LinearService.invalidateCaches();
  });

  it('AC-005a: issues exactly one rawRequest containing "teams(first: 250)"', async () => {
    const svc = new LinearService(FAKE_DB);
    await svc.listTeams();

    expect(mockRawRequest).toHaveBeenCalledOnce();
    const query = mockRawRequest.mock.calls[0][0] as string;
    expect(query).toContain('teams(first: 250)');
  });

  it('AC-005b: maps only id and name from nodes', async () => {
    mockRawRequest.mockResolvedValueOnce({
      data: {
        teams: {
          nodes: [
            { id: 't1', name: 'Engineering', key: 'ENG', extraField: 'ignored' },
            { id: 't2', name: 'Design', key: 'DES', extraField: 'also ignored' },
          ],
        },
      },
    });

    const svc = new LinearService(FAKE_DB);
    const teams = await svc.listTeams();

    expect(teams).toHaveLength(2);
    expect(teams[0]).toStrictEqual({ id: 't2', name: 'Design' });
    expect(teams[1]).toStrictEqual({ id: 't1', name: 'Engineering' });
    // key / extraField must NOT appear
    expect(teams[0]).not.toHaveProperty('key');
    expect(teams[0]).not.toHaveProperty('extraField');
  });

  it('AC-005c: sorts deterministically — case-insensitive, then exact name tie-break, then id', async () => {
    mockRawRequest.mockResolvedValueOnce({
      data: {
        teams: {
          nodes: [
            { id: 'id-z', name: 'Zebra' },
            { id: 'id-b2', name: 'beta' },
            { id: 'id-b1', name: 'Beta' },  // same case-insensitive as beta; tie-break by exact name
            { id: 'id-a', name: 'Alpha' },
          ],
        },
      },
    });

    const svc = new LinearService(FAKE_DB);
    const teams = await svc.listTeams();

    // Expected order: Alpha, Beta (uppercase B < lowercase b in ASCII), beta, Zebra
    // Case-insensitive: alpha < beta == beta < zebra
    // For the two "beta" entries: exact comparison 'Beta' < 'beta' (B=66 < b=98)
    expect(teams.map(t => t.name)).toEqual(['Alpha', 'Beta', 'beta', 'Zebra']);
  });

  it('AC-005d: id tie-break when name is truly identical', async () => {
    mockRawRequest.mockResolvedValueOnce({
      data: {
        teams: {
          nodes: [
            { id: 'id-z', name: 'Same' },
            { id: 'id-a', name: 'Same' },
          ],
        },
      },
    });

    const svc = new LinearService(FAKE_DB);
    const teams = await svc.listTeams();
    expect(teams.map(t => t.id)).toEqual(['id-a', 'id-z']);
  });

  it('AC-005e: returns [] for empty nodes array', async () => {
    const svc = new LinearService(FAKE_DB);
    const teams = await svc.listTeams();
    expect(teams).toEqual([]);
    expect(mockRawRequest).toHaveBeenCalledOnce();
  });

  it('AC-005f: second call within TTL serves from cache — rawRequest NOT called again', async () => {
    mockRawRequest.mockResolvedValueOnce({
      data: { teams: { nodes: [{ id: 't1', name: 'Engineering' }] } },
    });

    const svc = new LinearService(FAKE_DB);
    const first = await svc.listTeams();
    const second = await svc.listTeams();

    expect(mockRawRequest).toHaveBeenCalledOnce();
    expect(second).toStrictEqual(first);
  });

  it('AC-005g: returns [] without calling rawRequest when token is missing', async () => {
    delete process.env.ALLEN_LINEAR_ACCESS_TOKEN;
    const svc = new LinearService(FAKE_DB);
    const teams = await svc.listTeams();
    expect(teams).toEqual([]);
    expect(mockRawRequest).not.toHaveBeenCalled();
  });

  it('AC-005h: invalidateCaches() clears teamsCache — upstream called again after invalidation', async () => {
    const firstNodes = [{ id: 't1', name: 'First' }];
    const secondNodes = [{ id: 't2', name: 'Second' }];
    mockRawRequest
      .mockResolvedValueOnce({ data: { teams: { nodes: firstNodes } } })
      .mockResolvedValueOnce({ data: { teams: { nodes: secondNodes } } });

    const svc = new LinearService(FAKE_DB);

    const beforeInvalidation = await svc.listTeams();
    expect(beforeInvalidation.map(t => t.id)).toEqual(['t1']);

    LinearService.invalidateCaches();

    const afterInvalidation = await svc.listTeams();
    expect(afterInvalidation.map(t => t.id)).toEqual(['t2']);

    expect(mockRawRequest).toHaveBeenCalledTimes(2);
  });
});
