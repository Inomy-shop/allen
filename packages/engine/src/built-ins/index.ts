import type { BuiltInFunction } from '../types.js';
import { gitCreateBranch, gitCommit, gitPush, gitCreatePR, gitCleanupWorktree } from './git.js';
import { runBuild, runTests } from './build.js';
import { classifyTask } from './classify.js';
import { promptUser } from './prompt-user.js';
import { createWorkspace } from './workspace.js';

const builtIns: Record<string, BuiltInFunction> = {
  'git-create-branch': gitCreateBranch,
  'git-commit': gitCommit,
  'git-push': gitPush,
  'git-create-pr': gitCreatePR,
  'git-cleanup-worktree': gitCleanupWorktree,
  'run-build': runBuild,
  'run-tests': runTests,
  'classify-task': classifyTask,
  'prompt-user': promptUser,
  'create-workspace': createWorkspace,
};

export function getBuiltIns(): Record<string, BuiltInFunction> {
  return { ...builtIns };
}
