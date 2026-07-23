import type { TerminalSourceType } from './terminal-routing';

export type ChatTerminalSource = {
  type: TerminalSourceType;
  id: string;
  label: string;
};

type TerminalSourceInput = {
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  repoId?: string | null;
  repoLabel?: string | null;
};

/** Resolve a chat terminal cwd by priority: workspace, repository, Allen home. */
export function resolveChatTerminalSource(input: TerminalSourceInput): ChatTerminalSource {
  if (input.workspaceId) {
    return {
      type: 'workspace',
      id: input.workspaceId,
      label: input.workspaceLabel || 'Workspace',
    };
  }

  if (input.repoId) {
    return {
      type: 'repo',
      id: input.repoId,
      label: input.repoLabel || 'Repository',
    };
  }

  return {
    type: 'allen',
    id: 'home',
    label: '~/.allen',
  };
}
