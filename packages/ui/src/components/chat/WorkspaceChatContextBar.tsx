import { GitBranch, FolderOpen, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

type WorkspaceDoc = {
  _id: string;
  name: string;
  repoName?: string;
  repoId?: string;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
  status?: string;
  prNumber?: number;
  prUrl?: string;
};

type ArchivedWorkspace = {
  id?: string;
  name?: string;
  repoName?: string;
  branch?: string;
  baseBranch?: string;
  archivedAt?: string;
};

type Props = {
  workspace?: WorkspaceDoc | null;
  archivedWorkspace?: ArchivedWorkspace | null;
};

export default function WorkspaceChatContextBar({ workspace, archivedWorkspace }: Props) {
  const navigate = useNavigate();

  if (!workspace && !archivedWorkspace) return null;

  const isArchived = archivedWorkspace != null || workspace?.status === 'archived';
  const name = workspace?.name ?? archivedWorkspace?.name ?? 'Workspace';
  const repoName = workspace?.repoName ?? archivedWorkspace?.repoName;
  const branch = workspace?.branch ?? archivedWorkspace?.branch;
  const baseBranch = workspace?.baseBranch ?? archivedWorkspace?.baseBranch;
  const worktreePath = workspace?.worktreePath;
  const workspaceId = workspace?._id;

  return (
    <div className={`workspace-chat-context-bar flex items-center gap-3 px-4 py-2 border-b text-sm ${
      isArchived ? 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800' : 'bg-app-muted border-app'
    }`}>
      {isArchived && (
        <span className="rounded bg-yellow-100 dark:bg-yellow-800 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:text-yellow-200">
          Archived – read only
        </span>
      )}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="font-medium text-theme-primary truncate">{name}</span>
        {repoName && <span className="text-theme-muted truncate">· {repoName}</span>}
        {branch && (
          <span className="flex items-center gap-1 text-theme-muted font-mono text-xs truncate">
            <GitBranch className="h-3 w-3 shrink-0" />
            {branch}{baseBranch && ` → ${baseBranch}`}
          </span>
        )}
        {worktreePath && (
          <span className="flex items-center gap-1 text-theme-muted font-mono text-xs truncate">
            <FolderOpen className="h-3 w-3 shrink-0" />
            {worktreePath}
          </span>
        )}
      </div>
      {!isArchived && workspaceId && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => navigate(`/workspaces/${workspaceId}`)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-theme-secondary hover:bg-app-card hover:text-theme-primary transition-colors"
            title="Open Workspace IDE"
          >
            <ExternalLink className="h-3 w-3" />
            Open
          </button>
        </div>
      )}
    </div>
  );
}
