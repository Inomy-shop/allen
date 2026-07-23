import { describe, expect, it } from 'vitest';
import { chatSessionPath, shouldSwitchChatSession, workspaceChatPath } from './workspace-routes';

describe('workspace chat routes', () => {
  it('keeps workspace chat selection on the stable workspace route', () => {
    expect(chatSessionPath('chat-2', 'workspace/one')).toBe('/chat/chat-2?workspaceId=workspace%2Fone');
  });

  it('uses a session deep link outside workspace mode', () => {
    expect(chatSessionPath('chat/2')).toBe('/chat/chat%2F2');
    expect(workspaceChatPath('workspace one')).toBe('/chat?workspaceId=workspace%20one');
  });

  it('does not clear and reload an already active workspace conversation', () => {
    expect(shouldSwitchChatSession('chat-2', 'chat-2')).toBe(false);
    expect(shouldSwitchChatSession(null, 'chat-2')).toBe(true);
    expect(shouldSwitchChatSession('chat-1', 'chat-2')).toBe(true);
  });
});
