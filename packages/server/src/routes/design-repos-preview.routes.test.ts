/**
 * Unit tests for workspace-resolution in the design-repos preview-start route.
 *
 * Verifies that POST /repos/:repoId/preview-start resolves the preview root
 * from the chatSession's linked workspace (worktreePath) when one exists,
 * and falls back to the repo's registered path when no workspace is linked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../services/design-repo.service.js', () => ({
  DesignRepoService: vi.fn(),
}));

vi.mock('../services/design-preview.service.js', () => ({
  DesignPreviewService: vi.fn(),
}));

vi.mock('../services/design-repo-preview-manager.js', () => ({
  DesignRepoPreviewManager: {
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn(),
    getProxyTarget: vi.fn(),
    stopAll: vi.fn(),
  },
}));

import { DesignRepoService } from '../services/design-repo.service.js';
import { DesignPreviewService } from '../services/design-preview.service.js';
import { DesignRepoPreviewManager } from '../services/design-repo-preview-manager.js';
import { designReposRoutes } from './design-repos.routes.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ID = 'repo-abc123';
const REPO_PATH = '/repos/my-design-repo';
const WORKTREE_PATH = '/workspaces/ws-001/tree';
const CHAT_SESSION_ID = 'chat-session-xyz';

const MOCK_CONFIG = {
  enabled: true,
  workingDirectory: '',
  startCommand: 'npm run dev',
  portMode: 'auto',
};

function buildMockDb(workspaceFindResult: any = null) {
  const findOneMock = vi.fn().mockResolvedValue(workspaceFindResult);
  return {
    collection: (name: string) => {
      if (name === 'workspaces') return { findOne: findOneMock };
      // Return a no-op findOne for other collections so resolvePreviewRoot can
      // call chat_sessions / executions without throwing.
      return { findOne: vi.fn().mockResolvedValue(null) };
    },
    _findOneMock: findOneMock,
  } as any;
}

function buildApp(mockDb: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/design', designReposRoutes(mockDb));
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/design/repos/:repoId/preview-start — workspace resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(DesignPreviewService).mockImplementation(() => ({
      validateConfig: vi.fn().mockReturnValue({ ok: true }),
    } as any));

    vi.mocked(DesignRepoService).mockImplementation(() => ({
      getPreviewConfig: vi.fn().mockResolvedValue(MOCK_CONFIG),
      getRepoById: vi.fn().mockResolvedValue({ _id: REPO_ID, path: REPO_PATH }),
      savePreviewConfig: vi.fn(),
    } as any));

    vi.mocked(DesignRepoPreviewManager.start).mockResolvedValue({
      port: 12000,
      previewUrl: 'http://127.0.0.1:12000/',
    });
  });

  it('uses repo.path when no workspace is linked to the chatSessionId', async () => {
    const db = buildMockDb(null); // no workspace found
    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ chatSessionId: CHAT_SESSION_ID });

    expect(res.status).toBe(200);
    expect(vi.mocked(DesignRepoPreviewManager.start)).toHaveBeenCalledWith(
      REPO_ID,
      MOCK_CONFIG,
      REPO_PATH,  // falls back to repo path
      CHAT_SESSION_ID,
    );
  });

  it('uses workspace worktreePath when a workspace is linked via chatSessionId', async () => {
    const db = buildMockDb({ _id: 'ws-001', worktreePath: WORKTREE_PATH });
    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ chatSessionId: CHAT_SESSION_ID });

    expect(res.status).toBe(200);
    expect(vi.mocked(DesignRepoPreviewManager.start)).toHaveBeenCalledWith(
      REPO_ID,
      MOCK_CONFIG,
      WORKTREE_PATH,  // uses worktree
      CHAT_SESSION_ID,
    );
  });

  it('skips workspace lookup when chatSessionId is "global"', async () => {
    const db = buildMockDb({ _id: 'ws-001', worktreePath: WORKTREE_PATH }); // workspace exists but shouldn't be used
    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ chatSessionId: 'global' });

    expect(res.status).toBe(200);
    // Must NOT call workspace lookup for 'global' scope
    expect(db._findOneMock).not.toHaveBeenCalled();
    // Must use repo path
    expect(vi.mocked(DesignRepoPreviewManager.start)).toHaveBeenCalledWith(
      REPO_ID,
      MOCK_CONFIG,
      REPO_PATH,
      'global',
    );
  });

  it('falls back to repo.path when chatSessionId not found in chatSessionIds array either', async () => {
    // First findOne (chatSessionId field) returns null, second (chatSessionIds array) also returns null
    const findOneMock = vi.fn().mockResolvedValue(null);
    const db = {
      collection: () => ({ findOne: findOneMock }),
      _findOneMock: findOneMock,
    } as any;

    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ chatSessionId: CHAT_SESSION_ID });

    expect(res.status).toBe(200);
    expect(vi.mocked(DesignRepoPreviewManager.start)).toHaveBeenCalledWith(
      REPO_ID,
      MOCK_CONFIG,
      REPO_PATH,
      CHAT_SESSION_ID,
    );
  });

  it('resolves worktree via chat_sessions.workspaceId when workspaces direct link is absent', async () => {
    // The workspaces collection returns null for direct lookups,
    // but chat_sessions has workspaceId pointing to a workspace with a worktreePath.
    // VALID_SESSION_ID must be a valid 24-char hex ObjectId so ObjectId.isValid() passes.
    const VALID_SESSION_ID = '6a22c1760baff38e487bd097'; // valid 24-char hex
    // WS_OBJECT_ID must also be a valid 24-char hex ObjectId so the second ObjectId.isValid() passes.
    const WS_OBJECT_ID = '507f1f77bcf86cd799439011'; // valid 24-char hex
    const findOneMock = vi.fn()
      .mockResolvedValueOnce(null)  // workspaces.chatSessionId → null
      .mockResolvedValueOnce(null)  // workspaces.chatSessionIds → null
      .mockResolvedValueOnce({ _id: WS_OBJECT_ID, workspaceId: WS_OBJECT_ID })  // chat_sessions lookup
      .mockResolvedValueOnce({ _id: WS_OBJECT_ID, worktreePath: WORKTREE_PATH }); // workspaces by id

    const db = {
      collection: (name: string) => {
        if (name === 'workspaces' || name === 'chat_sessions') return { findOne: findOneMock };
        return { findOne: vi.fn().mockResolvedValue(null) };
      },
    } as any;

    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ chatSessionId: VALID_SESSION_ID });

    expect(res.status).toBe(200);
    // The start call should receive WORKTREE_PATH
    const startCall = vi.mocked(DesignRepoPreviewManager.start).mock.calls[0];
    expect(startCall[2]).toBe(WORKTREE_PATH);
  });

  it('resolves worktree via executions.meta.workspaceId as last resort', async () => {
    // All workspace/session direct lookups return null.
    // An execution for this chatSession has meta.workspaceId pointing to a workspace.
    // CHAT_SESSION_ID ('chat-session-xyz') is not a valid ObjectId, so the
    // chat_sessions.workspaceId path (step 3) is skipped — reaching executions (step 4).
    const EXEC_WS_PATH = '/workspaces/exec-ws-001/tree';
    // EXEC_WS_ID must be a valid 24-char hex ObjectId so ObjectId.isValid() passes.
    const EXEC_WS_ID = '507f191e810c19729de860ea'; // valid 24-char hex

    const workspacesFindOne = vi.fn()
      .mockResolvedValueOnce(null)   // chatSessionId direct
      .mockResolvedValueOnce(null)   // chatSessionIds array
      .mockResolvedValueOnce({ _id: EXEC_WS_ID, worktreePath: EXEC_WS_PATH }); // by exec workspaceId
    const sessionsFindOne = vi.fn().mockResolvedValueOnce(null); // no workspaceId on session
    const executionsFindOne = vi.fn().mockResolvedValueOnce({
      meta: { chatSessionId: CHAT_SESSION_ID, workspaceId: EXEC_WS_ID },
    });

    const db = {
      collection: (name: string) => {
        if (name === 'workspaces') return { findOne: workspacesFindOne };
        if (name === 'chat_sessions') return { findOne: sessionsFindOne };
        if (name === 'executions') return { findOne: executionsFindOne };
        return { findOne: vi.fn().mockResolvedValue(null) };
      },
    } as any;

    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ chatSessionId: CHAT_SESSION_ID });

    expect(res.status).toBe(200);
    const startCall = vi.mocked(DesignRepoPreviewManager.start).mock.calls[0];
    expect(startCall[2]).toBe(EXEC_WS_PATH);
  });

  it('returns cwd in the preview-start response body', async () => {
    const db = buildMockDb({ _id: 'ws-001', worktreePath: WORKTREE_PATH });
    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ chatSessionId: CHAT_SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cwd', WORKTREE_PATH);
  });

  it('uses explicit workspaceId from request body, bypassing chatSession DB lookup', async () => {
    // When workspaceId is explicitly sent, the server must look up by _id directly
    // and NOT fall back through the chatSession chain.
    const EXPLICIT_WS_ID = '507f1f77bcf86cd799439099'; // valid 24-char hex
    const workspacesFindOne = vi.fn().mockResolvedValue({ _id: EXPLICIT_WS_ID, worktreePath: WORKTREE_PATH });
    const db = {
      collection: (name: string) => {
        if (name === 'workspaces') return { findOne: workspacesFindOne };
        return { findOne: vi.fn().mockResolvedValue(null) };
      },
    } as any;
    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ chatSessionId: CHAT_SESSION_ID, workspaceId: EXPLICIT_WS_ID });

    expect(res.status).toBe(200);
    expect(vi.mocked(DesignRepoPreviewManager.start)).toHaveBeenCalledWith(
      REPO_ID,
      MOCK_CONFIG,
      WORKTREE_PATH,   // explicit workspace path wins
      CHAT_SESSION_ID, // chatSessionId still used for scope tracking
    );
    // workspacesFindOne called exactly once (the explicit _id lookup)
    expect(workspacesFindOne).toHaveBeenCalledTimes(1);
    expect(workspacesFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything(), status: { $nin: ['archived', 'failed'] } }),
      expect.anything(),
    );
  });

  it('returns 404 when explicit workspaceId is not found or archived', async () => {
    const EXPLICIT_WS_ID = '507f1f77bcf86cd799439099'; // valid 24-char hex
    const db = {
      collection: (name: string) => {
        if (name === 'workspaces') return { findOne: vi.fn().mockResolvedValue(null) };
        return { findOne: vi.fn().mockResolvedValue(null) };
      },
    } as any;
    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ workspaceId: EXPLICIT_WS_ID });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 400 when explicit workspaceId is not a valid ObjectId', async () => {
    const db = buildMockDb(null);
    const app = buildApp(db);

    const res = await request(app)
      .post(`/api/design/repos/${REPO_ID}/preview-start`)
      .send({ workspaceId: 'not-a-valid-objectid' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WORKSPACE_ID_INVALID');
  });
});

describe('GET /api/design/repos/:repoId/preview-status — cwd in response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(DesignPreviewService).mockImplementation(() => ({
      validateConfig: vi.fn().mockReturnValue({ ok: true }),
    } as any));
    vi.mocked(DesignRepoService).mockImplementation(() => ({
      getPreviewConfig: vi.fn().mockResolvedValue(MOCK_CONFIG),
      getRepoById: vi.fn().mockResolvedValue({ _id: REPO_ID, path: REPO_PATH }),
    } as any));
  });

  it('includes cwd in preview-status response when a preview is running', async () => {
    const db = buildMockDb(null);
    const app = buildApp(db);

    vi.mocked(DesignRepoPreviewManager.getStatus).mockReturnValue({
      repoId: REPO_ID,
      chatSessionId: CHAT_SESSION_ID,
      port: 12000,
      status: 'ready',
      repoPath: REPO_PATH,
      cwd: WORKTREE_PATH,
      startedAt: new Date(),
      previewUrl: 'http://127.0.0.1:12000/',
    });

    const res = await request(app)
      .get(`/api/design/repos/${REPO_ID}/preview-status?chatSessionId=${CHAT_SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cwd', WORKTREE_PATH);
  });
});
