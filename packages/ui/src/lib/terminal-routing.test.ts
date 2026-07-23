import { describe, expect, it } from 'vitest';
import { terminalWebSocketUrl } from './terminal-routing';

describe('terminalWebSocketUrl', () => {
  it('builds workspace and repository terminal routes', () => {
    expect(terminalWebSocketUrl('workspace', 'abc123', 'term-1', null))
      .toContain('/ws/workspaces/abc123/terminal/term-1');
    expect(terminalWebSocketUrl('repo', 'def456', 'term-2', null))
      .toContain('/ws/repos/def456/terminal/term-2');
  });

  it('builds the Allen home terminal route without a source id segment', () => {
    expect(terminalWebSocketUrl('allen', 'home', 'term-3', null))
      .toContain('/ws/allen/terminal/term-3');
  });
});
