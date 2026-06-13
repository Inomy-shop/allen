/**
 * Unit tests for resolveMentions() — the Linear-ticket branch in chat.service.ts.
 *
 * resolveMentions() is exported (see chat.service.ts) and responsible for:
 *   1. Scanning the user message for @<TEAM>-<number> tokens
 *   2. Fetching each ticket via LinearService.getIssue()
 *   3. Injecting a [LINEAR TICKET: …] context block for every resolved ticket
 *   4. Silently skipping if LinearService throws (unconfigured / network error)
 *   5. Capping at 3 identifiers per message
 *   6. NOT querying the workflow/repo/agent DB collections for ticket identifiers
 *
 * Covers:
 *   AC-004  – resolved ticket → context block with correct prefix
 *   AC-004b – exact format: \n[LINEAR TICKET: X] Title: …\nURL: …\nDescription: …\n
 *   AC-005  – LinearService.getIssue throws → no [LINEAR TICKET] block, no error
 *   AC-006  – 4 mentions → getIssue called exactly 3 times, 4th never resolved
 *   EC-009  – ticket identifiers are NOT looked up in workflow/repo/agent collections
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

// ---------------------------------------------------------------------------
// Hoist the mock fn so it is available inside the vi.mock() factory.
// ---------------------------------------------------------------------------
const mockGetIssue = vi.hoisted(() => vi.fn());

vi.mock('../linear.service.js', () => ({
  LinearService: vi.fn().mockImplementation(() => ({
    getIssue: mockGetIssue,
  })),
}));

// ── Stub out every transitive @allen/engine dependency that chat.service.ts
// imports. None of them are exercised by resolveMentions(), but they must
// resolve without error for the module to load.
// ---------------------------------------------------------------------------

vi.mock('../chat-llm.js', () => ({
  runChatLLM: vi.fn().mockResolvedValue({ content: '', cost: 0 }),
}));

vi.mock('../chat-providers.js', () => ({
  getDefaultChatProvider: vi.fn().mockReturnValue('claude'),
  getProvidersInDefaultOrder: vi.fn().mockReturnValue([]),
  getEnabledProvidersInDefaultOrder: vi.fn().mockResolvedValue([]),
  AGENT_FALLBACK_CWD: '/tmp',
  CLAUDE_COMPATIBLE_PROVIDER_CONFIGS: [],
}));

vi.mock('../agent-settings.js', () => ({
  resolveAgentSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock('../alert.service.js', () => ({
  AlertService: vi.fn().mockImplementation(() => ({
    createAlert: vi.fn(),
  })),
}));

vi.mock('../chat-tools.js', () => ({
  registerActiveSession: vi.fn(),
  unregisterActiveSession: vi.fn(),
  waitForBackgroundTasks: vi.fn().mockResolvedValue(undefined),
  executeChatTool: vi.fn().mockResolvedValue({}),
}));

vi.mock('../embedding.service.js', () => ({
  searchSimilar: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn().mockResolvedValue(undefined),
  invalidateCache: vi.fn(),
}));

vi.mock('../org-context.js', () => ({
  buildOrgContextBlock: vi.fn().mockReturnValue(''),
}));

vi.mock('../self-healing-monitor.service.js', () => ({
  MonitoringService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({ id: 'exec-1', status: 'running' }),
  })),
}));

// Import the function under test AFTER all mocks are registered.
import { resolveMentions } from '../chat.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal mock DB whose collections return null for every findOne call.
 * Exposes `_findOneMock` so tests can assert whether/what it was called with.
 */
function createMockDb() {
  const findOneMock = vi.fn().mockResolvedValue(null);
  const db = {
    collection: vi.fn().mockReturnValue({ findOne: findOneMock }),
    _findOneMock: findOneMock,
  } as unknown as Db & { _findOneMock: ReturnType<typeof vi.fn> };
  return db;
}

const MOCK_ISSUE = {
  identifier: 'ENG-123',
  title: 'My Test Ticket',
  url: 'https://linear.app/myteam/issue/ENG-123',
  fullDescription: 'This is the full description of the ticket.',
  description: 'Short description',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveMentions() — Linear ticket branch', () => {
  // Suppress console.log for the entire describe block once.
  // We do NOT use vi.restoreAllMocks() because that resets the LinearService
  // constructor mock's mockImplementation, causing linearSvc.getIssue to be
  // undefined and every subsequent getIssue call to silently throw.
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockGetIssue.mockReset();
    // Set a default resolved value for most tests; individual tests that need
    // a different behaviour override this themselves.
    mockGetIssue.mockResolvedValue(MOCK_ISSUE);
  });

  // ── AC-004 ────────────────────────────────────────────────────────────────

  describe('AC-004: resolved ticket → context block with [LINEAR TICKET:] prefix', () => {
    it('returns a context string that contains [LINEAR TICKET: ENG-123]', async () => {
      mockGetIssue.mockResolvedValue(MOCK_ISSUE);
      const db = createMockDb();

      const result = await resolveMentions('Can you summarise @ENG-123?', db);

      expect(result.context).toContain('[LINEAR TICKET: ENG-123]');
    });

    it('calls getIssue with the exact identifier (no @ prefix)', async () => {
      mockGetIssue.mockResolvedValue(MOCK_ISSUE);
      const db = createMockDb();

      await resolveMentions('Review @ENG-456 please', db);

      expect(mockGetIssue).toHaveBeenCalledOnce();
      expect(mockGetIssue).toHaveBeenCalledWith('ENG-456');
    });
  });

  // ── AC-004b ───────────────────────────────────────────────────────────────

  describe('AC-004b: exact context block format', () => {
    it('produces the exact expected format string', async () => {
      mockGetIssue.mockResolvedValue(MOCK_ISSUE);
      const db = createMockDb();

      const result = await resolveMentions('@ENG-123', db);

      const expected =
        `\n[LINEAR TICKET: ${MOCK_ISSUE.identifier}] Title: ${MOCK_ISSUE.title}` +
        `\nURL: ${MOCK_ISSUE.url}` +
        `\nDescription: ${MOCK_ISSUE.fullDescription}\n`;

      expect(result.context).toBe(expected);
    });

    it('uses fullDescription (not description) when both are present', async () => {
      mockGetIssue.mockResolvedValue({
        ...MOCK_ISSUE,
        fullDescription: 'Full detailed text',
        description: 'Short text',
      });
      const db = createMockDb();

      const result = await resolveMentions('@ENG-123', db);

      expect(result.context).toContain('Description: Full detailed text');
      expect(result.context).not.toContain('Description: Short text');
    });

    it('truncates description at 800 characters', async () => {
      const longDesc = 'A'.repeat(900);
      mockGetIssue.mockResolvedValue({
        ...MOCK_ISSUE,
        fullDescription: longDesc,
        description: null,
      });
      const db = createMockDb();

      const result = await resolveMentions('@ENG-123', db);

      // The Description value in the context block should be exactly 800 chars
      const match = result.context.match(/\nDescription: (A+)\n/);
      expect(match).not.toBeNull();
      expect(match![1].length).toBe(800);
    });

    it('falls back to description when fullDescription is absent', async () => {
      mockGetIssue.mockResolvedValue({
        ...MOCK_ISSUE,
        fullDescription: undefined,
        description: 'Fallback description',
      });
      const db = createMockDb();

      const result = await resolveMentions('@ENG-123', db);

      expect(result.context).toContain('Description: Fallback description');
    });
  });

  // ── AC-005 ────────────────────────────────────────────────────────────────

  describe('AC-005: LinearService.getIssue throws → silent skip, no error thrown', () => {
    it('does not throw when getIssue throws', async () => {
      mockGetIssue.mockRejectedValue(new Error('Linear not configured'));
      const db = createMockDb();

      await expect(resolveMentions('@ENG-999', db)).resolves.not.toThrow();
    });

    it('returns a context with no [LINEAR TICKET] block when getIssue throws', async () => {
      mockGetIssue.mockRejectedValue(new Error('Linear not configured'));
      const db = createMockDb();

      const result = await resolveMentions('@ENG-999', db);

      expect(result.context).not.toContain('[LINEAR TICKET');
    });

    it('does not throw when getIssue returns null (ticket not found)', async () => {
      mockGetIssue.mockResolvedValue(null);
      const db = createMockDb();

      const result = await resolveMentions('@ENG-999', db);

      expect(result.context).not.toContain('[LINEAR TICKET');
    });
  });

  // ── AC-006 ────────────────────────────────────────────────────────────────

  describe('AC-006: cap at 3 identifiers', () => {
    it('calls getIssue at most 3 times when 4 identifiers are in the message', async () => {
      mockGetIssue.mockResolvedValue(MOCK_ISSUE);
      const db = createMockDb();

      await resolveMentions('@ENG-1 @ENG-2 @ENG-3 @ENG-4', db);

      expect(mockGetIssue).toHaveBeenCalledTimes(3);
    });

    it('never resolves the 4th identifier', async () => {
      mockGetIssue.mockResolvedValue({ ...MOCK_ISSUE });
      const db = createMockDb();

      await resolveMentions('@ENG-1 @ENG-2 @ENG-3 @ENG-4', db);

      const calledWith = mockGetIssue.mock.calls.map((c: unknown[]) => c[0]);
      expect(calledWith).not.toContain('ENG-4');
    });

    it('deduplicates repeated identifiers before applying the cap', async () => {
      // ENG-1 appears twice → counts as one unique identifier
      mockGetIssue.mockResolvedValue(MOCK_ISSUE);
      const db = createMockDb();

      await resolveMentions('@ENG-1 @ENG-1 @ENG-2 @ENG-3 @ENG-4', db);

      // ENG-1 (deduped), ENG-2, ENG-3 → exactly 3 calls; ENG-4 is never called
      expect(mockGetIssue).toHaveBeenCalledTimes(3);
      const calledWith = mockGetIssue.mock.calls.map((c: unknown[]) => c[0]);
      expect(calledWith).not.toContain('ENG-4');
    });
  });

  // ── EC-009 ────────────────────────────────────────────────────────────────

  describe('EC-009: ticket identifiers are NOT looked up in workflow/repo/agent DB collections', () => {
    it('does not call db.collection().findOne() with a Linear ticket name', async () => {
      mockGetIssue.mockResolvedValue(MOCK_ISSUE);
      const db = createMockDb() as Db & { _findOneMock: ReturnType<typeof vi.fn> };

      await resolveMentions('Please look at @ENG-123', db);

      const findOneMock = (db as any)._findOneMock as ReturnType<typeof vi.fn>;
      const allCallFilters = findOneMock.mock.calls.map(
        (call: unknown[]) => call[0] as Record<string, unknown>,
      );
      const ticketLookup = allCallFilters.some(f => f.name === 'ENG-123');
      expect(ticketLookup).toBe(false);
    });

    it('does not query DB for any of the 3 resolved ticket identifiers', async () => {
      mockGetIssue.mockResolvedValue(MOCK_ISSUE);
      const db = createMockDb() as Db & { _findOneMock: ReturnType<typeof vi.fn> };

      await resolveMentions('@ENG-1 @ENG-2 @ENG-3', db);

      const findOneMock = (db as any)._findOneMock as ReturnType<typeof vi.fn>;
      const allCallFilters = findOneMock.mock.calls.map(
        (call: unknown[]) => call[0] as Record<string, unknown>,
      );
      const ticketIds = new Set(['ENG-1', 'ENG-2', 'ENG-3']);
      const anyTicketQueried = allCallFilters.some(
        f => typeof f.name === 'string' && ticketIds.has(f.name),
      );
      expect(anyTicketQueried).toBe(false);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('returns empty context when no @mentions are in the message', async () => {
      const db = createMockDb();

      const result = await resolveMentions('Hello world, no mentions here', db);

      expect(result.context).toBe('');
      expect(mockGetIssue).not.toHaveBeenCalled();
    });

    it('does not call getIssue for non-identifier mentions like @alice or @workflow-name', async () => {
      const db = createMockDb();

      await resolveMentions('@alice @my-workflow @some-repo', db);

      expect(mockGetIssue).not.toHaveBeenCalled();
    });

    it('returns repoPath: undefined for linear-only messages', async () => {
      mockGetIssue.mockResolvedValue(MOCK_ISSUE);
      const db = createMockDb();

      const result = await resolveMentions('@ENG-123', db);

      expect(result.repoPath).toBeUndefined();
    });
  });
});
