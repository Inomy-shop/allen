import { describe, expect, it } from 'vitest';
import { matchTerminalWebSocketRoute } from './workspace-terminal.js';

describe('matchTerminalWebSocketRoute', () => {
  it('matches workspace and repository terminals', () => {
    expect(matchTerminalWebSocketRoute('/ws/workspaces/abc123/terminal/term-1'))
      .toEqual({ sourceType: 'workspace', sourceId: 'abc123', terminalId: 'term-1' });
    expect(matchTerminalWebSocketRoute('/ws/repos/def456/terminal/term-2'))
      .toEqual({ sourceType: 'repo', sourceId: 'def456', terminalId: 'term-2' });
  });

  it('matches an Allen home terminal without a linked resource', () => {
    expect(matchTerminalWebSocketRoute('/ws/allen/terminal/term-3'))
      .toEqual({ sourceType: 'allen', sourceId: 'home', terminalId: 'term-3' });
  });
});
