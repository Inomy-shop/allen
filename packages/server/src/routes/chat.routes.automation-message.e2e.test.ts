/**
 * E2E route tests for POST /api/chat/sessions/:id/automation-message
 *
 * Tests:
 *  1. Valid request inserts message and returns { inserted: true, messageId }
 *  2. Returns 404 when session is not found
 *  3. Returns 400 when role is missing or invalid
 *  4. Returns 400 when content is empty
 *  5. Returns 401 when no auth token is provided
 *  6. Returns 403 when the session is not an automation session
 *  7. Returns 429 when the rate limit is exceeded
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Db } from 'mongodb';

// ── Hoist mock fns before vi.mock() ──────────────────────────────────────────

const mockAppendAutomationMessage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: 'msg-abc123' }),
);
const mockCancelChatSession = vi.hoisted(() => vi.fn().mockResolvedValue({ cancelled: false }));
const mockExecuteChatTool = vi.hoisted(() => vi.fn().mockResolvedValue({}));

// ── Mock all service modules that chat.routes.ts imports ─────────────────────

vi.mock('../services/chat.service.js', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    appendAutomationMessage: mockAppendAutomationMessage,
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ _id: 'sess-1' }),
    getSession: vi.fn().mockResolvedValue(null),
    getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    subscribeToStream: vi.fn(),
    isStreaming: vi.fn().mockReturnValue(false),
    generateTitleForSession: vi.fn().mockResolvedValue('Test Title'),
    updateSession: vi.fn().mockResolvedValue(null),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    broadcastToSession: vi.fn(),
    getProviders: vi.fn().mockReturnValue([]),
  })),
  cancelChatSession: mockCancelChatSession,
}));

vi.mock('../services/chat-tools.js', () => ({
  executeChatTool: mockExecuteChatTool,
  resolveActiveSession: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    submitInput: vi.fn().mockResolvedValue(false),
  })),
}));

vi.mock('../services/intervention.service.js', () => ({
  InterventionService: vi.fn().mockImplementation(() => ({
    listForWorkflowRun: vi.fn().mockResolvedValue([]),
    recordResponse: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../services/user.service.js', () => ({
  UserService: vi.fn().mockImplementation(() => ({
    findById: vi.fn().mockResolvedValue(null),
  })),
}));

// Import after mocks
import { chatRoutes } from '../routes/chat.routes.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { signAccessToken } from '../auth/jwt.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_DB = {} as unknown as Db;
const VALID_SESSION_ID = '507f1f77bcf86cd799439011';

function makeApp() {
  process.env.JWT_ACCESS_SECRET = 'test-chat-routes-e2e-secret';
  process.env.ACCESS_TOKEN_TTL = '1d';

  const app = express();
  app.use(express.json());
  app.use('/api/chat', requireAuth, chatRoutes(FAKE_DB));
  return app;
}

function makeToken(role: 'admin' | 'user' = 'admin'): string {
  return signAccessToken({
    sub: 'cron-system',
    email: 'cron@internal.local',
    role,
    mustResetPassword: false,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/chat/sessions/:id/automation-message', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    mockAppendAutomationMessage.mockClear();
    mockAppendAutomationMessage.mockResolvedValue({ messageId: 'msg-abc123' });
    mockExecuteChatTool.mockClear();
    mockExecuteChatTool.mockResolvedValue({});
    app = makeApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns { inserted: true, messageId } for a valid request', async () => {
    const res = await request(app)
      .post(`/api/chat/sessions/${VALID_SESSION_ID}/automation-message`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ role: 'assistant', content: '# Daily Briefing\nAll systems nominal.' });

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(true);
    expect(res.body.messageId).toBe('msg-abc123');
    expect(mockAppendAutomationMessage).toHaveBeenCalledWith(
      VALID_SESSION_ID,
      'assistant',
      '# Daily Briefing\nAll systems nominal.',
    );
  });

  it('returns 404 when the session is not found', async () => {
    mockAppendAutomationMessage.mockRejectedValueOnce(new Error('Session not found'));

    const res = await request(app)
      .post(`/api/chat/sessions/${VALID_SESSION_ID}/automation-message`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ role: 'assistant', content: 'Hello' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Session not found');
  });

  it('returns 400 when role is invalid', async () => {
    const res = await request(app)
      .post(`/api/chat/sessions/${VALID_SESSION_ID}/automation-message`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ role: 'system', content: 'Hello' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role must be one of/);
    expect(mockAppendAutomationMessage).not.toHaveBeenCalled();
  });

  it('returns 400 when content is empty', async () => {
    const res = await request(app)
      .post(`/api/chat/sessions/${VALID_SESSION_ID}/automation-message`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ role: 'assistant', content: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/);
    expect(mockAppendAutomationMessage).not.toHaveBeenCalled();
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app)
      .post(`/api/chat/sessions/${VALID_SESSION_ID}/automation-message`)
      .send({ role: 'assistant', content: 'Hello' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when the session is not an automation session', async () => {
    mockAppendAutomationMessage.mockRejectedValueOnce(new Error('Not an automation session'));

    const res = await request(app)
      .post(`/api/chat/sessions/${VALID_SESSION_ID}/automation-message`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ role: 'assistant', content: 'Hello' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not an automation session');
  });

  it('returns 429 when the rate limit is exceeded', async () => {
    // Use a unique sub so this test does not bleed state into others (module-level Map)
    const uniqueSub = `rate-limit-test-${Date.now()}`;
    const limitedToken = signAccessToken({
      sub: uniqueSub,
      email: 'rate-test@internal.local',
      role: 'admin',
      mustResetPassword: false,
    });

    // Exhaust the 60 req/min window
    for (let i = 0; i < 60; i++) {
      mockAppendAutomationMessage.mockResolvedValueOnce({ messageId: `msg-${i}` });
      await request(app)
        .post(`/api/chat/sessions/${VALID_SESSION_ID}/automation-message`)
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({ role: 'assistant', content: 'ping' });
    }

    // The 61st request should be rate-limited
    const res = await request(app)
      .post(`/api/chat/sessions/${VALID_SESSION_ID}/automation-message`)
      .set('Authorization', `Bearer ${limitedToken}`)
      .send({ role: 'assistant', content: 'over the limit' });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too many requests/i);
  });
});

describe('POST /api/chat/spawn-agent', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    mockExecuteChatTool.mockClear();
    mockExecuteChatTool.mockResolvedValue({ execution_id: 'exec-1', status: 'running' });
    app = makeApp();
  });

  it('forwards structured context_query to spawn_agent', async () => {
    const contextQuery = {
      user_request: 'Analyze product grouping',
      topics: ['product grouping'],
    };
    const res = await request(app)
      .post('/api/chat/spawn-agent')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        agent_name: 'backend-developer',
        prompt: 'Run analysis',
        context_query: contextQuery,
        repo_path: '/repo',
      });

    expect(res.status).toBe(200);
    expect(mockExecuteChatTool).toHaveBeenCalledWith(
      'spawn_agent',
      expect.objectContaining({
        agent_name: 'backend-developer',
        prompt: 'Run analysis',
        context_query: contextQuery,
        repo_path: '/repo',
      }),
      FAKE_DB,
      expect.any(Object),
    );
  });
});
