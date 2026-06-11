export type WorkspaceCreateBranchSource = {
  branch?: string;
  defaultBranch?: string;
  detected?: {
    defaultBranch?: string;
  };
};

export function workspaceCreateBaseBranch(repo: WorkspaceCreateBranchSource): string {
  return repo.detected?.defaultBranch?.trim()
    || repo.defaultBranch?.trim()
    || repo.branch?.trim()
    || 'main';
}
