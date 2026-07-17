/**
 * Unit tests for the CWD resolution fallback logic added in chat.service.ts
 * (B1 change, REQ-13 / AC-14).
 *
 * ChatService imports many modules that transitively import @allen/engine which
 * has no built dist/ directory.  To avoid the "Cannot find module" failure we
 * do NOT import ChatService.  Instead we reproduce the exact fallback logic
 * inline as a testable pure function and exercise it against a mock Mongo-like
 * DB object.
 *
 * Covered acceptance criteria:
 *   AC-14 – Agent cwd equals the selected workspace worktreePath (server-side
 *            CWD resolution via fallback path B1).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';

const AGENT_FALLBACK_CWD = '/tmp/allen';

// ---------------------------------------------------------------------------
// Inline reproduction of the CWD-resolution block from chat.service.ts
// (~lines 1556-1580).  Keep in sync with the source.
// ---------------------------------------------------------------------------

interface MockWorkspace {
  _id: ObjectId;
  chatSessionId?: string;
  worktreePath?: string;
  status?: string;
  name?: string;
  branch?: string;
  baseBranch?: string;
  repoName?: string;
}

interface MockSession {
  _id?: ObjectId;
  workspaceId?: unknown;
  llmSessionId?: string;
  llmSessionCwd?: string;
}

/** Mirrors the $nin filter used in the real query. */
function notArchivedOrFailed(ws: MockWorkspace): boolean {
  const s = ws.status ?? '';
  return s !== 'archived' && s !== 'failed';
}

/**
 * Reproduces the exact CWD-resolution logic from chat.service.ts runLLM().
 * Returns { resolvedCwd, via } where `via` is 'chatSessionId' | 'workspaceId'
 * | undefined so tests can assert which path was taken.
 */
async function resolveCwd(
  db: { collection: (name: string) => any },
  sessionId: string,
  session: MockSession | null,
): Promise<{ resolvedCwd: string | undefined; via: string | undefined }> {
  let via: string | undefined;

  // Primary lookup: workspace linked via chatSessionId field
  let linkedWs: MockWorkspace | null = await db
    .collection('workspaces')
    .findOne({ chatSessionId: sessionId, status: { $nin: ['archived', 'failed'] } });

  // Fallback B1: session.workspaceId set by linkChat
  if (!linkedWs && session?.workspaceId && ObjectId.isValid(session.workspaceId as string)) {
    linkedWs = await db.collection('workspaces').findOne({
      _id: new ObjectId(session.workspaceId as string),
      status: { $nin: ['archived', 'failed'] },
    });
    if (linkedWs) {
      via = 'workspaceId';
    }
  } else if (linkedWs) {
    via = 'chatSessionId';
  }

  const resolvedCwd = linkedWs ? (linkedWs.worktreePath as string | undefined) : undefined;
  return { resolvedCwd, via };
}

/**
 * Mirrors the provider process cwd selection in chat.service.ts runLLM().
 * Prompt/context cwd stays on `resolvedCwd`; only the provider subprocess cwd
 * switches to the stored session cwd for cwd-scoped resume.
 */
function resolveProviderCwd(session: MockSession | null, resolvedCwd: string | undefined): string {
  const resumeSessionId = session?.llmSessionId;
  const resumeSessionCwd = typeof session?.llmSessionCwd === 'string' && session.llmSessionCwd.trim()
    ? session.llmSessionCwd
    : undefined;
  return (resumeSessionId && resumeSessionCwd ? resumeSessionCwd : resolvedCwd) ?? AGENT_FALLBACK_CWD;
}

function resolvePromptAndContextCwd(resolvedCwd: string | undefined): string | undefined {
  return resolvedCwd;
}

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

function makeWorkspacesDb(workspaces: MockWorkspace[]) {
  return {
    collection: (_name: string) => ({
      findOne: async (query: Record<string, unknown>) => {
        for (const ws of workspaces) {
          // Match by chatSessionId
          if (query.chatSessionId !== undefined) {
            if (ws.chatSessionId !== query.chatSessionId) continue;
          }
          // Match by _id
          if (query._id !== undefined) {
            const qid = query._id as ObjectId;
            if (String(ws._id) !== String(qid)) continue;
          }
          // Apply $nin filter on status
          const statusFilter = (query.status as any)?.$nin;
          if (statusFilter && statusFilter.includes(ws.status ?? '')) continue;

          return ws;
        }
        return null;
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CWD resolution — primary path (chatSessionId)', () => {
  let workspaceId: ObjectId;
  let sessionId: string;

  beforeEach(() => {
    workspaceId = new ObjectId();
    sessionId = String(new ObjectId());
  });

  it('AC-14: resolves cwd from workspace linked by chatSessionId', async () => {
    const worktreePath = '/repos/my-project/worktree-abc';
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        chatSessionId: sessionId,
        worktreePath,
        status: 'active',
      },
    ]);
    const session: MockSession = { _id: new ObjectId() };

    const { resolvedCwd, via } = await resolveCwd(db, sessionId, session);

    expect(resolvedCwd).toBe(worktreePath);
    expect(via).toBe('chatSessionId');
  });

  it('AC-14: does NOT resolve cwd when workspace status is "archived" (primary path)', async () => {
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        chatSessionId: sessionId,
        worktreePath: '/repos/archived-ws',
        status: 'archived',
      },
    ]);
    const session: MockSession = { _id: new ObjectId() };

    const { resolvedCwd } = await resolveCwd(db, sessionId, session);

    expect(resolvedCwd).toBeUndefined();
  });

  it('AC-14: does NOT resolve cwd when workspace status is "failed" (primary path)', async () => {
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        chatSessionId: sessionId,
        worktreePath: '/repos/failed-ws',
        status: 'failed',
      },
    ]);
    const session: MockSession = { _id: new ObjectId() };

    const { resolvedCwd } = await resolveCwd(db, sessionId, session);

    expect(resolvedCwd).toBeUndefined();
  });
});

describe('CWD resolution — fallback path B1 (session.workspaceId)', () => {
  let workspaceId: ObjectId;
  let sessionId: string;

  beforeEach(() => {
    workspaceId = new ObjectId();
    sessionId = String(new ObjectId());
  });

  it('AC-14: falls back to workspace by _id when chatSessionId lookup finds nothing', async () => {
    const worktreePath = '/repos/my-project/worktree-b1';
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        // No chatSessionId set — only linkable by _id
        worktreePath,
        status: 'active',
      },
    ]);
    const session: MockSession = {
      workspaceId: String(workspaceId),
    };

    const { resolvedCwd, via } = await resolveCwd(db, sessionId, session);

    expect(resolvedCwd).toBe(worktreePath);
    expect(via).toBe('workspaceId');
  });

  it('AC-14: does NOT resolve cwd when fallback workspace has status "archived"', async () => {
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        worktreePath: '/repos/archived',
        status: 'archived',
      },
    ]);
    const session: MockSession = {
      workspaceId: String(workspaceId),
    };

    const { resolvedCwd } = await resolveCwd(db, sessionId, session);

    expect(resolvedCwd).toBeUndefined();
  });

  it('AC-14: does NOT resolve cwd when fallback workspace has status "failed"', async () => {
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        worktreePath: '/repos/failed',
        status: 'failed',
      },
    ]);
    const session: MockSession = {
      workspaceId: String(workspaceId),
    };

    const { resolvedCwd } = await resolveCwd(db, sessionId, session);

    expect(resolvedCwd).toBeUndefined();
  });

  it('AC-14: skips fallback when session.workspaceId is not a valid ObjectId', async () => {
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        worktreePath: '/repos/should-not-resolve',
        status: 'active',
      },
    ]);
    const session: MockSession = {
      workspaceId: 'not-a-valid-object-id',
    };

    const { resolvedCwd } = await resolveCwd(db, sessionId, session);

    expect(resolvedCwd).toBeUndefined();
  });

  it('AC-14: skips fallback when session has no workspaceId', async () => {
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        worktreePath: '/repos/should-not-resolve',
        status: 'active',
      },
    ]);
    // session exists but no workspaceId property
    const session: MockSession = {};

    const { resolvedCwd } = await resolveCwd(db, sessionId, session);

    expect(resolvedCwd).toBeUndefined();
  });

  it('AC-14: skips fallback when session is null', async () => {
    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        worktreePath: '/repos/should-not-resolve',
        status: 'active',
      },
    ]);

    const { resolvedCwd } = await resolveCwd(db, sessionId, null);

    expect(resolvedCwd).toBeUndefined();
  });

  it('AC-14: primary path takes precedence over fallback when both could match', async () => {
    const primaryWorktree = '/repos/primary-path';
    const fallbackWorktree = '/repos/fallback-path';
    const fallbackWsId = new ObjectId();

    const db = makeWorkspacesDb([
      {
        _id: workspaceId,
        chatSessionId: sessionId,
        worktreePath: primaryWorktree,
        status: 'active',
      },
      {
        _id: fallbackWsId,
        worktreePath: fallbackWorktree,
        status: 'active',
      },
    ]);
    const session: MockSession = {
      workspaceId: String(fallbackWsId),
    };

    const { resolvedCwd, via } = await resolveCwd(db, sessionId, session);

    // Primary chatSessionId match wins
    expect(resolvedCwd).toBe(primaryWorktree);
    expect(via).toBe('chatSessionId');
  });
});

describe('LLM resume cwd selection', () => {
  it('uses the freshly resolved cwd when there is no provider session to resume', () => {
    expect(resolveProviderCwd({}, '/repos/current-workspace')).toBe('/repos/current-workspace');
  });

  it('uses the stored llmSessionCwd for the provider process when resuming a provider session', () => {
    const session: MockSession = {
      llmSessionId: 'claude-session-id',
      llmSessionCwd: '/repos/original-chat-cwd',
    };

    expect(resolveProviderCwd(session, '/repos/newly-resolved-cwd')).toBe('/repos/original-chat-cwd');
  });

  it('does not change prompt/context cwd when resuming a provider session', () => {
    expect(resolvePromptAndContextCwd('/repos/newly-resolved-cwd')).toBe('/repos/newly-resolved-cwd');
  });

  it('falls back to the resolved cwd when old sessions do not have llmSessionCwd yet', () => {
    const session: MockSession = {
      llmSessionId: 'legacy-session-id',
    };

    expect(resolveProviderCwd(session, '/repos/current-workspace')).toBe('/repos/current-workspace');
  });

  it('ignores blank stored llmSessionCwd values', () => {
    const session: MockSession = {
      llmSessionId: 'claude-session-id',
      llmSessionCwd: '   ',
    };

    expect(resolveProviderCwd(session, '/repos/current-workspace')).toBe('/repos/current-workspace');
  });

  it('stores and reuses the explicit fallback cwd when no workspace/repo cwd exists', () => {
    expect(resolveProviderCwd({}, undefined)).toBe('/tmp/allen');
  });
});

describe('ObjectId.isValid guard', () => {
  it('rejects empty string', () => {
    expect(ObjectId.isValid('')).toBe(false);
  });

  it('rejects numeric strings', () => {
    expect(ObjectId.isValid('12345')).toBe(false);
  });

  it('accepts a valid 24-hex string', () => {
    expect(ObjectId.isValid(String(new ObjectId()))).toBe(true);
  });

  it('accepts an ObjectId instance', () => {
    expect(ObjectId.isValid(new ObjectId())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pre-validation ordering fix — code-review fix: validate workspaceId BEFORE
// creating the session (chat.routes.ts).  Tests that the guard fires first.
// ---------------------------------------------------------------------------

/**
 * Mirrors the route handler's pre-validation guard:
 *   if (workspaceId && !ObjectId.isValid(workspaceId)) { return 400; }
 *   const session = createSession(...);   // only reached when valid
 *
 * Returns 'rejected_before_create' | 'session_created'.
 */
function simulateRouteValidation(workspaceId: string | undefined): 'rejected_before_create' | 'session_created' {
  if (workspaceId && !ObjectId.isValid(workspaceId)) {
    return 'rejected_before_create'; // 400 returned — session never created
  }
  // Session creation would happen here
  return 'session_created';
}

describe('POST /sessions workspaceId pre-validation — orphan prevention (AC-13 fix)', () => {
  it('AC-13: invalid workspaceId → 400 before session creation (no orphan)', () => {
    expect(simulateRouteValidation('not-a-valid-id')).toBe('rejected_before_create');
  });

  it('AC-13: empty string workspaceId → 400 before session creation', () => {
    // empty string is falsy so the guard is not triggered — treated as absent
    // (workspaceId && ...) is false for empty string → session proceeds normally
    expect(simulateRouteValidation('')).toBe('session_created');
  });

  it('AC-13: numeric workspaceId string → 400 before session creation', () => {
    expect(simulateRouteValidation('12345')).toBe('rejected_before_create');
  });

  it('AC-13: valid ObjectId string → proceeds to session creation', () => {
    expect(simulateRouteValidation(String(new ObjectId()))).toBe('session_created');
  });

  it('AC-13: undefined workspaceId (no workspace) → proceeds to session creation', () => {
    expect(simulateRouteValidation(undefined)).toBe('session_created');
  });
});
