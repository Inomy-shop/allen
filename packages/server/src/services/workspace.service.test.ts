import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  chooseAvailableWorkspaceBranchName,
  findLocalBranchNamespaceConflict,
  WorkspaceManager,
} from './workspace.service';

function collectionFind(rows: any[]) {
  return {
    sort: () => ({
      toArray: async () => rows,
    }),
  };
}

describe('WorkspaceManager.list', () => {
  it('adds the repo saved default branch to workspace list rows', async () => {
    const repoId = new ObjectId();
    const workspaceId = new ObjectId();
    const db = {
      collection: (name: string) => {
        if (name === 'workspaces') {
          return {
            find: () => collectionFind([{
              _id: workspaceId,
              name: 'existing workspace',
              repoId: String(repoId),
              repoName: 'repo',
              repoPath: '/tmp/repo',
              worktreePath: '/tmp/workspace',
              branch: 'feature/existing',
              baseBranch: 'main',
              status: 'active',
              source: 'new',
              basePort: 15000,
              services: [],
              terminals: [],
              changedFiles: 0,
              ahead: 0,
              behind: 0,
            }]),
          };
        }
        if (name === 'chat_sessions') {
          return {
            aggregate: () => ({
              toArray: async () => [],
            }),
          };
        }
        if (name === 'repos') {
          return {
            find: () => ({
              toArray: async () => [{
                _id: repoId,
                detected: { defaultBranch: 'development' },
              }],
            }),
          };
        }
        throw new Error(`Unexpected collection: ${name}`);
      },
    } as any;

    const manager = new WorkspaceManager(db);
    const rows = await manager.list();

    expect(rows).toHaveLength(1);
    expect(rows[0].baseBranch).toBe('main');
    expect(rows[0].repoDefaultBranch).toBe('development');
  });

  it('orders workspaces by the most recent linked chat message', async () => {
    const repoId = new ObjectId();
    const olderWsId = new ObjectId();
    const newerWsId = new ObjectId();
    const older = new Date('2024-01-01T00:00:00Z');
    const newer = new Date('2024-02-01T00:00:00Z');
    const base = {
      repoId: String(repoId),
      repoName: 'repo',
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/workspace',
      branch: 'feature',
      baseBranch: 'main',
      status: 'active',
      source: 'new',
      basePort: 15000,
      services: [],
      terminals: [],
      changedFiles: 0,
      ahead: 0,
      behind: 0,
      updatedAt: older,
    };
    const db = {
      collection: (name: string) => {
        if (name === 'workspaces') {
          // Returned in the "wrong" order on purpose; list() must re-sort by chat activity.
          return {
            find: () => collectionFind([
              { _id: olderWsId, name: 'older', ...base },
              { _id: newerWsId, name: 'newer', ...base },
            ]),
          };
        }
        if (name === 'chat_sessions') {
          return {
            aggregate: () => ({
              toArray: async () => [
                { _id: String(newerWsId), latestMessageAt: newer },
                { _id: String(olderWsId), latestMessageAt: older },
              ],
            }),
          };
        }
        if (name === 'repos') {
          return {
            find: () => ({
              toArray: async () => [{ _id: repoId, detected: { defaultBranch: 'development' } }],
            }),
          };
        }
        throw new Error(`Unexpected collection: ${name}`);
      },
    } as any;

    const manager = new WorkspaceManager(db);
    const rows = await manager.list();

    expect(rows.map(row => row.name)).toEqual(['newer', 'older']);
    expect(rows[0].latestMessageAt).toEqual(newer);
  });
});

describe('workspace branch name resolution', () => {
  it('detects parent local branch namespace conflicts', () => {
    expect(findLocalBranchNamespaceConflict('testing/something', ['main', 'testing'])).toBe('testing');
  });

  it('detects child local branch namespace conflicts', () => {
    expect(findLocalBranchNamespaceConflict('testing', ['main', 'testing/something'])).toBe('testing/something');
  });

  it('keeps the requested branch when the local namespace is available', () => {
    expect(chooseAvailableWorkspaceBranchName('feature/something', '6a22bdabfb8ec31fdea3d0d8', ['main', 'testing'])).toBe('feature/something');
  });

  it('uses a workspace-specific fallback when a parent branch blocks the requested namespace', () => {
    expect(chooseAvailableWorkspaceBranchName('testing/something', '6a22bdabfb8ec31fdea3d0d8', ['main', 'testing'])).toBe('testing-something-6a22bdab');
  });
});
