import { describe, expect, it } from 'vitest';
import { resolveChatTerminalSource } from './chat-terminal-source';

describe('resolveChatTerminalSource', () => {
  it('prefers the linked workspace over the repository', () => {
    expect(resolveChatTerminalSource({
      workspaceId: 'workspace-1',
      workspaceLabel: 'feature/workspace',
      repoId: 'repo-1',
      repoLabel: 'allen-internal',
    })).toEqual({ type: 'workspace', id: 'workspace-1', label: 'feature/workspace' });
  });

  it('uses the linked repository when there is no workspace', () => {
    expect(resolveChatTerminalSource({ repoId: 'repo-1', repoLabel: 'allen-internal' }))
      .toEqual({ type: 'repo', id: 'repo-1', label: 'allen-internal' });
  });

  it('falls back to the Allen home directory when nothing is linked', () => {
    expect(resolveChatTerminalSource({}))
      .toEqual({ type: 'allen', id: 'home', label: '~/.allen' });
  });
});
