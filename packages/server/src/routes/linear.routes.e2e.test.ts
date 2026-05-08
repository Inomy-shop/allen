/**
 * E2E route tests for linear.routes.ts
 *
 * Covers:
 *   AC-001 – GET /api/linear/issues?assignee=me resolves req.user.email and
 *             forwards it as assigneeEmail to service.listIssues()
 *   AC-002 – GET /api/linear/issues?assignee=<anything-else> → assigneeEmail
 *             is NOT forwarded to service.listIssues()
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Db } from 'mongodb';

// ---------------------------------------------------------------------------
// Hoist the mock fn so it is available inside the vi.mock factory.
// vi.mock() calls are hoisted to the top of the compiled output, but the
// mock factory closure captures variables from the scope above. vi.hoisted()
// ensures the variable is created BEFORE vi.mock() runs.
// ---------------------------------------------------------------------------
const mockListIssues = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('../services/linear.service.js', () => ({
  LinearService: vi.fn().mockImplementation(() => ({
    listIssues: mockListIssues,
    getIssue: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue({ configured: false }),
    listProjects: vi.fn().mockResolvedValue([]),
    assignAgent: vi.fn().mockResolvedValue(null),
    dispatch: vi.fn().mockResolvedValue(null),
    dispatchWorkflow: vi.fn().mockResolvedValue(null),
  })),
  LINEAR_TOKEN_ENV_KEY: 'ALLEN_LINEAR_ACCESS_TOKEN',
}));

// Import AFTER the mock is registered.
import { linearRoutes } from '../routes/linear.routes.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { signAccessToken } from '../auth/jwt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_DB = {} as unknown as Db;

function makeApp() {
  // Ensure JWT middleware can verify tokens.
  process.env.JWT_ACCESS_SECRET = 'test-linear-routes-secret';
  process.env.ACCESS_TOKEN_TTL = '1d';

  const app = express();
  app.use(express.json());
  // Mount requireAuth before the routes so req.user is populated.
  app.use('/api/linear', requireAuth, linearRoutes(FAKE_DB));
  return app;
}

function makeToken(email: string = 'test@example.com'): string {
  return signAccessToken({ sub: 'user-id-001', email, role: 'user', mustResetPassword: false });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/linear/issues', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    mockListIssues.mockClear();
    mockListIssues.mockResolvedValue([]);
    app = makeApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── AC-001 ─────────────────────────────────────────────────────────────

  describe('AC-001: assignee=me resolves to authenticated user email', () => {
    it('calls listIssues with assigneeEmail equal to req.user.email', async () => {
      const email = 'alice@example.com';
      const token = makeToken(email);

      const res = await request(app)
        .get('/api/linear/issues?assignee=me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(mockListIssues).toHaveBeenCalledOnce();

      const callArgs = mockListIssues.mock.calls[0][0] as {
        assigneeEmail?: string;
        [key: string]: unknown;
      };
      expect(callArgs.assigneeEmail).toBe(email);
    });

    it('returns 200 with the issues array from service', async () => {
      const mockIssues = [{ id: 'i1', identifier: 'ENG-1', title: 'Test issue' }];
      mockListIssues.mockResolvedValue(mockIssues);

      const res = await request(app)
        .get('/api/linear/issues?assignee=me')
        .set('Authorization', `Bearer ${makeToken('bob@example.com')}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockIssues);
    });

    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get('/api/linear/issues?assignee=me');
      expect(res.status).toBe(401);
      expect(mockListIssues).not.toHaveBeenCalled();
    });
  });

  // ── AC-002 ─────────────────────────────────────────────────────────────

  describe('AC-002: assignee with any other value is ignored', () => {
    it('does NOT set assigneeEmail when assignee=unknown', async () => {
      const token = makeToken('charlie@example.com');

      const res = await request(app)
        .get('/api/linear/issues?assignee=unknown')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(mockListIssues).toHaveBeenCalledOnce();

      const callArgs = mockListIssues.mock.calls[0][0] as {
        assigneeEmail?: string;
      };
      expect(callArgs.assigneeEmail).toBeUndefined();
    });

    it('does NOT set assigneeEmail when assignee=all', async () => {
      const token = makeToken();

      await request(app)
        .get('/api/linear/issues?assignee=all')
        .set('Authorization', `Bearer ${token}`);

      const callArgs = mockListIssues.mock.calls[0][0] as {
        assigneeEmail?: string;
      };
      expect(callArgs.assigneeEmail).toBeUndefined();
    });

    it('does NOT set assigneeEmail when assignee param is absent', async () => {
      const token = makeToken();

      await request(app)
        .get('/api/linear/issues')
        .set('Authorization', `Bearer ${token}`);

      const callArgs = mockListIssues.mock.calls[0][0] as {
        assigneeEmail?: string;
      };
      expect(callArgs.assigneeEmail).toBeUndefined();
    });
  });
});
