/**
 * Unit tests for design.routes.ts — SF-001 IDOR ownership guard fix.
 *
 * Verifies that:
 *  - POST /sessions stamps ownerUserId from req.user.sub (not body)
 *  - GET  /sessions passes ownerUserId filter from req.user.sub
 *  - PATCH/DELETE/GET-messages/POST-run return 403 for a different user
 *  - Same endpoints allow the owning user through
 *  - Guard is permissive when ownerUserId is null (unauthenticated session)
 *  - Guard is permissive when currentUserId is undefined (unauthenticated request)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { designRoutes } from './design.routes.js';
import { DesignSessionService } from '../services/design-session.service.js';
import { DesignRoutingService } from '../services/design-routing.service.js';

// ── Service mocks ─────────────────────────────────────────────────────────────

vi.mock('../services/design-session.service.js', () => ({
  DesignSessionService: vi.fn(),
}));
vi.mock('../services/design-routing.service.js', () => ({
  DesignRoutingService: vi.fn(),
}));
vi.mock('../services/design-repo.service.js', () => ({
  DesignRepoService: vi.fn(),
}));

// ── Shared mock functions ─────────────────────────────────────────────────────

const mockFindById = vi.fn();
const mockCreate = vi.fn();
const mockList = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockCreateMessage = vi.fn();
const mockListMessages = vi.fn();
const mockUpdateMessage = vi.fn();

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMockDb() {
  return {
    collection: (name: string) => {
      if (name === 'repos') return { findOne: vi.fn().mockResolvedValue(null) };
      return {};
    },
  } as any;
}

function buildApp(mockDb: any, userPayload?: { sub: string; email?: string }) {
  const app = express();
  app.use(express.json());
  // Simulate auth middleware — sets req.user from userPayload
  app.use((req, _res, next) => {
    if (userPayload) (req as any).user = userPayload;
    next();
  });
  app.use('/api/design', designRoutes(mockDb));
  return app;
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(DesignSessionService).mockImplementation(() => ({
    findById: mockFindById,
    create: mockCreate,
    list: mockList,
    update: mockUpdate,
    delete: mockDelete,
    createMessage: mockCreateMessage,
    listMessages: mockListMessages,
    updateMessage: mockUpdateMessage,
  } as any));

  vi.mocked(DesignRoutingService).mockImplementation(() => ({
    resolveRoute: vi.fn().mockReturnValue({
      mode: 'workflow',
      workflowName: 'test-wf',
      resolvedBy: 'auto',
      reason: 'test',
      outputMode: 'spec_only',
    }),
    dispatch: vi.fn().mockResolvedValue({ executionId: 'exec-001' }),
  } as any));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/design/sessions — stamps ownerUserId from req.user.sub', () => {
  it('uses sub and email from req.user, not from the request body', async () => {
    const createdSession = {
      _id: 'sess-001',
      title: 'Test',
      ownerUserId: 'user-sub-001',
      ownerEmail: 'a@b.com',
    };
    mockCreate.mockResolvedValue(createdSession);

    const app = buildApp(buildMockDb(), { sub: 'user-sub-001', email: 'a@b.com' });

    const res = await request(app)
      .post('/api/design/sessions')
      .send({ title: 'Test', designRepoId: 'repo1' });

    expect(res.status).toBe(201);

    // Assert create was called with ownerUserId from req.user.sub
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.ownerUserId).toBe('user-sub-001');
    expect(callArg.ownerEmail).toBe('a@b.com');
  });

  it('does not pick up ownerUserId from the request body', async () => {
    mockCreate.mockResolvedValue({ _id: 'sess-001', ownerUserId: 'user-sub-001' });

    const app = buildApp(buildMockDb(), { sub: 'user-sub-001', email: 'a@b.com' });

    // Attempt to supply ownerUserId via body — it must be ignored
    await request(app)
      .post('/api/design/sessions')
      .send({ title: 'Test', designRepoId: 'repo1', ownerUserId: 'injected-user' });

    const callArg = mockCreate.mock.calls[0][0];
    // The service must have been called with the authenticated sub, not the injected value
    expect(callArg.ownerUserId).toBe('user-sub-001');
    expect(callArg.ownerUserId).not.toBe('injected-user');
  });
});

describe('GET /api/design/sessions — passes ownerUserId filter from req.user.sub', () => {
  it('calls sessionService.list with ownerUserId from req.user.sub', async () => {
    mockList.mockResolvedValue([]);

    const app = buildApp(buildMockDb(), { sub: 'user-sub-001' });

    const res = await request(app).get('/api/design/sessions');

    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledOnce();
    const callArg = mockList.mock.calls[0][0];
    expect(callArg.ownerUserId).toBe('user-sub-001');
  });
});

describe('PATCH /api/design/sessions/:id — SF-001 ownership guard', () => {
  it('returns 403 when a different user tries to patch the session', async () => {
    mockFindById.mockResolvedValue({ _id: 'sess-001', ownerUserId: 'user-A' });

    const app = buildApp(buildMockDb(), { sub: 'user-B' });

    const res = await request(app)
      .patch('/api/design/sessions/sess-001')
      .send({ title: 'Hacked title' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DESIGN_SESSION_FORBIDDEN');
  });

  it('returns 200 when the owner updates their own session', async () => {
    const existing = { _id: 'sess-001', ownerUserId: 'user-A', title: 'Old title' };
    const updated = { ...existing, title: 'New title' };
    mockFindById.mockResolvedValue(existing);
    mockUpdate.mockResolvedValue(updated);

    const app = buildApp(buildMockDb(), { sub: 'user-A' });

    const res = await request(app)
      .patch('/api/design/sessions/sess-001')
      .send({ title: 'New title' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New title');
  });
});

describe('DELETE /api/design/sessions/:id — SF-001 ownership guard', () => {
  it('returns 403 when a different user tries to delete the session', async () => {
    mockFindById.mockResolvedValue({ _id: 'sess-001', ownerUserId: 'user-A' });

    const app = buildApp(buildMockDb(), { sub: 'user-B' });

    const res = await request(app).delete('/api/design/sessions/sess-001');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DESIGN_SESSION_FORBIDDEN');
  });

  it('returns 204 when the owner deletes their own session', async () => {
    mockFindById.mockResolvedValue({ _id: 'sess-001', ownerUserId: 'user-A' });
    mockDelete.mockResolvedValue(undefined);

    const app = buildApp(buildMockDb(), { sub: 'user-A' });

    const res = await request(app).delete('/api/design/sessions/sess-001');

    expect(res.status).toBe(204);
  });
});

describe('GET /api/design/sessions/:id/messages — SF-001 ownership guard', () => {
  it('returns 403 when a different user requests messages', async () => {
    mockFindById.mockResolvedValue({ _id: 'sess-001', ownerUserId: 'user-A' });

    const app = buildApp(buildMockDb(), { sub: 'user-B' });

    const res = await request(app).get('/api/design/sessions/sess-001/messages');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DESIGN_SESSION_FORBIDDEN');
  });
});

describe('POST /api/design/sessions/:id/run — SF-001 ownership guard', () => {
  it('returns 403 when a different user tries to run the session', async () => {
    mockFindById.mockResolvedValue({ _id: 'sess-001', ownerUserId: 'user-A' });

    const app = buildApp(buildMockDb(), { sub: 'user-B' });

    const res = await request(app)
      .post('/api/design/sessions/sess-001/run')
      .send({ prompt: 'design something' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DESIGN_SESSION_FORBIDDEN');
  });
});

describe('Ownership guard edge cases', () => {
  it('allows any authenticated user when ownerUserId is null (unauthenticated session)', async () => {
    // ownerUserId is null — existing session has no owner, guard must pass through
    const existing = { _id: 'sess-001', ownerUserId: null, title: 'Old' };
    const updated = { ...existing, title: 'New' };
    mockFindById.mockResolvedValue(existing);
    mockUpdate.mockResolvedValue(updated);

    const app = buildApp(buildMockDb(), { sub: 'some-user' });

    const res = await request(app)
      .patch('/api/design/sessions/sess-001')
      .send({ title: 'New' });

    // Guard condition: existing.ownerUserId && currentUserId && ... → false when ownerUserId is falsy
    expect(res.status).toBe(200);
  });

  it('allows unauthenticated request (no req.user) even when session has an owner', async () => {
    // currentUserId is undefined — guard condition is: existing.ownerUserId && currentUserId && ...
    // → false when currentUserId is falsy, so request passes through
    const existing = { _id: 'sess-001', ownerUserId: 'user-A', title: 'Old' };
    const updated = { ...existing, title: 'New' };
    mockFindById.mockResolvedValue(existing);
    mockUpdate.mockResolvedValue(updated);

    // No userPayload → req.user is undefined → currentUserId is undefined
    const app = buildApp(buildMockDb(), undefined);

    const res = await request(app)
      .patch('/api/design/sessions/sess-001')
      .send({ title: 'New' });

    expect(res.status).toBe(200);
  });
});

describe('POST /api/design/sessions/:id/run — DESIGN_MISSING_WORKFLOW_INPUTS converted to direct response', () => {
  it('returns 200 with status=completed and directResponse when dispatch throws DESIGN_MISSING_WORKFLOW_INPUTS', async () => {
    const clarification = "I'd love to generate designs! Please configure a source repo first.";
    const session = { _id: 'sess-001', ownerUserId: null, status: 'idle' };
    const assistantMsg = { _id: { toString: () => 'msg-001' } };

    mockFindById.mockResolvedValue(session);
    mockCreateMessage.mockResolvedValue(assistantMsg);
    mockUpdate.mockResolvedValue({ ...session, status: 'idle' });
    mockUpdateMessage.mockResolvedValue(undefined);

    vi.mocked(DesignRoutingService).mockImplementation(() => ({
      resolveRoute: vi.fn().mockReturnValue({
        mode: 'workflow',
        workflowName: 'source-prd-to-ui-designs-variations',
        resolvedBy: 'auto',
        reason: 'Design request',
        outputMode: 'spec_only',
      }),
      dispatch: vi.fn().mockRejectedValue(
        Object.assign(new Error(clarification), {
          code: 'DESIGN_MISSING_WORKFLOW_INPUTS',
          clarification,
          missingInputs: ['source_repo_path'],
        }),
      ),
    } as any));

    const app = buildApp(buildMockDb());

    const res = await request(app)
      .post('/api/design/sessions/sess-001/run')
      .send({ prompt: 'generate a dashboard' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.directResponse).toBe(clarification);
    expect(mockUpdateMessage).toHaveBeenCalledWith(
      'msg-001',
      expect.objectContaining({ status: 'completed', content: clarification }),
    );
  });

  it('still returns 502 for real dispatch errors (not missing-input clarifications)', async () => {
    const session = { _id: 'sess-002', ownerUserId: null, status: 'idle' };
    const assistantMsg = { _id: { toString: () => 'msg-002' } };

    mockFindById.mockResolvedValue(session);
    mockCreateMessage.mockResolvedValue(assistantMsg);
    mockUpdate.mockResolvedValue({ ...session, status: 'failed' });
    mockUpdateMessage.mockResolvedValue(undefined);

    vi.mocked(DesignRoutingService).mockImplementation(() => ({
      resolveRoute: vi.fn().mockReturnValue({
        mode: 'workflow',
        workflowName: 'source-prd-to-ui-designs-variations',
        resolvedBy: 'auto',
        reason: 'Design request',
        outputMode: 'spec_only',
      }),
      dispatch: vi.fn().mockRejectedValue(
        Object.assign(new Error('Workflow execution failed'), { code: 'DESIGN_DISPATCH_FAILED' }),
      ),
    } as any));

    const app = buildApp(buildMockDb());

    const res = await request(app)
      .post('/api/design/sessions/sess-002/run')
      .send({ prompt: 'build a navbar' });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('DESIGN_DISPATCH_FAILED');
  });
});

describe('GET /api/design/sessions/:id/reconcile — reconcile streaming messages', () => {
  it('returns 404 when session not found', async () => {
    mockFindById.mockResolvedValue(null);

    const app = buildApp(buildMockDb(), { sub: 'user-A' });
    const res = await request(app).get('/api/design/sessions/nonexistent/reconcile');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DESIGN_SESSION_NOT_FOUND');
  });

  it('returns 403 when a different user tries to reconcile', async () => {
    mockFindById.mockResolvedValue({ _id: 'sess-001', ownerUserId: 'user-A' });

    const app = buildApp(buildMockDb(), { sub: 'user-B' });
    const res = await request(app).get('/api/design/sessions/sess-001/reconcile');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DESIGN_SESSION_FORBIDDEN');
  });

  it('reconciles a completed execution into the assistant message', async () => {
    const session = { _id: 'sess-001', ownerUserId: 'user-A', status: 'running' };
    const streamingMsg = {
      _id: { toString: () => 'msg-001' },
      designSessionId: 'sess-001',
      role: 'assistant',
      status: 'streaming',
      agentRunId: 'exec-completed-001',
      content: '',
    };
    const completedMsg = { ...streamingMsg, status: 'completed', content: 'Here is the design.' };

    mockFindById
      .mockResolvedValueOnce(session)         // initial findById
      .mockResolvedValueOnce({ ...session, status: 'idle' }); // after update
    mockListMessages
      .mockResolvedValueOnce([streamingMsg])   // first listMessages (streaming msgs)
      .mockResolvedValueOnce([completedMsg]);  // second listMessages (after reconcile)
    mockUpdateMessage.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue({ ...session, status: 'idle' });

    const execRow = { status: 'completed', id: 'exec-completed-001' };
    const traceRow = { rawResponse: 'Here is the design.', output: {} };
    const mockDb = {
      collection: (name: string) => {
        if (name === 'repos') return { findOne: vi.fn().mockResolvedValue(null) };
        if (name === 'executions') return { findOne: vi.fn().mockResolvedValue(execRow) };
        if (name === 'execution_traces') return { findOne: vi.fn().mockResolvedValue(traceRow) };
        return {};
      },
    } as any;

    const app = buildApp(mockDb, { sub: 'user-A' });
    const res = await request(app).get('/api/design/sessions/sess-001/reconcile');

    expect(res.status).toBe(200);
    expect(res.body.reconciledCount).toBe(1);
    expect(mockUpdateMessage).toHaveBeenCalledWith(
      'msg-001',
      expect.objectContaining({ status: 'completed', content: 'Here is the design.' }),
    );
  });

  it('reconciles a failed execution into the assistant message as failed', async () => {
    const session = { _id: 'sess-001', ownerUserId: 'user-A', status: 'running' };
    const streamingMsg = {
      _id: { toString: () => 'msg-002' },
      designSessionId: 'sess-001',
      role: 'assistant',
      status: 'streaming',
      agentRunId: 'exec-failed-002',
      content: '',
    };
    const failedMsg = { ...streamingMsg, status: 'failed', error: 'Agent crashed' };

    mockFindById
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, status: 'failed' });
    mockListMessages
      .mockResolvedValueOnce([streamingMsg])
      .mockResolvedValueOnce([failedMsg]);
    mockUpdateMessage.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue({ ...session, status: 'failed' });

    const execRow = { status: 'failed', id: 'exec-failed-002', errorMessage: 'Agent crashed' };
    const mockDb = {
      collection: (name: string) => {
        if (name === 'repos') return { findOne: vi.fn().mockResolvedValue(null) };
        if (name === 'executions') return { findOne: vi.fn().mockResolvedValue(execRow) };
        if (name === 'execution_traces') return { findOne: vi.fn().mockResolvedValue(null) };
        return {};
      },
    } as any;

    const app = buildApp(mockDb, { sub: 'user-A' });
    const res = await request(app).get('/api/design/sessions/sess-001/reconcile');

    expect(res.status).toBe(200);
    expect(res.body.reconciledCount).toBe(1);
    expect(mockUpdateMessage).toHaveBeenCalledWith(
      'msg-002',
      expect.objectContaining({ status: 'failed', error: 'Agent crashed' }),
    );
  });

  it('returns 0 reconciled when no streaming messages exist', async () => {
    const session = { _id: 'sess-001', ownerUserId: 'user-A', status: 'idle' };
    const completedMsg = {
      _id: { toString: () => 'msg-003' },
      designSessionId: 'sess-001',
      role: 'assistant',
      status: 'completed',
      content: 'Done',
    };

    mockFindById
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(session);
    mockListMessages
      .mockResolvedValueOnce([completedMsg])
      .mockResolvedValueOnce([completedMsg]);

    const mockDb = {
      collection: (name: string) => {
        if (name === 'repos') return { findOne: vi.fn().mockResolvedValue(null) };
        if (name === 'executions') return { findOne: vi.fn().mockResolvedValue(null) };
        return {};
      },
    } as any;

    const app = buildApp(mockDb, { sub: 'user-A' });
    const res = await request(app).get('/api/design/sessions/sess-001/reconcile');

    expect(res.status).toBe(200);
    expect(res.body.reconciledCount).toBe(0);
  });
});
