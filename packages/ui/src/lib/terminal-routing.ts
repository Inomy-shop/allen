export type TerminalSourceType = 'workspace' | 'repo' | 'allen';

type TerminalRuntimeInfo = {
  terminalWsUrl?: string | null;
};

export function terminalWebSocketUrl(
  sourceType: TerminalSourceType,
  sourceId: string,
  terminalId: string,
  runtimeInfo: TerminalRuntimeInfo | null,
): string {
  const path = sourceType === 'allen'
    ? `/ws/allen/terminal/${terminalId}`
    : `/ws/${sourceType === 'repo' ? 'repos' : 'workspaces'}/${sourceId}/terminal/${terminalId}`;
  if (runtimeInfo?.terminalWsUrl) {
    try {
      return new URL(path, runtimeInfo.terminalWsUrl).toString();
    } catch {
      // Fall through to browser-origin construction.
    }
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}
