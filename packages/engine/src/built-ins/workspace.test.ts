import { describe, it, expect } from 'vitest';
import { createWorkspace } from './workspace.js';

// ── Minimal mock helpers ──────────────────────────────────────────────────────

/**
 * Build a minimal BuiltInContext whose db supports findOne on both
 * 'repos' and 'workspaces' collections. The caller can supply whatever
 * findOne stubs they need; the default stub returns null (not found).
 */
function makeCtx(opts: {
  reposFindOne?: (filter: any) => Promise<any>;
  workspacesFindOne?: (filter: any) => Promise<any>;
  wsCreate?: (payload: any) => Promise<any>;
  wsGet?: (id: string) => Promise<any>;
}): any {
  const {
    reposFindOne = async () => null,
    workspacesFindOne = async () => null,
    wsCreate = async () => {
      throw new Error('wsCreate not expected in this test');
    },
    wsGet = async () => null,
  } = opts;

  return {
    emitter: {
      // Swallow all emitted events — tests that need them can spy here.
      emit: (_e: unknown) => {},
    },
    db: {
      collection: (name: string) => {
        if (name === 'repos') return { findOne: reposFindOne };
        if (name === 'workspaces') return { findOne: workspacesFindOne };
        return { findOne: async () => null };
      },
    },
    services: {
      workspaces: { create: wsCreate, get: wsGet },
    },
  };
}

// Fake repo documents
const FAKE_REPO = {
  _id: 'repo-abc',
  name: 'my-repo',
  path: '/home/ubuntu/repos/my-repo',
  detected: { defaultBranch: 'main' },
};

// Fake workspace document (as returned by the DB)
const FAKE_WS_DOC = {
  _id: 'ws-existing-id',
  name: 'feature-my-task',
  repoId: 'repo-abc',
  branch: 'feature/my-task-abc123',
  baseBranch: 'main',
  worktreePath: '/home/ubuntu/.allen/workspaces/ws-existing-id',
  basePort: 15010,
  status: 'active',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createWorkspace built-in', () => {
  // ── AC1: normal path — registered repo path creates a new workspace ─────────

  describe('normal path (registered repo path)', () => {
    it('creates a new workspace when repo_path is a registered repo path', async () => {
      // wsCreate returns a minimal workspace; wsGet returns it as "active"
      const createdWs = {
        _id: 'ws-new-id',
        status: 'creating',
        worktreePath: '/home/ubuntu/.allen/workspaces/ws-new-id',
        basePort: 15000,
      };
      let wsCreateCalled = false;
      const ctx = makeCtx({
        reposFindOne: async (filter: any) => {
          // The engine looks up by path first
          if (filter.path === FAKE_REPO.path) return FAKE_REPO;
          return null;
        },
        workspacesFindOne: async () => null, // no pre-existing worktree
        wsCreate: async (payload: any) => {
          wsCreateCalled = true;
          expect(payload.repoId).toBe(String(FAKE_REPO._id));
          expect(payload.repoPath).toBe(FAKE_REPO.path);
          return createdWs;
        },
        wsGet: async (_id: string) => ({
          ...createdWs,
          name: 'feature-new-task',
          status: 'active',
        }),
      });

      const result = await createWorkspace(
        { repo_path: FAKE_REPO.path, wait_for_setup: true, timeout_sec: 30 },
        {},
        ctx,
      );

      expect(wsCreateCalled).toBe(true);
      expect(result.workspace_id).toBe('ws-new-id');
      expect(result.worktree_path).toBe('/home/ubuntu/.allen/workspaces/ws-new-id');
      expect(result.status).toBe('active');
    });

    it('includes workspace setup errors when creation fails', async () => {
      const createdWs = {
        _id: 'ws-failed-id',
        status: 'creating',
        worktreePath: '/home/ubuntu/.allen/workspaces/ws-failed-id',
        basePort: 15000,
      };
      const ctx = makeCtx({
        reposFindOne: async (filter: any) => {
          if (filter.path === FAKE_REPO.path) return FAKE_REPO;
          return null;
        },
        wsCreate: async () => createdWs,
        wsGet: async () => ({
          ...createdWs,
          status: 'failed',
          setupError: "git fetch origin failed: 'origin' does not appear to be a git repository",
        }),
      });

      await expect(
        createWorkspace(
          { repo_path: FAKE_REPO.path, wait_for_setup: true, timeout_sec: 30 },
          {},
          ctx,
        ),
      ).rejects.toThrow("git fetch origin failed: 'origin' does not appear to be a git repository");
    });
  });

  // ── AC2: worktree path — returns existing workspace without creating a new one ──

  describe('worktree path (existing active workspace)', () => {
    it('returns existing workspace details when repo_path is a worktree path', async () => {
      let wsCreateCalled = false;
      const ctx = makeCtx({
        // Repos collection never matches a worktree path
        reposFindOne: async () => null,
        // Workspaces collection finds the pre-existing record
        workspacesFindOne: async (filter: any) => {
          if (filter.worktreePath === FAKE_WS_DOC.worktreePath) return FAKE_WS_DOC;
          return null;
        },
        wsCreate: async () => {
          wsCreateCalled = true;
          throw new Error('wsCreate must NOT be called for existing worktree paths');
        },
      });

      const result = await createWorkspace(
        { repo_path: FAKE_WS_DOC.worktreePath },
        {},
        ctx,
      );

      // No new workspace must have been created
      expect(wsCreateCalled).toBe(false);

      // Return shape must match the normal success path exactly
      expect(result.workspace_id).toBe('ws-existing-id');
      expect(result.workspace_name).toBe('feature-my-task');
      expect(result.branch).toBe('feature/my-task-abc123');
      expect(result.branch_name).toBe('feature/my-task-abc123');
      expect(result.base_branch).toBe('main');
      expect(result.worktree_path).toBe('/home/ubuntu/.allen/workspaces/ws-existing-id');
      expect(result.base_port).toBe(15010);
      expect(result.status).toBe('active');
      expect(result.repo_path).toBe('/home/ubuntu/.allen/workspaces/ws-existing-id');
    });

    it('accepts the worktree path via state.repo_path too', async () => {
      const ctx = makeCtx({
        reposFindOne: async () => null,
        workspacesFindOne: async (filter: any) => {
          if (filter.worktreePath === FAKE_WS_DOC.worktreePath) return FAKE_WS_DOC;
          return null;
        },
      });

      const result = await createWorkspace(
        {},
        { repo_path: FAKE_WS_DOC.worktreePath },
        ctx,
      );

      expect(result.workspace_id).toBe('ws-existing-id');
      expect(result.worktree_path).toBe('/home/ubuntu/.allen/workspaces/ws-existing-id');
    });
  });

  // ── AC3: excluded statuses fall through to error ─────────────────────────────

  describe('excluded-status worktree paths (status filter)', () => {
    // Helper: simulate $nin exclusion in the mock (MongoDB applies it server-side;
    // in unit tests we check the $nin list manually).
    function makeExcludedCtx(worktreePath: string, wsStatus: string) {
      return makeCtx({
        reposFindOne: async () => null,
        workspacesFindOne: async (filter: any) => {
          const excluded: string[] = filter.status?.$nin ?? [];
          if (filter.worktreePath === worktreePath && !excluded.includes(wsStatus)) {
            return { ...FAKE_WS_DOC, status: wsStatus, worktreePath };
          }
          return null; // excluded by $nin
        },
      });
    }

    it('throws "Repo not found" when the workspace is archived', async () => {
      const ctx = makeExcludedCtx('/home/ubuntu/.allen/workspaces/archived-ws', 'archived');

      await expect(
        createWorkspace({ repo_path: '/home/ubuntu/.allen/workspaces/archived-ws' }, {}, ctx),
      ).rejects.toThrow('Repo not found');
    });

    it('throws "Repo not found" when the workspace is archiving', async () => {
      const ctx = makeExcludedCtx('/home/ubuntu/.allen/workspaces/archiving-ws', 'archiving');

      await expect(
        createWorkspace({ repo_path: '/home/ubuntu/.allen/workspaces/archiving-ws' }, {}, ctx),
      ).rejects.toThrow('Repo not found');
    });

  });

  // ── Guard: missing db throws immediately ─────────────────────────────────────

  describe('guard: no db', () => {
    it('throws if ctx.db is absent', async () => {
      const ctx = { emitter: { emit: () => {} }, db: undefined, services: {} };
      await expect(createWorkspace({}, {}, ctx as any)).rejects.toThrow(
        'create-workspace requires a database connection',
      );
    });
  });
});
