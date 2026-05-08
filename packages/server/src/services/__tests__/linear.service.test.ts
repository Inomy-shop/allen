/**
 * Unit tests for LinearService.listIssues() filter construction.
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

// Import AFTER mocks are registered so that the service picks up mocked deps.
import { LinearService } from '../linear.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_DB = {} as unknown as Db;

/** rawRequest returns { data: <payload> }; LinearService unwraps .data */
const EMPTY_ISSUES_RESPONSE = { data: { issues: { nodes: [] } } };

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
