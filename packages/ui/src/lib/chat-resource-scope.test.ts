import { describe, expect, it } from 'vitest';
import { resolveChatResourceScope } from './chat-resource-scope';

describe('resolveChatResourceScope', () => {
  it('isolates every unsent chat tab from its siblings', () => {
    const first = resolveChatResourceScope({ chatTabId: 'temp-chat-1' });
    const second = resolveChatResourceScope({ chatTabId: 'temp-chat-2' });

    expect(first).toBe('chat:temp-chat-1');
    expect(second).toBe('chat:temp-chat-2');
    expect(second).not.toBe(first);
  });

  it('uses the persisted chat id after a conversation is created', () => {
    expect(resolveChatResourceScope({ chatTabId: 'session-1', sessionId: 'session-1' }))
      .toBe('chat:session-1');
  });

  it('isolates workspace temp chats and persisted chats', () => {
    expect(resolveChatResourceScope({
      workspaceId: 'workspace-1',
      workspaceTab: { kind: 'temp', tempId: 'temp-1' },
      sessionId: 'stale-session',
    })).toBe('chat:temp-1');

    expect(resolveChatResourceScope({
      workspaceId: 'workspace-1',
      workspaceTab: { kind: 'session', sessionId: 'session-2' },
    })).toBe('chat:session-2');
  });

  it('does not inherit a conversation scope in terminal or utility tabs', () => {
    expect(resolveChatResourceScope({ terminalTabId: 'terminal-1', chatTabId: 'session-1' }))
      .toBe('surface:chat:terminal:terminal-1');
    expect(resolveChatResourceScope({ utilityTabId: 'file-explorer', chatTabId: 'session-1' }))
      .toBe('surface:chat:utility:file-explorer');
    expect(resolveChatResourceScope({
      workspaceId: 'workspace-1',
      workspaceTab: { kind: 'code-diff' },
      sessionId: 'session-1',
    })).toBe('surface:chat:workspace:workspace-1:code-diff');
  });

  it('uses a blank scope before any chat tab or session exists', () => {
    expect(resolveChatResourceScope({})).toBe('surface:chat:new');
  });
});
