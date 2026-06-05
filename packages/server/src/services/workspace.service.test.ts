import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { WorkspaceManager } from './workspace.service';

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
});
