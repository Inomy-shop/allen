export function workspaceChatPath(workspaceId: string): string {
  return `/chat?workspaceId=${encodeURIComponent(workspaceId)}`;
}

export function chatSessionPath(sessionId: string, workspaceId?: string | null): string {
  const sessionPath = `/chat/${encodeURIComponent(sessionId)}`;
  return workspaceId ? `${sessionPath}?workspaceId=${encodeURIComponent(workspaceId)}` : sessionPath;
}

export function shouldSwitchChatSession(activeSessionId: string | null, targetSessionId: string): boolean {
  return activeSessionId !== targetSessionId;
}
