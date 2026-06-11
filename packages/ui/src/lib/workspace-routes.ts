export function workspaceChatPath(workspaceId: string): string {
  return `/chat?workspaceId=${encodeURIComponent(workspaceId)}`;
}
